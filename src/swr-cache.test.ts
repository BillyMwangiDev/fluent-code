import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {KeyedMemo, Memo} from './swr-cache.js';

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('stale-while-revalidate memo', () => {
  it('loads once for concurrent callers and serves the value inside the ttl', async () => {
    let loads = 0;
    const memo = new Memo(1_000, async () => { loads += 1; await tick(10); return loads; });
    const [a, b] = await Promise.all([memo.get(), memo.get()]);
    assert.equal(a, 1); assert.equal(b, 1);
    assert.equal(await memo.get(), 1);
    assert.equal(loads, 1);
  });

  it('serves a stale value immediately and replaces it in the background', async () => {
    let loads = 0;
    const memo = new Memo(20, async () => { loads += 1; await tick(10); return loads; });
    assert.equal(await memo.get(), 1);
    await tick(30);
    assert.equal(await memo.get(), 1, 'stale answer comes back without waiting');
    await tick(30);
    assert.equal(await memo.get(), 2, 'the background reload has replaced it');
  });

  it('reloads after invalidate and when asked for a fresh answer', async () => {
    let loads = 0;
    const memo = new Memo(1_000, async () => ++loads);
    await memo.get();
    memo.invalidate();
    assert.equal(await memo.get(), 2);
    assert.equal(await memo.get({fresh: true}), 3);
  });

  it('keeps one memo per key', async () => {
    const seen: string[] = [];
    const memo = new KeyedMemo(1_000, async (key: string) => { seen.push(key); return key.toUpperCase(); });
    assert.equal(await memo.get('a'), 'A');
    assert.equal(await memo.get('b'), 'B');
    assert.equal(await memo.get('a'), 'A');
    assert.deepEqual(seen, ['a', 'b']);
    memo.invalidate('a');
    await memo.get('a');
    assert.deepEqual(seen, ['a', 'b', 'a']);
  });
});
