import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {delimiter} from 'node:path';
import type {ProviderId} from './daemon-protocol.js';

const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * How a lane should invoke the coordination CLI. Prefers the installed `fluent-coord` on PATH,
 * because that is what a person would type and what an agent will guess; falls back to the built
 * script by absolute path so this works from a source checkout too.
 */
export function coordCommand() {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (entry && existsSync(join(entry, 'fluent-coord'))) return 'fluent-coord';
  }
  return `node ${join(packageRoot, 'dist', 'coord-cli.js')}`;
}

/**
 * What a lane is told about the other lanes.
 *
 * Deliberately short. It is prepended to the system prompt, so it is paid for on every turn — and
 * because it is a stable suffix on a stable prefix, it stays byte-identical across turns and does
 * not cost the prompt cache anything (the concern behind R4).
 *
 * It says when to run the command, not just that it exists: an agent told only that a tool is
 * available will mostly not use it.
 */
export function coordinationBriefing(command = coordCommand()) {
  return [
    'You are one of several agent lanes Fluent Code is running on this repository. Other lanes may be editing it right now.',
    '',
    `Coordinate with them using \`${command}\`, which identifies your lane from your working directory:`,
    `  ${command} status             everything at once: shared tasks, file claims, conflicts, handoffs`,
    `  ${command} claim PATH...      say which files you intend to edit, before you edit them`,
    `  ${command} release PATH...    give them back when you are done`,
    `  ${command} note SUMMARY       record a decision the other lanes should know about`,
    `  ${command} send LANE MESSAGE  message another lane — it may be running a different provider`,
    `  ${command} inbox              read messages waiting for you`,
    `  ${command} task add|start|done`,
    `  ${command} handoff LANE SUMMARY`,
    '',
    'Run `status` before you start and again before a large edit; pass `--since CURSOR` from your last check and you get one line back when nothing has changed.',
    'If a claim is refused, another lane is already working there. Do not edit those files: say so, and either pick different files or propose a handoff. Claims are advisory signals, not locks — they exist so two lanes do not silently write the same merge conflict.',
    'Read your inbox whenever `status` shows one or more messages waiting. The full protocol is in the `fluent-collab` skill.'
  ].join('\n');
}

/**
 * How to pass the briefing to a provider, using that CLI's own convention for project direction
 * (spec §7.5) rather than intercepting anything.
 *
 * Claude Code takes `--append-system-prompt`. Codex has no confirmed equivalent flag, and writing
 * an AGENTS.md into the lane's worktree would put a Fluent file into the user's diff and then into
 * their merge — so Codex lanes get no briefing until there is a confirmed mechanism, rather than a
 * guessed one. That is a real gap, and it is why `coordCommand` is also documented for humans.
 */
export function briefingArgs(provider: ProviderId, briefing = coordinationBriefing()): string[] {
  return provider === 'claude' ? ['--append-system-prompt', briefing] : [];
}
