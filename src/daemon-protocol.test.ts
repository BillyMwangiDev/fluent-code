import assert from 'node:assert/strict';
import {test} from 'node:test';
import {daemonSocketPath} from './daemon-protocol.js';

test('uses an explicit IPC endpoint unchanged on every platform', () => {
  assert.equal(
    daemonSocketPath('win32', {FLUENT_SOCKET: String.raw`\\.\pipe\fluent-custom`} as NodeJS.ProcessEnv),
    String.raw`\\.\pipe\fluent-custom`
  );
});

test('uses the owner-local Unix socket on macOS and Linux', () => {
  assert.equal(daemonSocketPath('darwin', {XDG_RUNTIME_DIR: '/run/user/501'}), '/run/user/501/fluent-code.sock');
  assert.equal(daemonSocketPath('linux', {}), '/tmp/fluent-code.sock');
});

test('uses a stable Windows named pipe and normalizes an unsafe username', () => {
  assert.equal(
    daemonSocketPath('win32', {USERNAME: 'Jane Doe/Build'}),
    String.raw`\\.\pipe\fluent-code-Jane-Doe-Build`
  );
  assert.equal(daemonSocketPath('win32', {}), String.raw`\\.\pipe\fluent-code-default`);
});
