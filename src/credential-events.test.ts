import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {appendCredentialEvent, listCredentialEvents} from './credential-events.js';

const directories: string[] = [];
async function stateDir() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-credential-events-'));
  directories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('the credential event log', () => {
  it('reads back an appended event', async () => {
    const directory = await stateDir();
    const event = {at: new Date().toISOString(), provider: 'claude' as const, fromAccountId: 'work-sub', toAccountId: 'work-credits', reason: 'fallback' as const};
    await appendCredentialEvent(directory, event);

    const events = await listCredentialEvents(directory, 0);

    assert.deepEqual(events, [event]);
  });

  it('keeps every event in append order across several switches', async () => {
    const directory = await stateDir();
    await appendCredentialEvent(directory, {at: new Date(1_000).toISOString(), provider: 'claude', toAccountId: 'a', reason: 'fallback'});
    await appendCredentialEvent(directory, {at: new Date(2_000).toISOString(), provider: 'claude', toAccountId: 'b', reason: 'revert'});

    const events = await listCredentialEvents(directory, 0);

    assert.deepEqual(events.map(event => event.toAccountId), ['a', 'b']);
  });

  it('excludes an event before the requested range', async () => {
    const directory = await stateDir();
    await appendCredentialEvent(directory, {at: new Date(1_000).toISOString(), provider: 'claude', toAccountId: 'a', reason: 'fallback'});
    await appendCredentialEvent(directory, {at: new Date(5_000).toISOString(), provider: 'claude', toAccountId: 'b', reason: 'fallback'});

    const events = await listCredentialEvents(directory, 3_000);

    assert.deepEqual(events.map(event => event.toAccountId), ['b']);
  });

  it('is empty for a provider that never switched', async () => {
    const directory = await stateDir();

    assert.deepEqual(await listCredentialEvents(directory, 0), []);
  });

  it('drops a torn final line rather than treating it as a crash', async () => {
    const directory = await stateDir();
    await appendCredentialEvent(directory, {at: new Date(1_000).toISOString(), provider: 'claude', toAccountId: 'a', reason: 'fallback'});
    // Simulate an unclean shutdown mid-write: append a partial JSON fragment directly.
    const {appendPrivateLine} = await import('./security/secure-state.js');
    await appendPrivateLine(join(directory, 'credential-events.jsonl'), '{"at":"2026-01-01T00:00:00.000Z","provider":"cla');

    const events = await listCredentialEvents(directory, 0);

    assert.deepEqual(events.map(event => event.toAccountId), ['a']);
  });
});
