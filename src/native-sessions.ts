import {open, readdir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** A session file can be written a moment before fluentd records the lane as started. */
const clockSlackMs = 60_000;
/** Codex's first line carries its full base instructions, so it is long — but not unbounded. */
const firstLineLimitBytes = 4 * 1024 * 1024;

async function firstLine(path: string) {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < firstLineLimitBytes) {
      const {bytesRead, buffer} = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk);
      position += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

const canonical = (path: string) => realpath(path).catch(() => path);

/** Local-date folders (YYYY/MM/DD), as Codex names them, from a day before `from` to a day after `to`. */
function dayFolders(from: number, to: number) {
  const days: string[][] = [];
  const cursor = new Date(from - 86_400_000);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= to + 86_400_000 && days.length < 400) {
    days.push([String(cursor.getFullYear()), String(cursor.getMonth() + 1).padStart(2, '0'), String(cursor.getDate()).padStart(2, '0')]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * The Codex session a lane's own CLI started, read from Codex's local session files — the ones
 * `codex resume` lists. Matched on working directory and start time, newest first. Read-only, and
 * limited to the dated session folders.
 */
export async function findCodexSession(directory: string, startedAt: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  const since = Date.parse(startedAt) - clockSlackMs;
  if (!Number.isFinite(since)) return undefined;
  const target = await canonical(directory);
  const candidates: Array<{id: string; at: number}> = [];
  for (const day of dayFolders(since, Date.now())) {
    const folder = join(codexHome, 'sessions', ...day);
    const files = await readdir(folder).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const meta = JSON.parse(await firstLine(join(folder, file))) as {type?: string; payload?: {id?: unknown; cwd?: unknown; timestamp?: unknown}};
        const payload = meta.payload;
        if (meta.type !== 'session_meta' || typeof payload?.id !== 'string' || typeof payload.cwd !== 'string' || typeof payload.timestamp !== 'string') continue;
        const at = Date.parse(payload.timestamp);
        if (!Number.isFinite(at) || at < since) continue;
        if (payload.cwd !== directory && await canonical(payload.cwd) !== target) continue;
        candidates.push({id: payload.id, at});
      } catch {
        // A partial or unrelated file is simply not a match.
      }
    }
  }
  return candidates.sort((left, right) => right.at - left.at)[0]?.id;
}
