import type {PriceOverride, SpendSummary} from './spend-tracker.js';
export type {PriceOverride, SpendSummary} from './spend-tracker.js';

export type ProviderId = 'claude' | 'codex';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'failed';

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
  /** The credential account active for this provider at the moment the session was created — a
   * historical record for the session list, not a live pointer (spec screen 4's account column). */
  accountId?: string;
  /** Original Git project when this session runs in an isolated worktree. */
  projectDirectory?: string;
  worktreePath?: string;
  /** Lane-ready latency: how long preparing this session's isolated worktree actually took,
   * including warming its caches. Measured so the orchestrator's speed claim stays falsifiable. */
  prepareMs?: number;
  /** Ignored cache directories reference-cloned into the worktree, empty when the filesystem
   * cannot reflink — so a slow lane start is explainable rather than mysterious. */
  warmedPaths?: string[];
  /** Outcome of the project's own checks in this lane. Deliberately separate from `status`: a lane
   * can be running and verified, or exited and failing, and collapsing the two loses that. */
  verification?: VerificationStatus;
};

export type SessionSnapshot = SessionSummary & {
  output: string;
};
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

export type HardwareSnapshot = {
  current: HardwareSample;
  history: HardwareSample[];
};

export type SoftwareSnapshot = {
  capturedAt: string;
  hostname: string;
  kernel: string;
  nodeVersion: string;
  daemonPid: number;
  git?: string;
  providers: ProviderHealth[];
};
export type UsageSnapshot = {sessions: Array<{sessionId: string; provider: 'claude'; model?: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; contextPercent?: number; costUsd?: number; cacheHitRatio?: number; fiveHourPercent?: number; fiveHourResetsAt?: string; sevenDayPercent?: number; sevenDayResetsAt?: string; updatedAt: string; history: Array<{capturedAt: string; inputTokens?: number; outputTokens?: number; contextPercent?: number; costUsd?: number}>}>};
export type ResourceSnapshot = {sequence: number; sampledAtUnixMs: number; scannedProcessCount: number; retainedProcessCount: number; inaccessibleProcessCount: number; processes: Array<{pid: number; ppid: number; name: string; command: string; status: string; cpuPercent: number; residentBytes: number; virtualBytes: number; ioReadBytes: number; ioWriteBytes: number}>};

export type ProviderHealth = {
  id: ProviderId;
  label: string;
  installed: boolean;
  executable?: string;
  version?: string;
};

/** Where the check fluentd ran came from — surfaced so a lane's green says what it actually ran. */
export type VerificationSource = 'configured' | 'package.json' | 'cargo' | 'go' | 'makefile';
export type VerificationStatus = 'running' | 'passed' | 'failed' | 'unavailable';
export type VerificationResult = {
  sessionId: string;
  status: VerificationStatus;
  command?: string;
  source?: VerificationSource;
  exitCode?: number | null;
  startedAt: string;
  durationMs: number;
  /** Reasons to read a pass sceptically — chiefly that the lane changed the tests it just passed. */
  warnings: string[];
  output: string;
  detail?: string;
  /** Identity of the exact tree this result was produced from; a result is reused only for the
   * identical tree. */
  treeId?: string;
};

/** What integrating one lane would do, computed without touching any working tree. */
export type MergePlan = {
  sessionId: string;
  /** Branch in the project checkout the lane would merge into. */
  base: string;
  baseHead: string;
  laneHead: string;
  uncommittedFiles: number;
  ahead: number;
  /** Files git predicts would conflict, from `merge-tree` — no tree is modified to find them. */
  conflicts: string[];
  /** Reasons integration cannot proceed right now, in plain language. */
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

export type CoordinationTask = {id: string; title: string; status: 'todo' | 'active' | 'done'; sessionId?: string; createdAt: string};
/**
 * A claim is an advisory signal that a lane intends to edit a path — never an OS lock (spec §11).
 * `origin` separates a claim an agent declared from one fluentd observed in the lane's own diff;
 * the lease fields let a dead lane's claims lapse instead of blocking live lanes forever.
 */
export type FileClaim = {path: string; sessionId: string; origin: 'declared' | 'observed'; createdAt: string; renewedAt: string; expiresAt: string};
/** `path` is the claim being attempted; `claimedPath` is the existing claim it overlaps, which is
 * not necessarily the same string — `src/` and `src/daemon.ts` overlap without matching. */
export type ClaimConflict = {path: string; claimedPath: string; sessionId: string; overlap: 'same' | 'contains' | 'contained'};
export type ClaimResult = {granted: boolean; state: CoordinationState; conflicts: ClaimConflict[]};
/** A conflict plus whether it lands on a file the project's own history says everything touches —
 * the collision hotspots that make late-discovered conflicts expensive. */
export type RankedConflict = ClaimConflict & {hotspot: boolean};
export type Decision = {id: string; summary: string; sessionId?: string; createdAt: string};
export type Handoff = {id: string; fromSessionId: string; toSessionId: string; summary: string; createdAt: string; status: 'open' | 'accepted'};
export type CoordinationState = {project: string; tasks: CoordinationTask[]; claims: FileClaim[]; decisions: Decision[]; handoffs: Handoff[]};
export type RemoteProfile = {id: string; name: string; host: string; port: number; remoteSocket: string; localSocket: string; status: 'disconnected' | 'connecting' | 'connected' | 'failed'; error?: string};
export type OpenDesignProfile = {url: string};
export type OpenDesignStatus = OpenDesignProfile & {reachable: boolean; status?: number; error?: string};
export type DesignToolId = 'pen' | 'open-design';
export type McpTarget = 'claude' | 'codex';
export type DesignTool = {id: DesignToolId; label: string; installed: boolean; executable?: string; version?: string; mcp: 'desktop-settings' | 'install-command'; detail: string};

export type RpcRequest =
  | {id: string; method: 'ping'}
  | {id: string; method: 'sessions.list'}
  | {id: string; method: 'sessions.create'; params: {provider: ProviderId; directory: string; task?: string; accountId?: string; isolate?: boolean}}
  | {id: string; method: 'sessions.get'; params: {sessionId: string}}
  | {id: string; method: 'sessions.send'; params: {sessionId: string; input: string}}
  | {id: string; method: 'sessions.stop'; params: {sessionId: string}}
  | {id: string; method: 'sessions.removeWorktree'; params: {sessionId: string}}
  | {id: string; method: 'sessions.diff'; params: {sessionId: string}}
  | {id: string; method: 'sessions.verify'; params: {sessionId: string; force?: boolean}}
  | {id: string; method: 'verification.list'}
  | {id: string; method: 'verification.setCommand'; params: {project: string; command?: string}}
  | {id: string; method: 'merge.plan'; params: {sessionId: string}}
  | {id: string; method: 'merge.integrate'; params: {sessionId: string}}
  | {id: string; method: 'merge.pending'; params: {project: string}}
  | {id: string; method: 'sessions.resize'; params: {sessionId: string; cols: number; rows: number}}
  | {id: string; method: 'sessions.subscribe'; params: {sessionId: string}}
  | {id: string; method: 'sessions.unsubscribe'; params: {sessionId: string}}
  | {id: string; method: 'stream.open'}
  | {id: string; method: 'hardware.snapshot'}
  | {id: string; method: 'software.snapshot'}
  | {id: string; method: 'usage.snapshot'}
  | {id: string; method: 'resources.snapshot'}
  | {id: string; method: 'resources.history'; params: {windowMs: number}}
  | {id: string; method: 'spend.summary'; params: {rangeDays?: number}}
  | {id: string; method: 'spend.setPriceOverride'; params: {model: string; override: PriceOverride}}
  | {id: string; method: 'spend.clearPriceOverride'; params: {model: string}}
  | {id: string; method: 'providers.list'}
  | {id: string; method: 'coordination.get'; params: {project: string}}
  | {id: string; method: 'coordination.task.create'; params: {project: string; title: string; sessionId?: string}}
  | {id: string; method: 'coordination.task.update'; params: {project: string; taskId: string; status: 'todo' | 'active' | 'done'; sessionId?: string}}
  | {id: string; method: 'coordination.claim'; params: {project: string; path: string; sessionId: string}}
  | {id: string; method: 'coordination.claims.sweep'}
  | {id: string; method: 'coordination.conflicts'; params: {project: string}}
  | {id: string; method: 'coordination.claim.release'; params: {project: string; path: string; sessionId: string}}
  | {id: string; method: 'coordination.decision.add'; params: {project: string; summary: string; sessionId?: string}}
  | {id: string; method: 'coordination.handoff.create'; params: {project: string; fromSessionId: string; toSessionId: string; summary: string}}
  | {id: string; method: 'coordination.handoff.accept'; params: {project: string; handoffId: string}}
  | {id: string; method: 'remote.list'}
  | {id: string; method: 'remote.save'; params: {name: string; host: string; port?: number; remoteSocket?: string}}
  | {id: string; method: 'remote.connect'; params: {profileId: string}}
  | {id: string; method: 'remote.disconnect'; params: {profileId: string}}
  | {id: string; method: 'openDesign.get'}
  | {id: string; method: 'openDesign.save'; params: {url: string}}
  | {id: string; method: 'openDesign.status'}
  | {id: string; method: 'designTools.list'}
  | {id: string; method: 'designTools.installOpenDesignMcp'; params: {target: McpTarget}}
  | {id: string; method: 'credentials.list'}
  | {id: string; method: 'credentials.upsertAccount'; params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string}}
  | {id: string; method: 'credentials.setChain'; params: {provider: ProviderId; accountIds: string[]}}
  | {id: string; method: 'credentials.setFallbackPolicy'; params: {provider: ProviderId; policy: FallbackPolicy}}
  | {id: string; method: 'credentials.confirmFallback'; params: {provider: ProviderId; accept: boolean; resetAt?: string}}
  | {id: string; method: 'credentials.guidance'; params: {provider: ProviderId}}
  | {id: string; method: 'hooks.report'; params: {cwd: string; event: string; payload: Record<string, unknown>}};

export type RpcResponse =
  | {id: string; ok: true; result: unknown}
  | {id: string; ok: false; error: string};

/** Server-pushed, unsolicited messages sent on a socket after `sessions.subscribe` — distinguished
 * from RpcResponse by having no `id`/`ok` fields. */
export type RpcEvent =
  | {event: 'sessions.output'; sessionId: string; chunk: string}
  | {event: 'sessions.status'; sessionId: string; summary: SessionSummary}
  | {event: 'credential.switched'; provider: ProviderId; accountId: string; reason: 'fallback' | 'revert' | 'manual'}
  | {event: 'credential.notice'; provider: ProviderId; message: string; resetAt?: string; guidance?: FallbackGuidance}
  /** A claim disappeared because its lane stopped renewing it — pushed so a claim never vanishes
   * from the orchestration column without a visible reason (spec §2 principle 3). */
  | {event: 'coordination.claimsExpired'; claims: Array<FileClaim & {project: string}>}
  | {event: 'sessions.verification'; sessionId: string; result: VerificationResult}
  /** Pushed when the set of overlaps in a project changes — a quiet sweep stays quiet. */
  | {event: 'coordination.conflicts'; project: string; conflicts: RankedConflict[]}
  | {event: 'merge.outcome'; outcome: MergeOutcome};

export type CredentialMode = 'subscription' | 'platform-credits' | 'api-key';
export type FallbackPolicy = 'always-ask' | 'always-switch' | 'never-switch';

export type CredentialAccount = {
  id: string;
  provider: ProviderId;
  mode: CredentialMode;
  label: string;
  /** API key material is held in the operating system credential store, never in Fluent state. */
  hasSecret?: boolean;
  baseUrl?: string;
};

/**
 * What a credential switch is about to cost, attached to every fallback notice. A switch changes
 * which account *new* sessions start on; sessions already running keep the credential they were
 * created with, so the switch buys headroom for the next lane rather than rescuing the current one.
 * That, plus the warm prompt cache a new account does not inherit, is the part a user needs in
 * front of them before answering "switch and keep going?".
 */
export type FallbackGuidance = {
  recommendation: 'switch' | 'wait';
  resetsInMs?: number;
  /** Prompt-cache hit ratio last observed on the limited account, where the CLI reported one. */
  cacheHitRatio?: number;
  /** Sessions already running on this provider, which keep their current credential either way. */
  activeSessions: number;
  detail: string;
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

export const daemonSocketPath = () => process.env.FLUENT_SOCKET ?? `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/fluent-code.sock`;
