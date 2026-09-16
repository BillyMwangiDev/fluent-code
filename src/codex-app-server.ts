import {EventEmitter} from 'node:events';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {ProviderQuota, QuotaWindow} from './daemon-protocol.js';

/**
 * Codex's app-server returns empty rate-limit data when asked too soon after `initialize`. Rather
 * than reporting "no limits known" for a session that has them, the first read is retried on this
 * schedule and then left to the event stream.
 */
const initialReadDelaysMs = [1_500, 6_000, 20_000];
const defaultRequestTimeoutMs = 15_000;

type Pending = {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout};

export type CodexApproval = {
  /** The server-request id. This is deliberately opaque: app-server request ids need not be numbers. */
  requestId: string | number;
  /** The documented app-server request method that raised the approval. */
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval' | 'item/permissions/requestApproval';
  kind: 'command' | 'file-change' | 'permissions';
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
};

const approvalMethods = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file-change',
  'item/permissions/requestApproval': 'permissions'
} as const;

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract the small, display-safe common subset of a documented server-initiated approval.
 * In particular, network approvals are intentionally not inferred from a command preview: Codex
 * represents them independently and a client must not pretend one is a shell command.
 */
export function approvalFrom(message: Record<string, unknown>): CodexApproval | undefined {
  const method = typeof message.method === 'string' ? message.method : undefined;
  if (!method || !(method in approvalMethods)) return undefined;
  const requestId = message.id;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return undefined;
  const params = message.params && typeof message.params === 'object'
    ? message.params as Record<string, unknown>
    : {};
  const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : {};
  return {
    requestId,
    method: method as CodexApproval['method'],
    kind: approvalMethods[method as keyof typeof approvalMethods],
    threadId: stringValue(params.threadId),
    turnId: stringValue(params.turnId),
    itemId: stringValue(item.id) ?? stringValue(params.itemId),
    reason: stringValue(params.reason),
    command: stringValue(params.command) ?? stringValue(item.command),
    cwd: stringValue(params.cwd) ?? stringValue(item.cwd),
    grantRoot: stringValue(params.grantRoot)
  };
}

/** The payload Codex reports for one window. Field names are its own. */
type RawWindow = {usedPercent?: number; windowDurationMins?: number; resetsAt?: number | string};

/**
 * Reads one of Codex's rate-limit windows. `resetsAt` is a Unix timestamp; a window that carries
 * nothing useful is dropped entirely so it merges as "unchanged" rather than as an empty window
 * that would overwrite what is already known.
 */
export function windowFrom(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const {usedPercent, windowDurationMins, resetsAt} = raw as RawWindow;
  const window: QuotaWindow = {
    usedPercent: typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? usedPercent : undefined,
    windowMinutes: typeof windowDurationMins === 'number' && Number.isFinite(windowDurationMins) ? windowDurationMins : undefined,
    resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt)
      ? new Date(resetsAt * 1000).toISOString()
      : typeof resetsAt === 'string' ? resetsAt : undefined
  };
  return window.usedPercent === undefined && window.windowMinutes === undefined && window.resetsAt === undefined ? undefined : window;
}

/** Normalizes either shape Codex uses to carry rate limits — the `account/rateLimits/read` result
 * and the `usage.rate_limits` notification carry the same two windows. */
export function quotaFrom(payload: unknown): Partial<ProviderQuota> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const source = payload as Record<string, unknown>;
  const nested = source.rateLimits ?? source.rate_limits ?? source;
  if (!nested || typeof nested !== 'object') return undefined;
  const windows = nested as Record<string, unknown>;
  const primary = windowFrom(windows.primary);
  const secondary = windowFrom(windows.secondary);
  if (!primary && !secondary) return undefined;
  return {primary, secondary, observedAt: new Date().toISOString()};
}

/**
 * A structured control channel for one Codex lane, alongside its PTY.
 *
 * Codex ships an app-server speaking JSON-RPC 2.0 over stdio, which is how a third party is meant
 * to observe a session: turn lifecycle, account state, and rate limits, without scraping a TUI.
 * Before this, the Codex adapter was a bare `spawn('codex')` with no telemetry path at all, and
 * the spec's §14 open risk assumed output pattern-matching might be needed. It is not.
 *
 * This channel observes; it never drives a turn. The PTY session remains the real, unmodified CLI
 * the user is talking to (spec §1), and nothing here reimplements what happens inside a turn.
 *
 * Emits 'quota' (Partial<ProviderQuota>), 'approval' (CodexApproval), and 'closed'.
 */
export class CodexAppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Only the rate-limit poll timers. A request's own timeout rides on its pending record instead,
   * so cancelling the polls can never cancel a request that is still in flight. */
  private pollTimers: NodeJS.Timeout[] = [];
  private closed = false;

  constructor(private readonly options: {executable?: string; cwd?: string; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number; initialReadDelaysMs?: readonly number[]} = {}) {
    super();
  }

  /**
   * Starts the app-server and asks it what it knows. Entirely best-effort: a Codex install too old
   * to have an app-server, or one that fails to start, must not stop the lane's PTY from running —
   * the lane simply has no structured channel, exactly as before.
   */
  async start() {
    if (this.child) return true;
    try {
      this.child = spawn(this.options.executable ?? 'codex', ['app-server'], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams;
    } catch {
      return false;
    }

    this.child.on('error', () => this.stop());
    this.child.on('exit', () => this.stop());
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk as string));
    // The app-server's own diagnostics are not the lane's output and must never reach the terminal.
    this.child.stderr.resume();

    try {
      await this.request('initialize', {clientInfo: {name: 'fluentd', version: '0.1.0'}});
    } catch {
      this.stop();
      return false;
    }

    // App-server's initialize handshake is complete only after this client notification. Sending
    // it also makes the channel safe to extend into a real structured adapter later.
    this.notify('initialized', {});

    this.scheduleInitialReads();
    return true;
  }

  /**
   * Reads current rate limits. Returns undefined when the server has nothing yet — which is a
   * documented state shortly after initialize, not an error.
   */
  async readRateLimits() {
    try {
      const quota = quotaFrom(await this.request('account/rateLimits/read', {}));
      if (quota) this.emit('quota', quota);
      return quota;
    } catch {
      return undefined;
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.pollTimers) clearTimeout(timer);
    this.pollTimers = [];
    for (const {reject, timer} of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('The Codex app-server channel closed'));
    }
    this.pending.clear();
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.emit('closed');
  }

  private scheduleInitialReads() {
    for (const delay of this.options.initialReadDelaysMs ?? initialReadDelaysMs) {
      const timer = setTimeout(() => {
        void this.readRateLimits().then(quota => {
          // Once something real comes back, stop asking — the event stream carries it from here.
          // Only the polls are cancelled; a request still waiting keeps its own timeout.
          if (quota) for (const poll of this.pollTimers) clearTimeout(poll);
        });
      }, delay);
      timer.unref();
      this.pollTimers.push(timer);
    }
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.handle(message);
    }
  }

  private handle(message: Record<string, unknown>) {
    if (typeof message.id === 'number' && (('result' in message) || ('error' in message))) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      if ('error' in message) {
        const error = message.error as {message?: string} | undefined;
        pending.reject(new Error(error?.message ?? 'Codex app-server error'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const approval = approvalFrom(message);
    if (approval) {
      // This process observes a separate app-server instance while the user controls the actual
      // lane in a PTY. It must never turn an observed request into an unreviewed terminal action.
      // Server requests require a response, so fail closed rather than leaving a provider turn
      // hanging. A future adapter that owns `thread/start` can replace this with its user-facing
      // approval decision path.
      this.respond(approval.requestId, approval.kind === 'permissions' ? {permissions: {}} : {decision: 'decline'});
      this.emit('approval', approval);
      return;
    }

    // Notifications. Rate limits can arrive on their own channel or attached to a turn's end;
    // either way they are the same two windows, and either way they are merged, never replaced.
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (!method) return;
    if (method === 'usage.rate_limits' || method.endsWith('rate_limits') || method.endsWith('rateLimits')) {
      const quota = quotaFrom(message.params);
      if (quota) this.emit('quota', quota);
      return;
    }
    if (method === 'turn/completed') {
      // `usage` here is read only for its rate-limit windows, the same shape as the two branches
      // above. A per-turn token count is not part of the documented `turn/completed` payload, so
      // there is nothing here for usage-monitor.ts to price a Codex lane's cost from — it stays
      // unpriced rather than guessed at (see UsageMonitor.priceUsage).
      const quota = quotaFrom((message.params as Record<string, unknown> | undefined)?.usage);
      if (quota) this.emit('quota', quota);
    }
  }

  private request(method: string, params: unknown) {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.child) return reject(new Error('The Codex app-server is not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app-server did not answer ${method}`));
      }, this.options.requestTimeoutMs ?? defaultRequestTimeoutMs);
      timer.unref();
      // The timeout travels with the pending record, so answering the request clears it. Keeping
      // every timer in one array instead grew that array for the whole life of the lane.
      this.pending.set(id, {resolve, reject, timer});
      // The app-server omits the standard "jsonrpc" member; it is a JSON-RPC 2.0 dialect, not
      // strict JSON-RPC, and sending the member is not what it reads.
      this.child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
    });
  }

  private notify(method: string, params: unknown) {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify({method, params})}\n`);
  }

  private respond(id: string | number, result: unknown) {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify({id, result})}\n`);
  }
}
