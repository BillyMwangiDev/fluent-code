import assert from 'node:assert/strict';
import {appendFile, lstat, mkdtemp, rm, stat, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {ApprovalRecords, canonicalApprovalTarget} from './approval-records.js';
import {appendPrivateLine, readPrivateFile, writePrivateFile} from './secure-state.js';

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-secure-state-'));
  directories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('secure state', () => {
  it('uses private modes and fsync-safe atomic writes', async () => {
    const root = await workspace();
    const path = join(root, 'state', 'sample.json');
    await writePrivateFile(path, '{"ok":true}\n');
    await appendPrivateLine(join(root, 'state', 'events.jsonl'), '{"sequence":1}');

    assert.equal((await stat(join(root, 'state'))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'state', 'events.jsonl'))).mode & 0o777, 0o600);
    assert.equal(await readPrivateFile(path), '{"ok":true}\n');
  });

  it('rejects state files which are symlinks', async () => {
    const root = await workspace();
    const target = join(root, 'target');
    const path = join(root, 'state', 'unsafe.json');
    await writePrivateFile(target, 'target');
    await writePrivateFile(join(root, 'state', 'placeholder'), 'placeholder');
    await symlink(target, path);

    await assert.rejects(() => readPrivateFile(path), /unsafe state file/);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
  });
});

describe('daemon approval records', () => {
  it('binds a single-use approval to the action, canonical target, command, and base SHA', async () => {
    const root = await workspace();
    const target = join(root, 'project');
    await writePrivateFile(join(target, 'sentinel'), 'ok');
    const approvals = new ApprovalRecords(join(root, 'state'));
    const record = await approvals.issue({action: 'integration.merge', target, command: 'git merge lane', baseSha: 'abc123'});

    assert.match(record.target, /^path:/);
    await approvals.consume({id: record.id, action: 'integration.merge', target, command: 'git merge lane', baseSha: 'abc123'});
    await assert.rejects(() => approvals.consume({id: record.id, action: 'integration.merge', target, command: 'git merge lane', baseSha: 'abc123'}), /already been used/);
  });

  it('does not allow a valid record to authorize a changed target, command, or SHA', async () => {
    const root = await workspace();
    const target = join(root, 'project');
    await writePrivateFile(join(target, 'sentinel'), 'ok');
    const approvals = new ApprovalRecords(join(root, 'state'));
    const record = await approvals.issue({action: 'recipe.execute', target, command: 'pnpm test', baseSha: 'one'});

    await assert.rejects(() => approvals.consume({id: record.id, action: 'recipe.execute', target, command: 'pnpm lint', baseSha: 'one'}), /does not authorize/);
    await assert.rejects(() => approvals.consume({id: record.id, action: 'recipe.execute', target, command: 'pnpm test', baseSha: 'two'}), /does not authorize/);
  });

  it('expires records and canonicalizes opaque identifiers without treating them as paths', async () => {
    const root = await workspace();
    const approvals = new ApprovalRecords(join(root, 'state'));
    const record = await approvals.issue({action: 'extension.install', target: 'claude:plugin/demo', ttlMs: 1});
    await new Promise(resolve => setTimeout(resolve, 5));

    await assert.rejects(() => approvals.consume({id: record.id, action: 'extension.install', target: 'claude:plugin/demo'}), /expired/);
    assert.equal(await canonicalApprovalTarget('  claude:plugin/demo  '), 'id:claude:plugin/demo');
  });
});
