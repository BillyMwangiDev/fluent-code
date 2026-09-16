import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {delimiter} from 'node:path';
import {providerIds, type LeadPool, type ProviderId} from './daemon-protocol.js';
import {describePool} from './lead-lanes.js';
import {scriptRunner} from './script-runner.js';

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
  return `${scriptRunner()} ${join(packageRoot, 'dist', 'coord-cli.js')}`;
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
 * Claude Code takes `--append-system-prompt`. Codex and Gemini lanes receive the discoverable,
 * user-scoped `fluent_coord` MCP tool plus the portable `fluent-collab` skill when the user has
 * installed Fluent's coordination bundle. Neither runtime has a launch flag we can rely on here,
 * and writing an AGENTS.md into the lane's worktree would put a Fluent file into the user's diff.
 * Keep the terminal command as the fallback rather than guessing a prompt-injection mechanism.
 */
export function briefingArgs(provider: ProviderId, briefing = coordinationBriefing()): string[] {
  return provider === 'claude' ? ['--append-system-prompt', briefing] : [];
}

/**
 * What a lead lane is told on top of the coordination briefing: that the user let it direct a
 * bounded number of lanes, the commands for doing so, and when delegation is worth its cost —
 * every lane is a whole agent's tokens (docs/research/2026-09-13-agent-orchestration.md §2.1).
 */
export function leadBriefing(maxLanes: number, command = coordCommand(), pool?: LeadPool) {
  const allowance = pool
    ? `a pool of ${describePool(pool)} subagent lane${maxLanes === 1 ? '' : 's'} (${maxLanes} at once)`
    : `up to ${maxLanes} other agent lane${maxLanes === 1 ? '' : 's'} at once`;
  return [
    `You are the orchestrator of this project: the user talks to you, and the lanes you start hear only from you. The user has given you ${allowance}. Each lane is a separate agent with its own terminal and, unless you pass --shared, its own Git worktree.${pool ? ' Only the providers in your pool can be started, and only up to their share.' : ''}`,
    '',
    `  ${command} lane start PROVIDER [--shared] [--task ID] PROMPT   start a lane (${providerIds.join(', ')})`,
    `  ${command} lane list                          your lanes, their status, and which of them need you`,
    `  ${command} lane assign LANE TASK              give one of your lanes a ticket from the board`,
    `  ${command} lane read LANE [--lines N]         the end of that lane's terminal screen`,
    `  ${command} lane wait [LANE...] [--timeout S]  return when a lane finishes, messages you, or stops`,
    `  ${command} lane stop LANE`,
    '',
    `Plan first, then delegate only work that splits into independent parts; each lane costs a whole agent's tokens. Put each part on the board with \`${command} task add\` so the user can see it, give each lane one precise prompt or ticket, and use \`wait\` rather than repeatedly reading screens. When a lane reports, \`read\` its screen, judge the work, and answer it with \`send\` or a follow-up ticket. Report the combined result to the user. Merging lanes stays with the user.`
  ].join('\n');
}

/** Where a lead's instructions go: Claude Code's system-prompt flag, beside the coordination
 * briefing; for providers without such a flag, ahead of the first prompt. */
export function leadDirection(provider: ProviderId, maxLanes: number, task?: string, command = coordCommand(), pool?: LeadPool): {systemPrompt?: string; prompt?: string} {
  const briefing = leadBriefing(maxLanes, command, pool);
  if (provider === 'claude') return {systemPrompt: `${coordinationBriefing(command)}\n\n${briefing}`, prompt: task};
  return {prompt: [briefing, task?.trim()].filter(Boolean).join('\n\n')};
}
