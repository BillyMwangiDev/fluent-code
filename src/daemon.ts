import {createServer, type Socket} from 'node:net';
import {unlink} from 'node:fs/promises';
import {daemonSocketPath, type RpcEvent, type RpcRequest, type RpcResponse} from './daemon-protocol.js';
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
import {VerificationRunner} from './verification.js';
import {ClaimObserver, type Lane} from './claim-observer.js';
import {MergeQueue} from './merge-queue.js';
import {CodexAppServer} from './codex-app-server.js';
import {renderAgentView, renderClaimResult, resolveId, shortId, viewCursor, type AgentView} from './agent-view.js';
import {AdmissionAdvisor} from './admission.js';
import {renderInbox} from './agent-view.js';
import {installSkill, skillStatus} from './collab-skill.js';
import {EvalRunner, planEvals} from './eval-runner.js';

const socketPath = daemonSocketPath();
const manager = new SessionManager();
const broker = new CredentialBroker();
const hardware = new HardwareMonitor();
const coordination = new CoordinationManager();
const remotes = new RemoteManager();
const software = new SoftwareMonitor();
const usage = new UsageMonitor();
const resources = new ResourceMonitorClient();
const spend = new SpendTracker();
const openDesign = new OpenDesignManager();
const designTools = new DesignToolManager();
const verification = new VerificationRunner();
const claimObserver = new ClaimObserver(coordination);
const merges = new MergeQueue(verification);
/** One structured control channel per running Codex lane, alongside its PTY (R1). */
const codexChannels = new Map<string, CodexAppServer>();
const admission = new AdmissionAdvisor();
const evals = new EvalRunner();

// Only sockets that explicitly opted in via `stream.open` or `sessions.subscribe` receive pushed
// RpcEvents. A plain one-shot request/response socket (ping, sessions.list, ...) must never see
// one interleaved with its reply — that was a real bug caught by the daemon smoke test.
const streamingSockets = new Set<Socket>();
const sessionSubscribers = new Map<string, Set<Socket>>();

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

manager.on('output', (sessionId: string, chunk: string) => {
  for (const socket of sessionSubscribers.get(sessionId) ?? []) pushEvent(socket, {event: 'sessions.output', sessionId, chunk});
});
manager.on('status', (sessionId: string, summary) => {
  for (const socket of sessionSubscribers.get(sessionId) ?? []) pushEvent(socket, {event: 'sessions.status', sessionId, summary});
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
  // on the project's own checks without waiting to be asked. A session sharing the user's own
  // checkout is deliberately left alone: running their suite unprompted in their working tree is
  // intrusive in a way it is not in a lane opened for one task.
  if (summary.status === 'exited' && summary.worktreePath && summary.verification !== 'running') {
    void verifySession(sessionId).catch(error => console.error(`fluentd could not verify ${sessionId}: ${error.message}`));
  }
});
broker.on('switched', (provider, accountId, reason) => {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'credential.switched', provider, accountId, reason});
});
broker.on('notice', (provider, message, resetAt, guidance) => {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'credential.notice', provider, message, resetAt, guidance});
});

/**
 * Runs the lane's project against its own checks and records the result on the session, so what
 * the session list shows is a check that ran rather than the agent's account of its own work.
 */
async function verifySession(sessionId: string, force = false) {
  const session = manager.get(sessionId);
  manager.setVerification(sessionId, 'running');
  const result = await verification.verify({
    sessionId,
    directory: session.directory,
    project: session.projectDirectory ?? session.directory,
    force
  });
  manager.setVerification(sessionId, result.status);
  for (const socket of streamingSockets) pushEvent(socket, {event: 'sessions.verification', sessionId, result});
  return result;
}

/**
 * Queues a lane for integration and re-broadcasts the outcome. The lane is re-read when its turn
 * comes rather than captured now: by then an earlier lane may have merged, moving the base it will
 * be planned against.
 */
async function integrateSession(sessionId: string) {
  const outcome = await merges.integrate(manager.get(sessionId), id => manager.get(id));
  if (outcome.status === 'merged') manager.setVerification(sessionId, outcome.verification?.status);
  for (const socket of streamingSockets) pushEvent(socket, {event: 'merge.outcome', outcome});
  return outcome;
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
function assessAdmission(provider: 'claude' | 'codex', accountId?: string) {
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
function laneFor(cwd: string) {
  const session = manager.findActiveByDirectory(cwd);
  if (!session) throw new Error(`No running Fluent lane is working in ${cwd}`);
  return {session, project: session.projectDirectory ?? session.directory};
}

async function agentView(cwd: string): Promise<AgentView> {
  const {session, project} = laneFor(cwd);
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

async function gitBranch(project: string) {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  return promisify(execFile)('git', ['-C', project, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {timeout: 5_000})
    .then(result => result.stdout.trim() || undefined, () => undefined);
}

/**
 * Answers an agent's combined status query. `since` is the cursor from its own last check: when
 * nothing has changed it gets one short line back instead of the whole picture again, which is the
 * difference between a lane that can afford to check often and one that cannot (spec §11).
 */
async function agentStatus(cwd: string, since?: string) {
  const view = await agentView(cwd);
  if (since && since === view.cursor) return {text: `unchanged ${view.cursor}`, view};
  return {text: renderAgentView(view), view};
}

async function agentClaim(cwd: string, paths: string[]) {
  const {session, project} = laneFor(cwd);
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
function activeSessionCount(provider: 'claude' | 'codex') {
  return manager.list().filter(session => session.provider === provider && (session.status === 'running' || session.status === 'starting')).length;
}

async function handleHookReport({cwd, event, payload}: {cwd: string; event: string; payload: Record<string, unknown>}) {
  const session = manager.findActiveByDirectory(cwd);
  if (!session) return {handled: false};
  if (event === 'StatusLine' && session.provider === 'claude') {
    await usage.recordClaude(session.id, payload);
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
  console.log(`fluentd: hook ${event} for session ${session.id} (${cwd})`);
  return {handled: true};
}

async function dispatch(request: RpcRequest) {
  switch (request.method) {
    case 'ping': return {ok: true, pid: process.pid};
    case 'sessions.list': return manager.list();
    case 'sessions.create': return manager.create({
      ...request.params,
      env: await broker.resolveEnv(request.params.provider, request.params.accountId),
      accountId: request.params.accountId ?? broker.list().find(state => state.provider === request.params.provider)?.activeAccountId
    });
    case 'sessions.get': return manager.get(request.params.sessionId);
    case 'sessions.send': await manager.send(request.params.sessionId, request.params.input); return {sent: true};
    case 'sessions.stop': return manager.stop(request.params.sessionId);
    case 'sessions.removeWorktree': return manager.removeWorktree(request.params.sessionId);
    case 'sessions.diff': return manager.diff(request.params.sessionId);
    case 'sessions.verify': return verifySession(request.params.sessionId, request.params.force ?? true);
    case 'verification.list': return verification.list();
    case 'verification.setCommand': return {command: await verification.setCommand(request.params.project, request.params.command)};
    case 'merge.plan': return merges.plan(manager.get(request.params.sessionId));
    case 'merge.integrate': return integrateSession(request.params.sessionId);
    case 'merge.pending': return merges.pending(request.params.project);
    case 'agent.status': return agentStatus(request.params.cwd, request.params.since);
    case 'agent.claim': return agentClaim(request.params.cwd, request.params.paths);
    case 'agent.release': {
      const {session, project} = laneFor(request.params.cwd);
      for (const path of request.params.paths) await coordination.releaseClaim(project, path, session.id);
      return {text: `released ${request.params.paths.join(' ')}`};
    }
    case 'agent.note': {
      const {session, project} = laneFor(request.params.cwd);
      await coordination.decision(project, request.params.summary, session.id);
      return {text: 'noted'};
    }
    case 'agent.task': {
      const {session, project} = laneFor(request.params.cwd);
      if (request.params.action === 'add') {
        if (!request.params.title?.trim()) throw new Error('A task needs a title');
        const state = await coordination.task(project, request.params.title.trim());
        return {text: `added ${shortId(state.tasks[0]!.id)}`};
      }
      if (!request.params.taskId) throw new Error('Name the task to update');
      const task = resolveId(coordination.get(project).tasks, request.params.taskId);
      await coordination.updateTask(project, task.id, request.params.action === 'start' ? 'active' : 'done', session.id);
      return {text: `${request.params.action === 'start' ? 'started' : 'done'} ${shortId(task.id)}`};
    }
    case 'agent.send': {
      const {session, project} = laneFor(request.params.cwd);
      const target = manager.list().find(candidate => candidate.id === request.params.to || candidate.id.startsWith(request.params.to));
      if (!target) throw new Error(`No lane matches ${request.params.to}`);
      if (target.id === session.id) throw new Error('That is your own lane');
      const message = await coordination.send(project, session.id, target.id, request.params.body);
      // Cross-lane traffic is shown, never hidden (spec §2 principle 3) — including to the user
      // whose two agents are talking to each other.
      for (const socket of streamingSockets) pushEvent(socket, {event: 'coordination.message', project, message});
      return {text: `sent to ${shortId(target.id)} — it will read this when it next checks its inbox`};
    }
    case 'agent.inbox': {
      const {session, project} = laneFor(request.params.cwd);
      return {text: renderInbox(await coordination.inbox(project, session.id, {peek: request.params.peek}))};
    }
    case 'skills.status': return skillStatus();
    case 'skills.install': return installSkill();
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
      const result = await evals.run({
        maxCostUsd: request.params.maxCostUsd,
        caseGlob: request.params.caseGlob,
        env: applyCredentialEnvironment(await broker.resolveEnv('claude').catch(() => undefined))
      });
      for (const socket of streamingSockets) pushEvent(socket, {event: 'evals.finished', run: result});
      return result;
    }
    case 'agent.handoff': {
      const {session, project} = laneFor(request.params.cwd);
      const target = manager.list().find(candidate => candidate.id === request.params.to || candidate.id.startsWith(request.params.to));
      if (!target) throw new Error(`No lane matches ${request.params.to}`);
      await coordination.handoff(project, session.id, target.id, request.params.summary);
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
    case 'spend.summary': return spend.summary(request.params.rangeDays);
    case 'spend.setPriceOverride': await spend.setPriceOverride(request.params.model, request.params.override); return {ok: true};
    case 'spend.clearPriceOverride': await spend.clearPriceOverride(request.params.model); return {ok: true};
    case 'providers.list': return providerHealth();
    case 'admission.assess': return assessAdmission(request.params.provider, request.params.accountId);
    case 'coordination.get': return coordination.get(request.params.project);
    case 'coordination.task.create': return coordination.task(request.params.project, request.params.title, request.params.sessionId);
    case 'coordination.task.update': return coordination.updateTask(request.params.project, request.params.taskId, request.params.status, request.params.sessionId);
    case 'coordination.claim': return coordination.claim(request.params.project, request.params.path, request.params.sessionId);
    case 'coordination.claims.sweep': return sweepClaimLeases();
    case 'coordination.conflicts': return claimObserver.rank(request.params.project, coordination.conflicts(request.params.project));
    case 'coordination.messages': return coordination.messages(request.params.project);
    case 'coordination.claim.release': return coordination.releaseClaim(request.params.project, request.params.path, request.params.sessionId);
    case 'coordination.decision.add': return coordination.decision(request.params.project, request.params.summary, request.params.sessionId);
    case 'coordination.handoff.create': return coordination.handoff(request.params.project, request.params.fromSessionId, request.params.toSessionId, request.params.summary);
    case 'coordination.handoff.accept': return coordination.acceptHandoff(request.params.project, request.params.handoffId);
    case 'remote.list': return remotes.list();
    case 'remote.save': return remotes.save(request.params);
    case 'remote.connect': return remotes.connect(request.params.profileId);
    case 'remote.disconnect': return remotes.disconnect(request.params.profileId);
    case 'openDesign.get': return openDesign.get();
    case 'openDesign.save': return openDesign.save(request.params.url);
    case 'openDesign.status': return openDesign.status();
    case 'designTools.list': return designTools.list();
    case 'designTools.installOpenDesignMcp': return designTools.installOpenDesignMcp(request.params.target);
    case 'credentials.list': return broker.list();
    case 'credentials.upsertAccount': return broker.upsertAccount(request.params.provider, request.params.id, request.params.mode, request.params.label, request.params.apiKey, request.params.baseUrl);
    case 'credentials.setChain': return broker.setChain(request.params.provider, request.params.accountIds);
    case 'credentials.setFallbackPolicy': return broker.setFallbackPolicy(request.params.provider, request.params.policy);
    case 'credentials.confirmFallback': return broker.confirmFallback(request.params.provider, request.params.accept, {resetAt: request.params.resetAt});
    case 'credentials.guidance': return broker.guidance(request.params.provider, {activeSessions: activeSessionCount(request.params.provider)});
    case 'credentials.authStatus': return broker.authStatus('claude');
    case 'hooks.report': return handleHookReport(request.params);
    // sessions.subscribe/unsubscribe/stream.open are handled before dispatch (need the socket).
    case 'sessions.subscribe': case 'sessions.unsubscribe': case 'stream.open': throw new Error(`${request.method} must not reach dispatch`);
  }
}

async function main() {
  await manager.restore();
  await broker.restore();
  await coordination.restore();
  await remotes.restore();
  await usage.restore();
  await spend.restore();
  await openDesign.restore();
  await verification.restore();
  await evals.restore();
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

  const server = createServer(socket => {
    socket.on('close', () => {
      streamingSockets.delete(socket);
      unsubscribe(socket);
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
  server.listen(socketPath, () => console.log(`fluentd listening on ${socketPath}`));
  const shutdown = () => {
    hardware.stop();
    resources.stop();
    for (const channel of codexChannels.values()) channel.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch(error => {
  console.error(`fluentd failed: ${error.message}`);
  process.exitCode = 1;
});
