import type {ProviderId} from '../daemon-protocol.js';
import type {RedactedPayload} from '../perf/redaction.js';

export type RunState = 'queued' | 'preparing' | 'ready' | 'running' | 'awaiting_approval' |
  'blocked' | 'verifying' | 'integrating' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
export type WorkClass = 'micro' | 'feature' | 'long' | 'race';
export type TimingValue = {atMonoMs?: number; atWall: string; available: boolean; detail?: string};
export type TimingMap = Record<string, TimingValue>;
export type CapabilitySet = Record<string, boolean | 'unavailable'>;
export type DeliveryState = 'idle' | 'intended' | 'confirmed' | 'unknown';
export type WorkspaceLease = {path: string; projectDirectory?: string; leaseId?: string; generation?: number};
/** A checkpoint records a reviewable position; it never snapshots or rewrites a working tree. */
export type CheckpointRef = {
  id: string;
  gitRef?: string;
  workingTree: 'clean' | 'dirty' | 'unknown';
  createdAt: string;
};

export type Run = {
  schemaVersion: 1;
  id: string;
  taskId?: string;
  origin: 'ad_hoc' | 'task';
  attempt: number;
  provider: ProviderId;
  accountId?: string;
  mode: 'interactive' | 'headless';
  class: WorkClass;
  state: RunState;
  delivery: DeliveryState;
  adapter: {id: string; version: string; capabilities: CapabilitySet};
  providerSession?: {threadId?: string; sessionId?: string; resumable: boolean};
  workspace?: WorkspaceLease;
  checkpoint?: CheckpointRef;
  timing: TimingMap;
  createdAt: string;
  updatedAt: string;
};

export type RunEventType = 'run.state_changed' | 'run.ready' | 'prompt.dispatch_intended' |
  'prompt.dispatch_confirmed' | 'run.delivery_unknown' | 'provider.first_event' |
  'text.delta' | 'tool.started' | 'tool.finished' | 'approval.requested' |
  'approval.resolved' | 'usage.updated' | 'checkpoint.created' |
  'verification.finished' | 'integration.finished' | 'stream.resync' |
  'run.finished' | 'run.failed';

export type RunEvent = {
  schemaVersion: 1;
  id: string;
  runId: string;
  sequence: number;
  clockEpochId: string;
  atMonoMs: number;
  atWall: string;
  type: RunEventType;
  payload: RedactedPayload;
  source: {adapter: string; providerEvent?: string};
};

const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'cancelled', 'failed', 'lost'],
  preparing: ['ready', 'blocked', 'failed', 'cancelled', 'lost'],
  ready: ['running', 'awaiting_approval', 'blocked', 'failed', 'cancelled', 'lost'],
  running: ['awaiting_approval', 'blocked', 'verifying', 'integrating', 'succeeded', 'failed', 'cancelled', 'lost'],
  awaiting_approval: ['running', 'blocked', 'failed', 'cancelled', 'lost'],
  blocked: ['ready', 'running', 'failed', 'cancelled', 'lost'],
  verifying: ['integrating', 'succeeded', 'failed', 'blocked', 'cancelled', 'lost'],
  integrating: ['succeeded', 'failed', 'blocked', 'lost'],
  succeeded: ['verifying', 'integrating'],
  failed: [],
  cancelled: [],
  lost: []
};

export function canTransition(from: RunState, to: RunState) {
  return transitions[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState) {
  if (!canTransition(from, to)) throw new Error(`Invalid run transition: ${from} → ${to}`);
}
