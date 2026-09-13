import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {after, describe, it} from 'node:test';
import {MergeQueue, conflictsFrom} from './merge-queue.js';
import {VerificationRunner} from './verification.js';
import type {SessionSummary} from './daemon-protocol.js';

const run = promisify(execFile);
const directories: string[] = [];

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-merge-'));
  directories.push(directory);
  return directory;
}

/** A project on `main` with a Makefile check that passes, plus a file to fight over. */
async function project({check = 'true'} = {}) {
  const root = await scratch();
  await run('git', ['-C', root, 'init', '--initial-branch=main']);
  await run('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', root, 'config', 'user.name', 'Test']);
  await writeFile(join(root, 'Makefile'), `test:\n\t${check}\n`);
  await writeFile(join(root, 'shared.txt'), 'line1\nline2\nline3\n');
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, 'commit', '-m', 'base']);
  return root;
}

async function lane(root: string, id: string): Promise<SessionSummary> {
  const path = join(await scratch(), id);
  await run('git', ['-C', root, 'worktree', 'add', '--detach', path, 'HEAD']);
  const now = new Date().toISOString();
  return {
    id, provider: 'claude', command: 'claude', directory: path, status: 'exited',
    createdAt: now, updatedAt: now, projectDirectory: root, worktreePath: path, task: `task ${id}`
  };
}

async function queue() {
  return new MergeQueue(new VerificationRunner(await scratch()));
}

const load = (session: SessionSummary) => (_id: string) => session;

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('conflict prediction parsing', () => {
  it('reads the conflicted paths and stops at the message block', () => {
    const stdout = '49e9431\nsrc/a.ts\nsrc/b.ts\n\nAuto-merging src/a.ts\nCONFLICT (content): Merge conflict in src/a.ts\n';
    assert.deepEqual(conflictsFrom(stdout), ['src/a.ts', 'src/b.ts']);
  });

  it('reads a clean merge as no conflicts', () => {
    assert.deepEqual(conflictsFrom('c2c122d\n'), []);
  });
});

describe('planning an integration', () => {
  it('predicts a clean merge without touching either tree', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    await writeFile(join(laneA.directory, 'new.txt'), 'from a\n');

    const plan = await (await queue()).plan(laneA);

    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.conflicts, []);
    assert.equal(plan.base, 'main');
    assert.equal(plan.uncommittedFiles, 1);
    // The plan must leave the lane exactly as it found it.
    const status = await run('git', ['-C', laneA.directory, 'status', '--porcelain']);
    assert.match(status.stdout, /new\.txt/);
    const head = await run('git', ['-C', root, 'rev-parse', 'HEAD']);
    assert.equal(head.stdout.trim(), plan.baseHead, 'planning must not move the base');
  });

  it('predicts the conflict two lanes would have, before either merges', async () => {
    const root = await project();
    const [laneA, laneB] = [await lane(root, 'lane-a'), await lane(root, 'lane-b')];
    await writeFile(join(laneA.directory, 'shared.txt'), 'A1\nline2\nline3\n');
    await writeFile(join(laneB.directory, 'shared.txt'), 'B1\nline2\nline3\n');
    const merges = await queue();

    assert.deepEqual((await merges.plan(laneB)).conflicts, [], 'nothing conflicts until something lands');
    assert.equal((await merges.integrate(laneA, load(laneA))).status, 'merged');

    assert.deepEqual((await merges.plan(laneB)).conflicts, ['shared.txt'], 'the second lane is re-planned against what actually landed');
  });

  it('refuses to plan a merge into a dirty checkout', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    await writeFile(join(root, 'shared.txt'), 'user was editing this\n');

    const plan = await (await queue()).plan(laneA);

    assert.match(plan.blockers.join(' '), /uncommitted changes/);
  });

  it('refuses to plan a merge into a detached HEAD', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    await run('git', ['-C', root, 'checkout', '--detach', 'HEAD']);

    assert.match((await (await queue()).plan(laneA)).blockers.join(' '), /detached HEAD/);
  });

  it('refuses to plan a lane that is still running', async () => {
    const root = await project();
    const laneA = {...await lane(root, 'lane-a'), status: 'running' as const};

    assert.match((await (await queue()).plan(laneA)).blockers.join(' '), /still running/);
  });

  it('says plainly that a session in the project checkout has nothing to merge', async () => {
    const root = await project();
    const shared: SessionSummary = {
      id: 'shared', provider: 'claude', command: 'claude', directory: root, status: 'exited',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };

    assert.match((await (await queue()).plan(shared)).blockers.join(' '), /nothing to merge/);
  });

  it('reports a lane with no changes rather than merging an empty commit', async () => {
    const root = await project();

    assert.match((await (await queue()).plan(await lane(root, 'lane-a'))).blockers.join(' '), /no changes to merge/);
  });
});

describe('integrating a lane', () => {
  it('merges the lane and leaves a merge commit on the base', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    await writeFile(join(laneA.directory, 'new.txt'), 'from a\n');

    const outcome = await (await queue()).integrate(laneA, load(laneA));

    assert.equal(outcome.status, 'merged');
    assert.equal(outcome.verification?.status, 'passed');
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'from a\n');
    const log = await run('git', ['-C', root, 'log', '--oneline', '-1', '--merges']);
    assert.match(log.stdout, /Merge lane: task lane-a/);
    const branch = await run('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD']);
    assert.equal(branch.stdout.trim(), 'main', 'the base branch is still checked out');
  });

  it('refuses a lane whose own checks fail, and leaves the base untouched', async () => {
    const root = await project({check: 'exit 1'});
    const laneA = await lane(root, 'lane-a');
    await writeFile(join(laneA.directory, 'new.txt'), 'from a\n');
    const before = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();

    const outcome = await (await queue()).integrate(laneA, load(laneA));

    assert.equal(outcome.status, 'unverified');
    assert.match(outcome.detail, /its own checks fail/);
    assert.equal((await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(), before);
  });

  it('refuses a conflicted lane and never resolves it itself', async () => {
    const root = await project();
    const [laneA, laneB] = [await lane(root, 'lane-a'), await lane(root, 'lane-b')];
    await writeFile(join(laneA.directory, 'shared.txt'), 'A1\nline2\nline3\n');
    await writeFile(join(laneB.directory, 'shared.txt'), 'B1\nline2\nline3\n');
    const merges = await queue();
    await merges.integrate(laneA, load(laneA));

    const outcome = await merges.integrate(laneB, load(laneB));

    assert.equal(outcome.status, 'conflicted');
    assert.match(outcome.detail, /shared\.txt/);
    assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'A1\nline2\nline3\n', 'the first lane\'s work stands');
    const status = await run('git', ['-C', root, 'status', '--porcelain']);
    assert.equal(status.stdout.trim(), '', 'a refused merge leaves the checkout clean, not mid-merge');
  });

  it('merges two non-overlapping lanes in the order they were queued', async () => {
    const root = await project();
    const [laneA, laneB] = [await lane(root, 'lane-a'), await lane(root, 'lane-b')];
    await writeFile(join(laneA.directory, 'a.txt'), 'from a\n');
    await writeFile(join(laneB.directory, 'b.txt'), 'from b\n');
    const merges = await queue();

    const [first, second] = await Promise.all([merges.integrate(laneA, load(laneA)), merges.integrate(laneB, load(laneB))]);

    assert.equal(first.status, 'merged');
    assert.equal(second.status, 'merged');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'from a\n');
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'from b\n');
    const subjects = (await run('git', ['-C', root, 'log', '--format=%s', '--merges'])).stdout.trim().split('\n');
    assert.deepEqual(subjects, ['Merge lane: task lane-b', 'Merge lane: task lane-a'], 'newest first — lane-a merged before lane-b');
  });

  it('does not let a blocked lane stall the one behind it', async () => {
    const root = await project();
    const blocked = {...await lane(root, 'lane-blocked'), status: 'running' as const};
    const laneB = await lane(root, 'lane-b');
    await writeFile(join(laneB.directory, 'b.txt'), 'from b\n');
    const merges = await queue();

    const [first, second] = await Promise.all([merges.integrate(blocked, load(blocked)), merges.integrate(laneB, load(laneB))]);

    assert.equal(first.status, 'blocked');
    assert.equal(second.status, 'merged');
    assert.deepEqual(merges.pending(root), [], 'the queue drains either way');
  });

  it('notes when nothing verified a merge because the project has no checks', async () => {
    const root = await scratch();
    await run('git', ['-C', root, 'init', '--initial-branch=main']);
    await run('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    await run('git', ['-C', root, 'config', 'user.name', 'Test']);
    await writeFile(join(root, 'readme.md'), 'x\n');
    await run('git', ['-C', root, 'add', '-A']);
    await run('git', ['-C', root, 'commit', '-m', 'base']);
    const laneA = await lane(root, 'lane-a');
    await writeFile(join(laneA.directory, 'new.txt'), 'from a\n');

    const outcome = await (await queue()).integrate(laneA, load(laneA));

    assert.equal(outcome.status, 'merged');
    assert.match(outcome.detail, /no checks fluentd could run/);
  });

  it('commits the lane\'s work in the lane, not in the project checkout', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    await writeFile(join(laneA.directory, 'new.txt'), 'from a\n');

    await (await queue()).integrate(laneA, load(laneA));

    const laneStatus = await run('git', ['-C', laneA.directory, 'status', '--porcelain']);
    assert.equal(laneStatus.stdout.trim(), '', 'the lane\'s work was committed in its own worktree');
    const laneLog = await run('git', ['-C', laneA.directory, 'log', '--format=%s', '-1']);
    assert.equal(laneLog.stdout.trim(), 'task lane-a');
  });
});
