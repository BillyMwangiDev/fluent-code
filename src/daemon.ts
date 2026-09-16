import {connect, createServer, type Socket} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod, unlink} from 'node:fs/promises';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {daemonSocketPath, fluentProtocolVersion, type ProviderId, type RpcEvent, type RpcRequest, type RpcResponse, type SessionSummary} from './daemon-protocol.js';
import {SessionManager, applyCredentialEnvironment} from './session-manager.js';
import {CredentialBroker} from './credential-broker.js';
import {HardwareMonitor} from './hardware-monitor.js';
import {providerAdapter, providerHealth, resolveProviderExecutable} from './providers.js';
import {CoordinationManager} from './coordination.js';
import {RemoteManager} from './remote-manager.js';
import {SoftwareMonitor} from './software-monitor.js';
import {UsageMonitor} from './usage-monitor.js';
import {ResourceMonitorClient} from './resource-monitor-client.js';
import {SpendTracker} from './spend-tracker.js';
import {OpenDesignManager} from './open-design-manager.js';
import {DesignToolManager} from './design-tool-manager.js';
import {VerificationRunner, discoverCommand} from './verification.js';
import {ClaimObserver, type Lane} from './claim-observer.js';
import {requireSessionInProject} from './coordination-membership.js';
import {MergeQueue} from './merge-queue.js';
import {CodexAppServer} from './codex-app-server.js';
import {renderAgentView, renderClaimResult, renderInbox, resolveId, shortId, viewCursor, type AgentView} from './agent-view.js';
import {AdmissionAdvisor} from './admission.js';
import {collaborationStatus, installCollaboration} from './collab-skill.js';
import {EvalRunner, planEvals} from './eval-runner.js';
import * as sourceControl from './source-control.js';
import * as catalog from './catalog-manager.js';
import {ApprovalRecords, type ApprovalAction} from './security/approval-records.js';
import {ExtensionSourcePolicy, type ExtensionSourcePolicyMode} from './security/extension-source-policy.js';
import {RunEventBus} from './execution/event-bus.js';
import {RecipeRunner} from './recipe-runner.js';
import {isLaneProvider} from './lane-commands.js';
import {assertTicketReady, isLiveLane, laneReadiness, poolRefusal, renderLanes, renderWait, screenText, ticketBrief, validLeadGrant} from './lead-lanes.js';
import {coordCommand} from './agent-briefing.js';
import {isRiskyPermission, sessionOptionArgs} from './session-options.js';
import {attentionDetail, attentionForStatus, type AttentionReason} from './attention.js';
import {shouldAutoVerify} from './auto-verify.js';
import {adoptConventionalPath, adoptLoginShellPath} from './shell-path.js';
import {Memo} from './swr-cache.js';
import {installFacts, installPlan, runInstall} from './installer.js';
import {budgetVerdict, inheritedBudget, validBudgetUsd} from './budget.js';
import {appendCredentialEvent, listCredentialEvents} from './credential-events.js';

const socketPath = daemonSocketPath();
/** Lanes whose exit has already started an automatic verification, so recording that verification's
 * own result cannot start another one. See auto-verify.ts. */
const autoVerified = new Set<string>();
const stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent');
const manager = new SessionManager();
const broker = new CredentialBroker();
const hardware = new HardwareMonitor();
const coordination = new CoordinationManager();
const remotes = new RemoteManager();
const software = new SoftwareMonitor();
const spend = new SpendTracker();
// Priced the same way a spend summary prices a transcript, so a running lane's live estimate and
// its later 30-day summary never disagree about a model's rate.
const usage = new UsageMonitor(undefined, model => spend.rateForModel(model));
const resources = new ResourceMonitorClient();
const openDesign = new OpenDesignManager();
const designTools = new DesignToolManager();
const verification = new VerificationRunner();
const claimObserver = new ClaimObserver(coordination, coordinationLane);
const merges = new MergeQueue(verification);
/** One structured control channel per running Codex lane, alongside its PTY (R1). */
const codexChannels = new Map<string, CodexAppServer>();
const admission = new AdmissionAdvisor();
const evals = new EvalRunner();
const approvals = new ApprovalRecords(stateDirectory);
const extensionSources = new ExtensionSourcePolicy(stateDirectory);
const recipes = new RecipeRunner(stateDirectory);
const runEvents = new RunEventBus(manager.runStore);

// Only sockets that explicitly opted in via `stream.open` or `sessions.subscribe` receive pushed
// RpcEvents. A plain one-shot request/response socket (ping, sessions.list, ...) must never see
// one interleaved with its reply — that was a real bug caught by the daemon smoke test.
const streamingSockets = new Set<Socket>();
const sessionSubscribers = new Map<string, Set<Socket>>();
const runSubscribers = new Map<Socket, string>();
/** The last status each lane was announced for, so one ending is one notification. */
const announcedStatus = new Map<string, string>();
/** Lanes already stopped for budget, so a second usage report for the same lane cannot stop it — or
 * announce it — twice while the first stop is still in flight. */
const budgetStopped = new Set<string>();

function announce(sessionId: string, reason: AttentionReason, summary: SessionSummary, detail?: string) {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'sessions.attention', sessionId, reason, summary, ...(detail ? {detail} : {})});
}

/**
 * Stops a lane the moment its own reported or estimated cost reaches its budget (spec §2.3) — the
 * only local, loop-agnostic safety net this release ships. Called after every usage update so a
 * runaway lane is caught on its very next report; a no-op for a lane with no cap or no cost figure.
 */
async function enforceBudget(sessionId: string) {
  const session = manager.list().find(candidate => candidate.id === sessionId);
  if (!session || session.status !== 'running' || budgetStopped.has(sessionId)) return;
  const verdict = budgetVerdict(usage.get(sessionId), session.budgetUsd);
  if (!verdict.enforceable || !verdict.over) return;
  budgetStopped.add(sessionId);
  await manager.stop(sessionId);
  const summary = manager.setStoppedBy(sessionId, 'budget');
  const detail = `stopped at $${verdict.costUsd!.toFixed(2)} of $${verdict.budgetUsd!.toFixed(2)}`;
  for (const socket of streamingSockets) pushEvent(socket, {event: 'sessions.attention', sessionId, reason: 'budget', summary, detail});
}

function reply(socket: Socket, response: RpcResponse) {
  socket.write(`${JSON.stringify(response)}\n`);
}

function pushEvent(socket: Socket, event: RpcEvent) {
  socket.write(`${JSON.stringify(event)}\n`);
}

function subscribe(socket: Socket, sessionId: string) {
  let subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers) {
    subscribers = new Set();
    sessionSubscribers.set(sessionId, subscribers);
  }
  subscribers.add(socket);
}

function unsubscribe(socket: Socket, sessionId?: string) {
  if (sessionId) {
    sessionSubscribers.get(sessionId)?.delete(socket);
    return;
  }
  for (const subscribers of sessionSubscribers.values()) subscribers.delete(socket);
}

function unsubscribeRun(socket: Socket) {
  const subscription = runSubscribers.get(socket);
  if (subscription) runEvents.unsubscribe(subscription);
  runSubscribers.delete(socket);
}

function subscribeRun(socket: Socket, runId: string, afterSequence?: number) {
  unsubscribeRun(socket);
  const subscription = runEvents.subscribe(runId, afterSequence, delivery => {
    const event: RpcEvent = delivery.kind === 'event'
      ? {event: 'runs.event', runId, data: delivery.event}
      : {event: 'runs.resync_required', runId, from: delivery.from, snapshot: delivery.snapshot, terminalGap: delivery.terminalGap};
    return socket.write(`${JSON.stringify(event)}\n`);
  }, true);
  runSubscribers.set(socket, subscription);
  socket.on('drain', () => runEvents.resume(subscription));
}

manager.on('output', (sessionId: string, chunk: string) => {
  for (const socket of sessionSubscribers.get(sessionId) ?? []) pushEvent(socket, {event: 'sessions.output', sessionId, chunk});
});
manager.on('status', (sessionId: string, summary) => {
  for (const socket of sessionSubscribers.get(sessionId) ?? []) pushEvent(socket, {event: 'sessions.status', sessionId, summary});
  // A lane that ended on its own is worth telling the user about, once per ending. A resumed lane
  // is running again, so its next ending is announced too.
  // A stop fluentd itself ordered for budget is announced by enforceBudget, with the figures; the
  // exit it causes must not also read as "finished".
  const reason = budgetStopped.has(sessionId) ? undefined : attentionForStatus(summary, announcedStatus.get(sessionId));
  if (reason) announce(sessionId, reason, summary);
  if (summary.status === 'running' || summary.status === 'starting') announcedStatus.delete(sessionId);
  else announcedStatus.set(sessionId, summary.status);
  // A lane that is no longer running cannot act on its claims, so it should not hold them. Without
  // this the lease below still frees them, but only after it lapses — this makes it immediate.
  if (summary.status === 'running') {
    // Advisory, and after the fact on purpose: spec §2 principle 4 and §13 keep this a warning in
    // v1, so the lane is already running by the time this is said. It is said anyway, because a
    // machine quietly thrashing is worse than being told why.
    const verdict = assessAdmission(summary.provider, summary.accountId);
    if (verdict.decision === 'over') {
      for (const socket of streamingSockets) pushEvent(socket, {event: 'admission.warning', sessionId, verdict});
    }
  }
  if (summary.provider === 'codex' && summary.status === 'running') {
    void startCodexChannel(sessionId, summary.directory, summary.accountId).catch(error => console.error(`fluentd could not open a Codex channel for ${sessionId}: ${error.message}`));
  }
  if (summary.status === 'exited' || summary.status === 'stopped' || summary.status === 'failed') {
    stopCodexChannel(sessionId);
    void coordination.releaseSession(sessionId).catch(error => console.error(`fluentd could not release claims for ${sessionId}: ${error.message}`));
    broker.forgetSession(summary.provider, sessionId);
  }
  // An isolated lane that exited is done, and its worktree is the thing being judged — so gate it
  // on the project's own checks without waiting to be asked. At most once per exit: recording the
  // result emits another status change, and treating that as a fresh exit made verification
  // re-enter itself until the daemon ran out of heap.
  if (shouldAutoVerify(summary, autoVerified)) {
    void verifySession(sessionId, false, undefined, true).catch(error => console.error(`fluentd could not verify ${sessionId}: ${error.message}`));
  }
});

// Once a local session record is deleted there is nothing meaningful for a stale terminal
// subscriber to receive. The provider was already stopped by the lifecycle guard in SessionManager.
manager.on('deleted', (sessionId: string) => {
  sessionSubscribers.delete(sessionId);
  autoVerified.delete(sessionId);
  budgetStopped.delete(sessionId);
});
manager.runStore.on('event', event => runEvents.publish(event));
broker.on('switched', (provider, accountId, reason, fromAccountId?: string, resetAt?: string) => {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'credential.switched', provider, accountId, reason});
  // Durable, independent of the live push above: the spend page reads this back for a range the
  // socket that switched the credential may no longer be connected for.
  const event = {at: new Date().toISOString(), provider, toAccountId: accountId, reason, ...(fromAccountId ? {fromAccountId} : {}), ...(resetAt ? {resetAt} : {})};
  void appendCredentialEvent(stateDirectory, event).catch(error => console.error(`fluentd could not record a credential event: ${error.message}`));
});
broker.on('notice', (provider, message, resetAt, guidance) => {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'credential.notice', provider, message, resetAt, guidance});
});

/**
 * Runs the lane's project against its own checks and records the result on the session, so what
 * the session list shows is a check that ran rather than the agent's account of its own work.
 */
async function verifySession(sessionId: string, force = false, approvalId?: string, automatic = false) {
  const session = manager.get(sessionId);
  const command = await discoverCommand(session.directory, verification.commandFor(session.projectDirectory ?? session.directory));
  if (!automatic) await approvals.consume({
    id: approvalId,
    action: 'recipe.execute',
    target: session.directory,
    command: command?.command
  });
  await manager.beginVerification(sessionId);
  manager.setVerification(sessionId, 'running');
  const result = await verification.verify({
    sessionId,
    directory: session.directory,
    project: session.projectDirectory ?? session.directory,
    force
  });
  manager.setVerification(sessionId, result.status);
  if (result.status !== 'running') await manager.finishVerification(sessionId, result.status);
  for (const socket of streamingSockets) pushEvent(socket, {event: 'sessions.verification', sessionId, result});
  return result;
}

/**
 * Queues a lane for integration and re-broadcasts the outcome. The lane is re-read when its turn
 * comes rather than captured now: by then an earlier lane may have merged, moving the base it will
 * be planned against.
 */
async function integrateSession(sessionId: string) {
  const session = manager.get(sessionId);
  await manager.beginIntegration(sessionId);
  const outcome = await merges.integrate(session, id => manager.get(id));
  if (outcome.status === 'merged') manager.setVerification(sessionId, outcome.verification?.status);
  await manager.finishIntegration(sessionId, outcome.status === 'merged' ? 'merged' : outcome.status === 'failed' ? 'failed' : 'blocked');
  for (const socket of streamingSockets) pushEvent(socket, {event: 'merge.outcome', outcome});
  return outcome;
}

async function requireApproval(id: string | undefined, action: ApprovalAction, target: string, command?: string, baseSha?: string) {
  return approvals.consume({id, action, target, command, baseSha});
}

function mcpApprovalBinding(targets: readonly ProviderId[], config: import('./catalog-manager.js').McpServerConfig) {
  const target = `mcp:${[...new Set(targets)].sort().join(',')}:${config.name}`;
  const command = config.transport === 'stdio'
    ? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
    : config.url;
  return {target, command};
}

async function allowMarketplaceSource(source: string, trustSource: boolean | undefined, policyApprovalId: string | undefined) {
  const validated = catalog.validateMarketplaceSource(source);
  const policySource = catalog.marketplacePolicySource(validated);
  if (trustSource) {
    await requireApproval(policyApprovalId, 'extension.policy', `marketplace:${validated.source}`, 'trust marketplace source');
    await extensionSources.trust(policySource);
  }
  if (!extensionSources.allows(policySource)) {
    throw new Error(`Marketplace source is not in the trusted extension allowlist: ${policySource.source}. Add it deliberately or switch the policy to review each.`);
  }
  return {validated, policySource};
}

async function allowMcpSource(targets: readonly ProviderId[], config: import('./catalog-manager.js').McpServerConfig, trustSource: boolean | undefined, policyApprovalId: string | undefined) {
  const policySource = catalog.mcpPolicySource(config);
  const binding = mcpApprovalBinding(targets, config);
  if (trustSource) {
    await requireApproval(policyApprovalId, 'extension.policy', binding.target, binding.command);
    await extensionSources.trust(policySource);
  }
  if (!extensionSources.allows(policySource)) {
    throw new Error(`MCP declaration is not in the trusted extension allowlist: ${policySource.source}. Trust this exact declaration deliberately or switch the policy to review each.`);
  }
  return binding;
}

async function allowPluginSource(target: ProviderId, pluginId: string) {
  if (extensionSources.get().mode === 'review-each') return;
  const plugin = (await catalog.allPlugins()).find(candidate => candidate.target === target && candidate.id === pluginId);
  if (!plugin) throw new Error('Cannot establish this plugin’s marketplace source while trusted-only policy is active');
  if (plugin.trust.level === 'provider-bundled') return;
  let source: import('./catalog-manager.js').ExtensionPolicySource;
  try {
    source = catalog.marketplacePolicySource(catalog.validateMarketplaceSource(plugin.source));
  } catch {
    throw new Error(`Plugin source is not eligible for the trusted extension allowlist: ${plugin.source}`);
  }
  if (!extensionSources.allows(source)) throw new Error(`Plugin source is not in the trusted extension allowlist: ${source.source}`);
}

/**
 * Renews the claims of every live lane and drops the ones whose lease lapsed — the safety net for
 * a lane fluentd never saw stop (daemon restart, killed process, machine sleep). Expiries are
 * pushed to streaming clients so a claim never disappears unexplained.
 */
async function sweepClaimLeases() {
  const live = manager.list().filter(session => session.status === 'running' || session.status === 'starting').map(session => session.id);
  const expired = await coordination.renewLeases(live);
  if (expired.length > 0) {
    for (const socket of streamingSockets) pushEvent(socket, {event: 'coordination.claimsExpired', claims: expired});
  }
  return {renewed: live.length, expired};
}

/**
 * Opens Codex's app-server for a lane so fluentd learns its quota from Codex's own reporting
 * rather than from scraping its terminal. Best-effort throughout: a Codex old enough to lack an
 * app-server just means this lane has no structured channel, never that it fails to start.
 */
async function startCodexChannel(sessionId: string, directory: string, accountId?: string) {
  if (codexChannels.has(sessionId)) return;
  let env: NodeJS.ProcessEnv = process.env;
  try {
    env = applyCredentialEnvironment(await broker.resolveEnv('codex', accountId));
  } catch {
    // A missing API key is the PTY's problem to report, not a reason to skip observing the lane.
  }
  const channel = new CodexAppServer({executable: resolveProviderExecutable(providerAdapter('codex')), cwd: directory, env});
  codexChannels.set(sessionId, channel);
  channel.on('quota', quota => {
    void usage.recordQuota(sessionId, 'codex', quota).catch(() => undefined);
    void reportCodexExhaustion(sessionId, accountId).catch(() => undefined);
  });
  channel.on('closed', () => codexChannels.delete(sessionId));
  if (!await channel.start()) {
    codexChannels.delete(sessionId);
    console.log(`fluentd: no Codex app-server for session ${sessionId}; its PTY runs unchanged, without structured telemetry`);
  }
}

/** Lanes already reported as exhausted, so a repeated quota report is not a repeated notice. */
const codexExhausted = new Set<string>();

/**
 * Turns Codex's own quota reporting into the same usage-limit signal the credential broker already
 * gets from Claude Code's `StopFailure` hook.
 *
 * The two signals are not identical and it is worth being precise about it: Claude's is a turn
 * that actually failed, while this is Codex saying a window is spent. It is the closest thing
 * Codex reports without driving its turns, so the threshold is a strict 100% — being slow to
 * announce a limit is better than switching a user's credential on a window that had headroom
 * left.
 */
async function reportCodexExhaustion(sessionId: string, accountId?: string) {
  const windows = [usage.get(sessionId)?.quota?.primary, usage.get(sessionId)?.quota?.secondary].filter(Boolean);
  const spent = windows.filter(window => (window!.usedPercent ?? 0) >= 100);
  if (spent.length === 0) {
    codexExhausted.delete(sessionId);
    return;
  }
  if (codexExhausted.has(sessionId)) return;
  codexExhausted.add(sessionId);
  // Of the spent windows, the one that frees up first is the one worth waiting for.
  const resetAt = spent.map(window => window!.resetsAt).filter(Boolean).sort()[0];
  await broker.reportUsageLimit('codex', {accountId, resetAt, activeSessions: activeSessionCount('codex')});
}

function stopCodexChannel(sessionId: string) {
  codexExhausted.delete(sessionId);
  codexChannels.get(sessionId)?.stop();
  codexChannels.delete(sessionId);
}

claimObserver.on('conflicts', (project: string, conflicts) => {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'coordination.conflicts', project, conflicts});
});

/** Isolated lanes whose working tree is worth reading: a lane sharing the user's own checkout would
 * report the user's uncommitted work as the lane's, which is not a claim anyone made. */
function observableLanes(): Lane[] {
  return manager.list()
    .filter(session => (session.status === 'running' || session.status === 'starting') && session.worktreePath && session.projectDirectory)
    .map(session => ({sessionId: session.id, project: session.projectDirectory!, directory: session.directory}));
}

/**
 * What this machine and this credential have room for. Reads the quota from whichever lane on this
 * provider reported most recently — quota belongs to the account, not to the lane, so any lane's
 * report is the account's state.
 */
function assessAdmission(provider: ProviderId, accountId?: string) {
  const hardwareSample = hardware.snapshot().current;
  const lanes = manager.list().filter(session => session.status === 'running' || session.status === 'starting');
  const reporting = usage.snapshot().sessions.find(session => session.provider === provider && session.quota);
  return admission.assess({
    provider,
    runningLanes: lanes.filter(session => session.provider === provider).length,
    memoryTotalBytes: hardwareSample.memoryTotalBytes,
    memoryUsedBytes: hardwareSample.memoryUsedBytes,
    // The five-hour-shaped window is the one that bites during a working session; the weekly one
    // is a slower problem and is already on the observatory.
    quota: {window: reporting?.quota?.primary, accountId: accountId ?? broker.list().find(state => state.provider === provider)?.activeAccountId}
  });
}

/** Records what each running lane currently costs, so the per-lane estimate becomes this machine's
 * own number rather than a constant (spec §14 asked for a real heuristic; this is how it gets one). */
async function sampleLaneCost() {
  const lanes = manager.list().filter(session => session.status === 'running' && session.pid !== undefined);
  if (lanes.length === 0) return;
  const snapshot = await resources.sampleNow();
  admission.sample(lanes.map(lane => ({provider: lane.provider, pid: lane.pid})), snapshot.processes);
}

/**
 * Resolves the lane a coordination command was run from. An agent knows where it is working and
 * nothing else about fluentd, so the working directory is the whole identity — the same
 * correlation the Claude Code hook relay already relies on.
 */
function laneFor(cwd: string, sessionId?: string) {
  const session = callerLane(cwd, sessionId);
  if (!session) throw new Error(sessionId && knownSession(sessionId) ? `Lane ${shortId(sessionId)} is no longer running` : `No running Fluent lane is working in ${cwd}`);
  return {session, project: session.projectDirectory ?? session.directory};
}

function knownSession(sessionId: string) {
  return manager.list(true).some(session => session.id === sessionId);
}

/**
 * The lane a command or hook came from. A `FLUENT_SESSION_ID` this daemon knows is authoritative even
 * after that lane has exited: falling back to the directory would credit a late hook or command to a
 * sibling lane sharing the checkout — the misattribution the id exists to prevent.
 */
function callerLane(cwd: string, sessionId?: string) {
  if (sessionId && knownSession(sessionId)) return liveSession(sessionId);
  return manager.findActiveByDirectory(cwd);
}

/** The lane a caller named by the `FLUENT_SESSION_ID` it was launched with, if that lane is live. */
function liveSession(sessionId?: string) {
  if (!sessionId) return undefined;
  return manager.list().find(session => session.id === sessionId && (session.status === 'running' || session.status === 'starting'));
}

/** Mutable coordination records name a lane, so validate the lane against the board's project
 * before accepting a caller-supplied id. The frontend is not the security boundary. */
function coordinationLane(project: string, sessionId: string) {
  return requireSessionInProject(project, sessionId, manager.list());
}

async function agentView(cwd: string, sessionId?: string): Promise<AgentView> {
  const {session, project} = laneFor(cwd, sessionId);
  const state = coordination.get(project);
  const conflicts = await claimObserver.rank(project, coordination.conflicts(project));
  const branch = await gitBranch(project);
  const partial = {
    lane: {sessionId: session.id, provider: session.provider, project, branch},
    unread: coordination.unreadCount(project, session.id),
    // Done tasks are history; a lane asking what is going on needs what is still open.
    tasks: state.tasks.filter(task => task.status !== 'done'),
    claims: state.claims,
    conflicts,
    handoffs: state.handoffs
  };
  return {...partial, cursor: viewCursor(partial)};
}

// Imported statically: the packaged fluentd's runtime cannot run a dynamic `import()`, and a lazy
// import here failed every `fluent-coord status` there ("A dynamic import callback was not specified").
const execFileAsync = promisify(execFile);

async function gitBranch(project: string) {
  return execFileAsync('git', ['-C', project, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {timeout: 5_000})
    .then(result => result.stdout.trim() || undefined, () => undefined);
}

/**
 * Answers an agent's combined status query. `since` is the cursor from its own last check: when
 * nothing has changed it gets one short line back instead of the whole picture again, which is the
 * difference between a lane that can afford to check often and one that cannot (spec §11).
 */
async function agentStatus(cwd: string, since?: string, sessionId?: string) {
  const view = await agentView(cwd, sessionId);
  if (since && since === view.cursor) return {text: `unchanged ${view.cursor}`, view};
  return {text: renderAgentView(view), view};
}

async function agentClaim(cwd: string, paths: string[], sessionId?: string) {
  const {session, project} = laneFor(cwd, sessionId);
  if (paths.length === 0) throw new Error('Name at least one path to claim');
  const refused: Array<{path: string; conflicts: Awaited<ReturnType<typeof claimObserver.rank>>}> = [];
  const claimed: string[] = [];
  for (const path of paths) {
    const result = await coordination.claim(project, path, session.id, 'declared');
    if (result.granted) claimed.push(path);
    else refused.push({path, conflicts: await claimObserver.rank(project, result.conflicts)});
  }
  if (refused.length === 0) return {text: renderClaimResult(claimed, true, [])};
  // Report the refusals; anything that was granted alongside them is still granted and is listed
  // so the agent does not re-claim it.
  const text = [
    renderClaimResult(refused.map(entry => entry.path), false, refused.flatMap(entry => entry.conflicts)),
    ...(claimed.length > 0 ? [`claimed ${claimed.join(' ')}`] : [])
  ].join('\n');
  return {text};
}

/** Sessions still holding a credential for this provider — they keep the one they started with,
 * which is precisely why a switch is not the rescue it looks like. */
function activeSessionCount(provider: ProviderId) {
  return manager.list().filter(session => session.provider === provider && (session.status === 'running' || session.status === 'starting')).length;
}

/**
 * A lead lane directing the lanes it started (docs/superpowers/specs/2026-09-15-lead-sessions-design.md).
 * Authority comes only from the user's grant on the lead's own session record, and reaches only
 * lanes whose `parentSessionId` is that lead — never lanes the user or another lead started.
 */
async function laneCommand(params: Extract<RpcRequest, {method: 'agent.lane'}>['params']) {
  const {session: caller, project} = laneFor(params.cwd, params.sessionId);
  const lead = caller.lead;
  if (!lead) {
    throw new Error(caller.parentSessionId
      ? `Only a lead session can start or direct lanes. This lane was started by lead ${shortId(caller.parentSessionId)}; message it with fluent-coord send instead.`
      : 'Only a lead session can start or direct lanes. The user can start a lead session from Fluent Code.');
  }
  const ownLanes = () => manager.list().filter(session => session.parentSessionId === caller.id);
  const ownLane = (reference: string) => {
    const matches = ownLanes().filter(session => session.id === reference || session.id.startsWith(reference));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`${reference} is not one of your lanes — run fluent-coord lane list`);
    throw new Error(`${reference} matches ${matches.length} of your lanes — use more of the id`);
  };
  const bounded = (value: unknown, fallback: number, max: number) =>
    Math.min(Math.max(Math.trunc(typeof value === 'number' && Number.isFinite(value) ? value : fallback), 1), max);

  switch (params.action) {
    case 'list':
      return {text: renderLanes(caller, ownLanes(), coordination.get(project))};
    case 'start': {
      if (!isLaneProvider(params.provider)) throw new Error(`Unknown provider ${String(params.provider)}`);
      const provider = params.provider;
      const running = ownLanes().filter(isLiveLane).length;
      const refusal = poolRefusal(lead, provider, ownLanes());
      if (refusal) throw new Error(refusal);
      const board = coordination.get(project);
      const task = params.taskId ? resolveId(board.tasks, params.taskId) : undefined;
      if (task) assertTicketReady(board, task);
      const prompt = [params.prompt?.trim(), task ? ticketBrief(task, board, caller.id, coordCommand()) : undefined].filter(Boolean).join('\n\n');
      if (!prompt) throw new Error('Give the lane a prompt, or a ticket with --task');
      // The user's lead grant for this project covers the Claude hook write a sessions.create
      // request would otherwise need its own approval for.
      const lane = await manager.create({
        provider,
        directory: project,
        task: prompt,
        env: await broker.resolveEnv(provider),
        accountId: broker.list().find(state => state.provider === provider)?.activeAccountId,
        isolate: !params.shared,
        parentSessionId: caller.id,
        // A subagent a lead starts inherits the lead's own budget cap (spec §2.3).
        budgetUsd: inheritedBudget(undefined, caller)
      });
      if (task) await coordination.assignTask(project, task.id, {sessionId: lane.id, provider}, caller.id);
      let verdict: ReturnType<typeof assessAdmission> | undefined;
      try {
        verdict = assessAdmission(provider);
      } catch {
        // Headroom advice is never the reason a lane start reports failure.
      }
      return {text: [
        `started ${shortId(lane.id)} ${provider} ${lane.worktreePath ? 'isolated' : 'shared'} lanes ${running + 1}/${lead.maxLanes}`,
        ...(task ? [`assigned ${shortId(task.id)}`] : []),
        // Advisory only (spec §2.4): headroom is reported, never a reason the lane did not start.
        ...(verdict && verdict.decision !== 'clear' ? [`headroom ${verdict.decision} — ${verdict.reasons[0] ?? 'see Fluent Code'}`] : [])
      ].join('\n')};
    }
    case 'assign': {
      const lane = ownLane(params.lane);
      if (!isLiveLane(lane)) throw new Error(`Lane ${shortId(lane.id)} is ${lane.status}`);
      const board = coordination.get(project);
      const task = resolveId(board.tasks, params.taskId);
      assertTicketReady(board, task);
      // Delivery first, as in the orchestration screen: the board never says a lane has a ticket
      // its terminal did not accept.
      await manager.inject(lane.id, ticketBrief(task, board, caller.id, coordCommand()));
      await coordination.assignTask(project, task.id, {sessionId: lane.id, provider: lane.provider}, caller.id);
      return {text: `assigned ${shortId(task.id)} to ${shortId(lane.id)} — it has the ticket brief`};
    }
    case 'read': {
      const lane = ownLane(params.lane);
      const {cols, rows} = manager.terminalSize(lane.id);
      const screen = await screenText(manager.get(lane.id).output, cols, rows, bounded(params.lines, 40, 200));
      return {text: `screen ${shortId(lane.id)} ${lane.status}\n${screen || '(blank)'}`};
    }
    case 'wait': {
      const targets = params.lanes?.length ? params.lanes.map(reference => ownLane(reference).id) : ownLanes().map(session => session.id);
      if (targets.length === 0) throw new Error('You have no lanes to wait on');
      const timeoutSeconds = bounded(params.timeoutSeconds, 60, 540);
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        const lanes = manager.list().filter(session => targets.includes(session.id));
        const board = coordination.get(project);
        const ready = lanes.filter(session => laneReadiness(session, caller.id, board));
        if (ready.length > 0 || Date.now() >= deadline) {
          return {text: renderWait(ready.map(session => session.id), timeoutSeconds, renderLanes(caller, lanes, board))};
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    case 'stop': {
      const lane = ownLane(params.lane);
      if (!isLiveLane(lane)) return {text: `${shortId(lane.id)} is already ${lane.status}`};
      await manager.stop(lane.id);
      return {text: `stopped ${shortId(lane.id)}${lane.worktreePath ? ' — its worktree is kept for review' : ''}`};
    }
  }
  throw new Error('Unknown lane action');
}

async function handleHookReport({cwd, sessionId, event, payload}: {cwd: string; sessionId?: string; event: string; payload: Record<string, unknown>}) {
  const session = callerLane(cwd, sessionId);
  if (!session) return {handled: false};
  if (event === 'StatusLine' && session.provider === 'claude') {
    await usage.recordClaude(session.id, payload);
    await enforceBudget(session.id);
    // The status line is where Claude Code reports its own prompt-cache reuse. Handing it to the
    // broker is what lets a fallback notice say what switching costs instead of implying it is
    // free (spec §9 + docs/research/2026-09-13-agent-orchestration.md §2.5).
    const cache = payload.prompt_cache;
    const hitRatio = cache && typeof cache === 'object' && typeof (cache as Record<string, unknown>).hit_ratio === 'number'
      ? (cache as {hit_ratio: number}).hit_ratio
      : undefined;
    broker.observeCache(session.provider, {sessionId: session.id, accountId: session.accountId, hitRatio});
    return {handled: true};
  }
  if (event === 'StopFailure') {
    const errorType = payload.error;
    if (errorType === 'rate_limit' || errorType === 'overloaded' || errorType === 'authentication_failed') {
      await broker.reportUsageLimit(session.provider, {
        accountId: session.accountId,
        resetAt: typeof payload.resetAt === 'string' ? payload.resetAt : undefined,
        activeSessions: activeSessionCount(session.provider)
      });
      return {handled: true};
    }
  }
  if (event === 'Notification') {
    // Claude Code's own "needs your attention" signal, from its hook — never inferred from the screen.
    announce(session.id, 'needs-input', session, attentionDetail(payload));
    return {handled: true};
  }
  console.log(`fluentd: hook ${event} for session ${session.id} (${cwd})`);
  return {handled: true};
}

async function dispatch(request: RpcRequest) {
  switch (request.method) {
    case 'ping': return {ok: true, pid: process.pid, protocolVersion: fluentProtocolVersion};
    case 'sessions.list': return manager.list(request.params?.includeArchived);
    case 'sessions.create': {
      // Letting a session start and direct other agents spends quota on the user's behalf, so the
      // grant and its budget are approval-bound here, never only a frontend checkbox. Validated
      // before any approval is consumed.
      const lead = request.params.lead ? validLeadGrant(request.params.lead) : undefined;
      // Launch options are validated before any consent record is spent. A mode that removes the
      // CLI's own safety prompts needs its own approval, bound to the directory and the mode.
      sessionOptionArgs(request.params.provider, {model: request.params.model, permissionMode: request.params.permissionMode});
      if (isRiskyPermission(request.params.provider, request.params.permissionMode)) {
        await requireApproval(request.params.permissionApprovalId, 'session.permissions', request.params.directory, `permission ${request.params.permissionMode}`);
      }
      // Claude's additive hook relay writes `.claude/settings.json` in the selected project.
      // Creating a terminal is user-initiated, but that project configuration write still needs a
      // daemon-issued, action-bound consent record rather than a frontend-only affordance.
      if (request.params.provider === 'claude') {
        await requireApproval(request.params.approvalId, 'project.configure', request.params.directory, 'configure Claude hooks');
      }
      if (lead) await requireApproval(request.params.leadApprovalId, 'session.lead', request.params.directory, `lead ${lead.maxLanes}`);
      return manager.create({
        ...request.params,
        lead,
        budgetUsd: validBudgetUsd(request.params.budgetUsd),
        // Only a lead's own `lane start` may record a parent; a raw request cannot forge one.
        parentSessionId: undefined,
        env: await broker.resolveEnv(request.params.provider, request.params.accountId),
        accountId: request.params.accountId ?? broker.list().find(state => state.provider === request.params.provider)?.activeAccountId
      });
    }
    case 'sessions.get': return manager.get(request.params.sessionId);
    case 'sessions.send': await manager.send(request.params.sessionId, request.params.input); return {sent: true};
    case 'sessions.inject': return manager.inject(request.params.sessionId, request.params.text, request.params.submit ?? true);
    case 'sessions.stop': return manager.stop(request.params.sessionId);
    case 'sessions.resume': {
      const session = manager.get(request.params.sessionId);
      // Resuming rewrites the same hook settings and relaunches with the same permission mode, so it
      // needs the same consent a new session would.
      if (session.provider === 'claude') await requireApproval(request.params.approvalId, 'project.configure', session.directory, 'configure Claude hooks');
      if (isRiskyPermission(session.provider, session.permissionMode)) {
        await requireApproval(request.params.permissionApprovalId, 'session.permissions', session.directory, `permission ${session.permissionMode}`);
      }
      // A resumed lane is not stopped for budget any more, whatever stopped it last time.
      budgetStopped.delete(session.id);
      return manager.resume(session.id, await broker.resolveEnv(session.provider, session.accountId), validBudgetUsd(request.params.budgetUsd));
    }
    case 'sessions.archive': return manager.archive(request.params.sessionId);
    case 'sessions.restore': return manager.restoreArchived(request.params.sessionId);
    case 'sessions.delete': {
      const session = manager.get(request.params.sessionId);
      await requireApproval(request.params.approvalId, 'session.delete', session.id, `delete local session ${session.id}`);
      return manager.delete(request.params.sessionId);
    }
    case 'sessions.removeWorktree': {
      const session = manager.get(request.params.sessionId);
      await requireApproval(request.params.approvalId, 'worktree.remove', session.worktreePath ?? session.directory, 'git worktree remove');
      return manager.removeWorktree(request.params.sessionId);
    }
    case 'sessions.diff': return manager.diff(request.params.sessionId);
    case 'sessions.verify': return verifySession(request.params.sessionId, request.params.force ?? true, request.params.approvalId);
    case 'verification.list': return verification.list();
    case 'verification.plan': return discoverCommand(request.params.directory, verification.commandFor(request.params.project ?? request.params.directory));
    case 'verification.setCommand': {
      await requireApproval(request.params.approvalId, 'project.configure', request.params.project, request.params.command);
      return {command: await verification.setCommand(request.params.project, request.params.command)};
    }
    case 'merge.plan': return merges.plan(manager.get(request.params.sessionId));
    case 'merge.integrate': {
      const session = manager.get(request.params.sessionId);
      const plan = await merges.plan(session);
      await requireApproval(request.params.approvalId, 'integration.merge', session.projectDirectory ?? session.directory, `git merge ${session.id}`, plan.baseHead);
      return integrateSession(request.params.sessionId);
    }
    case 'merge.pending': return merges.pending(request.params.project);
    case 'agent.status': return agentStatus(request.params.cwd, request.params.since, request.params.sessionId);
    case 'agent.claim': return agentClaim(request.params.cwd, request.params.paths, request.params.sessionId);
    case 'agent.release': {
      const {session, project} = laneFor(request.params.cwd, request.params.sessionId);
      for (const path of request.params.paths) await coordination.releaseClaim(project, path, session.id, session.id);
      return {text: `released ${request.params.paths.join(' ')}`};
    }
    case 'agent.note': {
      const {session, project} = laneFor(request.params.cwd, request.params.sessionId);
      await coordination.decision(project, request.params.summary, session.id, session.id);
      return {text: 'noted'};
    }
    case 'agent.task': {
      const {session, project} = laneFor(request.params.cwd, request.params.sessionId);
      if (request.params.action === 'add') {
        if (!request.params.title?.trim()) throw new Error('A task needs a title');
        const state = await coordination.task(project, {title: request.params.title.trim()}, session.id);
        return {text: `added ${shortId(state.tasks[0]!.id)}`};
      }
      if (!request.params.taskId) throw new Error('Name the task to update');
      const task = resolveId(coordination.get(project).tasks, request.params.taskId);
      await coordination.updateTask(project, task.id, request.params.action === 'start' ? 'active' : 'done', session.id, session.id);
      return {text: `${request.params.action === 'start' ? 'started' : 'done'} ${shortId(task.id)}`};
    }
    case 'agent.send': {
      const {session, project} = laneFor(request.params.cwd, request.params.sessionId);
      const target = manager.list().find(candidate => candidate.id === request.params.to || candidate.id.startsWith(request.params.to));
      if (!target) throw new Error(`No lane matches ${request.params.to}`);
      if (target.id === session.id) throw new Error('That is your own lane');
      coordinationLane(project, target.id);
      const message = await coordination.send(project, session.id, target.id, request.params.body);
      // Cross-lane traffic is shown, never hidden (spec §2 principle 3) — including to the user
      // whose two agents are talking to each other.
      for (const socket of streamingSockets) pushEvent(socket, {event: 'coordination.message', project, message});
      return {text: `sent to ${shortId(target.id)} — it will read this when it next checks its inbox`};
    }
    case 'agent.inbox': {
      const {session, project} = laneFor(request.params.cwd, request.params.sessionId);
      return {text: renderInbox(await coordination.inbox(project, session.id, {peek: request.params.peek}))};
    }
    case 'skills.status': return skillsMemo.get({fresh: request.params?.fresh});
    case 'skills.install': {
      await requireApproval(request.params?.approvalId, 'extension.install', 'fluent-collab', 'install collaboration skill');
      const installed = await installCollaboration();
      skillsMemo.invalidate();
      return installed;
    }
    case 'evals.latest': return {run: evals.last(), running: evals.isRunning()};
    case 'evals.readiness': {
      // The UI needs to ask for consent in the currency the active credential is actually spent in.
      const chain = broker.list().find(state => state.provider === 'claude');
      const account = chain?.accounts.find(candidate => candidate.id === chain.activeAccountId);
      const quota = usage.snapshot().sessions.find(session => session.provider === 'claude' && session.quota)?.quota?.primary;
      return {
        plan: await planEvals(),
        running: evals.isRunning(),
        run: evals.last(),
        accountId: account?.id,
        accountLabel: account?.label,
        mode: account?.mode,
        quotaUsedPercent: quota?.usedPercent,
        quotaResetsAt: quota?.resetsAt
      };
    }
    case 'evals.run': {
      // Never automatic: every case spawns real agent runs on the user's own credential.
      // Run the evaluator on the credential Fluent says is active, not on whatever `claude` itself
      // happens to be logged into — otherwise the app names one account and the run bills another.
      await requireApproval(request.params.approvalId, 'recipe.execute', 'fluent-evals', `claude plugin eval max-cost=${request.params.maxCostUsd ?? 'default'}`);
      const result = await evals.run({
        maxCostUsd: request.params.maxCostUsd,
        caseGlob: request.params.caseGlob,
        env: applyCredentialEnvironment(await broker.resolveEnv('claude').catch(() => undefined))
      });
      for (const socket of streamingSockets) pushEvent(socket, {event: 'evals.finished', run: result});
      return result;
    }
    case 'agent.lane': return laneCommand(request.params);
    case 'agent.handoff': {
      const {session, project} = laneFor(request.params.cwd, request.params.sessionId);
      const target = manager.list().find(candidate => candidate.id === request.params.to || candidate.id.startsWith(request.params.to));
      if (!target) throw new Error(`No lane matches ${request.params.to}`);
      coordinationLane(project, target.id);
      await coordination.handoff(project, session.id, target.id, request.params.summary, session.id);
      // Deliberately only proposed: a handoff is an explicit, visible action the user accepts
      // (spec §11), never something one lane can impose on another.
      return {text: `proposed handoff to ${shortId(target.id)} — waiting for the user to accept it`};
    }
    case 'sessions.resize': manager.resize(request.params.sessionId, request.params.cols, request.params.rows); return {resized: true};
    case 'hardware.snapshot': return hardware.snapshot();
    case 'software.snapshot': return software.snapshot();
    case 'usage.snapshot': return usage.snapshot();
    case 'resources.snapshot': return resources.sampleNow();
    case 'resources.history': return resources.readHistory(request.params.windowMs);
    case 'spend.summary': {
      const summary = await spend.summary(request.params.rangeDays);
      const sinceMs = Date.now() - summary.rangeDays * 24 * 60 * 60 * 1_000;
      return {...summary, credentialEvents: await listCredentialEvents(stateDirectory, sinceMs)};
    }
    case 'spend.setPriceOverride': await spend.setPriceOverride(request.params.model, request.params.override); return {ok: true};
    case 'spend.clearPriceOverride': await spend.clearPriceOverride(request.params.model); return {ok: true};
    case 'sourceControl.repoStatus': return sourceControl.repoStatus(request.params.directory);
    case 'sourceControl.assignedIssues': return sourceControl.assignedIssues({fresh: request.params?.fresh});
    case 'sourceControl.myOpenPullRequests': return sourceControl.myOpenPullRequests({fresh: request.params?.fresh});
    case 'catalog.plugins': return catalog.allPlugins({fresh: request.params?.fresh});
    case 'catalog.installPlugin': {
      await allowPluginSource(request.params.target, request.params.pluginId);
      await requireApproval(request.params.approvalId, 'extension.install', `${request.params.target}:${request.params.pluginId}`, `plugin install ${request.params.pluginId}`);
      const installed = await catalog.installPlugin(request.params.target, request.params.pluginId);
      catalog.invalidateCatalog();
      return installed;
    }
    case 'catalog.marketplaces': return catalog.allMarketplaces({fresh: request.params?.fresh});
    case 'catalog.addMarketplace': {
      // Validate before consuming the one-time approval. An invalid source must not spend the
      // user's consent record or reach a provider CLI as a surprising option/remote string.
      const source = (await allowMarketplaceSource(request.params.source, request.params.trustSource, request.params.policyApprovalId)).validated.source;
      await requireApproval(request.params.approvalId, 'extension.install', `${request.params.target}:${source}`, `marketplace add ${source}`);
      const added = await catalog.addMarketplace(request.params.target, source);
      catalog.invalidateCatalog();
      return added;
    }
    case 'catalog.sourcePolicy.get': return extensionSources.get();
    case 'catalog.sourcePolicy.mode.set': {
      const mode = request.params.mode as ExtensionSourcePolicyMode;
      await requireApproval(request.params.approvalId, 'extension.policy', 'extension-source-policy', `mode ${mode}`);
      return extensionSources.setMode(mode);
    }
    case 'catalog.sourcePolicy.trustMarketplace': {
      const validated = catalog.validateMarketplaceSource(request.params.source);
      await requireApproval(request.params.approvalId, 'extension.policy', `marketplace:${validated.source}`, 'trust marketplace source');
      return extensionSources.trust(catalog.marketplacePolicySource(validated));
    }
    case 'catalog.sourcePolicy.remove': {
      await requireApproval(request.params.approvalId, 'extension.policy', `extension-source-policy:${request.params.sourceId}`, `remove ${request.params.sourceId}`);
      return extensionSources.remove(request.params.sourceId);
    }
    case 'catalog.mcpServers': return catalog.mcpServers({fresh: request.params?.fresh});
    case 'catalog.addMcpServer': {
      const binding = await allowMcpSource(request.params.targets, request.params.config, request.params.trustSource, request.params.policyApprovalId);
      await requireApproval(request.params.approvalId, 'extension.install', binding.target, binding.command);
      const results = await catalog.addMcpServerToTargets(request.params.targets, request.params.config);
      catalog.invalidateCatalog();
      return results;
    }
    case 'providers.list': return providersMemo.get({fresh: request.params?.fresh});
    case 'tools.installPlan': return installPlan(request.params.tool, installFacts(), {agent: request.params.agent});
    case 'tools.install': {
      const plan = installPlan(request.params.tool, installFacts(), {agent: request.params.agent});
      if (!plan.ready) throw new Error(plan.unavailable);
      await requireApproval(request.params.approvalId, 'extension.install', `tool:${plan.tool}`, plan.command);
      const result = await runInstall(plan);
      // Installers add their own bin directory; adopt it and forget every answer that said "not installed".
      adoptConventionalPath();
      providersMemo.invalidate();
      designToolsMemo.invalidate();
      skillsMemo.invalidate();
      return result;
    }
    case 'admission.assess': return assessAdmission(request.params.provider, request.params.accountId);
    case 'coordination.get': return coordination.get(request.params.project);
    case 'coordination.brief.set': return coordination.setMasterBrief(request.params.project, request.params.brief);
    case 'coordination.task.create': {
      if (request.params.sessionId) coordinationLane(request.params.project, request.params.sessionId);
      return coordination.task(request.params.project, request.params);
    }
    case 'coordination.task.assign': {
      if (request.params.sessionId) coordinationLane(request.params.project, request.params.sessionId);
      return coordination.assignTask(request.params.project, request.params.taskId, request.params);
    }
    case 'coordination.task.dependencies.set': {
      return coordination.setDependencies(request.params.project, request.params.taskId, request.params.dependsOn);
    }
    case 'coordination.task.update': {
      if (request.params.sessionId) coordinationLane(request.params.project, request.params.sessionId);
      return coordination.updateTask(request.params.project, request.params.taskId, request.params.status, request.params.sessionId);
    }
    case 'coordination.claim': {
      coordinationLane(request.params.project, request.params.sessionId);
      return coordination.claim(request.params.project, request.params.path, request.params.sessionId);
    }
    case 'coordination.claims.sweep': return sweepClaimLeases();
    case 'coordination.conflicts': return claimObserver.rank(request.params.project, coordination.conflicts(request.params.project));
    case 'coordination.messages': return coordination.messages(request.params.project);
    case 'coordination.claim.release': {
      coordinationLane(request.params.project, request.params.sessionId);
      return coordination.releaseClaim(request.params.project, request.params.path, request.params.sessionId);
    }
    case 'coordination.decision.add': {
      if (request.params.sessionId) coordinationLane(request.params.project, request.params.sessionId);
      return coordination.decision(request.params.project, request.params.summary, request.params.sessionId);
    }
    case 'coordination.handoff.create': {
      coordinationLane(request.params.project, request.params.fromSessionId);
      coordinationLane(request.params.project, request.params.toSessionId);
      return coordination.handoff(request.params.project, request.params.fromSessionId, request.params.toSessionId, request.params.summary);
    }
    case 'coordination.handoff.accept': return coordination.acceptHandoff(request.params.project, request.params.handoffId);
    case 'coordination.handoff.decline': return coordination.declineHandoff(request.params.project, request.params.handoffId);
    case 'coordination.task.edit':
      return coordination.editTask(request.params.project, request.params.taskId, {title: request.params.title, description: request.params.description, role: request.params.role});
    case 'coordination.task.delete': return coordination.deleteTask(request.params.project, request.params.taskId);
    case 'coordination.message.send': {
      // Mail from the user is queued in the lane's inbox like mail from another lane — read when the
      // lane next checks, never typed into its terminal behind its back.
      coordinationLane(request.params.project, request.params.to);
      const message = await coordination.send(request.params.project, 'user', request.params.to, request.params.body);
      for (const socket of streamingSockets) pushEvent(socket, {event: 'coordination.message', project: request.params.project, message});
      return message;
    }
    case 'remote.list': return remotes.list();
    case 'remote.save': {
      await requireApproval(request.params.approvalId, 'remote.configure', `${request.params.host}:${request.params.port ?? 22}`, request.params.remoteSocket);
      return remotes.save(request.params);
    }
    case 'remote.connect': {
      await requireApproval(request.params.approvalId, 'remote.connect', request.params.profileId, 'ssh forward');
      return remotes.connect(request.params.profileId);
    }
    case 'remote.disconnect': return remotes.disconnect(request.params.profileId);
    case 'remote.remove': {
      await requireApproval(request.params.approvalId, 'remote.configure', request.params.profileId, 'remove remote profile');
      return remotes.remove(request.params.profileId);
    }
    case 'openDesign.get': return openDesign.get();
    case 'openDesign.save': return openDesign.save(request.params.url);
    case 'openDesign.status': return openDesign.status();
    case 'designTools.list': return designToolsMemo.get({fresh: request.params?.fresh});
    case 'designTools.installOpenDesignMcp': {
      await requireApproval(request.params.approvalId, 'extension.install', `open-design:${request.params.target}`, 'install OpenDesign MCP');
      return designTools.installOpenDesignMcp(request.params.target);
    }
    case 'credentials.list': return broker.list();
    case 'credentials.upsertAccount': {
      await requireApproval(request.params.approvalId, 'credential.change', `${request.params.provider}:${request.params.id}`, `credential ${request.params.mode}`);
      return broker.upsertAccount(request.params.provider, request.params.id, request.params.mode, request.params.label, request.params.apiKey, request.params.baseUrl, request.params.sameIdentityAs, request.params.model);
    }
    case 'credentials.removeAccount': {
      await requireApproval(request.params.approvalId, 'credential.change', `${request.params.provider}:${request.params.accountId}`, 'remove account');
      return broker.removeAccount(request.params.provider, request.params.accountId);
    }
    case 'credentials.setChain': {
      await requireApproval(request.params.approvalId, 'credential.change', request.params.provider, `chain ${request.params.accountIds.join(',')}`);
      return broker.setChain(request.params.provider, request.params.accountIds);
    }
    case 'credentials.setFallbackPolicy': {
      await requireApproval(request.params.approvalId, 'credential.change', request.params.provider, `fallback ${request.params.policy}`);
      return broker.setFallbackPolicy(request.params.provider, request.params.policy);
    }
    case 'credentials.confirmFallback': return broker.confirmFallback(request.params.provider, request.params.accept, {resetAt: request.params.resetAt});
    case 'credentials.guidance': return broker.guidance(request.params.provider, {activeSessions: activeSessionCount(request.params.provider)});
    case 'credentials.authStatus': return broker.authStatus('claude');
    case 'hooks.report': return handleHookReport(request.params);
    case 'approvals.issue': return approvals.issue(request.params);
    // sessions.subscribe/unsubscribe/stream.open are handled before dispatch (need the socket).
    case 'sessions.subscribe': case 'sessions.unsubscribe': case 'runs.subscribe': case 'runs.unsubscribe': case 'stream.open': throw new Error(`${request.method} must not reach dispatch`);
    case 'runs.list': return manager.runStore.list();
    case 'runs.get': return manager.runStore.get(request.params.runId);
    case 'runs.checkpoint': return manager.checkpoint(request.params.runId);
    case 'recipes.list': return recipes.list(request.params.directory);
    case 'recipes.receipts': return recipes.listReceipts(request.params?.directory);
    case 'recipes.execute': {
      const recipe = await recipes.recipe(request.params.directory, request.params.name);
      await requireApproval(request.params.approvalId, 'recipe.execute', request.params.directory, recipe.command);
      return recipes.execute(request.params.directory, recipe);
    }
  }
}

/**
 * Whether another daemon is listening on the socket path. Anything that accepts the connection
 * counts, answered ping or not: a daemon busy with many lanes can be slow to reply, and treating slow
 * as dead is exactly how a second daemon replaced a live one. Only a refused or missing socket — a
 * leftover file from a daemon that is gone — counts as absent.
 */
function runningDaemon(path: string): Promise<{pid?: number} | undefined> {
  return new Promise(resolve => {
    const socket = connect(path);
    let buffer = '';
    let connected = false;
    const finish = (found?: {pid?: number}) => {
      socket.destroy();
      resolve(found);
    };
    socket.setTimeout(2_000, () => finish(connected ? {} : undefined));
    socket.once('error', () => finish(connected ? {} : undefined));
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({id: 'fluentd-startup-probe', method: 'ping'})}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
        finish(response.ok ? response.result as {pid: number} : {});
      } catch {
        finish({});
      }
    });
  });
}

const stateLock = join(stateDirectory, 'fluentd.lock');

/**
 * Takes the state directory for this daemon alone. The socket guard cannot cover it: a daemon removes
 * its socket as soon as shutdown begins, then keeps journaling its lanes' exits for seconds, and a
 * daemon started in that window restored the same state and wrote it concurrently. A lock left by a
 * daemon that died is taken over once its pid is gone; a live holder gets a short wait, since it is
 * usually still finishing its shutdown.
 */
async function acquireStateLock() {
  mkdirSync(stateDirectory, {recursive: true, mode: 0o700});
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(stateLock, String(process.pid), {flag: 'wx', mode: 0o600});
      process.on('exit', () => {
        try {
          if (readFileSync(stateLock, 'utf8') === String(process.pid)) rmSync(stateLock);
        } catch { /* already gone */ }
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder = Number.NaN;
    try { holder = Number.parseInt(readFileSync(stateLock, 'utf8'), 10); } catch { /* released meanwhile */ }
    if (!pidAlive(holder)) {
      rmSync(stateLock, {force: true});
      continue;
    }
    if (attempt >= 20) {
      console.error(`fluentd state in ${stateDirectory} is in use by pid ${holder}; not starting another`);
      process.exit(1);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function pidAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Probing a CLI costs a process start each; these answers change only when something is installed.
const providersMemo = new Memo(60_000, providerHealth);
const designToolsMemo = new Memo(60_000, () => designTools.list());
const skillsMemo = new Memo(60_000, () => collaborationStatus());

async function main() {
  // Before any probe or lane: see the same PATH the user's terminal does (see shell-path.ts). The
  // usual installer directories apply now; the login shell's own PATH is merged in when it answers,
  // and every "not installed" answer given before then is forgotten.
  adoptConventionalPath();
  void adoptLoginShellPath({timeoutMs: 10_000}).then(result => {
    if (!result.added.length) return;
    console.log(`fluentd PATH: +${result.added.length} director${result.added.length === 1 ? 'y' : 'ies'} from the login shell`);
    providersMemo.invalidate();
    designToolsMemo.invalidate();
    skillsMemo.invalidate();
  });
  // Starting a second daemon used to unlink the first one's socket and listen in its place, leaving
  // the first running but unreachable — together with every lane it held. Each app launch did this,
  // so the window could end up talking to a stale daemon while live lanes sat orphaned. Defer to the
  // daemon that is already answering instead, before touching any state it owns.
  let existing = await runningDaemon(socketPath);
  // A daemon that accepts the connection without answering may only be busy, so give it time. It is
  // never replaced either way: a hung one is reported, because replacing it would orphan its lanes.
  // Each round is the probe's 2s reply timeout plus the pause: five rounds is the ~20s reported below.
  for (let attempt = 0; existing && existing.pid === undefined && attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    existing = await runningDaemon(socketPath);
  }
  if (existing?.pid !== undefined) {
    console.error(`fluentd is already running on ${socketPath} (pid ${existing.pid}); not starting another`);
    process.exit(0);
  }
  if (existing) {
    console.error(`fluentd on ${socketPath} accepts connections but has not answered for 20s; stop that process before starting another`);
    process.exit(1);
  }
  await acquireStateLock();
  await manager.restore();
  // Bounds run history (RunStore.compact); without it the snapshot grows with every lane-hour.
  const compaction = setInterval(() => void manager.runStore.compact().catch(error => console.error(`fluentd run compaction failed: ${error.message}`)), 10 * 60_000);
  compaction.unref();
  await broker.restore();
  await coordination.restore();
  await remotes.restore();
  await usage.restore();
  await spend.restore();
  await openDesign.restore();
  await verification.restore();
  await evals.restore();
  await approvals.restore();
  await extensionSources.restore();
  await recipes.restore();
  resources.start(process.pid);
  hardware.start();
  // Half the lease, so a live lane is always renewed well before its claims could lapse.
  const claimSweep = setInterval(() => void sweepClaimLeases().catch(error => console.error(`fluentd claim sweep failed: ${error.message}`)), 7 * 60_000);
  claimSweep.unref();
  // Frequent enough that an overlap surfaces while both lanes are still working on it, which is
  // the only time it is cheap to resolve; cheap enough to run continuously (one `git status` per
  // isolated lane).
  const observeClaims = setInterval(() => void claimObserver.sweep(observableLanes()).catch(error => console.error(`fluentd claim observation failed: ${error.message}`)), 20_000);
  observeClaims.unref();
  // Slower than the claim sweep: a lane's memory footprint settles, and the estimate wants a
  // spread of lanes over time rather than many readings of the same minute.
  const costSampler = setInterval(() => void sampleLaneCost().catch(() => undefined), 60_000);
  costSampler.unref();
  try {
    await unlink(socketPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket);
    socket.on('close', () => {
      clients.delete(socket);
      streamingSockets.delete(socket);
      unsubscribe(socket);
      unsubscribeRun(socket);
    });

    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let request: RpcRequest | undefined;
        try {
          request = JSON.parse(line) as RpcRequest;
          if (request.method === 'sessions.subscribe') {
            streamingSockets.add(socket);
            subscribe(socket, request.params.sessionId);
            reply(socket, {id: request.id, ok: true, result: manager.get(request.params.sessionId)});
            continue;
          }
          if (request.method === 'sessions.unsubscribe') {
            unsubscribe(socket, request.params.sessionId);
            reply(socket, {id: request.id, ok: true, result: {unsubscribed: true}});
            continue;
          }
          if (request.method === 'runs.subscribe') {
            const page = manager.runStore.eventsSince(request.params.runId, request.params.afterSequence);
            // Subscribe before acknowledging but defer event delivery until after this write. Since
            // Node processes this request synchronously, events after `page` are then delivered
            // strictly after the snapshot/cursor receipt — no reconnect window is guessed at.
            subscribeRun(socket, request.params.runId, page.events.at(-1)?.sequence ?? request.params.afterSequence);
            reply(socket, {id: request.id, ok: true, result: {snapshot: manager.runStore.get(request.params.runId), ...page}});
            continue;
          }
          if (request.method === 'runs.unsubscribe') {
            unsubscribeRun(socket);
            reply(socket, {id: request.id, ok: true, result: {unsubscribed: true}});
            continue;
          }
          if (request.method === 'stream.open') {
            streamingSockets.add(socket);
            reply(socket, {id: request.id, ok: true, result: {streaming: true}});
            continue;
          }
          void dispatch(request).then(result => reply(socket, {id: request!.id, ok: true, result})).catch(error => reply(socket, {id: request!.id, ok: false, error: error.message}));
        } catch (error: unknown) {
          reply(socket, {id: request?.id ?? 'unknown', ok: false, error: error instanceof Error ? error.message : 'invalid request'});
        }
      }
    });
  });
  server.listen({path: socketPath, readableAll: false, writableAll: false}, () => {
    // `readableAll` / `writableAll` make the initial Unix socket owner-only. chmod is a
    // belt-and-suspenders assertion for platforms whose IPC socket defaults follow umask.
    void chmod(socketPath, 0o600)
      .then(() => console.log(`fluentd listening on ${socketPath}`))
      .catch(error => console.error(`fluentd could not secure its socket: ${error.message}`));
    // Warm the screens whose answers come from provider CLIs and GitHub, staggered and well after
    // startup, so the first visit finds a cached answer and a short-lived daemon (tests, a quick
    // status check) never pays for any of it. `claude mcp list` health-checks every server (~10s)
    // and `codex plugin list` asks remote marketplaces; neither belongs on a click.
    const warm = (delayMs: number, label: string, work: () => Promise<unknown>) =>
      setTimeout(() => void work().catch(error => console.error(`fluentd ${label} warm-up failed: ${error.message}`)), delayMs).unref();
    warm(3_000, 'providers', () => providersMemo.get());
    warm(5_000, 'design tools', () => designToolsMemo.get());
    warm(8_000, 'skills', () => skillsMemo.get());
    warm(12_000, 'catalog', () => Promise.all([catalog.allPlugins(), catalog.allMarketplaces(), catalog.mcpServers()]));
    warm(20_000, 'spend', () => spend.warm());
  });
  let shuttingDown = false;
  const shutdown = () => {
    // SIGINT and SIGTERM can both arrive (tsx relays signals and may repeat one); shut down once.
    if (shuttingDown) return;
    shuttingDown = true;
    hardware.stop();
    resources.stop();
    for (const channel of codexChannels.values()) channel.stop();
    // `server.close` only stops new connections and waits for open ones — and the desktop app keeps
    // streams open indefinitely. Waiting for them left a daemon that had already removed its socket
    // running on: unreachable by any new client, yet still holding its lanes.
    server.close();
    for (const client of clients) client.destroy();
    // Lanes end with the daemon rather than being orphaned (see SessionManager.shutdown); the timer
    // bounds a lane that ignores SIGTERM.
    void Promise.all([manager.shutdown(), remotes.shutdown()])
      .catch(error => console.error(`fluentd shutdown: ${error.message}`))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch(error => {
  console.error(`fluentd failed: ${error.message}`);
  process.exitCode = 1;
});
