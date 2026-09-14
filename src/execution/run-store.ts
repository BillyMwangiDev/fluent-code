import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readPrivateFile, writePrivateFile, appendPrivateLine} from '../security/secure-state.js';
import {redactPayload, type RedactedPayload} from '../perf/redaction.js';
import {assertTransition, type CapabilitySet, type DeliveryState, type Run, type RunEvent, type RunEventType, type RunState, type TimingValue, type WorkClass} from './types.js';
import {join, resolve} from 'node:path';
import type {ProviderId} from '../daemon-protocol.js';

type Snapshot = {
  schemaVersion: 1;
  clockEpochId: string;
  runs: Run[];
  events: RunEvent[];
  compactionFloor: Record<string, number>;
};

export type EventPage = {events: RunEvent[]; floor: number; resyncRequired: boolean};

const defaultCapabilities: CapabilitySet = {structuredEvents: 'unavailable', providerFirstEvent: 'unavailable'};
const snapshotDelayMs = 1_000;

/**
 * Durable, append-before-publish run state. The snapshot makes ordinary restore cheap; JSONL is
 * the recovery journal for the small interval between appending a transition and writing that
 * snapshot. Terminal bytes deliberately never enter this store.
 */
export class RunStore extends EventEmitter {
  private readonly snapshotFile: string;
  private readonly eventLogFile: string;
  private readonly runs = new Map<string, Run>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly compactionFloor = new Map<string, number>();
  private readonly lastSequence = new Map<string, number>();
  private clockEpochId: string = randomUUID();
  private queue: Promise<void> = Promise.resolve();
  private snapshotTimer?: NodeJS.Timeout;

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    super();
    const directory = resolve(stateDirectory, 'execution');
    this.snapshotFile = join(directory, 'runs.snapshot.json');
    this.eventLogFile = join(directory, 'runs.events.jsonl');
  }

  async restore() {
    const snapshot = await (async () => {
      try {
        const raw = await readPrivateFile(this.snapshotFile);
        return raw ? JSON.parse(raw) as Snapshot : undefined;
      } catch (error) {
        throw new Error(`Could not restore durable run state: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    if (snapshot?.schemaVersion === 1) {
      this.clockEpochId = snapshot.clockEpochId || this.clockEpochId;
      for (const run of snapshot.runs) this.runs.set(run.id, run);
      for (const event of snapshot.events) this.eventsFor(event.runId).push(event);
      for (const [runId, floor] of Object.entries(snapshot.compactionFloor)) this.compactionFloor.set(runId, floor);
    }

    const log = await readPrivateFile(this.eventLogFile);
    if (log) {
      // A set rather than a scan per line: the journal holds every retained event of every run.
      const seen = new Set([...this.events.values()].flat().map(event => `${event.runId}:${event.sequence}`));
      for (const line of log.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as RunEvent;
          if (event.schemaVersion !== 1 || !event.runId || !event.sequence) continue;
          if (seen.has(`${event.runId}:${event.sequence}`)) continue;
          seen.add(`${event.runId}:${event.sequence}`);
          this.applyRecoveredEvent(event);
        } catch {
          // A torn final JSONL write was never fsync-complete and must not become a phantom event.
        }
      }
    }
    // Monotonic times cannot be compared over a restart. Keep the old epoch on recovered events,
    // then begin a new one for newly observed events.
    this.clockEpochId = randomUUID();
    for (const run of this.runs.values()) {
      if (run.delivery === 'intended') await this.deliveryUnknown(run.id, 'daemon restarted before a provider acknowledgement');
    }
    await this.compact();
  }

  list() { return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  has(runId: string) { return this.runs.has(runId); }

  get(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  eventsSince(runId: string, afterSequence?: number): EventPage {
    this.get(runId);
    const events = this.eventsFor(runId);
    const floor = this.compactionFloor.get(runId) ?? 0;
    const cursor = afterSequence ?? floor;
    return {floor, resyncRequired: cursor < floor, events: cursor < floor ? [] : events.filter(event => event.sequence > cursor)};
  }

  async create(input: {id?: string; taskId?: string; origin?: Run['origin']; attempt?: number; provider: ProviderId; accountId?: string; mode?: Run['mode']; class?: WorkClass; adapter?: Run['adapter']; workspace?: Run['workspace']}) {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    if (this.runs.has(id)) return this.get(id);
    const run: Run = {
      schemaVersion: 1,
      id,
      taskId: input.taskId,
      origin: input.origin ?? 'ad_hoc',
      attempt: input.attempt ?? 1,
      provider: input.provider,
      accountId: input.accountId,
      mode: input.mode ?? 'interactive',
      class: input.class ?? 'feature',
      state: 'queued',
      delivery: 'idle',
      adapter: input.adapter ?? {id: 'pty', version: '1', capabilities: defaultCapabilities},
      workspace: input.workspace,
      timing: {},
      createdAt: now,
      updatedAt: now
    };
    this.runs.set(id, run);
    await this.persistSnapshot();
    return run;
  }

  async transition(runId: string, to: RunState, reason: string, source: RunEvent['source'] = {adapter: 'fluentd'}) {
    const run = this.get(runId);
    assertTransition(run.state, to);
    const event = await this.append(run, 'run.state_changed', {from: run.state, to, reason}, source);
    run.state = to;
    run.updatedAt = event.atWall;
    this.applyTiming(run, `run.${to}`, {atMonoMs: event.atMonoMs, atWall: event.atWall, available: true});
    this.scheduleSnapshot();
    this.emit('event', event);
    return run;
  }

  async ready(runId: string, source: RunEvent['source'] = {adapter: 'fluentd'}) {
    const run = this.get(runId);
    if (run.state === 'preparing') await this.transition(runId, 'ready', 'workspace and adapter ready', source);
    const event = await this.record(runId, 'run.ready', {workspace: run.workspace?.path, adapter: run.adapter.id}, source);
    return event;
  }

  async dispatchIntent(runId: string, metadata: Record<string, unknown> = {}) {
    const run = this.get(runId);
    const event = await this.append(run, 'prompt.dispatch_intended', metadata, {adapter: run.adapter.id});
    run.delivery = 'intended';
    run.updatedAt = event.atWall;
    this.applyTiming(run, 'prompt.dispatch_intended', {atMonoMs: event.atMonoMs, atWall: event.atWall, available: true});
    this.scheduleSnapshot();
    this.emit('event', event);
    return event;
  }

  async dispatchConfirmed(runId: string, metadata: Record<string, unknown> = {}) {
    const run = this.get(runId);
    const event = await this.append(run, 'prompt.dispatch_confirmed', metadata, {adapter: run.adapter.id});
    run.delivery = 'confirmed';
    run.updatedAt = event.atWall;
    this.scheduleSnapshot();
    this.emit('event', event);
    return event;
  }

  async deliveryUnknown(runId: string, reason: string) {
    const run = this.get(runId);
    if (run.delivery === 'unknown') return undefined;
    const event = await this.append(run, 'run.delivery_unknown', {reason}, {adapter: run.adapter.id});
    run.delivery = 'unknown';
    run.updatedAt = event.atWall;
    this.scheduleSnapshot();
    this.emit('event', event);
    return event;
  }

  async record(runId: string, type: Exclude<RunEventType, 'run.state_changed' | 'prompt.dispatch_intended' | 'prompt.dispatch_confirmed' | 'run.delivery_unknown'>, payload: Record<string, unknown> = {}, source: RunEvent['source'] = {adapter: 'fluentd'}) {
    const run = this.get(runId);
    const event = await this.append(run, type, payload, source);
    run.updatedAt = event.atWall;
    if (type === 'provider.first_event') this.applyTiming(run, 'provider.first_event', {atMonoMs: event.atMonoMs, atWall: event.atWall, available: true});
    this.scheduleSnapshot();
    this.emit('event', event);
    return event;
  }

  async markTiming(runId: string, key: string, timing: TimingValue) {
    const run = this.get(runId);
    this.applyTiming(run, key, timing);
    run.updatedAt = new Date().toISOString();
    await this.persistSnapshot();
    return run;
  }

  async setWorkspace(runId: string, workspace: Run['workspace']) {
    const run = this.get(runId);
    run.workspace = workspace;
    run.updatedAt = new Date().toISOString();
    await this.persistSnapshot();
    return run;
  }

  /**
   * Bounds retained history: a live run keeps its recent events, a finished run only a short tail.
   * Runs outlive restarts and a streaming lane adds about one event a second, so without this the
   * snapshot — rewritten after every change — grows until writing it stalls the daemon again.
   */
  async compact(maxEventsPerRun = 1_000, maxFinishedRunEvents = 50) {
    for (const [runId, events] of this.events) {
      const state = this.runs.get(runId)?.state;
      const finished = state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'lost';
      const limit = Math.max(1, finished ? maxFinishedRunEvents : maxEventsPerRun);
      if (events.length <= limit) continue;
      const kept = events.slice(-limit);
      this.events.set(runId, kept);
      this.compactionFloor.set(runId, kept[0]!.sequence - 1);
    }
    await this.persistSnapshot();
    // Queued with appends, so an event journaled while this runs is neither lost nor written twice.
    await this.serial(async () => {
      const retained = [...this.events.values()].flat().sort((a, b) => a.atWall.localeCompare(b.atWall) || a.sequence - b.sequence);
      await writePrivateFile(this.eventLogFile, retained.map(event => JSON.stringify(event)).join('\n') + (retained.length ? '\n' : ''));
    });
  }

  private applyTiming(run: Run, key: string, timing: TimingValue) {
    run.timing[key] = timing;
  }

  private eventsFor(runId: string) {
    let events = this.events.get(runId);
    if (!events) {
      events = [];
      this.events.set(runId, events);
    }
    return events;
  }

  private async append(run: Run, type: RunEventType, payload: Record<string, unknown>, source: RunEvent['source']) {
    // Numbered before the write, pushed after it into whichever array holds the run's events then:
    // concurrent appends to one run each get their own sequence, and a compaction that replaced the
    // array while this write waited in the queue cannot swallow the event.
    const sequence = (this.lastSequence.get(run.id) ?? this.eventsFor(run.id).at(-1)?.sequence ?? this.compactionFloor.get(run.id) ?? 0) + 1;
    this.lastSequence.set(run.id, sequence);
    const event: RunEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      runId: run.id,
      sequence,
      clockEpochId: this.clockEpochId,
      atMonoMs: Math.round(performance.now()),
      atWall: new Date().toISOString(),
      type,
      payload: redactPayload(payload),
      source
    };
    await this.serial(() => appendPrivateLine(this.eventLogFile, JSON.stringify(event)));
    this.eventsFor(run.id).push(event);
    return event;
  }

  private applyRecoveredEvent(event: RunEvent) {
    const run = this.runs.get(event.runId);
    if (!run) return;
    this.eventsFor(event.runId).push(event);
    if (event.type === 'run.state_changed' && typeof event.payload.to === 'string') {
      run.state = event.payload.to as RunState;
      run.updatedAt = event.atWall;
    }
    if (event.type === 'prompt.dispatch_intended') run.delivery = 'intended';
    if (event.type === 'prompt.dispatch_confirmed') run.delivery = 'confirmed';
    if (event.type === 'run.delivery_unknown') run.delivery = 'unknown';
  }

  /** Writes any snapshot still waiting to be written — for a daemon about to exit. */
  async flush() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    await this.persistSnapshot();
  }

  /**
   * Journaled changes schedule a snapshot rather than writing one. The JSONL append that precedes
   * each of them is already the durable record, and restore replays it over whatever snapshot it
   * finds, so writing the whole snapshot — every run and every retained event — after each one
   * bought no durability. It did cost: with ten lanes streaming, the daemon re-serialized megabytes
   * per terminal chunk and stopped answering in time, and a newly started daemon then took it for
   * dead and replaced it, orphaning every lane it held.
   */
  private scheduleSnapshot() {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      void this.persistSnapshot().catch(error => console.error(`fluentd could not write run snapshot: ${error.message}`));
    }, snapshotDelayMs);
    this.snapshotTimer.unref();
  }

  private async persistSnapshot() {
    const snapshot: Snapshot = {
      schemaVersion: 1,
      clockEpochId: this.clockEpochId,
      runs: [...this.runs.values()],
      events: [...this.events.values()].flat(),
      compactionFloor: Object.fromEntries(this.compactionFloor)
    };
    // Compact JSON: rewritten often, read only by restore.
    await this.serial(() => writePrivateFile(this.snapshotFile, JSON.stringify(snapshot)));
  }

  private async serial(operation: () => Promise<void>) {
    const queued = this.queue.then(operation);
    this.queue = queued.catch(() => undefined);
    await queued;
  }
}
