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
after(async () => { for (const directory of directories) await rm(directory, {recursive: true, force: true}); });

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
