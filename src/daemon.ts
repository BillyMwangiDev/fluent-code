import {createServer, type Socket} from 'node:net';
import {unlink} from 'node:fs/promises';
import {daemonSocketPath, type RpcEvent, type RpcRequest, type RpcResponse} from './daemon-protocol.js';
import {SessionManager} from './session-manager.js';
import {CredentialBroker} from './credential-broker.js';
import {HardwareMonitor} from './hardware-monitor.js';
import {providerHealth} from './providers.js';
import {CoordinationManager} from './coordination.js';
import {RemoteManager} from './remote-manager.js';
import {SoftwareMonitor} from './software-monitor.js';
import {UsageMonitor} from './usage-monitor.js';
import {ResourceMonitorClient} from './resource-monitor-client.js';
import {SpendTracker} from './spend-tracker.js';
import {OpenDesignManager} from './open-design-manager.js';
import {DesignToolManager} from './design-tool-manager.js';
import * as sourceControl from './source-control.js';

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
});
broker.on('switched', (provider, accountId, reason) => {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'credential.switched', provider, accountId, reason});
});
broker.on('notice', (provider, message, resetAt) => {
  for (const socket of streamingSockets) pushEvent(socket, {event: 'credential.notice', provider, message, resetAt});
});

async function handleHookReport({cwd, event, payload}: {cwd: string; event: string; payload: Record<string, unknown>}) {
  const session = manager.findActiveByDirectory(cwd);
  if (!session) return {handled: false};
  if (event === 'StatusLine' && session.provider === 'claude') {
    await usage.recordClaude(session.id, payload);
    return {handled: true};
  }
  if (event === 'StopFailure') {
    const errorType = payload.error;
    if (errorType === 'rate_limit' || errorType === 'overloaded' || errorType === 'authentication_failed') {
      await broker.reportUsageLimit(session.provider, {accountId: session.accountId, resetAt: typeof payload.resetAt === 'string' ? payload.resetAt : undefined});
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
    case 'sessions.resize': manager.resize(request.params.sessionId, request.params.cols, request.params.rows); return {resized: true};
    case 'hardware.snapshot': return hardware.snapshot();
    case 'software.snapshot': return software.snapshot();
    case 'usage.snapshot': return usage.snapshot();
    case 'resources.snapshot': return resources.sampleNow();
    case 'resources.history': return resources.readHistory(request.params.windowMs);
    case 'spend.summary': return spend.summary(request.params.rangeDays);
    case 'spend.setPriceOverride': await spend.setPriceOverride(request.params.model, request.params.override); return {ok: true};
    case 'spend.clearPriceOverride': await spend.clearPriceOverride(request.params.model); return {ok: true};
    case 'sourceControl.repoStatus': return sourceControl.repoStatus(request.params.directory);
    case 'sourceControl.assignedIssues': return sourceControl.assignedIssues();
    case 'sourceControl.myOpenPullRequests': return sourceControl.myOpenPullRequests();
    case 'providers.list': return providerHealth();
    case 'coordination.get': return coordination.get(request.params.project);
    case 'coordination.task.create': return coordination.task(request.params.project, request.params.title, request.params.sessionId);
    case 'coordination.task.update': return coordination.updateTask(request.params.project, request.params.taskId, request.params.status, request.params.sessionId);
    case 'coordination.claim': return coordination.claim(request.params.project, request.params.path, request.params.sessionId);
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
  resources.start(process.pid);
  hardware.start();
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
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch(error => {
  console.error(`fluentd failed: ${error.message}`);
  process.exitCode = 1;
});
