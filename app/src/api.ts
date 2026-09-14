import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';

// Mirrors src/daemon-protocol.ts's shared types. Duplicated rather than imported across the
// package boundary — app/ is a separate, dependency-free frontend build from src/ (fluentd);
// keeping them independent means the desktop app never needs fluentd's Node toolchain to build.
export type ProviderId = 'claude' | 'codex' | 'gemini';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'failed';
export type CredentialMode = 'subscription' | 'platform-credits' | 'api-key';
export type FallbackPolicy = 'always-ask' | 'always-switch' | 'never-switch';
export type ApprovalAction = 'credential.change' | 'worktree.remove' | 'worktree.reset' | 'worktree.rebase' | 'integration.merge' | 'remote.configure' | 'remote.connect' | 'extension.install' | 'recipe.execute' | 'project.configure';
export type ApprovalRecord = {id: string; action: ApprovalAction; target: string; commandHash?: string; baseSha?: string; issuedAt: string; expiresAt: string; consumedAt?: string};

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
  prepareMs?: number;
  warmedPaths?: string[];
  verification?: VerificationStatus;
};

export type FallbackGuidance = {
  recommendation: 'switch' | 'wait';
  resetsInMs?: number;
  cacheHitRatio?: number;
  activeSessions: number;
  detail: string;
};

export type MergePlan = {
  sessionId: string;
  base: string;
  baseHead: string;
  laneHead: string;
  uncommittedFiles: number;
  ahead: number;
  conflicts: string[];
  blockers: string[];
};
export type MergeOutcome = {
  sessionId: string;
  status: 'merged' | 'blocked' | 'conflicted' | 'unverified' | 'failed';
  plan: MergePlan;
  verification?: VerificationResult;
  detail: string;
  mergeCommit?: string;
};

export type AdmissionVerdict = {
  provider: ProviderId;
  decision: 'clear' | 'tight' | 'over';
  recommendedLanes: number;
  runningLanes: number;
  freeBytes: number;
  reserveBytes: number;
  perLaneBytes: number;
  estimateSource: 'observed' | 'default';
  quotaUsedPercent?: number;
  quotaResetsAt?: string;
  accountId?: string;
  reasons: string[];
};

export type VerificationStatus = 'running' | 'passed' | 'failed' | 'unavailable';
export type VerificationResult = {
  sessionId: string;
  status: VerificationStatus;
  command?: string;
  source?: 'configured' | 'package.json' | 'cargo' | 'go' | 'makefile';
  exitCode?: number | null;
  startedAt: string;
  durationMs: number;
  warnings: string[];
  output: string;
  detail?: string;
};

export type SessionSnapshot = SessionSummary & {output: string};
export type SessionDiff = {status: string; patch: string; truncated: boolean};
export type Run = {
  id: string;
  provider: ProviderId;
  accountId?: string;
  state: 'queued' | 'preparing' | 'ready' | 'running' | 'awaiting_approval' | 'blocked' | 'verifying' | 'integrating' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  delivery: 'idle' | 'intended' | 'confirmed' | 'unknown';
  timing: Record<string, {atWall: string; atMonoMs?: number; available: boolean; detail?: string}>;
};

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
export type QuotaWindow = {usedPercent?: number; windowMinutes?: number; resetsAt?: string};
export type ProviderQuota = {primary?: QuotaWindow; secondary?: QuotaWindow; observedAt: string};
export type UsageSnapshot = {sessions: Array<{sessionId: string; provider: ProviderId; model?: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; contextPercent?: number; costUsd?: number; cacheHitRatio?: number; quota?: ProviderQuota; updatedAt: string; history: Array<{capturedAt: string; inputTokens?: number; outputTokens?: number; contextPercent?: number; costUsd?: number}>}>};
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

// Mirrors src/catalog-manager.ts.
export type CatalogPlugin = {id: string; name: string; marketplace: string; target: ProviderId; description?: string; category?: string; homepage?: string; installed: boolean; enabled?: boolean; version?: string; officialSource: boolean};
export type MarketplaceEntry = {name: string; target: ProviderId; source: string; officialSource: boolean};
export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpServerConfig = {name: string; transport: McpTransport; scope?: 'user' | 'local' | 'project'; command?: string; args?: string[]; url?: string};
export type McpServerEntry = {name: string; target: ProviderId; transport: McpTransport; command?: string; args?: string[]; url?: string; connected?: boolean; needsAuth?: boolean};
export type McpInstallResult = {target: ProviderId; ok: boolean; output: string};
export type CatalogActionResult = {ok: boolean; output: string};

export type ProviderHealth = {id: ProviderId; label: string; installed: boolean; executable?: string; version?: string};
export type CoordinationState = {
  project: string;
  tasks: Array<{id: string; title: string; status: 'todo' | 'active' | 'done'; sessionId?: string; createdAt: string}>;
  claims: Array<{path: string; sessionId: string; origin: 'declared' | 'observed'; createdAt: string; renewedAt: string; expiresAt: string}>;
  decisions: Array<{id: string; summary: string; sessionId?: string; createdAt: string}>;
  messages: LaneMessage[];
  handoffs: Array<{id: string; fromSessionId: string; toSessionId: string; summary: string; createdAt: string; status: 'open' | 'accepted'}>;
};
export type AccountAuthStatus = {
  accountId: string;
  provider: ProviderId;
  mode: CredentialMode;
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  loginCommand?: string;
  detail?: string;
};
export type EvalPlan = {cases: string[]; runsPerCase: number; arms: number; totalRuns: number};
export type EvalReadiness = {
  plan: EvalPlan;
  running: boolean;
  run?: EvalRun;
  accountId?: string;
  accountLabel?: string;
  mode?: CredentialMode;
  quotaUsedPercent?: number;
  quotaResetsAt?: string;
};
export type EvalCaseResult = {name: string; score: number; passRate: number; runs: number; costUsd: number; delta?: number; notes?: string};
export type EvalRun = {
  schemaVersion: number;
  claudeVersion?: string;
  startedAt: string;
  durationSeconds: number;
  costUsd: number;
  partial: boolean;
  ablation?: string;
  threshold: number;
  casesTotal: number;
  casesPassed: number;
  overallScore: number;
  overallPassRate: number;
  cases: EvalCaseResult[];
  reportPath?: string;
};
export type LaneMessage = {id: string; from: string; to: string; body: string; createdAt: string; readAt?: string};
export type SkillInstallState = {provider: ProviderId; path: string; installed: boolean; current: boolean; mcpConfigured?: boolean; mcpDetail?: string};
export type ClaimConflict = {path: string; claimedPath: string; sessionId: string; overlap: 'same' | 'contains' | 'contained'};
export type RankedConflict = ClaimConflict & {hotspot: boolean};
export type ClaimResult = {granted: boolean; state: CoordinationState; conflicts: ClaimConflict[]};
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

async function issueApproval(action: ApprovalAction, target: string, command?: string, baseSha?: string, local = false) {
  const request = local ? localDaemonRequest<ApprovalRecord> : daemonRequest<ApprovalRecord>;
  return request('approvals.issue', {action, target, command, baseSha});
}

export function activeRemoteSocket() { return activeSocket; }
export function selectRemoteSocket(socketPath?: string) {
  activeSocket = socketPath;
}

export const api = {
  ping: () => daemonRequest<{ok: boolean; pid: number}>('ping'),
  listSessions: () => daemonRequest<SessionSummary[]>('sessions.list'),
  createSession: async (params: {provider: ProviderId; directory: string; task?: string; accountId?: string; isolate?: boolean}) => {
    const approval = params.provider === 'claude'
      ? await issueApproval('project.configure', params.directory, 'configure Claude hooks')
      : undefined;
    return daemonRequest<SessionSummary>('sessions.create', {...params, approvalId: approval?.id});
  },
  getSession: (sessionId: string) => daemonRequest<SessionSnapshot>('sessions.get', {sessionId}),
  getRun: (runId: string) => daemonRequest<Run>('runs.get', {runId}),
  send: (sessionId: string, input: string) => daemonRequest<{sent: boolean}>('sessions.send', {sessionId, input}),
  stop: (sessionId: string) => daemonRequest<SessionSummary>('sessions.stop', {sessionId}),
  removeWorktree: async (sessionId: string) => {
    const session = await daemonRequest<SessionSnapshot>('sessions.get', {sessionId});
    const approval = await issueApproval('worktree.remove', session.worktreePath ?? session.directory, 'git worktree remove');
    return daemonRequest<SessionSummary>('sessions.removeWorktree', {sessionId, approvalId: approval.id});
  },
  sessionDiff: (sessionId: string) => daemonRequest<SessionDiff>('sessions.diff', {sessionId}),
  verifySession: async (sessionId: string, force = true) => {
    const session = await daemonRequest<SessionSnapshot>('sessions.get', {sessionId});
    const planned = await daemonRequest<{command: string} | undefined>('verification.plan', {directory: session.directory, project: session.projectDirectory ?? session.directory});
    const approval = await issueApproval('recipe.execute', session.directory, planned?.command);
    return daemonRequest<VerificationResult>('sessions.verify', {sessionId, force, approvalId: approval.id});
  },
  mergePlan: (sessionId: string) => daemonRequest<MergePlan>('merge.plan', {sessionId}),
  mergeIntegrate: async (sessionId: string) => {
    const [session, plan] = await Promise.all([daemonRequest<SessionSnapshot>('sessions.get', {sessionId}), daemonRequest<MergePlan>('merge.plan', {sessionId})]);
    const approval = await issueApproval('integration.merge', session.projectDirectory ?? session.directory, `git merge ${sessionId}`, plan.baseHead);
    return daemonRequest<MergeOutcome>('merge.integrate', {sessionId, approvalId: approval.id});
  },
  mergePending: (project: string) => daemonRequest<string[]>('merge.pending', {project}),
  assessAdmission: (provider: ProviderId, accountId?: string) => daemonRequest<AdmissionVerdict>('admission.assess', {provider, accountId}),
  setVerifyCommand: async (project: string, command?: string) => {
    const approval = await issueApproval('project.configure', project, command);
    return daemonRequest<{command?: string}>('verification.setCommand', {project, command, approvalId: approval.id});
  },
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
  catalogPlugins: () => daemonRequest<CatalogPlugin[]>('catalog.plugins'),
  installCatalogPlugin: async (target: ProviderId, pluginId: string) => {
    const approval = await issueApproval('extension.install', `${target}:${pluginId}`, `plugin install ${pluginId}`);
    return daemonRequest<CatalogActionResult>('catalog.installPlugin', {target, pluginId, approvalId: approval.id});
  },
  catalogMarketplaces: () => daemonRequest<MarketplaceEntry[]>('catalog.marketplaces'),
  addCatalogMarketplace: async (target: ProviderId, source: string) => {
    const approval = await issueApproval('extension.install', `${target}:${source}`, `marketplace add ${source}`);
    return daemonRequest<CatalogActionResult>('catalog.addMarketplace', {target, source, approvalId: approval.id});
  },
  catalogMcpServers: () => daemonRequest<McpServerEntry[]>('catalog.mcpServers'),
  addCatalogMcpServer: async (targets: ProviderId[], config: McpServerConfig) => {
    const target = `mcp:${[...new Set(targets)].sort().join(',')}:${config.name}`;
    const command = config.transport === 'stdio' ? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ') : config.url;
    const approval = await issueApproval('extension.install', target, command);
    return daemonRequest<McpInstallResult[]>('catalog.addMcpServer', {targets, config, approvalId: approval.id});
  },
  setPriceOverride: (model: string, override: PriceOverride) => daemonRequest<{ok: boolean}>('spend.setPriceOverride', {model, override}),
  clearPriceOverride: (model: string) => daemonRequest<{ok: boolean}>('spend.clearPriceOverride', {model}),
  listProviders: () => daemonRequest<ProviderHealth[]>('providers.list'),
  coordination: (project: string) => daemonRequest<CoordinationState>('coordination.get', {project}),
  createTask: (project: string, title: string, sessionId?: string) => daemonRequest<CoordinationState>('coordination.task.create', {project, title, sessionId}),
  updateTask: (project: string, taskId: string, status: 'todo' | 'active' | 'done', sessionId?: string) => daemonRequest<CoordinationState>('coordination.task.update', {project, taskId, status, sessionId}),
  claimFile: (project: string, path: string, sessionId: string) => daemonRequest<ClaimResult>('coordination.claim', {project, path, sessionId}),
  releaseClaim: (project: string, path: string, sessionId: string) => daemonRequest<CoordinationState>('coordination.claim.release', {project, path, sessionId}),
  conflicts: (project: string) => daemonRequest<RankedConflict[]>('coordination.conflicts', {project}),
  messages: (project: string) => daemonRequest<LaneMessage[]>('coordination.messages', {project}),
  skillStatus: () => daemonRequest<SkillInstallState[]>('skills.status'),
  installSkill: async () => {
    const approval = await issueApproval('extension.install', 'fluent-collab', 'install collaboration skill');
    return daemonRequest<SkillInstallState[]>('skills.install', {approvalId: approval.id});
  },
  evalReadiness: () => daemonRequest<EvalReadiness>('evals.readiness'),
  authStatus: () => daemonRequest<AccountAuthStatus[]>('credentials.authStatus'),
  runEvals: async (maxCostUsd: number) => {
    const approval = await issueApproval('recipe.execute', 'fluent-evals', `claude plugin eval max-cost=${maxCostUsd}`);
    return daemonRequest<EvalRun>('evals.run', {maxCostUsd, approvalId: approval.id});
  },
  addDecision: (project: string, summary: string, sessionId?: string) => daemonRequest<CoordinationState>('coordination.decision.add', {project, summary, sessionId}),
  createHandoff: (project: string, fromSessionId: string, toSessionId: string, summary: string) => daemonRequest<CoordinationState>('coordination.handoff.create', {project, fromSessionId, toSessionId, summary}),
  acceptHandoff: (project: string, handoffId: string) => daemonRequest<CoordinationState>('coordination.handoff.accept', {project, handoffId}),
  listRemotes: () => localDaemonRequest<RemoteProfile[]>('remote.list'),
  saveRemote: async (params: {name: string; host: string; port?: number; remoteSocket?: string}) => {
    const approval = await issueApproval('remote.configure', `${params.host}:${params.port ?? 22}`, params.remoteSocket, undefined, true);
    return localDaemonRequest<RemoteProfile>('remote.save', {...params, approvalId: approval.id});
  },
  connectRemote: async (profileId: string) => {
    const approval = await issueApproval('remote.connect', profileId, 'ssh forward', undefined, true);
    return localDaemonRequest<RemoteProfile>('remote.connect', {profileId, approvalId: approval.id});
  },
  disconnectRemote: (profileId: string) => localDaemonRequest<RemoteProfile>('remote.disconnect', {profileId}),
  openDesign: () => localDaemonRequest<OpenDesignProfile>('openDesign.get'),
  saveOpenDesign: (url: string) => localDaemonRequest<OpenDesignProfile>('openDesign.save', {url}),
  openDesignStatus: () => localDaemonRequest<OpenDesignStatus>('openDesign.status'),
  listDesignTools: () => localDaemonRequest<DesignTool[]>('designTools.list'),
  installOpenDesignMcp: async (target: 'claude' | 'codex') => {
    const approval = await issueApproval('extension.install', `open-design:${target}`, 'install OpenDesign MCP', undefined, true);
    return localDaemonRequest<{target: string; output: string}>('designTools.installOpenDesignMcp', {target, approvalId: approval.id});
  },
  listCredentials: () => daemonRequest<CredentialChainState[]>('credentials.list'),
  upsertAccount: async (params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string; sameIdentityAs?: string}) => {
    const approval = await issueApproval('credential.change', `${params.provider}:${params.id}`, `credential ${params.mode}`);
    return daemonRequest<CredentialChainState>('credentials.upsertAccount', {...params, approvalId: approval.id});
  },
  setChain: async (provider: ProviderId, accountIds: string[]) => {
    const approval = await issueApproval('credential.change', provider, `chain ${accountIds.join(',')}`);
    return daemonRequest<CredentialChainState>('credentials.setChain', {provider, accountIds, approvalId: approval.id});
  },
  setFallbackPolicy: async (provider: ProviderId, policy: FallbackPolicy) => {
    const approval = await issueApproval('credential.change', provider, `fallback ${policy}`);
    return daemonRequest<CredentialChainState>('credentials.setFallbackPolicy', {provider, policy, approvalId: approval.id});
  },
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

export function onCredentialNotice(handler: (event: {provider: ProviderId; message: string; resetAt?: string; guidance?: FallbackGuidance}) => void) {
  return listen<{provider: ProviderId; message: string; resetAt?: string; guidance?: FallbackGuidance}>('credential-notice', event => handler(event.payload));
}

export function onAdmissionWarning(handler: (event: {sessionId: string; verdict: AdmissionVerdict}) => void) {
  return listen<{sessionId: string; verdict: AdmissionVerdict}>('admission-warning', event => handler(event.payload));
}

export function onMergeOutcome(handler: (event: {outcome: MergeOutcome}) => void) {
  return listen<{outcome: MergeOutcome}>('merge-outcome', event => handler(event.payload));
}

export function onEvalsFinished(handler: (event: {run: EvalRun}) => void) {
  return listen<{run: EvalRun}>('evals-finished', event => handler(event.payload));
}

export function onCoordinationMessage(handler: (event: {project: string; message: LaneMessage}) => void) {
  return listen<{project: string; message: LaneMessage}>('coordination-message', event => handler(event.payload));
}

export function onConflicts(handler: (event: {project: string; conflicts: RankedConflict[]}) => void) {
  return listen<{project: string; conflicts: RankedConflict[]}>('coordination-conflicts', event => handler(event.payload));
}

/** A claim never disappears from the coordination column without a reason — this is the reason. */
export function onClaimsExpired(handler: (event: {claims: Array<{project: string; path: string; sessionId: string}>}) => void) {
  return listen<{claims: Array<{project: string; path: string; sessionId: string}>}>('coordination-claims-expired', event => handler(event.payload));
}

export function onSessionVerification(handler: (event: {sessionId: string; result: VerificationResult}) => void) {
  return listen<{sessionId: string; result: VerificationResult}>('session-verification', event => handler(event.payload));
}
