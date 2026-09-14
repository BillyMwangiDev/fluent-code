import {execFile} from 'node:child_process';
import {access, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = join(root, '.fluent-build', 'sidecar');
const binariesDirectory = join(root, 'src-tauri', 'binaries');

function pkgTargetFor(triple) {
  if (triple === 'aarch64-apple-darwin') return 'node22-macos-arm64';
  if (triple === 'x86_64-apple-darwin') return 'node22-macos-x64';
  if (triple === 'x86_64-pc-windows-msvc') return 'node22-win-x64';
  if (triple === 'aarch64-pc-windows-msvc') return 'node22-win-arm64';
  throw new Error(`fluentd sidecar has no release mapping for Rust target ${triple}`);
}

function nodePtyDirectoryFor(triple) {
  if (triple === 'aarch64-apple-darwin') return 'darwin-arm64';
  if (triple === 'x86_64-apple-darwin') return 'darwin-x64';
  if (triple === 'x86_64-pc-windows-msvc') return 'win32-x64';
  if (triple === 'aarch64-pc-windows-msvc') return 'win32-arm64';
  throw new Error(`fluentd sidecar has no node-pty assets for Rust target ${triple}`);
}

function keyringPackageFor(triple) {
  if (triple === 'aarch64-apple-darwin') return '@napi-rs/keyring-darwin-arm64';
  if (triple === 'x86_64-apple-darwin') return '@napi-rs/keyring-darwin-x64';
  if (triple === 'x86_64-pc-windows-msvc') return '@napi-rs/keyring-win32-x64-msvc';
  if (triple === 'aarch64-pc-windows-msvc') return '@napi-rs/keyring-win32-arm64-msvc';
  throw new Error(`fluentd sidecar has no keyring addon for Rust target ${triple}`);
}

async function hostTriple() {
  const {stdout} = await execute('rustc', ['-Vv']);
  const triple = /^host: (.+)$/m.exec(stdout)?.[1]?.trim();
  if (!triple) throw new Error('Could not determine the Rust host target');
  return triple;
}

const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? await hostTriple();
const host = await hostTriple();
if (targetTriple !== host) {
  throw new Error(`Build fluentd on ${targetTriple} itself. Cross-compiling its native terminal and keyring addons from ${host} is not supported.`);
}

const ptyAssets = resolve(root, 'node_modules', 'node-pty', 'prebuilds', nodePtyDirectoryFor(targetTriple));
const keyringPackage = keyringPackageFor(targetTriple);
let keyringRoot;
try {
  const keyringRequire = createRequire(require.resolve('@napi-rs/keyring'));
  keyringRoot = dirname(keyringRequire.resolve(keyringPackage));
} catch {
  throw new Error(`Missing ${keyringPackage}. Run pnpm install on ${targetTriple} before packaging fluentd.`);
}

await access(join(root, 'dist', 'daemon.js'));
await rm(temporaryDirectory, {recursive: true, force: true});
await mkdir(temporaryDirectory, {recursive: true});
await mkdir(binariesDirectory, {recursive: true});

const sidecarName = `fluentd-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`;
const output = join(binariesDirectory, sidecarName);
const configPath = join(temporaryDirectory, 'pkg.config.json');
await writeFile(configPath, JSON.stringify({
  pkg: {
    // node-pty finds these at runtime from generated paths, and napi-rs selects its binary from
    // an optional package. pkg cannot statically follow either pattern, so declare both
    // explicitly. Config globs are relative to this generated config file, not the project root.
    scripts: [
      `${relative(temporaryDirectory, resolve(root, 'node_modules', 'node-pty', 'lib'))}/**/*.js`
    ],
    assets: [
      `${relative(temporaryDirectory, resolve(root, 'node_modules', 'node-pty', 'package.json'))}`,
      `${relative(temporaryDirectory, ptyAssets)}/**/*`,
      `${relative(temporaryDirectory, keyringRoot)}/**/*`
    ],
    publicPackages: ['node-pty', '@napi-rs/keyring', keyringPackage]
  }
}, null, 2));

// pkg keeps ordinary assets in its read-only snapshot filesystem. `node-pty`'s macOS helper is
// one of the rare assets that must be executed, so pty-runtime.ts materialises it to Fluent's
// private state directory before node-pty loads. The dependency has no configuration hook for
// that path; patch its one helper-path assignment only while pkg snapshots the dependency, then
// restore node_modules exactly as pnpm installed it.
const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js');
const unixTerminalSource = await readFile(unixTerminalPath, 'utf8');
const helperAssignment = "var helperPath = native.dir + '/spawn-helper';";
if (!unixTerminalSource.includes(helperAssignment)) {
  throw new Error('node-pty helper path changed; update the fluentd packaging patch before releasing');
}
await writeFile(
  unixTerminalPath,
  unixTerminalSource.replace(helperAssignment, "var helperPath = process.env.FLUENT_PTY_SPAWN_HELPER || native.dir + '/spawn-helper';")
);

try {
  // Do not invoke `pnpm` here: on Windows it is commonly a .cmd shim, which `execFile` cannot
  // execute directly. Calling pkg's local JavaScript entry is portable and stays lockfile-owned.
  const pkgCli = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');
  await execute(process.execPath, [
    pkgCli, 'dist/daemon.js',
    '--targets', pkgTargetFor(targetTriple),
    '--output', output,
    '--config', configPath,
    '--public-packages', '*'
  ], {cwd: root, stdio: 'inherit'});
} finally {
  await writeFile(unixTerminalPath, unixTerminalSource);
}

console.log(`fluentd sidecar ready · ${output}`);
