import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';

// Mirrors src/daemon-protocol.ts's shared types. Duplicated rather than imported across the
// package boundary — app/ is a separate, dependency-free frontend build from src/ (fluentd);
// keeping them independent means the desktop app never needs fluentd's Node toolchain to build.
export type ProviderId = 'claude' | 'codex';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'failed';
export type CredentialMode = 'subscription' | 'platform-credits' | 'api-key';
export type FallbackPolicy = 'always-ask' | 'always-switch' | 'never-switch';

export type SessionSummary = {
  id: string;
  provider: ProviderId;
  command: string;
  directory: string;
  task?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  exitCode?: number | null;
  accountId?: string;
  projectDirectory?: string;
  worktreePath?: string;
};

export type SessionSnapshot = SessionSummary & {output: string};
export type SessionDiff = {status: string; patch: string; truncated: boolean};

export type HardwareSample = {
  capturedAt: string;
  cpuPercent: number;
  loadAverage: number[];
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  processRssBytes: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  uptimeSeconds: number;
  platform: string;
  arch: string;
};

export type HardwareSnapshot = {current: HardwareSample; history: HardwareSample[]};
export type SoftwareSnapshot = {capturedAt: string; hostname: string; kernel: string; nodeVersion: string; daemonPid: number; git?: string; providers: ProviderHealth[]};
export type UsageSnapshot = {sessions: Array<{sessionId: string; provider: 'claude'; model?: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; contextPercent?: number; costUsd?: number; cacheHitRatio?: number; fiveHourPercent?: number; fiveHourResetsAt?: string; sevenDayPercent?: number; sevenDayResetsAt?: string; updatedAt: string; history: Array<{capturedAt: string; inputTokens?: number; outputTokens?: number; contextPercent?: number; costUsd?: number}>}>};
export type ResourceSnapshot = {sequence: number; sampledAtUnixMs: number; scannedProcessCount: number; retainedProcessCount: number; inaccessibleProcessCount: number; processes: Array<{pid: number; ppid: number; name: string; command: string; status: string; cpuPercent: number; residentBytes: number; virtualBytes: number; ioReadBytes: number; ioWriteBytes: number}>};

// Mirrors src/spend-tracker.ts — forked from T3 Code's usage system (MIT licensed).
export type TokenTotals = {uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number; reasoningTokens: number};
export type CostSource = 'providerReported' | 'modelPriced' | 'unpriced';
export type PriceOverride = {inputCostPerMillionTokens: number; outputCostPerMillionTokens: number; cacheReadCostPerMillionTokens?: number; cacheWriteCostPerMillionTokens?: number};
export type SpendModelBucket = {provider: ProviderId; model: string; totals: TokenTotals; costUsd: number; costSource: CostSource; cacheSavingsUsd: number};
export type SpendDayBucket = {day: string; costUsd: number; totals: TokenTotals; models: SpendModelBucket[]};
export type SpendSummary = {
  rangeDays: number;
  totalCostUsd: number;
  totalCacheSavingsUsd: number;
  totals: TokenTotals;
  days: SpendDayBucket[];
  priceOverrides: Record<string, PriceOverride>;
  ratesUpdatedAt?: string;
  ratesError?: string;
};
// Mirrors src/source-control.ts.
export type PullRequestChecksStatus = 'pending' | 'passing' | 'failing' | 'unknown';
export type PullRequestStatus = {number: number; title: string; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; mergedAt: string | null; checksStatus: PullRequestChecksStatus};
export type RepoStatus = {connected: boolean; owner?: string; repo?: string; branch?: string; dirty?: boolean; pullRequest?: PullRequestStatus; error?: string};
export type AssignedIssue = {number: number; title: string; url: string; repo: string};
export type OpenPullRequest = {number: number; title: string; url: string; repo: string; isDraft: boolean};

export type ProviderHealth = {id: ProviderId; label: string; installed: boolean; executable?: string; version?: string};
export type CoordinationState = {
  project: string;
  tasks: Array<{id: string; title: string; status: 'todo' | 'active' | 'done'; sessionId?: string; createdAt: string}>;
  claims: Array<{path: string; sessionId: string; createdAt: string}>;
  decisions: Array<{id: string; summary: string; sessionId?: string; createdAt: string}>;
  handoffs: Array<{id: string; fromSessionId: string; toSessionId: string; summary: string; createdAt: string; status: 'open' | 'accepted'}>;
};
export type RemoteProfile = {id: string; name: string; host: string; port: number; remoteSocket: string; localSocket: string; status: 'disconnected' | 'connecting' | 'connected' | 'failed'; error?: string};
export type OpenDesignProfile = {url: string};
export type OpenDesignStatus = OpenDesignProfile & {reachable: boolean; status?: number; error?: string};
export type DesignTool = {id: 'pen' | 'open-design'; label: string; installed: boolean; executable?: string; version?: string; mcp: 'desktop-settings' | 'install-command'; detail: string};

export type CredentialAccount = {
  id: string;
  provider: ProviderId;
  mode: CredentialMode;
  label: string;
  hasSecret?: boolean;
  baseUrl?: string;
};

export type CredentialChainState = {
  provider: ProviderId;
  accounts: CredentialAccount[];
  chain: string[];
  activeAccountId?: string;
  fallbackPolicy: FallbackPolicy;
  limitedAccountId?: string;
  revertAt?: string;
};

// A forwarded Unix socket is owned by the local daemon process. Persisting its path across a
// restart would make the desktop silently target a stale endpoint, so remote selection is
// deliberately session-scoped and always starts local.
let activeSocket: string | undefined;

function daemonRequest<T>(method: string, params?: Record<string, unknown>, socketPath = activeSocket): Promise<T> {
  return invoke<T>('daemon_request', {method, params: params ?? null, socketPath: socketPath ?? null});
}

function localDaemonRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  return daemonRequest<T>(method, params, undefined);
}

export function activeRemoteSocket() { return activeSocket; }
export function selectRemoteSocket(socketPath?: string) {
  activeSocket = socketPath;
}

export const api = {
  ping: () => daemonRequest<{ok: boolean; pid: number}>('ping'),
  listSessions: () => daemonRequest<SessionSummary[]>('sessions.list'),
  createSession: (params: {provider: ProviderId; directory: string; task?: string; accountId?: string; isolate?: boolean}) => daemonRequest<SessionSummary>('sessions.create', params),
  getSession: (sessionId: string) => daemonRequest<SessionSnapshot>('sessions.get', {sessionId}),
  send: (sessionId: string, input: string) => daemonRequest<{sent: boolean}>('sessions.send', {sessionId, input}),
  stop: (sessionId: string) => daemonRequest<SessionSummary>('sessions.stop', {sessionId}),
  removeWorktree: (sessionId: string) => daemonRequest<SessionSummary>('sessions.removeWorktree', {sessionId}),
  sessionDiff: (sessionId: string) => daemonRequest<SessionDiff>('sessions.diff', {sessionId}),
  resize: (sessionId: string, cols: number, rows: number) => daemonRequest<{resized: boolean}>('sessions.resize', {sessionId, cols, rows}),
  hardwareSnapshot: () => daemonRequest<HardwareSnapshot>('hardware.snapshot'),
  softwareSnapshot: () => daemonRequest<SoftwareSnapshot>('software.snapshot'),
  usageSnapshot: () => daemonRequest<UsageSnapshot>('usage.snapshot'),
  resourceSnapshot: () => daemonRequest<ResourceSnapshot>('resources.snapshot'),
  resourceHistory: (windowMs: number) => daemonRequest<ResourceSnapshot[]>('resources.history', {windowMs}),
  spendSummary: (rangeDays?: number) => daemonRequest<SpendSummary>('spend.summary', {rangeDays}),
  repoStatus: (directory: string) => daemonRequest<RepoStatus>('sourceControl.repoStatus', {directory}),
  assignedIssues: () => daemonRequest<AssignedIssue[] | {error: string}>('sourceControl.assignedIssues'),
  myOpenPullRequests: () => daemonRequest<OpenPullRequest[] | {error: string}>('sourceControl.myOpenPullRequests'),
  setPriceOverride: (model: string, override: PriceOverride) => daemonRequest<{ok: boolean}>('spend.setPriceOverride', {model, override}),
  clearPriceOverride: (model: string) => daemonRequest<{ok: boolean}>('spend.clearPriceOverride', {model}),
  listProviders: () => daemonRequest<ProviderHealth[]>('providers.list'),
  coordination: (project: string) => daemonRequest<CoordinationState>('coordination.get', {project}),
  createTask: (project: string, title: string, sessionId?: string) => daemonRequest<CoordinationState>('coordination.task.create', {project, title, sessionId}),
  updateTask: (project: string, taskId: string, status: 'todo' | 'active' | 'done', sessionId?: string) => daemonRequest<CoordinationState>('coordination.task.update', {project, taskId, status, sessionId}),
  claimFile: (project: string, path: string, sessionId: string) => daemonRequest<{state: CoordinationState; conflict?: {path: string; sessionId: string}}>('coordination.claim', {project, path, sessionId}),
  releaseClaim: (project: string, path: string, sessionId: string) => daemonRequest<CoordinationState>('coordination.claim.release', {project, path, sessionId}),
  addDecision: (project: string, summary: string, sessionId?: string) => daemonRequest<CoordinationState>('coordination.decision.add', {project, summary, sessionId}),
  createHandoff: (project: string, fromSessionId: string, toSessionId: string, summary: string) => daemonRequest<CoordinationState>('coordination.handoff.create', {project, fromSessionId, toSessionId, summary}),
  acceptHandoff: (project: string, handoffId: string) => daemonRequest<CoordinationState>('coordination.handoff.accept', {project, handoffId}),
  listRemotes: () => localDaemonRequest<RemoteProfile[]>('remote.list'),
  saveRemote: (params: {name: string; host: string; port?: number; remoteSocket?: string}) => localDaemonRequest<RemoteProfile>('remote.save', params),
  connectRemote: (profileId: string) => localDaemonRequest<RemoteProfile>('remote.connect', {profileId}),
  disconnectRemote: (profileId: string) => localDaemonRequest<RemoteProfile>('remote.disconnect', {profileId}),
  openDesign: () => localDaemonRequest<OpenDesignProfile>('openDesign.get'),
  saveOpenDesign: (url: string) => localDaemonRequest<OpenDesignProfile>('openDesign.save', {url}),
  openDesignStatus: () => localDaemonRequest<OpenDesignStatus>('openDesign.status'),
  listDesignTools: () => localDaemonRequest<DesignTool[]>('designTools.list'),
  installOpenDesignMcp: (target: 'claude' | 'codex') => localDaemonRequest<{target: string; output: string}>('designTools.installOpenDesignMcp', {target}),
  listCredentials: () => daemonRequest<CredentialChainState[]>('credentials.list'),
  upsertAccount: (params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string}) =>
    daemonRequest<CredentialChainState>('credentials.upsertAccount', params),
  setChain: (provider: ProviderId, accountIds: string[]) => daemonRequest<CredentialChainState>('credentials.setChain', {provider, accountIds}),
  setFallbackPolicy: (provider: ProviderId, policy: FallbackPolicy) => daemonRequest<CredentialChainState>('credentials.setFallbackPolicy', {provider, policy}),
  confirmFallback: (provider: ProviderId, accept: boolean, resetAt?: string) => daemonRequest<CredentialChainState>('credentials.confirmFallback', {provider, accept, resetAt})
};

/**
 * Subscribes to one session's live output/status via the Rust bridge (which itself holds a
 * dedicated fluentd connection open — see src-tauri/src/daemon_client.rs). Call `unsubscribe()`
 * when the Active Session view unmounts.
 */
export function subscribeSession(sessionId: string, handlers: {onOutput?: (chunk: string) => void; onStatus?: (summary: SessionSummary) => void}) {
  let unlistenOutput: UnlistenFn | undefined;
  let unlistenStatus: UnlistenFn | undefined;
  // Keep a session pinned to the daemon it was opened against even if the user changes the
  // workspace target before leaving this screen.
  const sessionSocket = activeSocket;

  const ready = (async () => {
    unlistenOutput = await listen<{sessionId: string; chunk: string}>('session-output', event => {
      if (event.payload.sessionId === sessionId) handlers.onOutput?.(event.payload.chunk);
    });
    unlistenStatus = await listen<{sessionId: string; summary: SessionSummary}>('session-status', event => {
      if (event.payload.sessionId === sessionId) handlers.onStatus?.(event.payload.summary);
    });
    return invoke<SessionSnapshot>('sessions_subscribe', {sessionId, socketPath: sessionSocket ?? null});
  })();

  return {
    snapshot: ready,
    unsubscribe: async () => {
      unlistenOutput?.();
      unlistenStatus?.();
      await invoke('sessions_unsubscribe', {sessionId, socketPath: sessionSocket ?? null}).catch(() => undefined);
    }
  };
}

export function onCredentialSwitched(handler: (event: {provider: ProviderId; accountId: string; reason: 'fallback' | 'revert' | 'manual'}) => void) {
  return listen<{provider: ProviderId; accountId: string; reason: 'fallback' | 'revert' | 'manual'}>('credential-switched', event => handler(event.payload));
}

export function onCredentialNotice(handler: (event: {provider: ProviderId; message: string; resetAt?: string}) => void) {
  return listen<{provider: ProviderId; message: string; resetAt?: string}>('credential-notice', event => handler(event.payload));
}
