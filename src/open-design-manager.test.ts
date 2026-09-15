import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {normalizeLocalUrl, OpenDesignManager} from './open-design-manager.js';

const roots: string[] = [];

async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fluent-open-design-'));
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, {recursive: true, force: true});
});

describe('OpenDesign origin boundary', () => {
  it('retains only a credential-free loopback origin', () => {
    assert.equal(normalizeLocalUrl('https://LOCALHOST:7456/a/path?view=editor#canvas'), 'https://localhost:7456');
    assert.equal(normalizeLocalUrl('http://[::1]:7456'), 'http://[::1]:7456');
    for (const value of [
      'https://example.com',
      'http://user:secret@localhost:7456',
      'file:///tmp/open-design.html',
      'http://localhost:7456\nhttps://example.com'
    ]) {
      assert.throws(() => normalizeLocalUrl(value), /OpenDesign/);
    }
  });

  it('does not let state written before enablement gain frame permission on restore', async () => {
    const root = await stateRoot();
    await writeFile(join(root, 'open-design.json'), JSON.stringify({url: 'http://127.0.0.1:7456'}), {mode: 0o600});
    const restored = new OpenDesignManager(root);
    await restored.restore();
    assert.deepEqual(restored.get(), {url: 'http://127.0.0.1:7456', enabled: false});

    await restored.save('http://localhost:4200/design?mode=edit');
    assert.deepEqual(restored.get(), {url: 'http://localhost:4200', enabled: true});

    const reread = new OpenDesignManager(root);
    await reread.restore();
    assert.deepEqual(reread.get(), {url: 'http://localhost:4200', enabled: true});
  });
});
