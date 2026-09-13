import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {realpathSync} from 'node:fs';
import {delimiter, dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as pty from 'node-pty';
import {providerAdapter, resolveProviderExecutable} from './providers.js';
import {ensureClaudeHooks} from './hooks-config.js';
import {WorktreeManager} from './worktree-manager.js';
import {briefingArgs} from './agent-briefing.js';
import type {CredentialEnvironment, ProviderId, SessionSnapshot, SessionStatus, SessionSummary} from './daemon-protocol.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';
import {RunStore} from './execution/run-store.js';

const run = promisify(execFile);

type LiveSession = {
  terminal?: pty.IPty;
  output: string;
  summary: SessionSummary;
  directory: string;
};

type StoredSession = {summary: SessionSummary; directory: string; /** Legacy only; never written again. */ output?: string};

const maxOutputBytes = 160_000;

/**
 * Builds a lane's environment from the daemon's own, the credential's changes, and any overrides.
 *
 * The `unset` half is the part that matters and the part a plain spread cannot do: a credential
 * variable exported in the user's shell is inherited by the daemon and would otherwise reach every
 * lane, including lanes Fluent put on a different account.
 */
export function applyCredentialEnvironment(credential?: CredentialEnvironment, overrides: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const name of credential?.unset ?? []) delete env[name];
  return {...env, ...(credential?.set ?? {}), ...overrides};
}

/** Emits 'output' (sessionId, chunk) and 'status' (sessionId, summary) so daemon.ts can push
 * `sessions.subscribe` events without the manager knowing anything about sockets/RPC. */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly stateFile: string;
  readonly runStore: RunStore;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly worktrees = new WorktreeManager();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    super();
    this.stateFile = join(stateDirectory, 'sessions.json');
    this.runStore = new RunStore(stateDirectory);
  }

  async restore() {
    await this.runStore.restore();
    try {
      const stored = await readPrivateJson<StoredSession[]>(this.stateFile);
      if (!stored) return;
      let migrated = false;
      for (const item of stored) {
        const wasLive = item.summary.status === 'running' || item.summary.status === 'starting';
        this.sessions.set(item.summary.id, {
          ...item,
          output: '', // terminal text is intentionally memory-only, including legacy restore.
          summary: item.summary.status === 'running' || item.summary.status === 'starting'
            ? {...item.summary, status: 'stopped', updatedAt: new Date().toISOString()}
            : item.summary
        });
        if (item.output !== undefined || item.summary.task !== undefined) migrated = true;
        await this.projectRestoredSession(this.sessions.get(item.summary.id)!, wasLive);
      }
      if (migrated) await this.persist();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map(({summary}) => summary)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(sessionId: string): SessionSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return {...session.summary, output: session.output};
  }

  async create({provider, directory, task, env, accountId, isolate}: {provider: ProviderId; directory: string; task?: string; env?: CredentialEnvironment; accountId?: string; isolate?: boolean}) {
    const adapter = providerAdapter(provider);
    const executable = resolveProviderExecutable(adapter);
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.runStore.create({id, provider, accountId, adapter: {id: 'pty', version: '1', capabilities: {structuredEvents: 'unavailable', providerFirstEvent: 'unavailable'}}});
    await this.runStore.transition(id, 'preparing', 'session creation started', {adapter: 'pty'});
    await this.runStore.markTiming(id, 'provider.first_event', {atWall: now, available: false, detail: 'terminal-only PTY adapter'});
    let worktree;
    try {
      worktree = isolate ? await this.worktrees.create(directory, id) : undefined;
    } catch (error) {
      await this.runStore.transition(id, 'failed', 'workspace preparation failed', {adapter: 'pty'});
      throw error;
    }
    const sessionDirectory = worktree?.path ?? directory;
    const summary: SessionSummary = {
      id,
      provider,
      command: adapter.executable,
      directory: sessionDirectory,
      task: task?.trim() || undefined,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      accountId,
      projectDirectory: worktree?.projectDirectory,
      worktreePath: worktree?.path,
      prepareMs: worktree?.prepareMs,
      warmedPaths: worktree?.warmedPaths
    };
    const session: LiveSession = {summary, output: '', directory: sessionDirectory};
    this.sessions.set(summary.id, session);
    if (worktree) await this.runStore.setWorkspace(id, {path: worktree.path, projectDirectory: worktree.projectDirectory});
    await this.persist();

    if (provider === 'claude') {
      // Best-effort: a session should still start even if the directory isn't writable.
      await ensureClaudeHooks(sessionDirectory).catch(error => console.error(`fluentd could not configure Claude Code hooks: ${error.message}`));
    }

    // node-pty creates the terminal; Fluent still launches the provider CLI unchanged apart from
    // the coordination briefing, which goes in through that CLI's own flag for project direction
    // (spec §7.5) — never by rewriting what the CLI does or what it prints.
    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(executable, [...adapter.args, ...briefingArgs(provider)], {
      cwd: sessionDirectory,
      env: applyCredentialEnvironment(env, {
        // See providers.ts: preserve the Node bin that owns a discovered NVM CLI so its
        // `env node` shebang resolves inside the detached daemon as well.
        PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)
      }),
      name: process.env.TERM ?? 'xterm-256color',
      cols: 120,
      rows: 40
      });
    } catch (error) {
      await this.runStore.transition(id, 'failed', 'provider process could not start', {adapter: 'pty'});
      this.setStatus(session, 'failed');
      throw error;
    }
    session.terminal = terminal;
    session.summary.pid = terminal.pid;
    this.append(session, `$ ${adapter.executable}\n`);
    terminal.onData(chunk => this.append(session, chunk));
    await this.runStore.ready(id, {adapter: 'pty'});
    await this.runStore.transition(id, 'running', 'provider process spawned', {adapter: 'pty'});
    this.setStatus(session, 'running');
    terminal.onExit(({exitCode}) => {
      session.terminal = undefined;
      session.summary.pid = undefined;
      session.summary.exitCode = exitCode;
      this.setStatus(session, session.summary.status === 'stopped' ? 'stopped' : 'exited');
      void this.finishRun(session.summary.id, session.summary.status, exitCode).catch(error => console.error(`fluentd could not finalize run ${session.summary.id}: ${error.message}`));
    });

    if (summary.task) {
      // Give the interactive CLI a brief moment to initialize before delivering the first prompt.
      setTimeout(() => this.send(summary.id, `${summary.task}\n`).catch(() => undefined), 600).unref();
    }
    return summary;
  }

  async send(sessionId: string, input: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.terminal || session.summary.status !== 'running') throw new Error('Session is not accepting input');
    // A PTY write is only delivery intent. There is no provider acknowledgement we can prove, so
    // a restart after this point remains reviewable rather than being replayed automatically.
    await this.runStore.dispatchIntent(sessionId, {inputBytes: Buffer.byteLength(input)});
    session.terminal.write(input);
    session.summary.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /** Keeps the PTY's own idea of terminal size in sync with whatever xterm.js actually rendered
   * client-side — without this, a CLI drawing for its spawn-time size (see `create`'s hardcoded
   * cols/rows) wraps and truncates against a differently-sized viewport. */
  resize(sessionId: string, cols: number, rows: number) {
    const session = this.sessions.get(sessionId);
    session?.terminal?.resize(cols, rows);
  }

  async stop(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.terminal) session.terminal.kill('SIGTERM');
    const run = this.runStore.get(sessionId);
    if (run.state !== 'cancelled' && run.state !== 'failed' && run.state !== 'succeeded' && run.state !== 'lost') {
      await this.runStore.transition(sessionId, 'cancelled', 'user stopped session', {adapter: 'pty'});
      await this.runStore.record(sessionId, 'run.finished', {status: 'cancelled'}, {adapter: 'pty'});
    }
    this.setStatus(session, 'stopped');
    return session.summary;
  }

  async removeWorktree(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.terminal) throw new Error('Stop the session before removing its worktree');
    if (!session.summary.worktreePath) throw new Error('This session does not use an isolated worktree');
    await this.worktrees.remove(session.summary.projectDirectory ?? session.summary.worktreePath, session.summary.worktreePath);
    session.summary.worktreePath = undefined;
    await this.persist();
    return session.summary;
  }

  /** Records the outcome of the project's own checks against this lane. Emits a status change so
   * subscribers re-render: a verification result is part of how a lane reads, not a side note. */
  setVerification(sessionId: string, verification: SessionSummary['verification']) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.summary.verification = verification;
    session.summary.updatedAt = new Date().toISOString();
    this.queuePersist();
    this.emit('status', session.summary.id, session.summary);
    return session.summary;
  }

  async beginVerification(sessionId: string) {
    const run = this.runStore.get(sessionId);
    if (run.state === 'verifying') return run;
    if (run.state === 'running' || run.state === 'succeeded') return this.runStore.transition(sessionId, 'verifying', 'verification started', {adapter: run.adapter.id});
    return run;
  }

  async finishVerification(sessionId: string, status: Exclude<SessionSummary['verification'], 'running'>) {
    const run = this.runStore.get(sessionId);
    await this.runStore.record(sessionId, 'verification.finished', {status}, {adapter: run.adapter.id});
    if (run.state !== 'verifying') return run;
    if (status === 'passed') return this.runStore.transition(sessionId, 'succeeded', 'verification passed', {adapter: run.adapter.id});
    if (status === 'unavailable') return this.runStore.transition(sessionId, 'blocked', 'verification unavailable', {adapter: run.adapter.id});
    return this.runStore.transition(sessionId, 'failed', 'verification failed', {adapter: run.adapter.id});
  }

  async beginIntegration(sessionId: string) {
    const run = this.runStore.get(sessionId);
    if (run.state === 'succeeded') return this.runStore.transition(sessionId, 'integrating', 'integration started', {adapter: run.adapter.id});
    return run;
  }

  async finishIntegration(sessionId: string, status: 'merged' | 'failed' | 'blocked') {
    const run = this.runStore.get(sessionId);
    await this.runStore.record(sessionId, 'integration.finished', {status}, {adapter: run.adapter.id});
    if (run.state !== 'integrating') return run;
    if (status === 'merged') return this.runStore.transition(sessionId, 'succeeded', 'integration merged', {adapter: run.adapter.id});
    return this.runStore.transition(sessionId, status === 'blocked' ? 'blocked' : 'failed', `integration ${status}`, {adapter: run.adapter.id});
  }

  async diff(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    try {
      const [statusResult, diffResult] = await Promise.all([
        run('git', ['-C', session.directory, 'status', '--short'], {timeout: 5_000}),
        run('git', ['-C', session.directory, 'diff', '--no-ext-diff', '--unified=3'], {timeout: 8_000, maxBuffer: 512_000})
      ]);
      const patch = diffResult.stdout;
      const limit = 120_000;
      return {status: statusResult.stdout.trim() || 'working tree clean', patch: patch.slice(0, limit), truncated: patch.length > limit};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Git review is unavailable for this session: ${message}`);
    }
  }

  /** Most recently updated session in `cwd` still able to receive a hook signal — used to
   * correlate a Claude Code hook payload (which only carries the CLI's own cwd/session_id, not
   * Fluent's session id) back to the fluentd session that spawned it. */
  findActiveByDirectory(cwd: string): SessionSummary | undefined {
    const canonical = (directory: string) => {
      try { return realpathSync.native(directory); } catch { return directory; }
    };
    const canonicalCwd = canonical(cwd);
    return [...this.sessions.values()]
      .filter(session => canonical(session.directory) === canonicalCwd && (session.summary.status === 'running' || session.summary.status === 'starting'))
      .map(session => session.summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  private append(session: LiveSession, chunk: string) {
    session.output = (session.output + chunk).slice(-maxOutputBytes);
    session.summary.updatedAt = new Date().toISOString();
    this.queuePersist();
    this.emit('output', session.summary.id, chunk);
    // The terminal view remains live, but the durable event only records a redacted observation
    // count. Persisting raw terminal text would turn the trace into an accidental secret store.
    void this.runStore.record(session.summary.id, 'text.delta', {bytes: Buffer.byteLength(chunk)}, {adapter: 'pty'}).catch(error => console.error(`fluentd could not record terminal observation: ${error.message}`));
  }

  private setStatus(session: LiveSession, status: SessionStatus) {
    session.summary.status = status;
    session.summary.updatedAt = new Date().toISOString();
    this.queuePersist();
    this.emit('status', session.summary.id, session.summary);
  }

  private async persist() {
    const operation = this.persistQueue.then(() => this.persistNow());
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persistNow() {
    const stored = [...this.sessions.values()].map(({summary, directory}) => {
      // Prompt/task text and raw output belong only to the live terminal. The durable projection
      // deliberately keeps enough metadata for a session list and recovery decision, no more.
      const {task: _task, ...safeSummary} = summary;
      return {summary: safeSummary, directory} satisfies StoredSession;
    });
    await writePrivateJson(this.stateFile, stored);
  }

  private queuePersist() {
    void this.persist().catch(error => console.error(`fluentd could not persist sessions: ${error.message}`));
  }

  private async finishRun(sessionId: string, status: SessionStatus, exitCode: number) {
    const run = this.runStore.get(sessionId);
    if (run.state === 'cancelled' || run.state === 'failed' || run.state === 'succeeded' || run.state === 'lost') return;
    const session = this.sessions.get(sessionId);
    const next = status === 'stopped' ? 'cancelled' : exitCode === 0 ? (session?.summary.worktreePath ? 'verifying' : 'succeeded') : 'failed';
    await this.runStore.transition(sessionId, next, status === 'stopped' ? 'session stopped' : `provider exited ${exitCode}`, {adapter: 'pty'});
    await this.runStore.record(sessionId, next === 'failed' ? 'run.failed' : 'run.finished', {status: next, exitCode}, {adapter: 'pty'});
  }

  private async projectRestoredSession(session: LiveSession, wasLive: boolean) {
    if (!this.runStore.has(session.summary.id)) {
      await this.runStore.create({
        id: session.summary.id,
        provider: session.summary.provider,
        accountId: session.summary.accountId,
        adapter: {id: 'pty', version: 'legacy', capabilities: {structuredEvents: 'unavailable', providerFirstEvent: 'unavailable'}},
        workspace: session.summary.worktreePath ? {path: session.summary.worktreePath, projectDirectory: session.summary.projectDirectory} : undefined
      });
      await this.runStore.transition(session.summary.id, 'preparing', 'legacy session projection', {adapter: 'pty'});
      await this.runStore.ready(session.summary.id, {adapter: 'pty'});
      await this.runStore.transition(session.summary.id, 'running', 'legacy session projection', {adapter: 'pty'});
    }
    const run = this.runStore.get(session.summary.id);
    if (wasLive && run.state !== 'lost' && run.state !== 'failed' && run.state !== 'cancelled' && run.state !== 'succeeded') {
      await this.runStore.transition(session.summary.id, 'lost', 'daemon restarted while PTY session was active', {adapter: 'pty'});
      await this.runStore.record(session.summary.id, 'run.failed', {reason: 'PTY cannot be resumed automatically'}, {adapter: 'pty'});
    }
  }
}
