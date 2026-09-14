import assert from 'node:assert/strict';
import {appendFile, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {RunEventBus} from './event-bus.js';
import {RunStore} from './run-store.js';

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-runs-'));
  directories.push(directory);
  return directory;
}
// Snapshot writes are coalesced onto a timer, so one can still land while a directory is removed.
after(async () => { for (const directory of directories) await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });

describe('durable run store', () => {
  it('persists transitions before publishing and restores an intended PTY write as unknown', async () => {
    const state = await workspace();
    const store = new RunStore(state);
    const run = await store.create({id: 'run-a', provider: 'claude'});
    await store.transition(run.id, 'preparing', 'created');
    await store.ready(run.id);
    await store.transition(run.id, 'running', 'provider spawned');
    await store.dispatchIntent(run.id, {inputBytes: 42, input: 'sk-ant-canary-secret'});

    const files = await Promise.all([
      readFile(join(state, 'execution', 'runs.snapshot.json'), 'utf8'),
      readFile(join(state, 'execution', 'runs.events.jsonl'), 'utf8')
    ]);
    assert.equal(files.join('\n').includes('sk-ant-canary-secret'), false, 'raw input cannot enter a durable run artifact');

    const restored = new RunStore(state);
    await restored.restore();
    assert.equal(restored.get(run.id).delivery, 'unknown');
    assert.equal(restored.eventsSince(run.id).events.at(-1)?.type, 'run.delivery_unknown');
  });

  it('recovers a complete event while ignoring a torn trailing JSONL record', async () => {
    const state = await workspace();
    const store = new RunStore(state);
    const run = await store.create({id: 'run-b', provider: 'codex'});
    await store.transition(run.id, 'preparing', 'created');
    await store.transition(run.id, 'ready', 'ready');
    await appendFile(join(state, 'execution', 'runs.events.jsonl'), '{"partial":');

    const restored = new RunStore(state);
    await restored.restore();
    assert.equal(restored.get(run.id).state, 'ready');
  });

  it('recovers journaled events recorded just before a restart, before any snapshot was written', async () => {
    const state = await workspace();
    const store = new RunStore(state);
    const run = await store.create({id: 'run-burst', provider: 'claude'});
    await store.transition(run.id, 'preparing', 'created');
    await store.transition(run.id, 'ready', 'ready');
    await store.transition(run.id, 'running', 'provider spawned');
    for (let chunk = 0; chunk < 50; chunk++) await store.record(run.id, 'text.delta', {bytes: 10});

    const restored = new RunStore(state);
    await restored.restore();

    assert.equal(restored.get(run.id).state, 'running', 'the journal alone carries the state');
    assert.equal(restored.eventsSince(run.id).events.filter(event => event.type === 'text.delta').length, 50);
  });

  it('writes every pending event into the snapshot on flush', async () => {
    const state = await workspace();
    const store = new RunStore(state);
    const run = await store.create({id: 'run-flush', provider: 'codex'});
    await store.transition(run.id, 'preparing', 'created');
    await store.record(run.id, 'text.delta', {bytes: 3});

    await store.flush();

    const snapshot = JSON.parse(await readFile(join(state, 'execution', 'runs.snapshot.json'), 'utf8'));
    assert.equal(snapshot.runs.find((candidate: {id: string}) => candidate.id === run.id).state, 'preparing');
    assert.equal(snapshot.events.filter((event: {runId: string}) => event.runId === run.id).length, 2);
  });

  it('keeps only a short tail of a finished run, in memory and in the journal, across a restart', async () => {
    const state = await workspace();
    const store = new RunStore(state);
    const run = await store.create({id: 'run-history', provider: 'codex'});
    await store.transition(run.id, 'preparing', 'created');
    await store.transition(run.id, 'ready', 'ready');
    await store.transition(run.id, 'running', 'provider spawned');
    for (let chunk = 0; chunk < 120; chunk++) await store.record(run.id, 'text.delta', {bytes: 1});
    await store.transition(run.id, 'cancelled', 'user stopped session');

    await store.compact(1_000, 50);

    const page = store.eventsSince(run.id);
    assert.equal(page.events.length, 50);
    assert.equal(page.floor, 124 - 50, 'a reader behind the floor is told to resync rather than handed a gap');
    const journal = (await readFile(join(state, 'execution', 'runs.events.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(journal.length, 50);

    const restored = new RunStore(state);
    await restored.restore();
    assert.equal(restored.get(run.id).state, 'cancelled');
    assert.equal(restored.eventsSince(run.id).events.at(-1)?.sequence, 124);
  });

  it('gives concurrent events for one run distinct sequences', async () => {
    const store = new RunStore(await workspace());
    const run = await store.create({provider: 'claude'});
    const events = await Promise.all(Array.from({length: 20}, () => store.record(run.id, 'text.delta', {bytes: 1})));

    assert.equal(new Set(events.map(event => event.sequence)).size, 20);
  });

  it('has a finite transition table', async () => {
    const store = new RunStore(await workspace());
    const run = await store.create({provider: 'codex'});
    await assert.rejects(() => store.transition(run.id, 'succeeded', 'skipping work'), /Invalid run transition/);
  });
});

describe('resumable event delivery', () => {
  it('drops terminal deltas under pressure and gives the reader an honest resync receipt', async () => {
    const store = new RunStore(await workspace());
    const run = await store.create({provider: 'codex'});
    const bus = new RunEventBus(store, 1);
    const deliveries: string[] = [];
    const id = bus.subscribe(run.id, undefined, delivery => {
      deliveries.push(delivery.kind);
      return false; // model a full socket write buffer
    });
    bus.pause(id);
    const first = await store.record(run.id, 'text.delta', {bytes: 4});
    const second = await store.record(run.id, 'text.delta', {bytes: 4});
    const changed = await store.record(run.id, 'approval.requested', {scope: 'write'});
    bus.publish(first); bus.publish(second); bus.publish(changed);
    bus.resume(id);

    assert.ok(deliveries.includes('resync-required'));
  });
});
