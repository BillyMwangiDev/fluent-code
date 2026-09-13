import {execFile} from 'node:child_process';
import {mkdir, rm, stat} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

export type Worktree = {
  projectDirectory: string;
  path: string;
  /** Git-ignored cache directories cloned into the new worktree, in the order they were warmed. */
  warmedPaths: string[];
  /** Wall-clock cost of making this worktree usable — the lane-ready latency the orchestrator is
   * judged on, measured rather than asserted. */
  prepareMs: number;
};

/**
 * Top-level directories worth carrying into a fresh worktree when the filesystem can do it for
 * free. These are dependency trees and build caches: rebuilding them is the dominant cost of
 * starting a lane, and a lane that starts with a cold `node_modules` spends minutes doing work the
 * project next door already did.
 *
 * An entry is only ever cloned when Git actually ignores it (see `warm`), so this list can never
 * shadow a tracked file. It stays an allowlist rather than "every ignored path" on purpose:
 * ignored paths also include local env files and editor state, and copying those into a new
 * workspace is a decision for the user to make explicitly, not a side effect of opening a lane.
 */
const defaultWarmPaths = [
  'node_modules',
  'vendor',
  'target',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.gradle',
  '.cache'
];

function warmPaths() {
  const configured = process.env.FLUENT_WARM_PATHS;
  if (configured === undefined) return defaultWarmPaths;
  // An explicit empty value is a way to turn warming off entirely.
  return configured.split(',').map(entry => entry.trim()).filter(Boolean);
}

function cloneArgs(source: string, destination: string) {
  // macOS `cp -c` uses APFS clonefile; GNU `cp --reflink=always` fails loudly rather than silently
  // falling back to a full copy, which is what makes the reflink probe meaningful.
  return process.platform === 'darwin' ? ['-Rc', source, destination] : ['-a', '--reflink=always', source, destination];
}

async function isIgnored(projectDirectory: string, candidate: string) {
  try {
    await run('git', ['-C', projectDirectory, 'check-ignore', '-q', '--', candidate]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides which of `candidates` may be carried into a fresh worktree. Kept separate from the
 * cloning itself because this is the part that has to be *right* — cloning is just `cp` — and
 * because it is the part that can be verified on any filesystem, reflink-capable or not.
 *
 * A candidate qualifies only when it is a real directory in the project, Git ignores it, and the
 * worktree does not already have something at that path.
 */
export async function selectWarmCandidates(projectDirectory: string, worktreePath: string, candidates: readonly string[]) {
  const selected: string[] = [];
  for (const candidate of candidates) {
    try {
      if (!(await stat(join(projectDirectory, candidate))).isDirectory()) continue;
    } catch {
      continue;
    }
    // Only clone what Git ignores: a tracked path is already in the checkout, and shadowing it
    // with the other worktree's copy would silently change what the agent reads.
    if (!(await isIgnored(projectDirectory, candidate))) continue;
    try {
      await stat(join(worktreePath, candidate));
      continue;
    } catch {
      // Absent, as expected for an ignored path in a fresh worktree.
    }
    selected.push(candidate);
  }
  return selected;
}

/**
 * Creates a detached checkout for one agent. Detached worktrees intentionally avoid making a
 * branch-name decision for the user; the agent can create a branch when it is ready to hand off.
 * They live beside the project, never inside it, so Git does not mistake a nested checkout for
 * ordinary project files.
 *
 * Where the filesystem supports reflinks (APFS, btrfs, XFS with reflink=1, bcachefs, recent ZFS),
 * the worktree is then warmed by *reference-cloning* the project's ignored dependency and build
 * caches: the new tree shares extents with the original, so it costs almost no space and no time
 * and the lane starts with a warm cache. Where the filesystem cannot do that, the lane gets a
 * plain worktree exactly as before — warming degrades, it never fails and never falls back to a
 * real copy, because copying several gigabytes per lane is the problem, not the fix.
 */
export class WorktreeManager {
  /** Reflink support is a property of the filesystem, so it is probed once per project and reused
   * rather than re-discovered for every lane. */
  private readonly reflinkSupport = new Map<string, boolean>();

  async create(directory: string, sessionId: string): Promise<Worktree> {
    const startedAt = Date.now();
    const projectDirectory = (await run('git', ['-C', directory, 'rev-parse', '--show-toplevel'])).stdout.trim();
    if (!projectDirectory) throw new Error('Isolated agent sessions require a Git working tree');
    const path = join(process.env.FLUENT_WORKTREE_DIR ?? join(dirname(projectDirectory), '.fluent-worktrees'), basename(projectDirectory), sessionId);
    await mkdir(dirname(path), {recursive: true});
    try {
      await run('git', ['-C', projectDirectory, 'worktree', 'add', '--detach', path, 'HEAD']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not create an isolated worktree: ${message}`);
    }
    const warmedPaths = await this.warm(projectDirectory, path);
    return {projectDirectory, path, warmedPaths, prepareMs: Date.now() - startedAt};
  }

  async remove(projectDirectory: string, path: string) {
    // Warmed caches are untracked, which is exactly what `git worktree remove` refuses to discard
    // on its own — the `--force` this has always passed is what makes removing a warmed lane work.
    await run('git', ['-C', projectDirectory, 'worktree', 'remove', '--force', path]);
  }

  /**
   * Reference-clones the project's ignored caches into a new worktree. Entirely best-effort: any
   * failure leaves the lane with a plain worktree, which is correct, just colder. A partially
   * cloned directory is removed rather than left behind — half a `node_modules` is worse than
   * none, because the package manager would trust it.
   */
  private async warm(projectDirectory: string, worktreePath: string) {
    const candidates = await selectWarmCandidates(projectDirectory, worktreePath, warmPaths());
    if (candidates.length === 0) return [];
    if (!(await this.supportsReflink(projectDirectory))) return [];

    const warmed: string[] = [];
    for (const candidate of candidates) {
      const destination = join(worktreePath, candidate);
      try {
        await run('cp', cloneArgs(join(projectDirectory, candidate), destination), {timeout: 120_000});
        warmed.push(candidate);
      } catch {
        await rm(destination, {recursive: true, force: true}).catch(() => undefined);
      }
    }
    return warmed;
  }

  /** Probes by cloning a real file inside the project, because reflink support depends on the
   * filesystem the project actually lives on, not on the platform. */
  private async supportsReflink(projectDirectory: string) {
    const cached = this.reflinkSupport.get(projectDirectory);
    if (cached !== undefined) return cached;

    const probeDirectory = join(projectDirectory, '.git', 'fluent-reflink-probe');
    const source = join(probeDirectory, 'source');
    const destination = join(probeDirectory, 'clone');
    let supported = false;
    try {
      await mkdir(probeDirectory, {recursive: true});
      await run('sh', ['-c', `printf fluent > ${JSON.stringify(source)}`]);
      await run('cp', cloneArgs(source, destination), {timeout: 10_000});
      supported = true;
    } catch {
      supported = false;
    } finally {
      await rm(probeDirectory, {recursive: true, force: true}).catch(() => undefined);
    }

    this.reflinkSupport.set(projectDirectory, supported);
    return supported;
  }
}
