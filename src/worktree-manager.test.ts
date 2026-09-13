import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {after, before, describe, it} from 'node:test';
import {WorktreeManager, selectWarmCandidates} from './worktree-manager.js';

const run = promisify(execFile);
const directories: string[] = [];

/** A real Git project, because every rule here is expressed in terms of what Git considers
 * ignored — a fixture that only mimics the directory layout would prove nothing. */
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'fluent-worktree-'));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--initial-branch=main']);
  await run('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', root, 'config', 'user.name', 'Test']);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.venv/\n');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  // Tracked, and also named in the warm allowlist — the case that must never be cloned.
  await mkdir(join(root, 'vendor'), {recursive: true});
  await writeFile(join(root, 'vendor', 'tracked.txt'), 'tracked\n');
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, 'commit', '-m', 'fixture']);
  // Ignored caches, created after the commit so they are genuinely untracked.
  await mkdir(join(root, 'node_modules', 'left-pad'), {recursive: true});
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(root, 'not-a-directory'), 'file\n');
  return root;
}

let reflinkSupported = false;

before(async () => {
  // Reflink support is a property of the filesystem under the test runner, not of the platform,
  // so the suite discovers it rather than assuming it.
  const probe = await mkdtemp(join(tmpdir(), 'fluent-reflink-'));
  directories.push(probe);
  await writeFile(join(probe, 'source'), 'probe');
  const args = process.platform === 'darwin' ? ['-Rc', join(probe, 'source'), join(probe, 'clone')] : ['-a', '--reflink=always', join(probe, 'source'), join(probe, 'clone')];
  reflinkSupported = await run('cp', args).then(() => true, () => false);
});

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('warm candidate selection', () => {
  it('selects an ignored cache directory that the worktree lacks', async () => {
    const root = await project();
    const worktree = join(root, 'empty-worktree');
    await mkdir(worktree, {recursive: true});

    assert.deepEqual(await selectWarmCandidates(root, worktree, ['node_modules']), ['node_modules']);
  });

  it('never selects a tracked directory, even one named in the allowlist', async () => {
    const root = await project();
    const worktree = join(root, 'empty-worktree');
    await mkdir(worktree, {recursive: true});

    assert.deepEqual(
      await selectWarmCandidates(root, worktree, ['vendor']),
      [],
      'cloning over a tracked path would silently change what the agent reads'
    );
  });

  it('skips a candidate that does not exist, and one that is a file', async () => {
    const root = await project();
    const worktree = join(root, 'empty-worktree');
    await mkdir(worktree, {recursive: true});

    assert.deepEqual(await selectWarmCandidates(root, worktree, ['.venv', 'not-a-directory']), []);
  });

  it('skips a candidate the worktree already has', async () => {
    const root = await project();
    const worktree = join(root, 'occupied-worktree');
    await mkdir(join(worktree, 'node_modules'), {recursive: true});

    assert.deepEqual(await selectWarmCandidates(root, worktree, ['node_modules']), []);
  });
});

describe('worktree creation', () => {
  it('creates a usable detached worktree and reports its own cost', async () => {
    const root = await project();
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'fluent-worktrees-'));
    directories.push(worktreeRoot);
    process.env.FLUENT_WORKTREE_DIR = worktreeRoot;
    const manager = new WorktreeManager();

    const worktree = await manager.create(root, 'lane-a');

    assert.equal(worktree.projectDirectory, await run('git', ['-C', root, 'rev-parse', '--show-toplevel']).then(result => result.stdout.trim()));
    assert.ok((await stat(join(worktree.path, 'README.md'))).isFile(), 'the checkout is real');
    assert.equal(typeof worktree.prepareMs, 'number');
    assert.ok(worktree.prepareMs >= 0);
    // Detached on purpose: opening a lane must not decide a branch name for the user.
    const head = await run('git', ['-C', worktree.path, 'symbolic-ref', '-q', 'HEAD']).then(() => 'attached', () => 'detached');
    assert.equal(head, 'detached');

    await manager.remove(worktree.projectDirectory, worktree.path);
    await assert.rejects(() => stat(join(worktree.path, 'README.md')));
    delete process.env.FLUENT_WORKTREE_DIR;
  });

  it('warms ignored caches where the filesystem can reflink, and degrades cleanly where it cannot', async () => {
    const root = await project();
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'fluent-worktrees-'));
    directories.push(worktreeRoot);
    process.env.FLUENT_WORKTREE_DIR = worktreeRoot;
    const manager = new WorktreeManager();

    const worktree = await manager.create(root, 'lane-b');
    const warmed = join(worktree.path, 'node_modules', 'left-pad', 'index.js');

    if (reflinkSupported) {
      assert.deepEqual(worktree.warmedPaths, ['node_modules']);
      assert.ok((await stat(warmed)).isFile(), 'a warmed cache has to actually contain the cache');
    } else {
      // The documented degradation: a plain worktree, never a multi-gigabyte real copy.
      assert.deepEqual(worktree.warmedPaths, []);
      await assert.rejects(() => stat(join(worktree.path, 'node_modules')), 'nothing partial is left behind');
    }
    // Either way the tracked lookalike is untouched by warming.
    assert.ok((await stat(join(worktree.path, 'vendor', 'tracked.txt'))).isFile());

    await manager.remove(worktree.projectDirectory, worktree.path);
    delete process.env.FLUENT_WORKTREE_DIR;
  });

  it('leaves no probe directory behind in the project', async () => {
    const root = await project();
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'fluent-worktrees-'));
    directories.push(worktreeRoot);
    process.env.FLUENT_WORKTREE_DIR = worktreeRoot;

    const manager = new WorktreeManager();
    const worktree = await manager.create(root, 'lane-c');

    await assert.rejects(() => stat(join(root, '.git', 'fluent-reflink-probe')));
    await manager.remove(worktree.projectDirectory, worktree.path);
    delete process.env.FLUENT_WORKTREE_DIR;
  });

  it('refuses a directory that is not a Git working tree', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'fluent-plain-'));
    directories.push(plain);

    await assert.rejects(() => new WorktreeManager().create(plain, 'lane-d'));
  });
});
