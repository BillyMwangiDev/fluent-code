import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {ClaimConflict, ClaimReleaseReason, ClaimResult, CoordinationEvent, CoordinationEventKind, CoordinationState, CoordinationTask, DesignHandoffSpec, FileClaim, LaneMessage, ProviderId, TaskSource} from './daemon-protocol.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';

/**
 * How long a claim survives without its lane renewing it. A claim is a *signal of intent*, never
 * an OS lock (spec §11) — but an un-expiring signal from a lane that died is worse than no signal
 * at all, because it blocks live lanes forever with no way to tell it is stale.
 */
const claimLeaseMs = 15 * 60_000;
/** Per-project retained board history. This is a compact coordination journal, not an audit log. */
export const coordinationEventLimit = 500;

const coordinationEventKinds: readonly CoordinationEventKind[] = [
  'task.created', 'task.assigned', 'task.status_changed', 'task.dependencies_changed', 'master_brief.set', 'claim.declared', 'claim.observed', 'claim.conflicted',
  'claim.released', 'decision.recorded', 'handoff.requested', 'handoff.accepted', 'message.sent'
];
const claimReleaseReasons: readonly ClaimReleaseReason[] = ['released', 'observed_cleared', 'session_ended', 'lease_expired'];
const providers: readonly ProviderId[] = ['claude', 'codex', 'gemini', 'qwen', 'glm', 'nvidia'];
const taskSources: readonly TaskSource[] = ['manual', 'spec', 'planner'];
const taskTitleLimit = 240;
const taskDescriptionLimit = 12_000;
const taskRoleLimit = 100;
const taskDependencyLimit = 100;
const masterBriefLimit = 20_000;
const designTextLimit = 4_000;
const designPathLimit = 240;
const designPathCountLimit = 100;

export type TaskDraft = {
  title: string;
  description?: string;
  role?: string;
  provider?: ProviderId;
  source?: TaskSource;
  sessionId?: string;
  designHandoff?: DesignHandoffSpec;
  dependsOn?: string[];
};

export type TaskAssignment = Pick<TaskDraft, 'sessionId' | 'provider' | 'role'>;

function stableEventOrder(left: CoordinationEvent, right: CoordinationEvent) {
  return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
}

function compactSessionIds(ids: readonly (string | undefined)[]) {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

function validTaskStatus(value: unknown): value is 'todo' | 'active' | 'done' {
  return value === 'todo' || value === 'active' || value === 'done';
}

function validProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (providers as readonly string[]).includes(value);
}

function validTaskSource(value: unknown): value is TaskSource {
  return typeof value === 'string' && (taskSources as readonly string[]).includes(value);
}

function cleanText(value: unknown, limit: number) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, limit) : undefined;
}

/** Repository-relative reference only; a design handoff may describe a file, never reach outside
 * the project or smuggle a platform-dependent absolute path into a future lane's brief. */
function cleanRepositoryPath(value: unknown) {
  const text = cleanText(value, designPathLimit)?.replaceAll('\\', '/');
  if (!text || text.startsWith('/') || text === '..' || text.startsWith('../') || text.includes('/../')) return undefined;
  return text.replace(/^\.\//, '');
}

function cleanPreviewUrl(value: unknown) {
  const text = cleanText(value, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function cleanedDesignHandoff(value: unknown): DesignHandoffSpec | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const sourceRef = cleanRepositoryPath(raw.sourceRef);
  const componentSpec = cleanText(raw.componentSpec, designTextLimit);
  const tokenSpec = cleanText(raw.tokenSpec, designTextLimit);
  const previewUrl = cleanPreviewUrl(raw.previewUrl);
  const implementationPaths = Array.isArray(raw.implementationPaths)
    ? [...new Set(raw.implementationPaths.map(cleanRepositoryPath).filter((path): path is string => Boolean(path)))].slice(0, designPathCountLimit)
    : [];
  if (!sourceRef && !componentSpec && !tokenSpec && !previewUrl && implementationPaths.length === 0) return undefined;
  return {
    ...(sourceRef ? {sourceRef} : {}),
    ...(componentSpec ? {componentSpec} : {}),
    ...(tokenSpec ? {tokenSpec} : {}),
    ...(previewUrl ? {previewUrl} : {}),
    ...(implementationPaths.length > 0 ? {implementationPaths} : {})
  };
}

/** The restore path may salvage the valid portion of an old or corrupted record. New RPC input is
 * stricter: silently dropping a source, preview, or path a user thought they handed to a builder
 * would be both surprising and unsafe. */
function validateNewDesignHandoff(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  const sourceRequested = cleanText(raw.sourceRef, designPathLimit);
  if (sourceRequested && !cleanRepositoryPath(raw.sourceRef)) throw new Error('Design source mapping must be a repository-relative path');
  const previewRequested = cleanText(raw.previewUrl, 2_000);
  if (previewRequested && !cleanPreviewUrl(raw.previewUrl)) throw new Error('Design preview must be a credential-free loopback http(s) URL');
  if (raw.implementationPaths !== undefined) {
    if (!Array.isArray(raw.implementationPaths) || raw.implementationPaths.some(path => !cleanRepositoryPath(path))) {
      throw new Error('Design implementation paths must be repository-relative');
    }
  }
}

/** Backward-compatible restore for the original bare `{title, status, sessionId}` board cards. */
function restoredTask(value: unknown): CoordinationTask | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 200);
  const title = cleanText(raw.title, taskTitleLimit);
  const createdAt = typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : undefined;
  if (!id || !title || !createdAt || !validTaskStatus(raw.status)) return undefined;
  const task: CoordinationTask = {id, title, status: raw.status, createdAt};
  const description = cleanText(raw.description, taskDescriptionLimit);
  const role = cleanText(raw.role, taskRoleLimit);
  const designHandoff = cleanedDesignHandoff(raw.designHandoff);
  const dependsOn = Array.isArray(raw.dependsOn)
    ? [...new Set(raw.dependsOn.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, taskDependencyLimit)
    : [];
  if (typeof raw.sessionId === 'string' && raw.sessionId) task.sessionId = raw.sessionId;
  if (description) task.description = description;
  if (designHandoff) task.designHandoff = designHandoff;
  if (dependsOn.length > 0) task.dependsOn = dependsOn;
  if (role) task.role = role;
  if (validProvider(raw.provider)) task.provider = raw.provider;
  if (validTaskSource(raw.source)) task.source = raw.source;
  if (typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))) task.updatedAt = raw.updatedAt;
  return task;
}

function pathExists(edges: ReadonlyMap<string, readonly string[]>, from: string, target: string, visited = new Set<string>()): boolean {
  if (from === target) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  return (edges.get(from) ?? []).some(next => pathExists(edges, next, target, visited));
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Restore never lets one malformed task graph make a whole board unavailable. References to
 * vanished tasks, self-dependencies, and the final edge in each detected cycle are discarded. */
function restoredDependencies(tasks: readonly CoordinationTask[]) {
  const ids = new Set(tasks.map(task => task.id));
  const edges = new Map<string, readonly string[]>();
  return tasks.map(task => {
    const safe: string[] = [];
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency) || dependency === task.id || safe.includes(dependency)) continue;
      if (pathExists(edges, dependency, task.id)) continue;
      safe.push(dependency);
    }
    edges.set(task.id, safe);
    return {...task, ...(safe.length > 0 ? {dependsOn: safe} : {dependsOn: undefined})};
  }).map(task => {
    if (!task.dependsOn?.length) delete task.dependsOn;
    return task;
  });
}

function validConflict(value: unknown): value is ClaimConflict {
  if (!value || typeof value !== 'object') return false;
  const conflict = value as Record<string, unknown>;
  return typeof conflict.path === 'string'
    && typeof conflict.claimedPath === 'string'
    && typeof conflict.sessionId === 'string'
    && (conflict.overlap === 'same' || conflict.overlap === 'contains' || conflict.overlap === 'contained');
}

/** One malformed persisted event must never prevent the rest of a project board from restoring. */
function restoredEvent(value: unknown): CoordinationEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return undefined;
  if (typeof raw.kind !== 'string' || !(coordinationEventKinds as readonly string[]).includes(raw.kind)) return undefined;
  if (!Array.isArray(raw.sessionIds) || raw.sessionIds.some(id => typeof id !== 'string')) return undefined;
  const event: CoordinationEvent = {id: raw.id, at: raw.at, kind: raw.kind as CoordinationEventKind, sessionIds: compactSessionIds(raw.sessionIds as string[])};
  if (typeof raw.actorSessionId === 'string') event.actorSessionId = raw.actorSessionId;
  if (typeof raw.taskId === 'string') event.taskId = raw.taskId;
  if (Array.isArray(raw.dependsOn) && raw.dependsOn.every(id => typeof id === 'string')) event.dependsOn = [...new Set(raw.dependsOn as string[])];
  if (typeof raw.claimId === 'string') event.claimId = raw.claimId;
  if (typeof raw.path === 'string') event.path = raw.path;
  if (raw.claimOrigin === 'declared' || raw.claimOrigin === 'observed') event.claimOrigin = raw.claimOrigin;
  if (validTaskStatus(raw.fromStatus)) event.fromStatus = raw.fromStatus;
  if (validTaskStatus(raw.toStatus)) event.toStatus = raw.toStatus;
  if (typeof raw.releaseReason === 'string' && (claimReleaseReasons as readonly string[]).includes(raw.releaseReason)) event.releaseReason = raw.releaseReason as ClaimReleaseReason;
  if (typeof raw.decisionId === 'string') event.decisionId = raw.decisionId;
  if (typeof raw.handoffId === 'string') event.handoffId = raw.handoffId;
  if (typeof raw.messageId === 'string') event.messageId = raw.messageId;
  if (validProvider(raw.provider)) event.provider = raw.provider;
  if (typeof raw.role === 'string') event.role = raw.role;
  if (Array.isArray(raw.conflicts) && raw.conflicts.every(validConflict)) event.conflicts = raw.conflicts;

  switch (event.kind) {
    case 'task.created': case 'task.assigned': return event.taskId ? event : undefined;
    case 'task.dependencies_changed': return event.taskId && event.dependsOn ? event : undefined;
    case 'task.status_changed': return event.taskId && event.fromStatus && event.toStatus ? event : undefined;
    case 'master_brief.set': return event;
    case 'claim.declared': case 'claim.observed': return event.claimId && event.path && event.claimOrigin ? event : undefined;
    case 'claim.conflicted': return event.path && event.conflicts?.length ? event : undefined;
    case 'claim.released': return event.claimId && event.path && event.releaseReason ? event : undefined;
    case 'decision.recorded': return event.decisionId ? event : undefined;
    case 'handoff.requested': case 'handoff.accepted': return event.handoffId ? event : undefined;
    case 'message.sent': return event.messageId ? event : undefined;
  }
}

function eventFingerprint(event: CoordinationEvent) {
  return JSON.stringify([
    event.id, event.at, event.kind, event.actorSessionId, event.sessionIds, event.taskId, event.claimId,
    event.path, event.claimOrigin, event.fromStatus, event.toStatus, event.releaseReason, event.dependsOn, event.decisionId,
    event.handoffId, event.messageId, event.provider, event.role,
    event.conflicts?.map(conflict => [conflict.path, conflict.claimedPath, conflict.sessionId, conflict.overlap])
  ]);
}

/** Compare normalized fields rather than object property order, so a valid journal does not get
 * rewritten on every daemon start merely because it was reconstructed into a new object. */
function eventsNeedMigration(original: unknown, normalized: readonly CoordinationEvent[]) {
  if (!Array.isArray(original) || original.length !== normalized.length) return true;
  return original.some((event, index) => {
    const restored = restoredEvent(event);
    return !restored || eventFingerprint(restored) !== eventFingerprint(normalized[index]!);
  });
}

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
      const parsed = await readPrivateJson<CoordinationState[]>(this.stateFile);
      if (!parsed) return;
      let migrated = false;
      for (const state of parsed) {
        const originalTasks = state.tasks;
        state.tasks = (Array.isArray(originalTasks) ? originalTasks : [])
          .map(restoredTask)
          .filter((task): task is CoordinationTask => task !== undefined);
        state.tasks = restoredDependencies(state.tasks);
        if (!Array.isArray(originalTasks) || originalTasks.length !== state.tasks.length
          || originalTasks.some((task, index) => JSON.stringify(task) !== JSON.stringify(state.tasks[index]))) migrated = true;
        const originalBrief = state.masterBrief;
        const brief = cleanText(originalBrief, masterBriefLimit);
        if (brief) state.masterBrief = brief;
        else delete state.masterBrief;
        if (state.masterBrief !== originalBrief) migrated = true;
        if (state.masterBrief) {
          if (typeof state.masterBriefUpdatedAt !== 'string' || !Number.isFinite(Date.parse(state.masterBriefUpdatedAt))) {
            state.masterBriefUpdatedAt = new Date().toISOString();
            migrated = true;
          }
        } else if (state.masterBriefUpdatedAt !== undefined) {
          delete state.masterBriefUpdatedAt;
          migrated = true;
        }
        // Claims written before leases existed carry no expiry. Give them one starting now rather
        // than dropping them: a restored claim from a lane that is still running gets renewed on
        // the next heartbeat, and one from a lane that is gone expires on its own.
        const originalClaims = state.claims;
        state.claims = (Array.isArray(originalClaims) ? originalClaims : []).map(claim => ({
          ...claim,
          id: claim.id ?? randomUUID(),
          origin: claim.origin ?? 'declared',
          renewedAt: claim.renewedAt ?? claim.createdAt,
          expiresAt: claim.expiresAt ?? new Date(Date.now() + claimLeaseMs).toISOString()
        }));
        if (!Array.isArray(originalClaims) || state.claims.some((claim, index) => claim.id !== originalClaims[index]?.id || claim.origin !== originalClaims[index]?.origin || claim.renewedAt !== originalClaims[index]?.renewedAt || claim.expiresAt !== originalClaims[index]?.expiresAt)) migrated = true;
        const originalMessages = state.messages;
        state.messages = Array.isArray(originalMessages) ? originalMessages : [];
        if (!Array.isArray(originalMessages)) migrated = true;
        const originalEvents = state.events;
        state.events = (Array.isArray(originalEvents) ? originalEvents : [])
          .map(restoredEvent)
          .filter((event): event is CoordinationEvent => event !== undefined)
          .sort(stableEventOrder)
          .slice(-coordinationEventLimit);
        if (eventsNeedMigration(originalEvents, state.events)) migrated = true;
        const originalProject = state.project;
        state.project = this.canonicalProject(state.project);
        if (state.project !== originalProject) migrated = true;
        this.states.set(state.project, state);
      }
      // Stable claim IDs are a relationship key, not an in-memory convenience. Persist each
      // compatibility migration before the daemon can restart and generate a different identity.
      if (migrated) await this.persist();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(project: string) {
    return this.ensure(project);
  }

  async setMasterBrief(project: string, brief: string, actorSessionId?: string) {
    const state = this.ensure(project);
    const nextBrief = cleanText(brief, masterBriefLimit);
    if (state.masterBrief === nextBrief) return state;
    if (nextBrief) {
      state.masterBrief = nextBrief;
      state.masterBriefUpdatedAt = new Date().toISOString();
    } else {
      delete state.masterBrief;
      delete state.masterBriefUpdatedAt;
    }
    this.record(state, {kind: 'master_brief.set', actorSessionId, sessionIds: []});
    await this.persist();
    return state;
  }

  async task(project: string, draft: TaskDraft, actorSessionId?: string) {
    const state = this.ensure(project);
    const title = cleanText(draft.title, taskTitleLimit);
    if (!title) throw new Error('A task needs a title');
    const description = cleanText(draft.description, taskDescriptionLimit);
    const role = cleanText(draft.role, taskRoleLimit);
    const sessionId = cleanText(draft.sessionId, 200);
    const dependsOn = this.resolveDependencies(state, draft.dependsOn);
    if (sessionId) this.assertDependenciesComplete(state, dependsOn);
    validateNewDesignHandoff(draft.designHandoff);
    const designHandoff = cleanedDesignHandoff(draft.designHandoff);
    const createdAt = new Date().toISOString();
    const task: CoordinationTask = {
      id: randomUUID(), title, status: sessionId ? 'active' : 'todo', sessionId, createdAt,
      description, role, ...(dependsOn.length > 0 ? {dependsOn} : {}), ...(designHandoff ? {designHandoff} : {}), provider: validProvider(draft.provider) ? draft.provider : undefined,
      source: validTaskSource(draft.source) ? draft.source : 'manual'
    };
    state.tasks.unshift(task);
    this.record(state, {
      kind: 'task.created', actorSessionId, sessionIds: compactSessionIds([sessionId]), taskId: task.id,
      provider: task.provider, role: task.role
    });
    await this.persist();
    return state;
  }

  async assignTask(project: string, taskId: string, assignment: TaskAssignment, actorSessionId?: string) {
    const state = this.ensure(project);
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('Coordination task not found');
    // Assignment fields are independently optional: choosing an existing lane must not erase the
    // ticket's already declared provider or role merely because this particular action omitted it.
    const sessionId = assignment.sessionId === undefined ? task.sessionId : cleanText(assignment.sessionId, 200);
    const role = assignment.role === undefined ? task.role : cleanText(assignment.role, taskRoleLimit);
    const provider = assignment.provider === undefined ? task.provider : validProvider(assignment.provider) ? assignment.provider : undefined;
    if (sessionId) this.assertDependenciesComplete(state, task.dependsOn ?? []);
    const changed = task.sessionId !== sessionId || task.provider !== provider || task.role !== role;
    if (!changed) return state;
    task.sessionId = sessionId;
    task.provider = provider;
    task.role = role;
    if (sessionId && task.status === 'todo') task.status = 'active';
    task.updatedAt = new Date().toISOString();
    this.record(state, {
      kind: 'task.assigned', actorSessionId, sessionIds: compactSessionIds([sessionId]), taskId: task.id,
      provider: task.provider, role: task.role
    });
    await this.persist();
    return state;
  }

  async updateTask(project: string, taskId: string, status: 'todo' | 'active' | 'done', sessionId?: string, actorSessionId?: string) {
    const state = this.ensure(project);
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('Coordination task not found');
    const fromStatus = task.status;
    const nextSessionId = sessionId ?? task.sessionId;
    if (status !== 'todo') this.assertDependenciesComplete(state, task.dependsOn ?? []);
    if (fromStatus === status && task.sessionId === nextSessionId) return state;
    task.status = status;
    task.sessionId = nextSessionId;
    task.updatedAt = new Date().toISOString();
    this.record(state, {
      kind: 'task.status_changed', actorSessionId, sessionIds: compactSessionIds([task.sessionId]),
      taskId: task.id, fromStatus, toStatus: status
    });
    await this.persist();
    return state;
  }

  /** Replaces a task's dependency set as one visible, cycle-checked board operation. */
  async setDependencies(project: string, taskId: string, dependencyIds: readonly string[], actorSessionId?: string) {
    const state = this.ensure(project);
    const task = this.resolveTask(state, taskId);
    if (task.status !== 'todo') throw new Error('Reopen this task before changing its dependencies');
    const dependsOn = this.resolveDependencies(state, dependencyIds);
    if (dependsOn.includes(task.id)) throw new Error('A task cannot depend on itself');
    const previous = task.dependsOn;
    if (sameIds(previous ?? [], dependsOn)) return state;
    task.dependsOn = dependsOn.length > 0 ? dependsOn : undefined;
    if (this.hasCycle(state)) {
      task.dependsOn = previous;
      throw new Error('Task dependencies cannot contain a cycle');
    }
    task.updatedAt = new Date().toISOString();
    this.record(state, {kind: 'task.dependencies_changed', actorSessionId, sessionIds: [], taskId: task.id, dependsOn});
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
      if (existing) {
        const promoteToDeclared = existing.origin === 'observed' && origin === 'declared';
        Object.assign(existing, lease, {origin: promoteToDeclared ? 'declared' : existing.origin});
        if (promoteToDeclared) this.record(state, {
          kind: 'claim.declared', actorSessionId: sessionId, sessionIds: [sessionId],
          claimId: existing.id, path: existing.path, claimOrigin: existing.origin
        });
      } else {
        const claim: FileClaim = {id: randomUUID(), path: claimPath, sessionId, origin, createdAt: now.toISOString(), ...lease};
        state.claims.push(claim);
        this.record(state, {
          kind: origin === 'declared' ? 'claim.declared' : 'claim.observed', actorSessionId: sessionId,
          sessionIds: [sessionId], claimId: claim.id, path: claim.path, claimOrigin: claim.origin
        });
      }
    } else {
      this.record(state, {
        kind: 'claim.conflicted', actorSessionId: sessionId,
        sessionIds: compactSessionIds([sessionId, ...conflicts.map(conflict => conflict.sessionId)]),
        path: claimPath, claimOrigin: origin, conflicts
      });
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
    const previouslyObserved = new Map(state.claims
      .filter(claim => claim.sessionId === sessionId && claim.origin === 'observed')
      .map(claim => [claim.path, claim]));
    const observed: FileClaim[] = [...normalized]
      .filter(path => !declaredPaths.has(path))
      .map(path => {
        const previous = previouslyObserved.get(path);
        return {id: previous?.id ?? randomUUID(), path, sessionId, origin: 'observed' as const, createdAt: previous?.createdAt ?? now.toISOString(), ...lease};
      });

    state.claims = [...others, ...mineDeclared, ...observed];
    for (const claim of observed) {
      if (previouslyObserved.has(claim.path)) continue;
      this.record(state, {
        kind: 'claim.observed', actorSessionId: sessionId, sessionIds: [sessionId],
        claimId: claim.id, path: claim.path, claimOrigin: claim.origin
      });
    }
    for (const claim of previouslyObserved.values()) {
      if (normalized.has(claim.path) && !declaredPaths.has(claim.path)) continue;
      this.record(state, {
        kind: 'claim.released', sessionIds: [sessionId], claimId: claim.id, path: claim.path,
        releaseReason: 'observed_cleared'
      });
    }

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

  async releaseClaim(project: string, path: string, sessionId: string, actorSessionId?: string) {
    const state = this.ensure(project);
    const claimPath = normalizeClaimPath(path);
    const released = state.claims.filter(claim => claim.path === claimPath && claim.sessionId === sessionId);
    state.claims = state.claims.filter(claim => !(claim.path === claimPath && claim.sessionId === sessionId));
    if (released.length === 0) throw new Error('File claim not found for this agent');
    for (const claim of released) this.record(state, {
      kind: 'claim.released', actorSessionId, sessionIds: [sessionId], claimId: claim.id, path: claim.path, releaseReason: 'released'
    });
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
        this.record(state, {
          kind: 'claim.released', sessionIds: [claim.sessionId], claimId: claim.id, path: claim.path,
          releaseReason: 'lease_expired'
        });
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
      const released = state.claims.filter(claim => claim.sessionId === sessionId);
      state.claims = state.claims.filter(claim => claim.sessionId !== sessionId);
      for (const claim of released) this.record(state, {
        kind: 'claim.released', sessionIds: [sessionId], claimId: claim.id, path: claim.path,
        releaseReason: 'session_ended'
      });
      if (released.length > 0) changed = true;
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
    this.record(state, {kind: 'message.sent', actorSessionId: from, sessionIds: compactSessionIds([from, to]), messageId: message.id});
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

  async decision(project: string, summary: string, sessionId?: string, actorSessionId?: string) {
    const state = this.ensure(project);
    const decision = {id: randomUUID(), summary, sessionId, createdAt: new Date().toISOString()};
    state.decisions.unshift(decision);
    this.record(state, {kind: 'decision.recorded', actorSessionId, sessionIds: compactSessionIds([sessionId]), decisionId: decision.id});
    await this.persist();
    return state;
  }

  async handoff(project: string, fromSessionId: string, toSessionId: string, summary: string, actorSessionId?: string) {
    const state = this.ensure(project);
    const handoff = {id: randomUUID(), fromSessionId, toSessionId, summary, createdAt: new Date().toISOString(), status: 'open' as const};
    state.handoffs.unshift(handoff);
    this.record(state, {
      kind: 'handoff.requested', actorSessionId, sessionIds: compactSessionIds([fromSessionId, toSessionId]), handoffId: handoff.id
    });
    await this.persist();
    return state;
  }

  async acceptHandoff(project: string, handoffId: string) {
    const state = this.ensure(project);
    const handoff = state.handoffs.find(item => item.id === handoffId);
    if (!handoff) throw new Error('Coordination handoff not found');
    if (handoff.status === 'accepted') return state;
    handoff.status = 'accepted';
    this.record(state, {
      kind: 'handoff.accepted', sessionIds: compactSessionIds([handoff.fromSessionId, handoff.toSessionId]), handoffId: handoff.id
    });
    await this.persist();
    return state;
  }

  private ensure(project: string) {
    const canonicalProject = this.canonicalProject(project);
    let state = this.states.get(canonicalProject);
    if (!state) {
      state = {project: canonicalProject, tasks: [], claims: [], decisions: [], handoffs: [], messages: [], events: []};
      this.states.set(canonicalProject, state);
    }
    return state;
  }

  private resolveTask(state: CoordinationState, id: string) {
    const reference = cleanText(id, 200);
    if (!reference) throw new Error('Name the task whose dependencies should change');
    const matches = state.tasks.filter(task => task.id === reference || task.id.startsWith(reference));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`No task matches dependency id ${reference}`);
    throw new Error(`Dependency id ${reference} is ambiguous; use more of the task id`);
  }

  private resolveDependencies(state: CoordinationState, input: unknown): string[] {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > taskDependencyLimit) throw new Error(`A task may depend on at most ${taskDependencyLimit} other tasks`);
    const dependencies: string[] = [];
    for (const dependency of input) {
      if (typeof dependency !== 'string') throw new Error('Task dependencies must be task ids');
      const task = this.resolveTask(state, dependency);
      if (!dependencies.includes(task.id)) dependencies.push(task.id);
    }
    return dependencies;
  }

  private assertDependenciesComplete(state: CoordinationState, dependencyIds: readonly string[]) {
    const pending = dependencyIds
      .map(id => state.tasks.find(task => task.id === id))
      .filter(task => !task || task.status !== 'done');
    if (pending.length === 0) return;
    const labels = pending.map(task => task ? `${task.id.slice(0, 8)} (${task.title})` : 'missing task').join(', ');
    throw new Error(`Task is blocked by unfinished dependencies: ${labels}`);
  }

  private hasCycle(state: CoordinationState) {
    const edges = new Map(state.tasks.map(task => [task.id, task.dependsOn ?? []] as const));
    return state.tasks.some(task => (task.dependsOn ?? []).some(dependency => pathExists(edges, dependency, task.id)));
  }

  /** `/var` and `/private/var` name the same macOS worktree. State must not fork by spelling. */
  private canonicalProject(project: string) { return canonicalProjectPath(project); }

  private record(state: CoordinationState, event: Omit<CoordinationEvent, 'id' | 'at'>) {
    state.events.push({id: randomUUID(), at: new Date().toISOString(), ...event, sessionIds: compactSessionIds(event.sessionIds)});
    state.events.sort(stableEventOrder);
    if (state.events.length > coordinationEventLimit) state.events.splice(0, state.events.length - coordinationEventLimit);
  }

  private async persist() {
    const run = this.queue.then(async () => {
      await writePrivateJson(this.stateFile, [...this.states.values()]);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Keep project-key comparisons consistent between the durable coordination store and RPC guards. */
export function canonicalProjectPath(project: string) {
  try { return realpathSync.native(project); } catch { return project; }
}
