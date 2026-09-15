import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {realpathSync} from 'node:fs';
import {delimiter, dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {providerAdapter, providerLaunchArgs, resolveProviderExecutable} from './providers.js';
import {ensureClaudeHooks} from './hooks-config.js';
import {WorktreeManager} from './worktree-manager.js';
import {briefingArgs, leadDirection} from './agent-briefing.js';
import {ptyRuntime} from './pty-runtime.js';
import type {CredentialEnvironment, ProviderId, SessionSnapshot, SessionStatus, SessionSummary} from './daemon-protocol.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';
import {RunStore} from './execution/run-store.js';

const run = promisify(execFile);

type LiveSession = {
  terminal?: import('node-pty').IPty;
  output: string;
  summary: SessionSummary;
  directory: string;
  /** Whether the CLI has turned on bracketed paste, read from its own terminal output. */
  bracketedPaste?: boolean;
  /** The end of the previous chunk, so a mode sequence split across two reads is still seen. */
  modeTail?: string;
  /** Output bytes seen since the last durable observation was recorded. */
  pendingOutputBytes?: number;
  observationTimer?: NodeJS.Timeout;
  /** Settles only after the PTY exit path has written its final durable projection. */
  terminalExited?: Promise<void>;
  /** The size the CLI is drawing for, once a view has resized it from the spawn default. */
  cols?: number;
  rows?: number;
  resolveTerminalExit?: () => void;
};

type StoredSession = {summary: SessionSummary; directory: string; /** Legacy only; never written again. */ output?: string};

const maxOutputBytes = 160_000;
/** How often a streaming lane's output is summarized into one durable observation. */
const observationIntervalMs = 1_000;
/** How long a burst of output or keystrokes may leave `sessions.json` behind before it is written. */
const persistDelayMs = 500;

/**
 * Variables a parent agent session exports to mark its own children. fluentd is often started from
 * inside one (a Claude Code or Codex terminal), and a lane that inherits them believes it is that
 * session's subprocess: Claude Code turns transcript saving off for a "child session", and the lane
 * would be handed the parent's private messaging socket and token.
 */
const inheritedSessionMarkers = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'FLUENT_SESSION_ID'
];

/**
 * Builds a lane's environment from the daemon's own, the credential's changes, and any overrides.
 *
 * The `unset` half is the part that matters and the part a plain spread cannot do: a credential
 * variable exported in the user's shell is inherited by the daemon and would otherwise reach every
 * lane, including lanes Fluent put on a different account.
 */
export function applyCredentialEnvironment(credential?: CredentialEnvironment, overrides: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const name of inheritedSessionMarkers) delete env[name];
  for (const name of credential?.unset ?? []) delete env[name];
  return {...env, ...(credential?.set ?? {}), ...overrides};
}

/**
 * The starting task goes in through the CLI's own launch argument for an interactive session with
 * a first prompt. Typing it into the terminal after a guessed delay raced the CLI's startup and,
 * worse, landed on its directory-trust prompt — where Claude Code's default answer is "No, exit".
 */
export function initialPromptArgs(provider: ProviderId, task?: string): string[] {
  const prompt = task?.trim();
  if (!prompt) return [];
  if (provider === 'gemini') return ['--prompt-interactive', prompt];
  if (provider === 'qwen' || provider === 'glm' || provider === 'nvidia') return ['--prompt', prompt];
  // A leading dash would be parsed as an option instead of as the prompt.
  return [prompt.startsWith('-') ? ` ${prompt}` : prompt];
}

const privateModeSequence = /\x1b\[\?([\d;]+)([hl])/g;

/** Follows DEC private mode 2004 (bracketed paste) through a CLI's output; the last toggle wins. */
export function bracketedPasteMode(current: boolean, output: string) {
  let mode = current;
  for (const match of output.matchAll(privateModeSequence)) {
    if (match[1]!.split(';').includes('2004')) mode = match[2] === 'h';
  }
  return mode;
}

/**
 * Text as a terminal delivers a paste. Inside a bracketed paste a newline is part of the text rather
 * than a submit, so a multi-line brief arrives whole.
 *
 * Every other control character is removed, not just paste markers. Injected text can come from an
 * agent (a ticket another lane wrote), and a filter that deletes whole markers in one pass rebuilds a
 * marker nested inside one — closing the paste early and typing the rest into the lane as keystrokes.
 * With no ESC left, no marker can be formed. Without bracketed paste a newline would submit mid-brief,
 * so lines are joined instead.
 */
export function pastePayload(text: string, bracketed: boolean) {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean.replace(/[\t\n]+/g, ' ');
}

/** Emits 'output' (sessionId, chunk) and 'status' (sessionId, summary) so daemon.ts can push
 * `sessions.subscribe` events without the manager knowing anything about sockets/RPC. */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly stateFile: string;
  readonly runStore: RunStore;
  private persistQueue: Promise<void> = Promise.resolve();
  private persistTimer?: NodeJS.Timeout;
  /** Set once shutdown begins; no lane may start after the shutdown has taken its list of lanes. */
  private closing = false;
  private shutdownPromise?: Promise<unknown>;
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

  /** Default lists exclude deliberately archived records so historic terminal sessions never read
   * as live work. Callers that render the archive opt in explicitly. */
  list(includeArchived = false): SessionSummary[] {
    return [...this.sessions.values()]
      .map(({summary}) => summary)
      .filter(summary => includeArchived || !summary.archivedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(sessionId: string): SessionSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return {...session.summary, output: session.output};
  }

  async create({provider, directory, task, env, accountId, isolate, lead, parentSessionId}: {provider: ProviderId; directory: string; task?: string; env?: CredentialEnvironment; accountId?: string; isolate?: boolean; lead?: {maxLanes: number}; parentSessionId?: string}) {
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
    const modelReference = env?.set.FLUENT_OPENCODE_MODEL;
    const model = (provider === 'qwen' || provider === 'glm' || provider === 'nvidia')
      && modelReference?.startsWith(`fluent-${provider}/`)
      ? modelReference.slice(`fluent-${provider}/`.length)
      : undefined;
    const summary: SessionSummary = {
      id,
      provider,
      command: adapter.executable,
      model,
      directory: sessionDirectory,
      task: task?.trim() || undefined,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      accountId,
      projectDirectory: worktree?.projectDirectory,
      worktreePath: worktree?.path,
      prepareMs: worktree?.prepareMs,
      warmedPaths: worktree?.warmedPaths,
      ...(lead ? {lead} : {}),
      ...(parentSessionId ? {parentSessionId} : {})
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
    let terminal: import('node-pty').IPty;
    try {
      // Checked at the spawn itself: a launch already underway when shutdown took its list of lanes
      // would otherwise start a lane nothing will stop.
      if (this.closing) throw new Error('fluentd is shutting down');
      const pty = await ptyRuntime();
      // A lead's instructions travel through the same per-CLI channels as the coordination briefing.
      const direction = lead ? leadDirection(provider, lead.maxLanes, summary.task) : undefined;
      terminal = pty.spawn(executable, [...adapter.args, ...providerLaunchArgs(provider, env), ...briefingArgs(provider, direction?.systemPrompt), ...initialPromptArgs(provider, direction ? direction.prompt : summary.task)], {
      cwd: sessionDirectory,
      env: applyCredentialEnvironment(env, {
        // See providers.ts: preserve the Node bin that owns a discovered NVM CLI so its
        // `env node` shebang resolves inside the detached daemon as well.
        PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter),
        // Lets the lane's hook relay and `fluent-coord` name their lane exactly. The working
        // directory alone cannot tell apart several lanes sharing one checkout.
        FLUENT_SESSION_ID: id
      }),
      name: process.env.TERM ?? 'xterm-256color',
      cols: 120,
      rows: 40
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      session.summary.error = `Could not start ${adapter.label}: ${detail}`;
      this.append(session, `[Fluent] ${session.summary.error}\n`);
      await this.runStore.transition(id, 'failed', 'provider process could not start', {adapter: 'pty'});
      this.setStatus(session, 'failed');
      throw new Error(session.summary.error);
    }
    session.terminal = terminal;
    session.summary.pid = terminal.pid;
    this.append(session, `$ ${adapter.executable}\n`);
    terminal.onData(chunk => this.append(session, chunk));
    await this.runStore.ready(id, {adapter: 'pty'});
    await this.runStore.transition(id, 'running', 'provider process spawned', {adapter: 'pty'});
    this.setStatus(session, 'running');
    session.terminalExited = new Promise(resolve => { session.resolveTerminalExit = resolve; });
    terminal.onExit(({exitCode}) => {
      void this.finalizeTerminalExit(session, exitCode);
    });
    return summary;
  }

  /**
   * Delivers context into a lane the way a person pasting it would: one paste, so a multi-line brief
   * is not submitted line by line, then Enter on its own. The pause lets the CLI finish taking in the
   * paste first; an Enter that arrives in the same read can be swallowed as part of it.
   */
  async inject(sessionId: string, text: string, submit = true) {
    const session = this.sessions.get(sessionId);
    if (!session?.terminal || session.summary.status !== 'running') throw new Error('Session is not accepting input');
    if (!text.trim()) throw new Error('There is no context to inject');
    const bracketedPaste = session.bracketedPaste ?? false;
    await this.send(sessionId, pastePayload(text, bracketedPaste));
    if (submit) {
      await new Promise(resolve => setTimeout(resolve, 250));
      await this.send(sessionId, '\r');
    }
    return {injected: true, submitted: submit, bracketedPaste};
  }

  async send(sessionId: string, input: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.terminal || session.summary.status !== 'running') throw new Error('Session is not accepting input');
    // A PTY write is only delivery intent. There is no provider acknowledgement we can prove, so
    // a restart after this point remains reviewable rather than being replayed automatically.
    // Only a submit is a prompt dispatch: single keystrokes, a paste still waiting for Enter, and the
    // replies a terminal sends to a CLI's own queries (cursor position, focus, colours) are not —
    // recording each of those made every typed character a durable run event.
    if (input.includes('\r')) await this.runStore.dispatchIntent(sessionId, {inputBytes: Buffer.byteLength(input)});
    session.terminal.write(input);
    session.summary.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  /**
   * Ends every lane this daemon started, for a daemon that is shutting down. A lane outlives its
   * closed terminal (Claude Code keeps running after its PTY hangs up) and a restarted daemon cannot
   * reattach to it, so leaving lanes behind would leak live agents that nothing can see or stop.
   * Every call gets the same shutdown, since a signal handler can fire more than once.
   */
  shutdown() {
    this.shutdownPromise ??= this.shutdownLanes();
    return this.shutdownPromise;
  }

  private async shutdownLanes() {
    this.closing = true;
    const live = [...this.sessions.values()].filter(session => session.terminal);
    // Signal every lane before the first await: under `pnpm daemon`, tsx can SIGKILL fluentd moments
    // after relaying SIGINT, and a lane never signalled would be orphaned.
    for (const session of live) session.terminal!.kill('SIGTERM');
    await Promise.all(live.map(session => this.stop(session.summary.id).catch(() => undefined)));
    // A child normally responds to SIGTERM immediately. Escalate only during daemon shutdown so a
    // user-facing Stop remains a regular provider-friendly request, while a daemon never exits
    // before it has either reaped its lanes or made a best effort to do so.
    await Promise.all(live.map(async session => {
      await this.waitForTerminalExit(session, 2_000);
      if (session.terminal) {
        session.terminal.kill('SIGKILL');
        await this.waitForTerminalExit(session, 1_000);
      }
    }));
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await Promise.all([this.runStore.flush(), this.persist()]);
    return live.length;
  }

  /** Keeps the PTY's own idea of terminal size in sync with whatever xterm.js actually rendered
   * client-side — without this, a CLI drawing for its spawn-time size (see `create`'s hardcoded
   * cols/rows) wraps and truncates against a differently-sized viewport. */
  resize(sessionId: string, cols: number, rows: number) {
    const session = this.sessions.get(sessionId);
    if (!session?.terminal) return;
    session.terminal.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  /** The size a lane's CLI is currently drawing for, so its screen can be replayed at that size. */
  terminalSize(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return {cols: session?.cols ?? 120, rows: session?.rows ?? 40};
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

  /**
   * Checkpoints are deliberately observational. `git rev-parse` and `git status` tell a future
   * lane exactly what it can review, without Fluent committing, stashing, resetting, or pretending
   * an interactive PTY can be resumed after a daemon restart.
   */
  async checkpoint(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    let gitRef: string | undefined;
    let workingTree: 'clean' | 'dirty' | 'unknown' = 'unknown';
    try {
      const [head, status] = await Promise.all([
        run('git', ['-C', session.directory, 'rev-parse', '--verify', 'HEAD'], {timeout: 5_000}),
        run('git', ['-C', session.directory, 'status', '--porcelain', '--untracked-files=normal'], {timeout: 5_000})
      ]);
      const candidate = head.stdout.trim();
      if (/^[0-9a-f]{40,64}$/i.test(candidate)) gitRef = candidate;
      workingTree = status.stdout.trim() ? 'dirty' : 'clean';
    } catch {
      // A directory without Git is still a valid lane. The checkpoint remains useful as a durable
      // time marker, and its explicit unknown state avoids inventing a recoverable source ref.
    }
    return this.runStore.checkpoint(sessionId, {gitRef, workingTree}, {adapter: 'pty'});
  }

  async archive(sessionId: string) {
    const session = this.requireStoppedSession(sessionId, 'archive');
    if (session.summary.archivedAt) return session.summary;
    session.summary.archivedAt = new Date().toISOString();
    session.summary.updatedAt = session.summary.archivedAt;
    await this.persist();
    this.emit('status', sessionId, session.summary);
    return session.summary;
  }

  async restoreArchived(sessionId: string) {
    const session = this.requireStoppedSession(sessionId, 'restore');
    if (!session.summary.archivedAt) return session.summary;
    delete session.summary.archivedAt;
    session.summary.updatedAt = new Date().toISOString();
    await this.persist();
    this.emit('status', sessionId, session.summary);
    return session.summary;
  }

  /** Removes only Fluent's local session entry. Worktrees, project files, coordination history,
   * and usage data remain intentionally untouched: each has an independent, explicit lifecycle. */
  async delete(sessionId: string) {
    const session = this.requireStoppedSession(sessionId, 'delete');
    if (!session.summary.archivedAt) throw new Error('Archive the session before deleting its local record');
    this.sessions.delete(sessionId);
    await this.persist();
    this.emit('deleted', sessionId);
    return {deleted: true as const, sessionId};
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

  private requireStoppedSession(sessionId: string, action: 'archive' | 'restore' | 'delete') {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.terminal || session.summary.status === 'running' || session.summary.status === 'starting') {
      throw new Error(`Stop the session before you ${action} it`);
    }
    return session;
  }

  private append(session: LiveSession, chunk: string) {
    session.bracketedPaste = bracketedPasteMode(session.bracketedPaste ?? false, (session.modeTail ?? '') + chunk);
    session.modeTail = chunk.slice(-32);
    session.output = (session.output + chunk).slice(-maxOutputBytes);
    session.summary.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit('output', session.summary.id, chunk);
    // The terminal view remains live, but the durable event only records a redacted observation
    // count. Persisting raw terminal text would turn the trace into an accidental secret store.
    // A TUI emits many small chunks per second, so the count is summarized once per interval.
    session.pendingOutputBytes = (session.pendingOutputBytes ?? 0) + Buffer.byteLength(chunk);
    if (!session.observationTimer) {
      session.observationTimer = setTimeout(() => {
        void this.recordObservation(session).catch(error => console.error(`fluentd could not record terminal observation: ${error.message}`));
      }, observationIntervalMs);
      session.observationTimer.unref();
    }
  }

  private async finalizeTerminalExit(session: LiveSession, exitCode: number) {
    // In-memory state first: a journal write that fails must not leave an exited lane reading as
    // running, unarchivable, and holding a pid that shutdown would signal after the OS reused it.
    session.terminal = undefined;
    session.summary.pid = undefined;
    session.summary.exitCode = exitCode;
    this.setStatus(session, session.summary.status === 'stopped' ? 'stopped' : 'exited');
    try {
      await this.recordObservation(session);
      await this.finishRun(session.summary.id, session.summary.status, exitCode);
    } catch (error) {
      console.error(`fluentd could not finalize run ${session.summary.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      session.resolveTerminalExit?.();
      session.resolveTerminalExit = undefined;
    }
  }

  private async recordObservation(session: LiveSession) {
    if (session.observationTimer) clearTimeout(session.observationTimer);
    session.observationTimer = undefined;
    const bytes = session.pendingOutputBytes ?? 0;
    session.pendingOutputBytes = 0;
    if (bytes === 0) return;
    await this.runStore.record(session.summary.id, 'text.delta', {bytes}, {adapter: 'pty'});
  }

  /** Waits for the whole exit path, including its durable writes, but never lets a stuck provider
   * make the daemon's shutdown path unbounded. */
  private async waitForTerminalExit(session: LiveSession, timeoutMs: number) {
    if (!session.terminalExited) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      session.terminalExited,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      })
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Coalesces the frequent, low-stakes `updatedAt` changes from output and keystrokes. */
  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.queuePersist();
    }, persistDelayMs);
    this.persistTimer.unref();
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
