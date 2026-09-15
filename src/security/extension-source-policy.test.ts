import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {ExtensionSourcePolicy} from './extension-source-policy.js';

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-extension-policy-'));
  directories.push(directory);
  return directory;
}
after(async () => { for (const directory of directories) await rm(directory, {recursive: true, force: true}); });

describe('extension source policy', () => {
  it('starts review-each, then durably requires the exact trusted source', async () => {
    const directory = await workspace();
    const policy = new ExtensionSourcePolicy(directory);
    await policy.restore();
    const github = {id: 'marketplace:github:example/tools', kind: 'marketplace' as const, source: 'github.com/example/tools'};

    assert.equal(policy.allows(github), true, 'the default preserves existing approval-per-action behavior');
    await policy.setMode('trusted-only');
    assert.equal(policy.allows(github), false);
    await policy.trust(github);
    assert.equal(policy.allows(github), true);
    assert.equal(policy.allows({...github, id: 'marketplace:github:example/other'}), false);

    const restored = new ExtensionSourcePolicy(directory);
    await restored.restore();
    assert.deepEqual(restored.get().sources.map(source => source.id), [github.id]);
    assert.equal(restored.get().mode, 'trusted-only');
  });

  it('does not turn repeated trust into duplicate authority and allows deliberate removal', async () => {
    const policy = new ExtensionSourcePolicy(await workspace());
    const source = {id: 'mcp:exact-declaration', kind: 'mcp' as const, source: 'local MCP process: node server.js'};
    await policy.trust(source);
    await policy.trust(source);
    assert.equal(policy.get().sources.length, 1);
    await policy.remove(source.id);
    assert.equal(policy.get().sources.length, 0);
    await assert.rejects(() => policy.remove(source.id), /not found/);
  });
});
