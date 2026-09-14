import {connect} from 'node:net';
import {randomUUID} from 'node:crypto';
import {
  daemonSocketPath,
  type CredentialChainState,
  type CredentialMode,
  type FallbackPolicy,
  type HardwareSnapshot,
  type SoftwareSnapshot,
  type UsageSnapshot,
  type ProviderHealth,
  type ProviderId,
  type RpcEvent,
  type RpcRequest,
  type RpcResponse,
  type Run,
  type RunEvent,
  type SessionSnapshot,
  type SessionDiff,
  type SessionSummary
} from './daemon-protocol.js';

/** The one-shot RPC every client here is built on, exported so the agent-facing CLI (coord-cli.ts)
 * can use it without going through the app-shaped `daemonClient` surface below. */
export async function daemonRequest<T>(method: RpcRequest['method'], params?: Record<string, unknown>): Promise<T> {
  return request<T>(method, params);
}

async function request<T>(method: RpcRequest['method'], params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemonSocketPath());
    let buffer = '';
    socket.once('error', error => reject(new Error(`fluentd unavailable: ${error.message}. Start it with pnpm daemon.`)));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const line = buffer.indexOf('\n');
      if (line < 0) return;
      const response = JSON.parse(buffer.slice(0, line)) as RpcResponse;
      socket.end();
      if (response.ok) resolve(response.result as T);
      else reject(new Error(response.error));
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({id: randomUUID(), method, ...(params ? {params} : {})})}\n`));
  });
}

/**
 * Opens a long-lived connection and streams `sessions.output`/`sessions.status` events for one
 * session. Unlike `request()`, this socket is deliberately kept open past the first reply — the
 * first line is the subscribe ack (an initial snapshot), every line after is a pushed RpcEvent.
 */
function subscribeSession(sessionId: string, handlers: {onSnapshot?: (snapshot: SessionSnapshot) => void; onOutput?: (chunk: string) => void; onStatus?: (summary: SessionSummary) => void; onError?: (error: Error) => void}) {
  const socket = connect(daemonSocketPath());
  const requestId = randomUUID();
  let buffer = '';
  let gotAck = false;

  socket.once('error', error => handlers.onError?.(new Error(`fluentd unavailable: ${error.message}. Start it with pnpm daemon.`)));
  socket.once('connect', () => socket.write(`${JSON.stringify({id: requestId, method: 'sessions.subscribe', params: {sessionId}})}\n`));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as RpcResponse | RpcEvent;
      if (!gotAck && 'id' in parsed) {
        gotAck = true;
        if (parsed.ok) handlers.onSnapshot?.(parsed.result as SessionSnapshot);
        else handlers.onError?.(new Error(parsed.error));
        continue;
      }
      const event = parsed as RpcEvent;
      if (event.event === 'sessions.output' && event.sessionId === sessionId) handlers.onOutput?.(event.chunk);
      if (event.event === 'sessions.status' && event.sessionId === sessionId) handlers.onStatus?.(event.summary);
    }
  });

  return {
    unsubscribe: () => {
      socket.write(`${JSON.stringify({id: randomUUID(), method: 'sessions.unsubscribe', params: {sessionId}})}\n`);
      socket.end();
    }
  };
}

/**
 * Resumable execution subscription. Unlike the legacy terminal stream, this is a durable cursor
 * over redacted run events; callers must treat `resync-required` as a snapshot boundary, not as
 * missing terminal text they can reconstruct.
 */
function subscribeRun(runId: string, afterSequence: number | undefined, handlers: {onSnapshot?: (snapshot: Run, events: RunEvent[]) => void; onEvent?: (event: RunEvent) => void; onResyncRequired?: (value: {from: number; snapshot: Run; terminalGap: boolean}) => void; onError?: (error: Error) => void}) {
  const socket = connect(daemonSocketPath());
  const requestId = randomUUID();
  let buffer = '';
  let gotAck = false;
  socket.once('error', error => handlers.onError?.(new Error(`fluentd unavailable: ${error.message}. Start it with pnpm daemon.`)));
  socket.once('connect', () => socket.write(`${JSON.stringify({id: requestId, method: 'runs.subscribe', params: {runId, ...(afterSequence === undefined ? {} : {afterSequence})}})}\n`));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as RpcResponse | RpcEvent;
      if (!gotAck && 'id' in parsed) {
        gotAck = true;
        if (parsed.ok) {
          const result = parsed.result as {snapshot: Run; events: RunEvent[]; resyncRequired: boolean; floor: number};
          handlers.onSnapshot?.(result.snapshot, result.events);
          if (result.resyncRequired) handlers.onResyncRequired?.({from: result.floor, snapshot: result.snapshot, terminalGap: true});
        } else handlers.onError?.(new Error(parsed.error));
        continue;
      }
      const event = parsed as RpcEvent;
      if (event.event === 'runs.event' && event.runId === runId) handlers.onEvent?.(event.data);
      if (event.event === 'runs.resync_required' && event.runId === runId) handlers.onResyncRequired?.({from: event.from, snapshot: event.snapshot, terminalGap: event.terminalGap});
    }
  });
  return {unsubscribe: () => { socket.write(`${JSON.stringify({id: randomUUID(), method: 'runs.unsubscribe', params: {runId}})}\n`); socket.end(); }};
}

/**
 * Long-lived connection for provider-wide events (currently `credential.switched` /
 * `credential.notice`) that aren't scoped to one session — used by screens like Credentials that
 * want fallback notices without subscribing to a specific session's output.
 */
function openEventStream(handlers: {onSwitched?: (event: Extract<RpcEvent, {event: 'credential.switched'}>) => void; onNotice?: (event: Extract<RpcEvent, {event: 'credential.notice'}>) => void; onError?: (error: Error) => void}) {
  const socket = connect(daemonSocketPath());
  let buffer = '';
  socket.once('error', error => handlers.onError?.(new Error(`fluentd unavailable: ${error.message}. Start it with pnpm daemon.`)));
  socket.once('connect', () => socket.write(`${JSON.stringify({id: randomUUID(), method: 'stream.open'})}\n`));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as RpcResponse | RpcEvent;
      if ('id' in parsed) continue; // the stream.open ack itself, nothing to do with it
      if (parsed.event === 'credential.switched') handlers.onSwitched?.(parsed);
      if (parsed.event === 'credential.notice') handlers.onNotice?.(parsed);
    }
  });
  return {close: () => socket.end()};
}

export const daemonClient = {
  ping: () => request<{ok: boolean; pid: number}>('ping'),
  listSessions: () => request<SessionSummary[]>('sessions.list'),
  createSession: (params: {provider: ProviderId; directory: string; task?: string; accountId?: string; isolate?: boolean}) => request<SessionSummary>('sessions.create', params),
  getSession: (sessionId: string) => request<SessionSnapshot>('sessions.get', {sessionId}),
  listRuns: () => request<Run[]>('runs.list'),
  getRun: (runId: string) => request<Run>('runs.get', {runId}),
  send: (sessionId: string, input: string) => request<{sent: boolean}>('sessions.send', {sessionId, input}),
  stop: (sessionId: string) => request<SessionSummary>('sessions.stop', {sessionId}),
  sessionDiff: (sessionId: string) => request<SessionDiff>('sessions.diff', {sessionId}),
  hardwareSnapshot: () => request<HardwareSnapshot>('hardware.snapshot'),
  updateTask: (project: string, taskId: string, status: 'todo' | 'active' | 'done', sessionId?: string) => request<unknown>('coordination.task.update', {project, taskId, status, sessionId}),
  softwareSnapshot: () => request<SoftwareSnapshot>('software.snapshot'),
  usageSnapshot: () => request<UsageSnapshot>('usage.snapshot'),
  listProviders: () => request<ProviderHealth[]>('providers.list'),
  coordination: (project: string) => request<import('./daemon-protocol.js').CoordinationState>('coordination.get', {project}),
  createTask: (project: string, title: string, sessionId?: string) => request<import('./daemon-protocol.js').CoordinationState>('coordination.task.create', {project, title, sessionId}),
  claimFile: (project: string, path: string, sessionId: string) => request<import('./daemon-protocol.js').ClaimResult>('coordination.claim', {project, path, sessionId}),
  resize: (sessionId: string, cols: number, rows: number) => request<{resized: boolean}>('sessions.resize', {sessionId, cols, rows}),
  subscribeSession,
  subscribeRun,
  openEventStream,
  listCredentials: () => request<CredentialChainState[]>('credentials.list'),
  upsertAccount: (params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string; sameIdentityAs?: string}) => request<CredentialChainState>('credentials.upsertAccount', params),
  setCredentialChain: (provider: ProviderId, accountIds: string[]) => request<CredentialChainState>('credentials.setChain', {provider, accountIds}),
  setFallbackPolicy: (provider: ProviderId, policy: FallbackPolicy) => request<CredentialChainState>('credentials.setFallbackPolicy', {provider, policy}),
  confirmFallback: (provider: ProviderId, accept: boolean, resetAt?: string) => request<CredentialChainState>('credentials.confirmFallback', {provider, accept, resetAt})
};
