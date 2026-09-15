import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {findCodexSession} from './native-sessions.js';

const roots: string[] = [];

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'fluent-native-'));
  roots.push(root);
  return root;
}

/** Writes a Codex rollout the way the CLI does: dated folders, session_meta as the first line. */
async function rollout(codexHome: string, id: string, cwd: string, timestamp: string) {
  const date = new Date(timestamp);
  const folder = join(codexHome, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  await mkdir(folder, {recursive: true});
  const meta = {timestamp, type: 'session_meta', payload: {id, session_id: id, timestamp, cwd, originator: 'codex-tui'}};
  await writeFile(join(folder, `rollout-${timestamp.replace(/[:.]/g, '-')}-${id}.jsonl`), `${JSON.stringify(meta)}\n{"type":"event"}\n`);
}

after(async () => {
  for (const root of roots) await rm(root, {recursive: true, force: true});
});

describe('finding a lane\'s own Codex session', () => {
  it('picks the session that started in the lane directory after the lane did', async () => {
    const codexHome = await scratch();
    const lane = await scratch();
    await rollout(codexHome, 'aaaaaaaa-0000-4000-8000-000000000001', lane, '2026-09-15T10:00:05.000Z');
    await rollout(codexHome, 'aaaaaaaa-0000-4000-8000-000000000002', lane, '2026-09-15T10:20:00.000Z');

    assert.equal(await findCodexSession(lane, '2026-09-15T10:00:00.000Z', codexHome), 'aaaaaaaa-0000-4000-8000-000000000002', 'the most recent session in that directory wins');
  });

  it('ignores sessions from other directories and ones that started before the lane', async () => {
    const codexHome = await scratch();
    const lane = await scratch();
    const elsewhere = await scratch();
    await rollout(codexHome, 'bbbbbbbb-0000-4000-8000-000000000001', lane, '2026-09-14T09:00:00.000Z');
    await rollout(codexHome, 'bbbbbbbb-0000-4000-8000-000000000002', elsewhere, '2026-09-15T10:05:00.000Z');

    assert.equal(await findCodexSession(lane, '2026-09-15T10:00:00.000Z', codexHome), undefined);
  });

  it('returns nothing when Codex has no session files', async () => {
    assert.equal(await findCodexSession(await scratch(), '2026-09-15T10:00:00.000Z', await scratch()), undefined);
  });
});
