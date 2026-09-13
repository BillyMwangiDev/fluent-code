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
  /** PTY process id while the lane runs, so its whole process tree can be costed (see admission.ts). */
  pid?: number;
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
/**
 * One provider-reported usage window. Both supported CLIs report the same shape under different
 * names — Claude Code's status line calls them five_hour/seven_day, Codex's app-server calls them
 * primary/secondary — so fluentd normalizes to the window's own duration rather than to either
 * vendor's vocabulary.
 */
export type QuotaWindow = {usedPercent?: number; windowMinutes?: number; resetsAt?: string};
/**
 * Quota as last reported, per provider. Updates are *sparse*: a provider may report only one
 * window, and an absent field means "unchanged", never "cleared" — Codex's app-server documents
 * this explicitly, and treating absence as zero would show a user full headroom they do not have.
 */
export type ProviderQuota = {primary?: QuotaWindow; secondary?: QuotaWindow; observedAt: string};

export type UsageSnapshot = {sessions: Array<{sessionId: string; provider: ProviderId; model?: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; contextPercent?: number; costUsd?: number; cacheHitRatio?: number; quota?: ProviderQuota; updatedAt: string; history: Array<{capturedAt: string; inputTokens?: number; outputTokens?: number; contextPercent?: number; costUsd?: number}>}>};
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

/**
 * Whether there is room for another lane. Advisory by design: spec §2 principle 4 and §13 keep
 * resource intelligence to a recommendation in v1, so this is shown before a lane is opened and
 * never used to refuse one.
 */
export type AdmissionVerdict = {
  provider: ProviderId;
  decision: 'clear' | 'tight' | 'over';
  /** Roughly how many more lanes the free memory would carry. */
  recommendedLanes: number;
  runningLanes: number;
  freeBytes: number;
  reserveBytes: number;
  perLaneBytes: number;
  /** Whether the per-lane figure came from this machine or from a starting-point default. */
  estimateSource: 'observed' | 'default';
  quotaUsedPercent?: number;
  quotaResetsAt?: string;
  accountId?: string;
  reasons: string[];
};

/**
 * One scored eval case. Evals answer what tests cannot: a test proves `fluent-coord` works, an eval
 * measures whether an agent actually *uses* it. `delta` is what the skill was worth on this case
 * under with/without ablation.
 */
/** What a run will cost in work, before it is started. */
export type EvalPlan = {cases: string[]; runsPerCase: number; arms: number; totalRuns: number};
/**
 * Everything the UI needs to ask for consent in the right currency: a subscription is spent in
 * quota, platform credits and an API key in dollars.
 */
export type EvalReadiness = {
  plan: EvalPlan;
  running: boolean;
  run?: EvalRun;
  /** The Claude credential Fluent would run the evaluator on. */
  accountId?: string;
  accountLabel?: string;
  mode?: CredentialMode;
  /** Where that credential's five-hour-shaped window stands, when the provider has reported one. */
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
  /** True when a cost ceiling or interrupt cut the run short — the scores below are incomplete. */
  partial: boolean;
  ablation?: string;
  threshold: number;
  casesTotal: number;
  casesPassed: number;
  overallScore: number;
  overallPassRate: number;
  cases: EvalCaseResult[];
  /** Local path to the self-contained HTML report, never published on the user's behalf. */
  reportPath?: string;
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
/**
 * A message from one lane to another. Durable and ordered per recipient, because the alternative —
 * one agent writing into another's terminal as it runs — is the kind of invisible coordination
 * spec §2 principle 3 rules out. A lane reads its own mail when it is ready to.
 */
export type LaneMessage = {id: string; from: string; to: string; body: string; createdAt: string; readAt?: string};
export type CoordinationState = {project: string; tasks: CoordinationTask[]; claims: FileClaim[]; decisions: Decision[]; handoffs: Handoff[]; messages: LaneMessage[]};
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
  /**
   * The agent-facing surface. Every method identifies its lane by the working directory it was run
   * from, so an agent never has to know or pass a session id — it just runs a command where it is
   * already working (see coord-cli.ts).
   */
  | {id: string; method: 'agent.status'; params: {cwd: string; since?: string}}
  | {id: string; method: 'agent.claim'; params: {cwd: string; paths: string[]}}
  | {id: string; method: 'agent.release'; params: {cwd: string; paths: string[]}}
  | {id: string; method: 'agent.note'; params: {cwd: string; summary: string}}
  | {id: string; method: 'agent.task'; params: {cwd: string; action: 'add' | 'start' | 'done'; title?: string; taskId?: string}}
  | {id: string; method: 'agent.handoff'; params: {cwd: string; to: string; summary: string}}
  | {id: string; method: 'agent.send'; params: {cwd: string; to: string; body: string}}
  | {id: string; method: 'agent.inbox'; params: {cwd: string; peek?: boolean}}
  | {id: string; method: 'skills.status'}
  | {id: string; method: 'skills.install'}
  | {id: string; method: 'evals.latest'}
  | {id: string; method: 'evals.readiness'}
  | {id: string; method: 'evals.run'; params: {maxCostUsd?: number; caseGlob?: string}}
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
  | {id: string; method: 'admission.assess'; params: {provider: ProviderId; accountId?: string}}
  | {id: string; method: 'coordination.get'; params: {project: string}}
  | {id: string; method: 'coordination.task.create'; params: {project: string; title: string; sessionId?: string}}
  | {id: string; method: 'coordination.task.update'; params: {project: string; taskId: string; status: 'todo' | 'active' | 'done'; sessionId?: string}}
  | {id: string; method: 'coordination.claim'; params: {project: string; path: string; sessionId: string}}
  | {id: string; method: 'coordination.claims.sweep'}
  | {id: string; method: 'coordination.conflicts'; params: {project: string}}
  | {id: string; method: 'coordination.messages'; params: {project: string}}
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
  | {id: string; method: 'credentials.authStatus'}
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
  | {event: 'merge.outcome'; outcome: MergeOutcome}
  /** Pushed when a lane starts with no headroom — a warning after the fact, never a refusal. */
  | {event: 'admission.warning'; sessionId: string; verdict: AdmissionVerdict}
  /** A lane sent another lane a message — surfaced so cross-lane traffic is never invisible. */
  | {event: 'coordination.message'; project: string; message: LaneMessage}
  | {event: 'evals.finished'; run: EvalRun};

export type CredentialMode = 'subscription' | 'platform-credits' | 'api-key';

/**
 * Environment changes that put a session on one account. `unset` matters as much as `set`: an
 * inherited `ANTHROPIC_API_KEY` in the user's shell is a credential Fluent did not choose, and a
 * lane it did not choose it for should not inherit it.
 */
export type CredentialEnvironment = {set: Record<string, string>; unset: string[]};

/**
 * Connection state read from the provider CLI's own `auth status`, never from its credential files
 * (spec §7.5). `authMethod` is the CLI's own word for it — `oauth_token` for both Claude
 * subscription and Console billing, an api-key value when a key is in play.
 */
export type AccountAuthStatus = {
  accountId: string;
  provider: ProviderId;
  mode: CredentialMode;
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  /** The exact command that connects this account, for an account that is not connected yet. */
  loginCommand?: string;
  detail?: string;
};
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
