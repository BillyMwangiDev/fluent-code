import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {after, describe, it} from 'node:test';
import {ClaimObserver, changedPathsFrom, type Lane} from './claim-observer.js';
import {CoordinationManager} from './coordination.js';

const run = promisify(execFile);
const directories: string[] = [];

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-observer-'));
  directories.push(directory);
  return directory;
}

/** A project plus two lane checkouts of it — the shape the observer actually reads. */
async function project() {
  const root = await scratch();
  await run('git', ['-C', root, 'init', '--initial-branch=main']);
  await run('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', root, 'config', 'user.name', 'Test']);
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'router.ts'), 'export const routes = [];\n');
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, 'commit', '-m', 'base']);
  return root;
}

async function lane(root: string, sessionId: string): Promise<Lane> {
  const path = join(await scratch(), sessionId);
  await run('git', ['-C', root, 'worktree', 'add', '--detach', path, 'HEAD']);
  return {sessionId, project: root, directory: path};
}

async function coordination() {
  return new CoordinationManager(await scratch());
}

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('reading a working tree', () => {
  it('takes the destination of a rename, not the source', () => {
    assert.deepEqual(changedPathsFrom('R  src/old.ts -> src/new.ts\n'), ['src/new.ts']);
  });

  it('reads modified, added, deleted and untracked alike', () => {
    const porcelain = ' M src/a.ts\nA  src/b.ts\n D src/c.ts\n?? src/d.ts\n';
    assert.deepEqual(changedPathsFrom(porcelain), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });

  it('unquotes a path Git had to quote', () => {
    assert.deepEqual(changedPathsFrom('?? "src/odd name.ts"\n'), ['src/odd name.ts']);
  });

  it('ignores blank lines', () => {
    assert.deepEqual(changedPathsFrom('\n M src/a.ts\n\n'), ['src/a.ts']);
  });
});

describe('observing lanes', () => {
  it('records what a lane changed without being told', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    const state = await coordination();
    const observer = new ClaimObserver(state);

    await writeFile(join(laneA.directory, 'src', 'a.ts'), 'export const a = 2;\n');
    await observer.sweep([laneA]);

    const claims = state.get(root).claims;
    assert.deepEqual(claims.map(claim => claim.path), ['src/a.ts']);
    assert.equal(claims[0]?.origin, 'observed');
  });

  it('raises the overlap when two lanes edit the same file', async () => {
    const root = await project();
    const [laneA, laneB] = [await lane(root, 'lane-a'), await lane(root, 'lane-b')];
    const state = await coordination();
    const observer = new ClaimObserver(state);

    await writeFile(join(laneA.directory, 'src', 'a.ts'), 'from a\n');
    await writeFile(join(laneB.directory, 'src', 'a.ts'), 'from b\n');
    const byProject = await observer.sweep([laneA, laneB]);

    const conflicts = byProject.get(root) ?? [];
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.path, 'src/a.ts');
    assert.equal(conflicts[0]?.overlap, 'same');
    assert.equal(conflicts[0]?.sessionId, 'lane-a', 'the overlap names the lane that got there first');
  });

  it('says nothing when lanes stay out of each other\'s way', async () => {
    const root = await project();
    const [laneA, laneB] = [await lane(root, 'lane-a'), await lane(root, 'lane-b')];
    const state = await coordination();
    const observer = new ClaimObserver(state);

    await writeFile(join(laneA.directory, 'src', 'a.ts'), 'from a\n');
    await writeFile(join(laneB.directory, 'src', 'b.ts'), 'from b\n');

    assert.deepEqual((await observer.sweep([laneA, laneB])).get(root), []);
  });

  it('drops a claim once the lane reverts the change', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    const state = await coordination();
    const observer = new ClaimObserver(state);

    await writeFile(join(laneA.directory, 'src', 'a.ts'), 'changed\n');
    await observer.sweep([laneA]);
    assert.equal(state.get(root).claims.length, 1);

    await run('git', ['-C', laneA.directory, 'checkout', '--', 'src/a.ts']);
    await observer.sweep([laneA]);

    assert.deepEqual(state.get(root).claims, [], 'a path the lane no longer touches is no longer claimed');
  });

  it('leaves a lane\'s declared claims alone while replacing its observed ones', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    const state = await coordination();
    const observer = new ClaimObserver(state);
    await state.claim(root, 'src/planned.ts', 'lane-a');

    await writeFile(join(laneA.directory, 'src', 'a.ts'), 'changed\n');
    await observer.sweep([laneA]);

    const byOrigin = Object.fromEntries(state.get(root).claims.map(claim => [claim.path, claim.origin]));
    assert.deepEqual(byOrigin, {'src/planned.ts': 'declared', 'src/a.ts': 'observed'});
  });

  it('announces a change in conflicts once, not on every sweep', async () => {
    const root = await project();
    const [laneA, laneB] = [await lane(root, 'lane-a'), await lane(root, 'lane-b')];
    const state = await coordination();
    const observer = new ClaimObserver(state);
    const announced: number[] = [];
    observer.on('conflicts', (_project: string, conflicts: unknown[]) => announced.push(conflicts.length));

    await writeFile(join(laneA.directory, 'src', 'a.ts'), 'from a\n');
    await observer.sweep([laneA, laneB]);
    await writeFile(join(laneB.directory, 'src', 'a.ts'), 'from b\n');
    await observer.sweep([laneA, laneB]);
    await observer.sweep([laneA, laneB]);

    assert.deepEqual(announced, [0, 1], 'a sweep that finds the same overlaps is not news');
  });

  it('leaves claims untouched when a lane\'s tree cannot be read', async () => {
    const root = await project();
    const laneA = await lane(root, 'lane-a');
    const state = await coordination();
    const observer = new ClaimObserver(state);
    await writeFile(join(laneA.directory, 'src', 'a.ts'), 'changed\n');
    await observer.sweep([laneA]);

    await observer.sweep([{...laneA, directory: join(laneA.directory, 'gone')}]);

    assert.equal(state.get(root).claims.length, 1, 'an unreadable tree is not the same as an empty one');
  });
});

describe('collision hotspots', () => {
  it('ranks a conflict on a much-changed file above an ordinary one', async () => {
    const root = await project();
    // Give the router the history of a file every feature touches.
    for (let change = 0; change < 8; change++) {
      await writeFile(join(root, 'src', 'router.ts'), `export const routes = [${change}];\n`);
      await run('git', ['-C', root, 'commit', '-qam', `route ${change}`]);
    }
    const state = await coordination();
    const observer = new ClaimObserver(state);
    await state.claim(root, 'src/router.ts', 'lane-a');
    await state.claim(root, 'src/a.ts', 'lane-b');
    await state.observe(root, 'lane-c', ['src/router.ts', 'src/a.ts']);

    const ranked = await observer.rank(root, state.conflicts(root));

    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]?.path, 'src/router.ts');
    assert.equal(ranked[0]?.hotspot, true);
    assert.equal(ranked[1]?.hotspot, false);
  });

  it('finds no hotspots in a project with no history to learn from', async () => {
    const empty = await scratch();
    await run('git', ['-C', empty, 'init', '--initial-branch=main']);

    assert.equal((await new ClaimObserver(await coordination()).hotspotPaths(empty)).size, 0);
  });
});
