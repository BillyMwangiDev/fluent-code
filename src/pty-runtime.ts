import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

let prepared: Promise<void> | undefined;
const require = createRequire(import.meta.url);

/**
 * `node-pty` needs a real executable helper on macOS. In development it lives in node_modules;
 * in the single-file fluentd sidecar it is a pkg asset under `/snapshot`, which cannot be
 * executed. Materialise that one bundled helper into Fluent's owner-only state directory before
 * dynamically loading node-pty, then let the patched packaged module use this path.
 */
async function prepareMacHelper() {
  const packaged = Boolean((process as NodeJS.Process & {pkg?: unknown}).pkg);
  if (process.platform !== 'darwin' || !packaged) return;
  const source = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper'
  );
  const targetDirectory = join(process.env.FLUENT_STATE_DIR ?? tmpdir(), 'runtime');
  const target = join(targetDirectory, 'node-pty-spawn-helper');
  await mkdir(targetDirectory, {recursive: true, mode: 0o700});
  // Rewriting from the sidecar's own embedded asset makes an upgrade deterministic and repairs
  // a partial write without trusting an executable already present in the state directory.
  await writeFile(target, await readFile(source), {mode: 0o700});
  await chmod(target, 0o700);
  process.env.FLUENT_PTY_SPAWN_HELPER = target;
}

export async function ptyRuntime(): Promise<typeof import('node-pty')> {
  prepared ??= prepareMacHelper();
  await prepared;
  // Keep the package name literal so pkg snapshots the module, while deferring evaluation until
  // after `FLUENT_PTY_SPAWN_HELPER` is ready. pkg's embedded Node runtime does not implement the
  // callback required for ESM `import()`, whereas createRequire works in both builds.
  return require('node-pty') as typeof import('node-pty');
}
