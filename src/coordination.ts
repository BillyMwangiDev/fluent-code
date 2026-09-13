import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {ClaimConflict, ClaimResult, CoordinationState, FileClaim, LaneMessage} from './daemon-protocol.js';

/**
 * How long a claim survives without its lane renewing it. A claim is a *signal of intent*, never
 * an OS lock (spec §11) — but an un-expiring signal from a lane that died is worse than no signal
 * at all, because it blocks live lanes forever with no way to tell it is stale.
 */
const claimLeaseMs = 15 * 60_000;

/**
 * Normalizes a claim path so overlap comparison is meaningful: POSIX separators, no leading `./`
 * or `/`, no trailing `/`. Paths stay exactly as the caller scoped them (repo-relative or
 * absolute) — this only removes spelling differences, it never resolves against the filesystem.
 */
function normalizeClaimPath(path: string) {
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized) throw new Error('A file claim needs a path');
  return normalized;
}

/**
 * Two claims overlap when they name the same path, or when one is a directory containing the
 * other. This is the fix for the original exact-string comparison, under which a lane claiming
 * `src/` and a lane claiming `src/daemon.ts` looked entirely unrelated.
 *
 * Deliberately *not* glob matching: every real claim seen so far is a concrete file or directory,
 * and a half-correct glob implementation would report overlaps it cannot justify. A claim
 * containing wildcards is compared literally until there is a reason to do better.
 */
function claimsOverlap(left: string, right: string): ClaimConflict['overlap'] | undefined {
  if (left === right) return 'same';
  if (right.startsWith(`${left}/`)) return 'contains';
  if (left.startsWith(`${right}/`)) return 'contained';
  return undefined;
}

export class CoordinationManager {
  private readonly states = new Map<string, CoordinationState>();
  private readonly stateFile: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.stateFile = join(stateDirectory, 'coordination.json');
  }

  async restore() {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as CoordinationState[];
      for (const state of parsed) {
        // Claims written before leases existed carry no expiry. Give them one starting now rather
        // than dropping them: a restored claim from a lane that is still running gets renewed on
        // the next heartbeat, and one from a lane that is gone expires on its own.
        state.claims = (state.claims ?? []).map(claim => ({
          ...claim,
          origin: claim.origin ?? 'declared',
          renewedAt: claim.renewedAt ?? claim.createdAt,
          expiresAt: claim.expiresAt ?? new Date(Date.now() + claimLeaseMs).toISOString()
        }));
        state.messages ??= [];
        this.states.set(state.project, state);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(project: string) {
    return this.ensure(project);
  }

  async task(project: string, title: string, sessionId?: string) {
    const state = this.ensure(project);
    state.tasks.unshift({id: randomUUID(), title, status: sessionId ? 'active' : 'todo', sessionId, createdAt: new Date().toISOString()});
    await this.persist();
    return state;
  }

  async updateTask(project: string, taskId: string, status: 'todo' | 'active' | 'done', sessionId?: string) {
    const state = this.ensure(project);
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('Coordination task not found');
    task.status = status;
    task.sessionId = sessionId ?? task.sessionId;
    await this.persist();
    return state;
  }

  /**
   * Claims `path` for one lane. The result says explicitly whether the claim was granted: the
   * previous shape returned the conflict alongside the state, so a caller that forgot to check
   * `conflict` read a refused claim as a successful one.
   *
   * A conflict does not block the edit — nothing here is an OS lock (spec §11). It raises a
   * visible overlap so the orchestration column can show it before two lanes discover it at
   * merge time, which is where the field measures a 27.67% conflict rate (and 41.7% when the two
   * lanes run different providers — see docs/research/2026-09-13-agent-orchestration.md §2.3).
   */
  async claim(project: string, path: string, sessionId: string, origin: FileClaim['origin'] = 'declared'): Promise<ClaimResult> {
    const state = this.ensure(project);
    const claimPath = normalizeClaimPath(path);
    const now = new Date();
    const conflicts: ClaimConflict[] = [];
    for (const existing of state.claims) {
      if (existing.sessionId === sessionId) continue;
      const overlap = claimsOverlap(claimPath, existing.path);
      if (overlap) conflicts.push({path: claimPath, claimedPath: existing.path, sessionId: existing.sessionId, overlap});
    }

    const granted = conflicts.length === 0;
    if (granted) {
      const existing = state.claims.find(claim => claim.path === claimPath && claim.sessionId === sessionId);
      const lease = {renewedAt: now.toISOString(), expiresAt: new Date(now.getTime() + claimLeaseMs).toISOString()};
      if (existing) Object.assign(existing, lease, {origin: existing.origin === 'declared' ? 'declared' : origin});
      else state.claims.push({path: claimPath, sessionId, origin, createdAt: now.toISOString(), ...lease});
    }

    await this.persist();
    return {granted, state, conflicts};
  }

  /**
   * Records what a lane has *actually* changed, as distinct from what it announced it intends to
   * change. An observed claim is a fact rather than a request, so unlike `claim` it is never
   * refused: two lanes that have both already edited a file is exactly the situation worth
   * showing, and refusing to record the second one would hide it.
   *
   * The lane's observed claims are replaced wholesale, so a path it has since reverted stops being
   * claimed. Declared claims are left alone — an agent's stated intent outlives one sweep of its
   * working tree.
   */
  async observe(project: string, sessionId: string, paths: readonly string[]) {
    const state = this.ensure(project);
    const now = new Date();
    const lease = {renewedAt: now.toISOString(), expiresAt: new Date(now.getTime() + claimLeaseMs).toISOString()};
    const normalized = new Set<string>();
    for (const path of paths) {
      try {
        normalized.add(normalizeClaimPath(path));
      } catch {
        // A path that normalizes to nothing is not worth failing a sweep over.
      }
    }

    const others = state.claims.filter(claim => claim.sessionId !== sessionId);
    const mineDeclared = state.claims
      .filter(claim => claim.sessionId === sessionId && claim.origin === 'declared')
      .map(claim => ({...claim, ...lease}));
    const declaredPaths = new Set(mineDeclared.map(claim => claim.path));
    // Keep the original createdAt for a path this lane was already touching: conflict ordering
    // depends on who arrived first, and re-observing the same file is not a new arrival.
    const previouslyObserved = new Map(state.claims.filter(claim => claim.sessionId === sessionId).map(claim => [claim.path, claim.createdAt]));
    const observed: FileClaim[] = [...normalized]
      .filter(path => !declaredPaths.has(path))
      .map(path => ({path, sessionId, origin: 'observed', createdAt: previouslyObserved.get(path) ?? now.toISOString(), ...lease}));

    state.claims = [...others, ...mineDeclared, ...observed];

    await this.persist();
    return {state, conflicts: this.conflicts(project)};
  }

  /**
   * Every pair of overlapping claims held by different lanes. Each overlap is reported once, from
   * the perspective of the more recently created claim — the lane that arrived second is the one
   * that needs to know.
   */
  conflicts(project: string): ClaimConflict[] {
    const state = this.ensure(project);
    const ordered = [...state.claims].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const conflicts: ClaimConflict[] = [];
    for (let index = 0; index < ordered.length; index++) {
      const claim = ordered[index]!;
      for (let earlier = 0; earlier < index; earlier++) {
        const existing = ordered[earlier]!;
        if (existing.sessionId === claim.sessionId) continue;
        const overlap = claimsOverlap(claim.path, existing.path);
        if (overlap) conflicts.push({path: claim.path, claimedPath: existing.path, sessionId: existing.sessionId, overlap});
      }
    }
    return conflicts;
  }

  async releaseClaim(project: string, path: string, sessionId: string) {
    const state = this.ensure(project);
    const claimPath = normalizeClaimPath(path);
    const before = state.claims.length;
    state.claims = state.claims.filter(claim => !(claim.path === claimPath && claim.sessionId === sessionId));
    if (state.claims.length === before) throw new Error('File claim not found for this agent');
    await this.persist();
    return state;
  }

  /**
   * Renews every claim held by a live lane and drops every claim whose lease lapsed. Driven by a
   * daemon heartbeat rather than by the agents, because the thing a lease protects against is a
   * lane that can no longer act on its own behalf.
   *
   * Returns the claims it dropped so the daemon can tell subscribers *why* a claim disappeared —
   * a claim vanishing with no explanation is exactly the hidden coordination spec §2 forbids.
   */
  async renewLeases(liveSessionIds: readonly string[]) {
    const live = new Set(liveSessionIds);
    const now = Date.now();
    const renewedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + claimLeaseMs).toISOString();
    const expired: Array<FileClaim & {project: string}> = [];
    let changed = false;

    for (const state of this.states.values()) {
      const keep: FileClaim[] = [];
      for (const claim of state.claims) {
        if (live.has(claim.sessionId)) {
          claim.renewedAt = renewedAt;
          claim.expiresAt = expiresAt;
          keep.push(claim);
          changed = true;
          continue;
        }
        if (new Date(claim.expiresAt).getTime() > now) {
          keep.push(claim);
          continue;
        }
        expired.push({...claim, project: state.project});
        changed = true;
      }
      state.claims = keep;
    }

    if (changed) await this.persist();
    return expired;
  }

  /** Drops every claim a lane holds, across every project — called when a session stops or exits
   * so the next lane does not wait out a lease for a lane that is already gone. */
  async releaseSession(sessionId: string) {
    let changed = false;
    for (const state of this.states.values()) {
      const before = state.claims.length;
      state.claims = state.claims.filter(claim => claim.sessionId !== sessionId);
      if (state.claims.length !== before) changed = true;
    }
    if (changed) await this.persist();
    return changed;
  }

  /**
   * Queues a message from one lane to another. Appended, never unshifted: mail is read in the order
   * it was sent, and a later message that assumes an earlier one was read is otherwise nonsense.
   */
  async send(project: string, from: string, to: string, body: string) {
    if (!body.trim()) throw new Error('An empty message is not worth sending');
    const state = this.ensure(project);
    const message: LaneMessage = {id: randomUUID(), from, to, body: body.trim(), createdAt: new Date().toISOString()};
    state.messages.push(message);
    await this.persist();
    return message;
  }

  /**
   * A lane's unread mail, oldest first. Reading marks it read, which is what makes this a mailbox
   * rather than a feed — `peek` is for the UI, which watches without consuming.
   */
  async inbox(project: string, sessionId: string, {peek = false} = {}) {
    const state = this.ensure(project);
    const unread = state.messages.filter(message => message.to === sessionId && !message.readAt);
    if (!peek && unread.length > 0) {
      const readAt = new Date().toISOString();
      for (const message of unread) message.readAt = readAt;
      await this.persist();
    }
    return unread;
  }

  unreadCount(project: string, sessionId: string) {
    return this.ensure(project).messages.filter(message => message.to === sessionId && !message.readAt).length;
  }

  messages(project: string) {
    return this.ensure(project).messages;
  }

  async decision(project: string, summary: string, sessionId?: string) {
    const state = this.ensure(project);
    state.decisions.unshift({id: randomUUID(), summary, sessionId, createdAt: new Date().toISOString()});
    await this.persist();
    return state;
  }

  async handoff(project: string, fromSessionId: string, toSessionId: string, summary: string) {
    const state = this.ensure(project);
    state.handoffs.unshift({id: randomUUID(), fromSessionId, toSessionId, summary, createdAt: new Date().toISOString(), status: 'open'});
    await this.persist();
    return state;
  }

  async acceptHandoff(project: string, handoffId: string) {
    const state = this.ensure(project);
    const handoff = state.handoffs.find(item => item.id === handoffId);
    if (!handoff) throw new Error('Coordination handoff not found');
    handoff.status = 'accepted';
    await this.persist();
    return state;
  }

  private ensure(project: string) {
    let state = this.states.get(project);
    if (!state) {
      state = {project, tasks: [], claims: [], decisions: [], handoffs: [], messages: []};
      this.states.set(project, state);
    }
    return state;
  }

  private async persist() {
    const run = this.queue.then(async () => {
      await mkdir(dirname(this.stateFile), {recursive: true});
      const temporary = `${this.stateFile}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.states.values()], null, 2));
      await rename(temporary, this.stateFile);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
