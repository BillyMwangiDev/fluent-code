import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {delimiter, dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as pty from 'node-pty';
import {providerAdapter, resolveProviderExecutable} from './providers.js';
import {ensureClaudeHooks} from './hooks-config.js';
import {WorktreeManager} from './worktree-manager.js';
import {briefingArgs} from './agent-briefing.js';
import type {ProviderId, SessionSnapshot, SessionStatus, SessionSummary} from './daemon-protocol.js';

const run = promisify(execFile);

type LiveSession = {
  terminal?: pty.IPty;
  output: string;
  summary: SessionSummary;
  directory: string;
};

type StoredSession = Omit<LiveSession, 'child'>;

const maxOutputBytes = 160_000;

/** Emits 'output' (sessionId, chunk) and 'status' (sessionId, summary) so daemon.ts can push
 * `sessions.subscribe` events without the manager knowing anything about sockets/RPC. */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly stateFile: string;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly worktrees = new WorktreeManager();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    super();
    this.stateFile = join(stateDirectory, 'sessions.json');
  }

  async restore() {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const stored = JSON.parse(raw) as StoredSession[];
      for (const item of stored) {
        this.sessions.set(item.summary.id, {
          ...item,
          summary: item.summary.status === 'running' || item.summary.status === 'starting'
            ? {...item.summary, status: 'stopped', updatedAt: new Date().toISOString()}
            : item.summary
        });
      }
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

  async create({provider, directory, task, env, accountId, isolate}: {provider: ProviderId; directory: string; task?: string; env?: Record<string, string>; accountId?: string; isolate?: boolean}) {
    const adapter = providerAdapter(provider);
    const executable = resolveProviderExecutable(adapter);
    const now = new Date().toISOString();
    const id = randomUUID();
    const worktree = isolate ? await this.worktrees.create(directory, id) : undefined;
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
    await this.persist();

    if (provider === 'claude') {
      // Best-effort: a session should still start even if the directory isn't writable.
      await ensureClaudeHooks(sessionDirectory).catch(error => console.error(`fluentd could not configure Claude Code hooks: ${error.message}`));
    }

    // node-pty creates the terminal; Fluent still launches the provider CLI unchanged apart from
    // the coordination briefing, which goes in through that CLI's own flag for project direction
    // (spec §7.5) — never by rewriting what the CLI does or what it prints.
    const terminal = pty.spawn(executable, [...adapter.args, ...briefingArgs(provider)], {
      cwd: sessionDirectory,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        ...env,
        // See providers.ts: preserve the Node bin that owns a discovered NVM CLI so its
        // `env node` shebang resolves inside the detached daemon as well.
        PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)
      },
      name: process.env.TERM ?? 'xterm-256color',
      cols: 120,
      rows: 40
    });
    session.terminal = terminal;
    session.summary.pid = terminal.pid;
    this.append(session, `$ ${adapter.executable}\n`);
    terminal.onData(chunk => this.append(session, chunk));
    this.setStatus(session, 'running');
    terminal.onExit(({exitCode}) => {
      session.terminal = undefined;
      session.summary.pid = undefined;
      session.summary.exitCode = exitCode;
      this.setStatus(session, session.summary.status === 'stopped' ? 'stopped' : 'exited');
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
    return [...this.sessions.values()]
      .filter(session => session.directory === cwd && (session.summary.status === 'running' || session.summary.status === 'starting'))
      .map(session => session.summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  private append(session: LiveSession, chunk: string) {
    session.output = (session.output + chunk).slice(-maxOutputBytes);
    session.summary.updatedAt = new Date().toISOString();
    this.queuePersist();
    this.emit('output', session.summary.id, chunk);
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
    await mkdir(dirname(this.stateFile), {recursive: true});
    const serialized = JSON.stringify([...this.sessions.values()].map(({terminal: _terminal, ...stored}) => stored), null, 2);
    const temporary = `${this.stateFile}.tmp`;
    await writeFile(temporary, serialized, 'utf8');
    await rename(temporary, this.stateFile);
  }

  private queuePersist() {
    void this.persist().catch(error => console.error(`fluentd could not persist sessions: ${error.message}`));
  }
}
