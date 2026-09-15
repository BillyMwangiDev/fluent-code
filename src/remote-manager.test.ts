import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {normalizeRemoteProfileInput, RemoteManager} from './remote-manager.js';

// Covers the manager's whole handshake budget (12 probes, up to ~8.4s) plus a slow fake-ssh start
// when the full suite runs every test file at once.
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for remote tunnel');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function fakeSsh(root: string) {
  const bin = join(root, 'bin');
  await mkdir(bin);
  const executable = join(bin, 'ssh');
  await writeFile(executable, `#!/usr/bin/env node
const net = require('node:net');
const forward = process.argv[process.argv.indexOf('-L') + 1];
const localSocket = forward.slice(0, forward.indexOf(':'));
const protocolVersion = process.argv.at(-1).includes('old.') ? 2 : Number(process.env.FLUENT_TEST_PROTOCOL ?? '1');
const exitOnceFile = process.env.FLUENT_TEST_EXIT_ONCE_FILE;
const failAfterHandshake = Boolean(exitOnceFile && !require('node:fs').existsSync(exitOnceFile));
if (failAfterHandshake) require('node:fs').writeFileSync(exitOnceFile, 'started');
let failing = false;
const server = net.createServer(socket => socket.on('data', () => {
  socket.end(JSON.stringify({id: 'probe', ok: true, result: {protocolVersion}}) + '\\n');
  // Drop only after Fluent has seen this tunnel answer, so the test covers a connected tunnel
  // failing rather than racing the handshake against a fixed timer on a loaded machine.
  if (failAfterHandshake && !failing) {
    failing = true;
    setTimeout(() => server.close(() => process.exit(1)), 120).unref();
  }
}));
server.listen(localSocket);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  await chmod(executable, 0o755);
  return executable;
}

describe('remote profile validation', () => {
  it('accepts a bounded SSH destination and absolute remote Unix socket', () => {
    assert.deepEqual(
      normalizeRemoteProfileInput({name: 'build host', host: 'dev@builder.internal', port: 2202, remoteSocket: '/run/user/501/fluent.sock'}),
      {name: 'build host', host: 'dev@builder.internal', port: 2202, remoteSocket: '/run/user/501/fluent.sock', autoReconnect: false}
    );
  });

  it('refuses option-like, ambiguous, and control-character-bearing SSH inputs', () => {
    for (const input of [
      {name: 'host', host: '-oProxyCommand=evil'},
      {name: 'host', host: 'dev @builder'},
      {name: 'host', host: 'dev@@builder'},
      {name: 'host', host: 'dev@builder\n-r'},
      {name: '', host: 'builder'},
      {name: 'host', host: 'builder', port: 0},
      {name: 'host', host: 'builder', port: 65_536},
      {name: 'host', host: 'builder', remoteSocket: 'relative.sock'},
      {name: 'host', host: 'builder', remoteSocket: '/tmp/fluent:sock'}
    ]) {
      assert.throws(() => normalizeRemoteProfileInput(input), /Remote (name|host|SSH port|daemon socket)/);
    }
  });

  it('requires a compatible Fluent handshake before activating an SSH tunnel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fluent-remote-'));
    const manager = new RemoteManager(join(root, 'state'), {sshExecutable: await fakeSsh(root)});
    try {
      const profile = await manager.save({name: 'fixture', host: 'dev@builder.internal'});
      await manager.connect(profile.id);
      await waitFor(() => manager.list()[0]?.status === 'connected');
      assert.equal(manager.list()[0]?.status, 'connected');

      await manager.disconnect(profile.id);
      const incompatible = await manager.save({name: 'old fixture', host: 'old.builder.internal'});
      await manager.connect(incompatible.id);
      await waitFor(() => manager.list().find(item => item.id === incompatible.id)?.status === 'failed');
      assert.match(manager.list().find(item => item.id === incompatible.id)?.error ?? '', /protocol is incompatible/);
      await manager.disconnect(incompatible.id);
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      // A failed wait must not leave the fake tunnel running: its child process would keep this
      // test file, and so the whole suite, from ever exiting.
      await manager.shutdown();
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('remote tunnel recovery', () => {
  it('reconnects only when the saved, user-selected policy enables it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fluent-remote-'));
    const exitFile = join(root, 'exit-once');
    const manager = new RemoteManager(join(root, 'state'), {
      sshExecutable: await fakeSsh(root),
      sshEnvironment: {...process.env, FLUENT_TEST_EXIT_ONCE_FILE: exitFile}
    });
    try {
      const profile = await manager.save({name: 'reconnect fixture', host: 'builder.internal', autoReconnect: true});
      await manager.connect(profile.id);
      await waitFor(() => manager.list()[0]?.status === 'connected');
      await waitFor(() => existsSync(exitFile));
      await waitFor(() => manager.list()[0]?.status === 'reconnecting');
      await waitFor(() => manager.list()[0]?.status === 'connected');
      assert.equal(manager.list()[0]?.autoReconnect, true);

      await manager.disconnect(profile.id);
      assert.equal(manager.list()[0]?.status, 'disconnected', 'a direct disconnect cancels any scheduled recovery');
    } finally {
      // A failed wait must not leave the fake tunnel running: its child process would keep this
      // test file, and so the whole suite, from ever exiting.
      await manager.shutdown();
      await rm(root, {recursive: true, force: true});
    }
  });
});
