import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// The hook command is run by Claude Code itself via plain `node`, never `tsx` — so it must always
// point at the compiled dist/ script, regardless of whether *this* module is currently executing
// from src/ (tsx, dev) or dist/ (node, built). `pnpm build` must have run at least once.
const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const relayScript = join(packageRoot, 'dist', 'hook-relay.js');

const managedEvents = ['SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact', 'Notification', 'StopFailure'] as const;

type HookEntry = {matcher?: string; hooks: Array<{type: 'command'; command: string}>};
type ClaudeSettings = {hooks?: Record<string, HookEntry[]>; statusLine?: unknown; [key: string]: unknown};

function relayCommand(event: string) {
  return `node ${JSON.stringify(relayScript)} ${event}`;
}

function alreadyManaged(entries: HookEntry[] | undefined, event: string) {
  return (entries ?? []).some(entry => entry.hooks.some(hook => hook.command === relayCommand(event)));
}

/**
 * Additive-only merge of fluentd's own hook entries into the session directory's project-local
 * `.claude/settings.json` — never touches a hook the user already configured. This is how
 * fluentd learns about rate limits and session lifecycle (spec §7.5): the CLI's own typed
 * signals, never terminal-output parsing.
 */
export async function ensureClaudeHooks(directory: string) {
  const settingsPath = join(directory, '.claude', 'settings.json');
  let settings: ClaudeSettings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8')) as ClaudeSettings;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  settings.hooks ??= {};
  let changed = false;
  for (const event of managedEvents) {
    settings.hooks[event] ??= [];
    if (alreadyManaged(settings.hooks[event], event)) continue;
    settings.hooks[event].push({hooks: [{type: 'command', command: relayCommand(event)}]});
    changed = true;
  }
  // A status line is Claude Code's official source for context, cost, cache and quota fields.
  // Never overwrite a user's own status line: observability is useful, but not worth taking over
  // their terminal chrome.
  if (!settings.statusLine) {
    settings.statusLine = {type: 'command', command: relayCommand('StatusLine'), padding: 1};
    changed = true;
  }
  if (!changed) return;

  await mkdir(dirname(settingsPath), {recursive: true});
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
