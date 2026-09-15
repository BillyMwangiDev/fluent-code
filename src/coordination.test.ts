import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {coordinationEventLimit, CoordinationManager} from './coordination.js';

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

describe('design-to-build handoffs', () => {
  it('persists a bounded source mapping, spec, loopback preview, and intended files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
    directories.push(directory);
    const first = new CoordinationManager(directory);
    await first.task('/project', {
      title: 'design: remote connection state',
      role: 'design',
      designHandoff: {
        sourceRef: './design/pen/fluent-code.pen',
        componentSpec: 'remote profile card',
        tokenSpec: 'Coral only for failed state',
        previewUrl: 'http://127.0.0.1:4173/remote',
        implementationPaths: ['app/src/main.ts', 'src/remote-manager.ts', 'app/src/main.ts']
      }
    });

    const restored = new CoordinationManager(directory);
    await restored.restore();
    assert.deepEqual(restored.get('/project').tasks[0]?.designHandoff, {
      sourceRef: 'design/pen/fluent-code.pen',
      componentSpec: 'remote profile card',
      tokenSpec: 'Coral only for failed state',
      previewUrl: 'http://127.0.0.1:4173/remote',
      implementationPaths: ['app/src/main.ts', 'src/remote-manager.ts']
    });
  });

  it('rejects external previews and path escapes rather than silently losing handoff context', async () => {
    const coordination = await manager();
    await assert.rejects(() => coordination.task('/project', {
      title: 'design: safe mapping',
      designHandoff: {sourceRef: '../outside.pen', previewUrl: 'https://example.test/', implementationPaths: ['../secret', '/absolute', 'src/ok.ts']}
    }), /Design source mapping/);

    assert.deepEqual(coordination.get('/project').tasks, []);
  });
});

describe('task dependencies', () => {
  it('blocks assignment and progress until every dependency is complete', async () => {
    const coordination = await manager();
    const prerequisite = (await coordination.task('/project', {title: 'write protocol'})).tasks[0]!;
    const dependent = (await coordination.task('/project', {title: 'implement client', dependsOn: [prerequisite.id]})).tasks[0]!;

    await assert.rejects(
      () => coordination.assignTask('/project', dependent.id, {sessionId: 'lane-client'}),
      /blocked by unfinished dependencies/
    );
    await assert.rejects(
      () => coordination.updateTask('/project', dependent.id, 'active'),
      /blocked by unfinished dependencies/
    );
    await coordination.updateTask('/project', prerequisite.id, 'done');
    await coordination.assignTask('/project', dependent.id, {sessionId: 'lane-client'});

    assert.equal(coordination.get('/project').tasks.find(task => task.id === dependent.id)?.status, 'active');
  });

  it('rejects unknown and cyclic dependency graphs without changing the board', async () => {
    const coordination = await manager();
    await assert.rejects(() => coordination.task('/project', {title: 'bad', dependsOn: ['does-not-exist']}), /No task matches/);
    const first = (await coordination.task('/project', {title: 'first'})).tasks[0]!;
    const second = (await coordination.task('/project', {title: 'second'})).tasks[0]!;
    await coordination.setDependencies('/project', first.id, [second.id]);
    await assert.rejects(() => coordination.setDependencies('/project', second.id, [first.id]), /cannot contain a cycle/);

    const state = coordination.get('/project');
    assert.deepEqual(state.tasks.find(task => task.id === first.id)?.dependsOn, [second.id]);
    assert.equal(state.tasks.find(task => task.id === second.id)?.dependsOn, undefined);
    assert.equal(state.events.at(-1)?.kind, 'task.dependencies_changed');
  });

  it('repairs a restored graph that references missing tasks or contains a cycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
    directories.push(directory);
    const {mkdir, writeFile} = await import('node:fs/promises');
    await mkdir(directory, {recursive: true});
    const now = new Date().toISOString();
    await writeFile(join(directory, 'coordination.json'), JSON.stringify([{
      project: '/project', claims: [], decisions: [], handoffs: [], messages: [], events: [],
      tasks: [
        {id: 'task-a', title: 'A', status: 'todo', createdAt: now, dependsOn: ['task-b', 'missing']},
        {id: 'task-b', title: 'B', status: 'todo', createdAt: now, dependsOn: ['task-a']}
      ]
    }]));
    const coordination = new CoordinationManager(directory);
    await coordination.restore();

    const state = coordination.get('/project');
    assert.deepEqual(state.tasks.find(task => task.id === 'task-a')?.dependsOn, ['task-b']);
    assert.equal(state.tasks.find(task => task.id === 'task-b')?.dependsOn, undefined);
  });
});

describe('messages between lanes', () => {
  it('delivers to the named lane, oldest first', async () => {
    const coordination = await manager();
    await coordination.send('/project', 'lane-a', 'lane-b', 'first');
    await coordination.send('/project', 'lane-a', 'lane-b', 'second');

    const inbox = await coordination.inbox('/project', 'lane-b');

    assert.deepEqual(inbox.map(message => message.body), ['first', 'second'], 'a later message that assumes an earlier one was read is nonsense out of order');
  });

  it('only shows a lane its own mail', async () => {
    const coordination = await manager();
    await coordination.send('/project', 'lane-a', 'lane-b', 'for b');
    await coordination.send('/project', 'lane-b', 'lane-a', 'for a');

    assert.deepEqual((await coordination.inbox('/project', 'lane-a')).map(message => message.body), ['for a']);
  });

  it('reading marks it read, so the same message is not delivered twice', async () => {
    const coordination = await manager();
    await coordination.send('/project', 'lane-a', 'lane-b', 'once');

    assert.equal((await coordination.inbox('/project', 'lane-b')).length, 1);
    assert.equal((await coordination.inbox('/project', 'lane-b')).length, 0);
    assert.equal(coordination.unreadCount('/project', 'lane-b'), 0);
  });

  it('peeking leaves it unread, which is what the UI needs', async () => {
    const coordination = await manager();
    await coordination.send('/project', 'lane-a', 'lane-b', 'still waiting');

    assert.equal((await coordination.inbox('/project', 'lane-b', {peek: true})).length, 1);
    assert.equal(coordination.unreadCount('/project', 'lane-b'), 1, 'watching is not reading');
  });

  it('keeps read mail in the record rather than deleting it', async () => {
    const coordination = await manager();
    await coordination.send('/project', 'lane-a', 'lane-b', 'archived');
    await coordination.inbox('/project', 'lane-b');

    assert.equal(coordination.messages('/project').length, 1, 'the user can still see what the lanes said to each other');
    assert.ok(coordination.messages('/project')[0]?.readAt);
  });

  it('refuses an empty message rather than queueing nothing', async () => {
    const coordination = await manager();
    await assert.rejects(() => coordination.send('/project', 'lane-a', 'lane-b', '   '));
  });

  it('survives state written before messages existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
    directories.push(directory);
    const {writeFile} = await import('node:fs/promises');
    await writeFile(join(directory, 'coordination.json'), JSON.stringify([{project: '/project', tasks: [], claims: [], decisions: [], handoffs: []}]));

    const coordination = new CoordinationManager(directory);
    await coordination.restore();

    assert.deepEqual(coordination.messages('/project'), []);
    await coordination.send('/project', 'lane-a', 'lane-b', 'works');
    assert.equal(coordination.messages('/project').length, 1);
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

describe('retained coordination history', () => {
  it('persists a master brief and specialist ticket assignment across a daemon restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
    directories.push(directory);
    const coordination = new CoordinationManager(directory);
    await coordination.setMasterBrief('/project', 'Ship the settings flow with explicit account choice.');
    const created = await coordination.task('/project', {
      title: 'Build credential form', description: 'Keep keyboard flow and validation visible.',
      role: 'frontend', provider: 'claude', source: 'spec'
    });
    const task = created.tasks[0]!;
    await coordination.assignTask('/project', task.id, {sessionId: 'lane-frontend', provider: 'claude', role: 'frontend'});

    const state = coordination.get('/project');
    assert.equal(state.masterBrief, 'Ship the settings flow with explicit account choice.');
    assert.equal(state.tasks[0]?.status, 'active');
    assert.equal(state.tasks[0]?.provider, 'claude');
    assert.equal(state.tasks[0]?.role, 'frontend');
    assert.equal(state.tasks[0]?.source, 'spec');
    assert.deepEqual(state.events.map(event => event.kind), ['master_brief.set', 'task.created', 'task.assigned']);

    const afterRestart = new CoordinationManager(directory);
    await afterRestart.restore();
    const restored = afterRestart.get('/project');
    assert.equal(restored.masterBrief, state.masterBrief);
    assert.deepEqual(restored.tasks[0], state.tasks[0]);
  });

  it('records meaningful board changes but not read, lease-heartbeat, or idempotent noise', async () => {
    const coordination = await manager();
    const task = (await coordination.task('/project', {title: 'history task'}, 'lane-a')).tasks[0]!;
    await coordination.updateTask('/project', task.id, 'active', 'lane-a', 'lane-a');
    await coordination.updateTask('/project', task.id, 'active', 'lane-a', 'lane-a');
    await coordination.claim('/project', 'src/declared.ts', 'lane-a');
    await coordination.claim('/project', 'src/declared.ts', 'lane-a');
    await coordination.claim('/project', 'src/declared.ts', 'lane-b');
    await coordination.observe('/project', 'lane-a', ['src/observed.ts']);
    await coordination.observe('/project', 'lane-a', []);
    await coordination.releaseClaim('/project', 'src/declared.ts', 'lane-a', 'lane-a');
    await coordination.decision('/project', 'keep it local', 'lane-a', 'lane-a');
    const handoff = (await coordination.handoff('/project', 'lane-a', 'lane-b', 'review it', 'lane-a')).handoffs[0]!;
    await coordination.acceptHandoff('/project', handoff.id);
    await coordination.acceptHandoff('/project', handoff.id);
    await coordination.send('/project', 'lane-a', 'lane-b', 'ready');
    await coordination.inbox('/project', 'lane-b');
    const countBeforeHeartbeat = coordination.get('/project').events.length;
    await coordination.renewLeases(['lane-a']);

    const events = coordination.get('/project').events;
    assert.deepEqual([...events.map(event => event.kind)].sort(), [
      'task.created', 'task.status_changed', 'claim.declared', 'claim.conflicted', 'claim.observed',
      'claim.released', 'claim.released', 'decision.recorded', 'handoff.requested', 'handoff.accepted', 'message.sent'
    ].sort());
    assert.deepEqual([...events.filter(event => event.kind === 'claim.released').map(event => event.releaseReason)].sort(), ['observed_cleared', 'released']);
    assert.equal(events.find(event => event.kind === 'task.created')?.actorSessionId, 'lane-a');
    assert.equal(events.find(event => event.kind === 'handoff.accepted')?.actorSessionId, undefined, 'user acceptance is not falsely attributed to a lane');
    assert.equal(events.length, countBeforeHeartbeat, 'lease renewal does not add journal noise');
  });

  it('records session and lease claim releases, and bounds history oldest-first', async () => {
    const coordination = await manager();
    await coordination.claim('/project', 'src/session.ts', 'lane-session');
    await coordination.releaseSession('lane-session');
    await coordination.claim('/project', 'src/expired.ts', 'lane-expired');
    coordination.get('/project').claims[0]!.expiresAt = new Date(Date.now() - 1).toISOString();
    await coordination.renewLeases([]);
    assert.deepEqual(
      coordination.get('/project').events.filter(event => event.kind === 'claim.released').map(event => event.releaseReason),
      ['session_ended', 'lease_expired']
    );

    const state = coordination.get('/project');
    state.events = Array.from({length: coordinationEventLimit}, (_, index) => ({
      id: `old-${String(index).padStart(4, '0')}`,
      at: `2020-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      kind: 'task.created' as const,
      sessionIds: [],
      taskId: `old-task-${index}`
    }));
    await coordination.task('/project', {title: 'newest'});
    assert.equal(state.events.length, coordinationEventLimit);
    assert.ok(!state.events.some(event => event.id === 'old-0000'));
    assert.equal(state.events.at(-1)?.kind, 'task.created');
  });

  it('migrates missing claim IDs and safely ignores malformed historic events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
    directories.push(directory);
    const {writeFile} = await import('node:fs/promises');
    await writeFile(join(directory, 'coordination.json'), JSON.stringify([{
      project: '/project', tasks: [], claims: [{path: 'src/a.ts', sessionId: 'lane-a', createdAt: new Date().toISOString()}], decisions: [], handoffs: [], messages: [],
      events: [
        {id: 'valid', at: '2026-09-14T00:00:00.000Z', kind: 'task.created', sessionIds: [], taskId: 'task-a'},
        {id: 'bad-time', at: 'not-a-date', kind: 'task.created', sessionIds: [], taskId: 'task-b'},
        {id: 'bad-payload', at: '2026-09-14T00:00:01.000Z', kind: 'claim.released', sessionIds: []},
        'not an event'
      ]
    }]));

    const coordination = new CoordinationManager(directory);
    await coordination.restore();
    const migratedClaimId = coordination.get('/project').claims[0]?.id;
    assert.ok(migratedClaimId, 'pre-history claims receive a stable identity');
    assert.deepEqual(coordination.get('/project').events.map(event => event.id), ['valid']);

    const afterRestart = new CoordinationManager(directory);
    await afterRestart.restore();
    assert.equal(afterRestart.get('/project').claims[0]?.id, migratedClaimId, 'migration persists before a later board mutation can happen');
  });
});

describe('handoff decisions', () => {
  it('lets the user decline an open handoff, and keeps a decided one decided', async () => {
    const coordination = await manager();
    const state = await coordination.handoff('/project', 'lane-a', 'lane-b', 'review the router');
    const handoffId = state.handoffs[0]!.id;

    const declined = await coordination.declineHandoff('/project', handoffId);

    assert.equal(declined.handoffs[0]?.status, 'declined');
    assert.ok(declined.events.some(event => event.kind === 'handoff.declined' && event.handoffId === handoffId));
    await assert.rejects(() => coordination.acceptHandoff('/project', handoffId), /declined/);
  });

  it('does not decline a handoff that was already accepted', async () => {
    const coordination = await manager();
    const state = await coordination.handoff('/project', 'lane-a', 'lane-b', 'review the router');
    await coordination.acceptHandoff('/project', state.handoffs[0]!.id);
    await assert.rejects(() => coordination.declineHandoff('/project', state.handoffs[0]!.id), /accepted/);
  });
});

describe('editing and deleting tasks', () => {
  it('edits a task title, brief, and role, and refuses an empty title', async () => {
    const coordination = await manager();
    const created = await coordination.task('/project', {title: 'Parse config'});
    const taskId = created.tasks[0]!.id;

    const edited = await coordination.editTask('/project', taskId, {title: 'Parse the config file', description: 'TOML and JSON', role: 'backend'});

    assert.deepEqual(
      {title: edited.tasks[0]?.title, description: edited.tasks[0]?.description, role: edited.tasks[0]?.role},
      {title: 'Parse the config file', description: 'TOML and JSON', role: 'backend'}
    );
    assert.ok(edited.events.some(event => event.kind === 'task.edited' && event.taskId === taskId));
    await assert.rejects(() => coordination.editTask('/project', taskId, {title: '   '}), /title/);
  });

  it('deletes a task and removes it from the tasks that depended on it', async () => {
    const coordination = await manager();
    const first = (await coordination.task('/project', {title: 'Schema'})).tasks[0]!;
    const second = (await coordination.task('/project', {title: 'Parser', dependsOn: [first.id]})).tasks[0]!;

    const state = await coordination.deleteTask('/project', first.id);

    assert.deepEqual(state.tasks.map(task => task.id), [second.id]);
    assert.equal(state.tasks[0]?.dependsOn, undefined, 'a deleted prerequisite no longer blocks anything');
    assert.ok(state.events.some(event => event.kind === 'task.deleted' && event.taskId === first.id));
  });

  it('keeps declines, edits, and deletions in the restored journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-coordination-'));
    directories.push(directory);
    const coordination = new CoordinationManager(directory);
    const task = (await coordination.task('/project', {title: 'Parse config'})).tasks[0]!;
    await coordination.editTask('/project', task.id, {title: 'Parse the config file'});
    await coordination.deleteTask('/project', task.id);
    const handoff = (await coordination.handoff('/project', 'lane-a', 'lane-b', 'review')).handoffs[0]!;
    await coordination.declineHandoff('/project', handoff.id);

    const restored = new CoordinationManager(directory);
    await restored.restore();
    const kinds = restored.get('/project').events.map(event => event.kind);

    for (const kind of ['task.edited', 'task.deleted', 'handoff.declined']) assert.ok(kinds.includes(kind as never), `${kind} survives a restart`);
    assert.equal(restored.get('/project').handoffs[0]?.status, 'declined');
  });
});
