import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
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

/** A worktree root outside the project, as `create` would choose. */
async function worktreeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fluent-worktrees-'));
  directories.push(root);
  process.env.FLUENT_WORKTREE_DIR = root;
  return root;
}

describe('snapshot before removal', () => {
  it('keeps uncommitted work recoverable after the worktree is gone', async () => {
    const root = await project();
    await worktreeRoot();
    const manager = new WorktreeManager();
    const worktree = await manager.create(root, 'lane-snapshot');
    // Exactly what a stopped lane leaves behind: an edit to a tracked file and a brand new one.
    await writeFile(join(worktree.path, 'README.md'), '# edited by the agent\n');
    await writeFile(join(worktree.path, 'invoice.txt'), 'agent work\n');

    const snapshot = await manager.remove(worktree.projectDirectory, worktree.path);

    assert.ok(snapshot, 'removing a dirty worktree must not discard its work');
    await assert.rejects(() => stat(join(worktree.path, 'README.md')), 'the worktree is still removed');
    // Recoverable from the project itself, which is the only copy that outlives the worktree.
    assert.equal((await run('git', ['-C', root, 'show', `${snapshot.ref}:README.md`])).stdout, '# edited by the agent\n');
    assert.equal((await run('git', ['-C', root, 'show', `${snapshot.ref}:invoice.txt`])).stdout, 'agent work\n');
    delete process.env.FLUENT_WORKTREE_DIR;
  });

  it('writes no snapshot when the worktree has nothing uncommitted', async () => {
    const root = await project();
    await worktreeRoot();
    const manager = new WorktreeManager();
    const worktree = await manager.create(root, 'lane-clean');

    assert.equal(await manager.remove(worktree.projectDirectory, worktree.path), undefined);
    delete process.env.FLUENT_WORKTREE_DIR;
  });

  it('leaves ignored caches out of the snapshot', async () => {
    const root = await project();
    await worktreeRoot();
    const manager = new WorktreeManager();
    const worktree = await manager.create(root, 'lane-ignored');
    await writeFile(join(worktree.path, 'invoice.txt'), 'agent work\n');
    await mkdir(join(worktree.path, '.venv'), {recursive: true});
    await writeFile(join(worktree.path, '.venv', 'pyvenv.cfg'), 'home = /usr\n');

    const snapshot = await manager.remove(worktree.projectDirectory, worktree.path);

    assert.ok(snapshot);
    await assert.rejects(
      () => run('git', ['-C', root, 'show', `${snapshot.ref}:.venv/pyvenv.cfg`]),
      'a snapshot that swallowed ignored caches would be gigabytes of nothing'
    );
    delete process.env.FLUENT_WORKTREE_DIR;
  });
});

describe('.worktreeinclude', () => {
  it('copies a listed ignored file into a new worktree', async () => {
    const root = await project();
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.venv/\n.env.local\n');
    await writeFile(join(root, '.env.local'), 'SECRET=1\n');
    await writeFile(join(root, '.worktreeinclude'), '# local config the checkout cannot carry\n\n.env.local\n');
    await worktreeRoot();

    const worktree = await new WorktreeManager().create(root, 'lane-include');

    assert.deepEqual(worktree.includedPaths, ['.env.local']);
    assert.equal(await readFile(join(worktree.path, '.env.local'), 'utf8'), 'SECRET=1\n');
    delete process.env.FLUENT_WORKTREE_DIR;
  });

  it('never copies a path Git does not ignore', async () => {
    const root = await project();
    // `vendor` is tracked, so the checkout already has it; copying would shadow what the agent reads.
    await writeFile(join(root, '.worktreeinclude'), 'vendor\n');
    await worktreeRoot();

    const worktree = await new WorktreeManager().create(root, 'lane-shadow');

    assert.deepEqual(worktree.includedPaths, []);
    assert.equal(await readFile(join(worktree.path, 'vendor', 'tracked.txt'), 'utf8'), 'tracked\n');
    delete process.env.FLUENT_WORKTREE_DIR;
  });
});
