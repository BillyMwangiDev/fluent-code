import assert from 'node:assert/strict';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {approvalFrom, CodexAppServer, quotaFrom, windowFrom} from './codex-app-server.js';
import {mergeQuota} from './usage-monitor.js';
import type {ProviderQuota} from './daemon-protocol.js';

const directories: string[] = [];

/**
 * A stand-in app-server speaking the documented wire format. The real `codex` binary is not
 * installed in this environment, so the protocol handling is proven against a scripted peer rather
 * than against Codex itself — see the caveat in the commit message.
 */
async function fakeServer(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-codex-'));
  directories.push(directory);
  const path = join(directory, 'codex');
  await writeFile(path, `#!/usr/bin/env node
'use strict';
if (process.argv[2] !== 'app-server') { process.exit(2); }
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    handle(request, send);
  }
});
${body}
`);
  await chmod(path, 0o755);
  return path;
}

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('reading Codex rate limits', () => {
  it('converts a window, turning the Unix reset into a timestamp', () => {
    const window = windowFrom({usedPercent: 42, windowDurationMins: 300, resetsAt: 1_760_000_000});
    assert.equal(window?.usedPercent, 42);
    assert.equal(window?.windowMinutes, 300);
    assert.equal(window?.resetsAt, new Date(1_760_000_000_000).toISOString());
  });

  it('drops a window carrying nothing, so it merges as unchanged rather than as empty', () => {
    assert.equal(windowFrom({}), undefined);
    assert.equal(windowFrom(undefined), undefined);
  });

  it('reads both the nested and the bare payload shape', () => {
    const nested = quotaFrom({rateLimits: {primary: {usedPercent: 10, windowDurationMins: 300}}});
    const bare = quotaFrom({primary: {usedPercent: 10, windowDurationMins: 300}});
    assert.equal(nested?.primary?.usedPercent, 10);
    assert.equal(bare?.primary?.usedPercent, 10);
  });

  it('reads a payload carrying only the weekly window', () => {
    const quota = quotaFrom({primary: undefined, secondary: {usedPercent: 88, windowDurationMins: 10_080}});
    assert.equal(quota?.primary, undefined);
    assert.equal(quota?.secondary?.usedPercent, 88);
  });

  it('reports nothing for a payload with no windows at all', () => {
    assert.equal(quotaFrom({}), undefined);
    assert.equal(quotaFrom(null), undefined);
  });
});

describe('reading documented Codex approval requests', () => {
  it('keeps server request ids opaque and does not fabricate a command for a non-command approval', () => {
    const approval = approvalFrom({
      id: 'server-request-7',
      method: 'item/fileChange/requestApproval',
      params: {threadId: 'thread-1', turnId: 'turn-1', item: {id: 'item-1'}, reason: 'edit a file'}
    });

    assert.deepEqual(approval, {
      requestId: 'server-request-7',
      method: 'item/fileChange/requestApproval',
      kind: 'file-change',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      reason: 'edit a file',
      command: undefined,
      cwd: undefined,
      grantRoot: undefined
    });
  });

  it('ignores malformed or unknown server requests', () => {
    assert.equal(approvalFrom({id: 1, method: 'turn/started', params: {}}), undefined);
    assert.equal(approvalFrom({method: 'item/commandExecution/requestApproval', params: {}}), undefined);
  });
});

describe('merging sparse quota updates', () => {
  it('keeps a window an update does not mention', () => {
    const first: ProviderQuota = {primary: {usedPercent: 20, windowMinutes: 300}, secondary: {usedPercent: 60, windowMinutes: 10_080}, observedAt: 'a'};

    const merged = mergeQuota(first, {primary: {usedPercent: 35}, observedAt: 'b'});

    assert.equal(merged.primary?.usedPercent, 35);
    assert.equal(merged.primary?.windowMinutes, 300, 'an absent field within a window is unchanged too');
    assert.equal(merged.secondary?.usedPercent, 60, 'an absent window is unchanged, never cleared');
  });

  it('accepts a first report with nothing to merge into', () => {
    assert.equal(mergeQuota(undefined, {secondary: {usedPercent: 5}}).secondary?.usedPercent, 5);
  });
});

describe('talking to an app-server', () => {
  it('initializes, then reads rate limits and reports them', async () => {
    const executable = await fakeServer(`
function handle(request, send) {
  if (request.method === 'initialize') return send({id: request.id, result: {serverInfo: {name: 'fake'}}});
  if (request.method === 'account/rateLimits/read') {
    return send({id: request.id, result: {rateLimits: {primary: {usedPercent: 42, windowDurationMins: 300, resetsAt: 1760000000}, secondary: {usedPercent: 70, windowDurationMins: 10080}}}});
  }
  send({id: request.id, error: {message: 'unexpected ' + request.method}});
}`);
    const channel = new CodexAppServer({executable});
    const reported: Array<Partial<ProviderQuota>> = [];
    channel.on('quota', quota => reported.push(quota));

    assert.equal(await channel.start(), true);
    const quota = await channel.readRateLimits();
    channel.stop();

    assert.equal(quota?.primary?.usedPercent, 42);
    assert.equal(quota?.secondary?.usedPercent, 70);
    assert.equal(reported.length, 1, 'a read is also announced, so a caller need not poll');
  });

  it('completes the initialize handshake and reports a structured approval request', async () => {
    const executable = await fakeServer(`
let initialized = false;
function handle(request, send) {
  if (request.method === 'initialize') return send({id: request.id, result: {}});
  if (request.method === 'initialized') {
    initialized = true;
    return setTimeout(() => send({
      id: 'approval-request-1',
      method: 'item/commandExecution/requestApproval',
      params: {threadId: 'thread-1', turnId: 'turn-1', item: {id: 'item-1', command: 'git status', cwd: '/repo'}, reason: 'needs review'}
    }), 10);
  }
  if (request.id === 'approval-request-1') {
    if (request.result?.decision !== 'decline') process.exit(3);
    return send({method: 'usage.rate_limits', params: {primary: {usedPercent: 23}}});
  }
  send({id: request.id, result: {}});
}`);
    const channel = new CodexAppServer({executable});
    const approval = new Promise<any>(resolve => channel.once('approval', resolve));
    const response = new Promise<Partial<ProviderQuota>>(resolve => channel.once('quota', resolve));

    assert.equal(await channel.start(), true);
    const reported = await approval;
    const quota = await response;
    channel.stop();

    assert.equal(reported.requestId, 'approval-request-1');
    assert.equal(reported.kind, 'command');
    assert.equal(reported.command, 'git status');
    assert.equal(reported.cwd, '/repo');
    assert.equal(quota.primary?.usedPercent, 23, 'the fake server observed Fluent fail closed before it continued');
  });

  it('picks up rate limits pushed as a notification', async () => {
    const executable = await fakeServer(`
function handle(request, send) {
  if (request.method === 'initialize') {
    send({id: request.id, result: {}});
    setTimeout(() => send({method: 'usage.rate_limits', params: {primary: {usedPercent: 13, windowDurationMins: 300}}}), 20);
    return;
  }
  send({id: request.id, result: {}});
}`);
    const channel = new CodexAppServer({executable});
    const quota = await new Promise<Partial<ProviderQuota>>(async resolve => {
      channel.on('quota', resolve);
      await channel.start();
    });
    channel.stop();

    assert.equal(quota.primary?.usedPercent, 13);
  });

  it('survives an app-server that answers the first read with nothing', async () => {
    // The documented early-initialize state: a read too soon comes back empty.
    const executable = await fakeServer(`
function handle(request, send) {
  if (request.method === 'initialize') return send({id: request.id, result: {}});
  send({id: request.id, result: {rateLimits: {}}});
}`);
    const channel = new CodexAppServer({executable});

    assert.equal(await channel.start(), true);
    assert.equal(await channel.readRateLimits(), undefined, 'empty is a state, not a crash');
    channel.stop();
  });

  it('reports a failure to start instead of throwing into the lane', async () => {
    const channel = new CodexAppServer({executable: '/nonexistent/codex'});

    assert.equal(await channel.start(), false, 'a lane whose channel will not open still runs its PTY');
    channel.stop();
  });

  it('gives up on an app-server that never completes initialize', async () => {
    const executable = await fakeServer(`
function handle(request, send) { /* deliberately silent */ }`);
    const channel = new CodexAppServer({executable});

    assert.equal(await channel.start(), false);
    channel.stop();
  });

  it('ignores a line that is not JSON rather than desynchronizing', async () => {
    const executable = await fakeServer(`
function handle(request, send) {
  if (request.method === 'initialize') {
    process.stdout.write('not json at all\\n');
    return send({id: request.id, result: {}});
  }
  send({id: request.id, result: {rateLimits: {primary: {usedPercent: 7}}}});
}`);
    const channel = new CodexAppServer({executable});

    assert.equal(await channel.start(), true);
    assert.equal((await channel.readRateLimits())?.primary?.usedPercent, 7);
    channel.stop();
  });

  it('announces closing once, even when stopped twice', async () => {
    const executable = await fakeServer(`
function handle(request, send) { send({id: request.id, result: {}}); }`);
    const channel = new CodexAppServer({executable});
    let closed = 0;
    channel.on('closed', () => closed++);

    await channel.start();
    channel.stop();
    channel.stop();

    assert.equal(closed, 1);
  });
});
