import {execFile} from 'node:child_process';
import type {Stats} from 'node:fs';
import {mkdir, readFile, rm, stat} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

export type Worktree = {
  projectDirectory: string;
  path: string;
  /** Git-ignored cache directories cloned into the new worktree, in the order they were warmed. */
  warmedPaths: string[];
  /** Git-ignored paths the project's `.worktreeinclude` asked to carry into this worktree. */
  includedPaths: string[];
  /** Wall-clock cost of making this worktree usable — the lane-ready latency the orchestrator is
   * judged on, measured rather than asserted. */
  prepareMs: number;
};

/** Where a removed worktree's uncommitted work went. The ref lives in the *project* repository, so
 * it outlives the worktree that produced it and is restorable with ordinary Git:
 * `git worktree add <path> <ref>`. */
export type WorktreeSnapshot = {
  ref: string;
  commit: string;
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
 * copying itself because this is the part that has to be *right* — copying is just `cp` — and
 * because it is the part that can be verified on any filesystem, reflink-capable or not.
 *
 * A candidate qualifies only when it exists in the project and is a kind `accept`s, Git ignores it,
 * and the worktree does not already have something at that path.
 */
async function selectCarryable(
  projectDirectory: string,
  worktreePath: string,
  candidates: readonly string[],
  accept: (entry: Stats) => boolean
) {
  const selected: string[] = [];
  for (const candidate of candidates) {
    try {
      if (!accept(await stat(join(projectDirectory, candidate)))) continue;
    } catch {
      continue;
    }
    // Only carry what Git ignores: a tracked path is already in the checkout, and shadowing it with
    // the project's copy would silently change what the agent reads. This rule is also what keeps a
    // `.worktreeinclude` entry from reaching outside the project, where Git ignores nothing.
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

/** Warming only ever carries whole cache directories. A stray ignored *file* is local state, and
 * carrying it is a decision for the user to make explicitly through `.worktreeinclude`. */
export async function selectWarmCandidates(projectDirectory: string, worktreePath: string, candidates: readonly string[]) {
  return selectCarryable(projectDirectory, worktreePath, candidates, entry => entry.isDirectory());
}

/**
 * Paths the project asks to carry into every new worktree, read from a `.worktreeinclude` file at
 * the project root: one path per line, blank lines and `#` comments ignored.
 *
 * This is the explicit counterpart to warming. Warming guesses at caches and is only worth doing
 * when the filesystem can reflink; an include is a decision someone wrote down, so it is copied
 * outright — these are `.env.local`-sized files, not dependency trees.
 */
async function listIncludes(projectDirectory: string) {
  let listed: string;
  try {
    listed = await readFile(join(projectDirectory, '.worktreeinclude'), 'utf8');
  } catch {
    return [];
  }
  return listed.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
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
    const includedPaths = await this.include(projectDirectory, path);
    return {projectDirectory, path, warmedPaths, includedPaths, prepareMs: Date.now() - startedAt};
  }

  /**
   * Removes a worktree, but never before saving whatever was left uncommitted in it. Returns where
   * that work went, or `undefined` when there was nothing to save.
   *
   * A failed snapshot aborts the removal instead of proceeding: the entire point is that "remove
   * worktree" stops being a way to lose work, and a removal that quietly discarded the very thing
   * it promised to keep would be worse than one that refuses.
   */
  async remove(projectDirectory: string, path: string): Promise<WorktreeSnapshot | undefined> {
    const snapshot = await this.snapshot(projectDirectory, path);
    // Warmed caches are untracked, which is exactly what `git worktree remove` refuses to discard
    // on its own — the `--force` this has always passed is what makes removing a warmed lane work.
    await run('git', ['-C', projectDirectory, 'worktree', 'remove', '--force', path]);
    return snapshot;
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

  /**
   * Copies the project's `.worktreeinclude` paths into a new worktree. Best-effort in the same way
   * warming is: a local config file that cannot be copied leaves the lane workable, so it must not
   * fail the lane's creation. A partial copy is removed rather than left behind.
   */
  private async include(projectDirectory: string, worktreePath: string) {
    const candidates = await selectCarryable(projectDirectory, worktreePath, await listIncludes(projectDirectory), () => true);
    const included: string[] = [];
    for (const candidate of candidates) {
      const destination = join(worktreePath, candidate);
      try {
        await mkdir(dirname(destination), {recursive: true});
        await run('cp', ['-R', join(projectDirectory, candidate), destination], {timeout: 120_000});
        included.push(candidate);
      } catch {
        await rm(destination, {recursive: true, force: true}).catch(() => undefined);
      }
    }
    return included;
  }

  /**
   * Commits the worktree's uncommitted state into the project's object store and points a ref at
   * it. `git add -A` is what defines "uncommitted work" here: tracked modifications plus untracked
   * files, minus everything Git ignores — so a snapshot never swallows the gigabytes of warmed
   * cache sitting beside it.
   *
   * The commit is written from the worktree's own index, which is about to be deleted, but the ref
   * is written in the project, because that is the copy which outlives the removal. The two share
   * an object store, so the snapshot costs only what actually changed.
   */
  private async snapshot(projectDirectory: string, worktreePath: string): Promise<WorktreeSnapshot | undefined> {
    await run('git', ['-C', worktreePath, 'add', '-A']);
    const tree = (await run('git', ['-C', worktreePath, 'write-tree'])).stdout.trim();
    const head = (await run('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
    // Nothing to save: the worktree still matches the commit it was checked out at.
    if (tree === (await run('git', ['-C', worktreePath, 'rev-parse', 'HEAD^{tree}'])).stdout.trim()) return undefined;

    // Fluent's own identity, so snapshotting works whether or not the user has configured Git, and
    // so an agent's leftovers are never attributed to them.
    const commit = (await run('git', [
      '-C', worktreePath,
      '-c', 'user.name=Fluent',
      '-c', 'user.email=fluent@localhost',
      'commit-tree', tree, '-p', head, '-m', `Fluent snapshot of ${basename(worktreePath)}`
    ])).stdout.trim();
    const ref = `refs/fluent-snapshots/${basename(worktreePath)}`;
    await run('git', ['-C', projectDirectory, 'update-ref', ref, commit]);
    return {ref, commit};
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
