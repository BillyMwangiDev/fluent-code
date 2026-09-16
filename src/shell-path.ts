import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

/**
 * A GUI-launched process (Finder, Dock, Explorer) inherits the system PATH, not the one the user's
 * shell builds — so a packaged fluentd could not see Homebrew, nvm, `~/.local/bin` or anything an
 * installer had added, and reported every CLI as "not installed" while `claude` worked fine in a
 * terminal. This module asks the login shell for its PATH once, the way VS Code does, and falls
 * back to the directories the common installers use.
 */

/** Directories the common installers use, for when the login shell cannot be asked. */
export function conventionalBinDirectories(home = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const system = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']
    : ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(home, '.linuxbrew', 'bin')];
  return [
    join(home, '.local', 'bin'),
    ...system,
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.deno', 'bin')
  ];
}

/**
 * The inherited entries first, then `additions`; no duplicates, no blanks. Whatever started fluentd
 * keeps precedence — a test putting a stand-in `codex` first, a user preferring one install over
 * another — and a GUI launch, whose inherited PATH is the bare system one, gains everything else.
 */
export function mergePath(current: string | undefined, additions: readonly string[], separator = delimiter): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...(current ?? '').split(separator), ...additions]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(separator);
}

const marker = '__FLUENT_PATH__';

/** The PATH the user's own shell builds, or undefined when it cannot be asked (missing, hung, Windows). */
export async function loginShellPath(shell = process.env.SHELL, timeoutMs = 5_000): Promise<string | undefined> {
  if (!shell || process.platform === 'win32') return undefined;
  try {
    // -l reads the profile files installers append to; -i reads the rc files nvm/volta hook into.
    // Markers bracket the value so banners and prompts printed by chatty rc files are ignored.
    const {stdout} = await run(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {timeout: timeoutMs, env: {...process.env, TERM: 'dumb'}, maxBuffer: 1 << 20});
    const start = stdout.indexOf(marker);
    if (start === -1) return undefined;
    const end = stdout.indexOf(marker, start + marker.length);
    if (end === -1) return undefined;
    const value = stdout.slice(start + marker.length, end).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function adopt(additions: readonly string[]): string[] {
  const before = new Set((process.env.PATH ?? '').split(delimiter));
  process.env.PATH = mergePath(process.env.PATH, additions);
  return process.env.PATH.split(delimiter).filter(entry => !before.has(entry));
}

/** Adds the installer directories that exist on this machine. Synchronous and instant. */
export function adoptConventionalPath(): string[] {
  return adopt(conventionalBinDirectories().filter(directory => existsSync(directory)));
}

/**
 * Widens this process's PATH to what the user's terminal resolves, so every probe, lane and
 * installer fluentd starts finds the same tools the user does. Never awaited on the startup path:
 * a chatty rc file can hold the shell for a minute (seen: an update check), so callers apply the
 * conventional directories first and let this land when it lands.
 */
export async function adoptLoginShellPath(options: {timeoutMs?: number} = {}): Promise<{source: 'login-shell' | 'conventional'; added: string[]}> {
  const login = await loginShellPath(process.env.SHELL, options.timeoutMs);
  const added = adopt([...(login ? login.split(delimiter) : []), ...conventionalBinDirectories().filter(directory => existsSync(directory))]);
  return {source: login ? 'login-shell' : 'conventional', added};
}
