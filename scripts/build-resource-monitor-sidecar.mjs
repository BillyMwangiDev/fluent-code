import {execFile} from 'node:child_process';
import {chmod, copyFile, mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const monitorRoot = join(root, 'native', 'resource-monitor');
const binariesDirectory = join(root, 'src-tauri', 'binaries');

async function hostTriple() {
  const {stdout} = await execute('rustc', ['-Vv']);
  const triple = /^host: (.+)$/m.exec(stdout)?.[1]?.trim();
  if (!triple) throw new Error('Could not determine the Rust host target');
  return triple;
}

const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? await hostTriple();
const host = await hostTriple();
if (targetTriple !== host) {
  throw new Error(`Build fluent-resource-monitor on ${targetTriple} itself. Cross-compiling this native process sampler from ${host} is not supported.`);
}

const extension = process.platform === 'win32' ? '.exe' : '';
await execute('cargo', ['build', '--release'], {cwd: monitorRoot});
await mkdir(binariesDirectory, {recursive: true});
const source = join(monitorRoot, 'target', 'release', `fluent-resource-monitor${extension}`);
const output = join(binariesDirectory, `fluent-resource-monitor-${targetTriple}${extension}`);
await copyFile(source, output);
if (process.platform !== 'win32') await chmod(output, 0o755);
console.log(`fluent-resource-monitor sidecar ready · ${output}`);
