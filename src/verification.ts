import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import type {VerificationResult, VerificationSource} from './daemon-protocol.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';

const run = promisify(execFile);

const defaultTimeoutMs = 10 * 60_000;
const maxOutputBytes = 24_000;

/** Files whose changes mean the lane may have authored part of the oracle it is being judged by. */
const testPathPattern = /(^|\/)(tests?|__tests__|spec|e2e)\//i;
const testFilePattern = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|(^|\/).+_spec\.rb$/i;

type Discovered = {command: string; source: VerificationSource};

async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** The package manager the project itself uses, so the discovered command is the one a contributor
 * would actually run rather than a generically correct one that ignores the lockfile. */
async function packageRunner(directory: string) {
  if (await exists(join(directory, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(directory, 'yarn.lock'))) return 'yarn';
  if (await exists(join(directory, 'bun.lockb'))) return 'bun run';
  return 'npm run';
}

/**
 * Finds the check this project already has. The ordering matters: an explicitly configured command
 * wins, then the repo's own script names, then language defaults. Nothing here invents a check —
 * if a project has none, that is reported as `unavailable` rather than papered over with something
 * that would always pass.
 */
export async function discoverCommand(directory: string, configured?: string): Promise<Discovered | undefined> {
  if (configured?.trim()) return {command: configured.trim(), source: 'configured'};

  const manifest = await readJson(join(directory, 'package.json'));
  const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts as Record<string, unknown> : undefined;
  if (scripts) {
    // `verify` before `test` before `check`: a project that defines `verify` has said what its
    // gate is, and a test suite is a stronger signal than a typecheck when both exist.
    for (const script of ['verify', 'test', 'check']) {
      if (typeof scripts[script] === 'string') return {command: `${await packageRunner(directory)} ${script}`, source: 'package.json'};
    }
  }

  if (await exists(join(directory, 'Cargo.toml'))) return {command: 'cargo test', source: 'cargo'};
  if (await exists(join(directory, 'go.mod'))) return {command: 'go test ./...', source: 'go'};

  const makefile = await readFile(join(directory, 'Makefile'), 'utf8').catch(() => undefined);
  if (makefile) {
    for (const target of ['verify', 'test', 'check']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile)) return {command: `make ${target}`, source: 'makefile'};
    }
  }

  return undefined;
}

/**
 * Flags the checks a lane may have written for itself. Research on agent-authored tests found the
 * great majority carry weak or no assertion, so "the lane added tests and they pass" is close to
 * no signal — a reviewer needs to know when the green came partly from the lane's own oracle.
 *
 * This reports the fact, it does not judge assertion strength: naming what changed is something
 * the daemon can be right about, and scoring an oracle is not.
 */
export function oracleWarnings(changedPaths: readonly string[], command: string) {
  const warnings: string[] = [];
  const authored = changedPaths.filter(path => testPathPattern.test(path) || testFilePattern.test(path));
  if (authored.length > 0) {
    warnings.push(`${authored.length} test file${authored.length === 1 ? '' : 's'} changed in this lane — the checks it passed include ones it wrote (${authored.slice(0, 3).join(', ')}${authored.length > 3 ? ', …' : ''})`);
  }
  if (changedPaths.some(path => path === 'package.json' || path === 'Makefile' || path.endsWith('/package.json'))) {
    warnings.push(`this lane changed a file that defines the verification command (${command})`);
  }
  return warnings;
}

/**
 * Runs a lane's project against its own pre-existing checks and records the outcome, so a lane's
 * state reflects a check that actually ran rather than the agent's report of its own work.
 *
 * Results are cached against the exact tree that produced them (HEAD plus a digest of the working
 * diff), so re-reading a verified lane costs nothing and a lane that changed since is re-run.
 */
export class VerificationRunner {
  private readonly results = new Map<string, VerificationResult>();
  private readonly commands = new Map<string, string>();
  private readonly stateFile: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.stateFile = join(stateDirectory, 'verification.json');
  }

  async restore() {
    try {
      const stored = await readPrivateJson<{results?: Array<Omit<VerificationResult, 'output'> & {output?: string}>; commands?: Record<string, string>}>(this.stateFile);
      if (!stored) return;
      for (const result of stored.results ?? []) this.results.set(result.sessionId, {...result, output: ''});
      for (const [project, command] of Object.entries(stored.commands ?? {})) this.commands.set(project, command);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(sessionId: string) {
    return this.results.get(sessionId);
  }

  list() {
    return [...this.results.values()];
  }

  /** Per-project override of the discovered command — the escape hatch for a project whose real
   * gate is not the one its scripts advertise. */
  async setCommand(project: string, command: string | undefined) {
    if (command?.trim()) this.commands.set(project, command.trim());
    else this.commands.delete(project);
    await this.persist();
    return this.commands.get(project);
  }

  commandFor(project: string) {
    return this.commands.get(project);
  }

  async verify({sessionId, directory, project, force}: {sessionId: string; directory: string; project?: string; force?: boolean}): Promise<VerificationResult> {
    const discovered = await discoverCommand(directory, this.commands.get(project ?? directory));
    const startedAt = new Date().toISOString();

    if (!discovered) {
      return this.record({
        sessionId,
        status: 'unavailable',
        detail: 'This project has no check fluentd can run — set one to gate this lane.',
        startedAt,
        durationMs: 0,
        warnings: [],
        output: ''
      });
    }

    const treeId = await this.treeIdentity(directory);
    const cached = this.results.get(sessionId);
    if (!force && cached && cached.treeId && cached.treeId === treeId && cached.status !== 'running') return cached;

    const changedPaths = await this.changedPaths(directory);
    const running = this.record({
      sessionId,
      status: 'running',
      command: discovered.command,
      source: discovered.source,
      startedAt,
      durationMs: 0,
      warnings: [],
      output: '',
      treeId
    });
    void running;

    const began = Date.now();
    let status: VerificationResult['status'] = 'passed';
    let exitCode: number | null = 0;
    let output = '';
    try {
      // Run it the way a contributor runs it — through a shell, from the lane's own worktree.
      const result = await run('sh', ['-c', discovered.command], {cwd: directory, timeout: defaultTimeoutMs, maxBuffer: 4_000_000});
      output = `${result.stdout}${result.stderr}`;
    } catch (error) {
      const failure = error as {stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string};
      status = 'failed';
      exitCode = typeof failure.code === 'number' ? failure.code : null;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}` || failure.message || 'the check produced no output';
      if (failure.killed) output = `${output}\n\nfluentd stopped this check after ${defaultTimeoutMs / 60_000} minutes.`;
    }

    return this.record({
      sessionId,
      status,
      command: discovered.command,
      source: discovered.source,
      exitCode,
      startedAt,
      durationMs: Date.now() - began,
      // Only worth saying on a pass: on a failure the lane is going back to work regardless.
      warnings: status === 'passed' ? oracleWarnings(changedPaths, discovered.command) : [],
      output: output.slice(-maxOutputBytes),
      treeId
    });
  }

  async forget(sessionId: string) {
    if (!this.results.delete(sessionId)) return false;
    await this.persist();
    return true;
  }

  /** HEAD plus a digest of the working diff: two runs share a result only when they would be
   * running against byte-identical trees. */
  private async treeIdentity(directory: string) {
    try {
      const [head, diff, untracked] = await Promise.all([
        run('git', ['-C', directory, 'rev-parse', 'HEAD'], {timeout: 5_000}).then(result => result.stdout.trim()),
        run('git', ['-C', directory, 'diff', '--no-ext-diff'], {timeout: 8_000, maxBuffer: 8_000_000}).then(result => result.stdout),
        run('git', ['-C', directory, 'status', '--porcelain'], {timeout: 5_000}).then(result => result.stdout)
      ]);
      return createHash('sha256').update(head).update(diff).update(untracked).digest('hex').slice(0, 16);
    } catch {
      return undefined;
    }
  }

  private async changedPaths(directory: string) {
    try {
      const result = await run('git', ['-C', directory, 'status', '--porcelain'], {timeout: 5_000});
      return result.stdout.split('\n').map(line => line.slice(3).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private record(result: VerificationResult) {
    this.results.set(result.sessionId, result);
    void this.persist().catch(error => console.error(`fluentd could not persist verification state: ${error.message}`));
    return result;
  }

  private async persist() {
    const operation = this.queue.then(async () => {
      // A run interrupted by a daemon restart must not come back claiming to still be running.
      const results = [...this.results.values()].map(result => {
        const safe = result.status === 'running' ? {...result, status: 'unavailable' as const, detail: 'interrupted before it finished'} : result;
        const {output: _output, ...withoutOutput} = safe;
        return withoutOutput;
      });
      await writePrivateJson(this.stateFile, {results, commands: Object.fromEntries(this.commands)});
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
