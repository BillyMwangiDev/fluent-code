import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {CoordinationManager} from './coordination.js';

const directories: string[] = [];

/** Each manager gets its own state directory so tests never share persisted coordination state. */
async function manager() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
  directories.push(directory);
  return new CoordinationManager(directory);
}

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('file claims', () => {
  it('grants a path nobody holds', async () => {
    const coordination = await manager();
    const result = await coordination.claim('/project', 'src/daemon.ts', 'lane-a');
    assert.equal(result.granted, true);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.state.claims.length, 1);
  });

  it('detects a directory overlapping a file already claimed inside it', async () => {
    // The case the original exact-string comparison missed entirely.
    const coordination = await manager();
    await coordination.claim('/project', 'src/daemon.ts', 'lane-a');
    const result = await coordination.claim('/project', 'src/', 'lane-b');

    assert.equal(result.granted, false);
    assert.equal(result.conflicts.length, 1);
    // The conflict names the *existing* claim, which is not the path that was attempted.
    assert.equal(result.conflicts[0]?.claimedPath, 'src/daemon.ts');
    assert.equal(result.conflicts[0]?.path, 'src');
    assert.equal(result.conflicts[0]?.overlap, 'contains');
    assert.equal(result.conflicts[0]?.sessionId, 'lane-a');
  });

  it('detects a file inside an already-claimed directory', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'app/src', 'lane-a');
    const result = await coordination.claim('/project', 'app/src/main.ts', 'lane-b');

    assert.equal(result.granted, false);
    assert.equal(result.conflicts[0]?.overlap, 'contained');
  });

  it('does not confuse a shared name prefix with containment', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'src/daemon.ts', 'lane-a');
    const result = await coordination.claim('/project', 'src/daemon-client.ts', 'lane-b');

    assert.equal(result.granted, true, 'siblings sharing a name prefix are unrelated paths');
  });

  it('normalizes spelling before comparing', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'src/daemon.ts', 'lane-a');
    const result = await coordination.claim('/project', './src/daemon.ts/', 'lane-b');

    assert.equal(result.granted, false);
    assert.equal(result.conflicts[0]?.overlap, 'same');
  });

  it('lets a lane re-claim its own path without duplicating it', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'src/daemon.ts', 'lane-a');
    const result = await coordination.claim('/project', 'src/daemon.ts', 'lane-a');

    assert.equal(result.granted, true);
    assert.equal(result.state.claims.length, 1);
  });

  it('refuses a claim with no path rather than storing one', async () => {
    const coordination = await manager();
    await assert.rejects(() => coordination.claim('/project', '   ', 'lane-a'));
  });

  it('keeps a declared claim declared when the same path is later observed', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'src/daemon.ts', 'lane-a', 'declared');
    const result = await coordination.claim('/project', 'src/daemon.ts', 'lane-a', 'observed');

    assert.equal(result.state.claims[0]?.origin, 'declared', 'an agent stating intent outranks an inference from its diff');
  });
});

describe('claim leases', () => {
  it('renews a live lane and expires a lane that is gone', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'src/a.ts', 'lane-live');
    await coordination.claim('/project', 'src/b.ts', 'lane-dead');
    for (const claim of coordination.get('/project').claims) claim.expiresAt = new Date(Date.now() - 1).toISOString();

    const expired = await coordination.renewLeases(['lane-live']);

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.sessionId, 'lane-dead');
    assert.equal(expired[0]?.project, '/project', 'an expiry has to say which project it came from');
    assert.deepEqual(coordination.get('/project').claims.map(claim => claim.sessionId), ['lane-live']);
    assert.ok(new Date(coordination.get('/project').claims[0]!.expiresAt).getTime() > Date.now());
  });

  it('keeps an unrenewed claim whose lease has not lapsed yet', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'src/a.ts', 'lane-quiet');

    const expired = await coordination.renewLeases([]);

    assert.deepEqual(expired, [], 'a lane fluentd simply has not heard from yet still holds its claim');
    assert.equal(coordination.get('/project').claims.length, 1);
  });

  it('releases every claim a lane holds across projects', async () => {
    const coordination = await manager();
    await coordination.claim('/one', 'src/a.ts', 'lane-a');
    await coordination.claim('/two', 'src/b.ts', 'lane-a');
    await coordination.claim('/two', 'src/c.ts', 'lane-b');

    assert.equal(await coordination.releaseSession('lane-a'), true);
    assert.equal(coordination.get('/one').claims.length, 0);
    assert.deepEqual(coordination.get('/two').claims.map(claim => claim.sessionId), ['lane-b']);
    assert.equal(await coordination.releaseSession('lane-a'), false, 'releasing twice changes nothing');
  });

  it('gives a claim restored from pre-lease state a lease instead of dropping it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
    directories.push(directory);
    const {writeFile, mkdir} = await import('node:fs/promises');
    await mkdir(directory, {recursive: true});
    await writeFile(
      join(directory, 'coordination.json'),
      JSON.stringify([{project: '/project', tasks: [], claims: [{path: 'src/a.ts', sessionId: 'lane-a', createdAt: new Date().toISOString()}], decisions: [], handoffs: []}])
    );

    const coordination = new CoordinationManager(directory);
    await coordination.restore();
    const [claim] = coordination.get('/project').claims;

    assert.equal(claim?.origin, 'declared');
    assert.ok(claim && new Date(claim.expiresAt).getTime() > Date.now());
  });
});
