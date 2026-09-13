import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readPrivateFile, writePrivateFile, writePrivateJson, appendPrivateLine} from '../security/secure-state.js';
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
  private clockEpochId: string = randomUUID();
  private queue: Promise<void> = Promise.resolve();

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
      for (const line of log.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as RunEvent;
          if (event.schemaVersion !== 1 || !event.runId || !event.sequence) continue;
          if (this.eventsFor(event.runId).some(existing => existing.sequence === event.sequence)) continue;
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
    await this.persistSnapshot();
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
    await this.persistSnapshot();
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
    await this.persistSnapshot();
    this.emit('event', event);
    return event;
  }

  async dispatchConfirmed(runId: string, metadata: Record<string, unknown> = {}) {
    const run = this.get(runId);
    const event = await this.append(run, 'prompt.dispatch_confirmed', metadata, {adapter: run.adapter.id});
    run.delivery = 'confirmed';
    run.updatedAt = event.atWall;
    await this.persistSnapshot();
    this.emit('event', event);
    return event;
  }

  async deliveryUnknown(runId: string, reason: string) {
    const run = this.get(runId);
    if (run.delivery === 'unknown') return undefined;
    const event = await this.append(run, 'run.delivery_unknown', {reason}, {adapter: run.adapter.id});
    run.delivery = 'unknown';
    run.updatedAt = event.atWall;
    await this.persistSnapshot();
    this.emit('event', event);
    return event;
  }

  async record(runId: string, type: Exclude<RunEventType, 'run.state_changed' | 'prompt.dispatch_intended' | 'prompt.dispatch_confirmed' | 'run.delivery_unknown'>, payload: Record<string, unknown> = {}, source: RunEvent['source'] = {adapter: 'fluentd'}) {
    const run = this.get(runId);
    const event = await this.append(run, type, payload, source);
    run.updatedAt = event.atWall;
    if (type === 'provider.first_event') this.applyTiming(run, 'provider.first_event', {atMonoMs: event.atMonoMs, atWall: event.atWall, available: true});
    await this.persistSnapshot();
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

  async compact(maxEventsPerRun = 1_000) {
    for (const [runId, events] of this.events) {
      if (events.length <= maxEventsPerRun) continue;
      const kept = events.slice(-maxEventsPerRun);
      this.events.set(runId, kept);
      this.compactionFloor.set(runId, kept[0]!.sequence - 1);
    }
    await this.persistSnapshot();
    const retained = [...this.events.values()].flat().sort((a, b) => a.atWall.localeCompare(b.atWall) || a.sequence - b.sequence);
    await writePrivateFile(this.eventLogFile, retained.map(event => JSON.stringify(event)).join('\n') + (retained.length ? '\n' : ''));
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
    const events = this.eventsFor(run.id);
    const event: RunEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      runId: run.id,
      sequence: (events.at(-1)?.sequence ?? this.compactionFloor.get(run.id) ?? 0) + 1,
      clockEpochId: this.clockEpochId,
      atMonoMs: Math.round(performance.now()),
      atWall: new Date().toISOString(),
      type,
      payload: redactPayload(payload),
      source
    };
    await this.serial(() => appendPrivateLine(this.eventLogFile, JSON.stringify(event)));
    events.push(event);
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

  private async persistSnapshot() {
    const snapshot: Snapshot = {
      schemaVersion: 1,
      clockEpochId: this.clockEpochId,
      runs: [...this.runs.values()],
      events: [...this.events.values()].flat(),
      compactionFloor: Object.fromEntries(this.compactionFloor)
    };
    await this.serial(() => writePrivateJson(this.snapshotFile, snapshot));
  }

  private async serial(operation: () => Promise<void>) {
    const queued = this.queue.then(operation);
    this.queue = queued.catch(() => undefined);
    await queued;
  }
}
