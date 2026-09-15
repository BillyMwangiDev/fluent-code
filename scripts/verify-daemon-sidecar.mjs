import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const {stdout: rustVersion} = await execute('rustc', ['-Vv']);
const hostTriple = /^host: (.+)$/m.exec(rustVersion)?.[1]?.trim();
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple;
if (!targetTriple) throw new Error('Could not determine the fluentd smoke-test target');

const extension = process.platform === 'win32' ? '.exe' : '';
const daemonPath = join(root, 'src-tauri', 'binaries', `fluentd-${targetTriple}${extension}`);
const probeDirectory = await mkdtemp(join(tmpdir(), 'fluentd-package-smoke-'));
const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\fluent-code-package-smoke-${process.pid}-${Date.now()}`
  : join(probeDirectory, 'fluent.sock');
let child;
let stdout = '';
let stderr = '';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ping() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({id: 'package-smoke', method: 'ping'})}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.ok && response.result?.ok) resolve(response.result);
        else reject(new Error(response.error ?? 'fluentd returned an invalid ping response'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

try {
  child = spawn(daemonPath, [], {
    env: {
      ...process.env,
      FLUENT_SOCKET: socketPath,
      FLUENT_STATE_DIR: join(probeDirectory, 'state'),
      FLUENT_WORKTREE_DIR: join(probeDirectory, 'worktrees')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  let lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await ping();
      console.log(`fluentd sidecar smoke test passed · pid ${response.pid}`);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (child.exitCode !== null) break;
      await wait(100);
    }
  }
  if (lastError) {
    throw new Error(`fluentd sidecar never accepted a ping: ${lastError instanceof Error ? lastError.message : String(lastError)}${stdout || stderr ? `\nstdout:\n${stdout}\nstderr:\n${stderr}` : ''}`);
  }
} finally {
  if (child && child.exitCode === null) {
    // fluentd flushes its state on SIGTERM, so deleting the probe directory under that final write
    // races it (ENOTEMPTY). Shutdown is bounded; wait for the exit, but never indefinitely.
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, wait(5_000)]);
  }
  await rm(probeDirectory, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
