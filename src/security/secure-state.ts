import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * State is a security boundary, not ordinary cache data.  These helpers deliberately reject a
 * symlink at the state-directory or file boundary, repair legacy permissions, and sync both a
 * durable file and its containing directory before returning success.
 */
export async function ensurePrivateDirectory(directory: string) {
  const absolute = resolve(directory);
  await mkdir(absolute, {recursive: true, mode: privateDirectoryMode});
  const details = await lstat(absolute);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Refusing unsafe state directory: ${absolute}`);
  if ((details.mode & 0o077) !== 0) await chmod(absolute, privateDirectoryMode);
  return absolute;
}

async function existingRegularFile(path: string) {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Refusing unsafe state file: ${path}`);
    if ((details.mode & 0o077) !== 0) await chmod(path, privateFileMode);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function syncDirectory(directory: string) {
  // Windows has no directory fsync: flushing a directory handle fails with EPERM, which stopped a
  // packaged fluentd on its first state write. There the rename's durability rests on NTFS's
  // metadata journal instead.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Reads a private regular file, returning undefined only when it does not exist. */
export async function readPrivateFile(path: string) {
  await ensurePrivateDirectory(dirname(path));
  if (!await existingRegularFile(path)) return undefined;
  return readFile(path, 'utf8');
}

/** Writes a file atomically without ever following a state-file symlink. */
export async function writePrivateFile(path: string, contents: string | Uint8Array) {
  const parent = await ensurePrivateDirectory(dirname(path));
  await existingRegularFile(path);
  const temporary = `${path}.tmp-${randomUUID()}`;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(temporary, flags, privateFileMode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, privateFileMode);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Appends one durable JSONL record. A partial trailing record is intentionally recoverable. */
export async function appendPrivateLine(path: string, line: string) {
  const parent = await ensurePrivateDirectory(dirname(path));
  await existingRegularFile(path);
  const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags, privateFileMode);
  try {
    await handle.writeFile(line.endsWith('\n') ? line : `${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, privateFileMode);
  await syncDirectory(parent);
}

export async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  const contents = await readPrivateFile(path);
  return contents === undefined ? undefined : JSON.parse(contents) as T;
}

export async function writePrivateJson(path: string, value: unknown) {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
