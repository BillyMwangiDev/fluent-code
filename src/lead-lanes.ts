import {createRequire} from 'node:module';
import {shortId} from './agent-view.js';
import type {CoordinationState, CoordinationTask, SessionSummary} from './daemon-protocol.js';

// @xterm/headless is a CommonJS bundle. Its default import is the whole module under Node's ESM
// loader but `undefined` once pkg runs the packaged daemon as CommonJS; createRequire resolves it
// the same way in both, as pty-runtime.ts already does for node-pty.
const require = createRequire(import.meta.url);
const {Terminal} = require('@xterm/headless') as typeof import('@xterm/headless');

/**
 * The daemon side of lead sessions: what a lead sees about the lanes it started, and what those
 * lanes are told. See docs/superpowers/specs/2026-09-15-lead-sessions-design.md.
 */

export const maxLeadLanes = 10;

export function validLeadBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maxLeadLanes) {
    throw new Error(`A lead's lane budget must be a whole number between 1 and ${maxLeadLanes}`);
  }
  return value;
}

export const isLiveLane = (lane: SessionSummary) => lane.status === 'running' || lane.status === 'starting';

export type LaneReadiness = 'stopped' | 'exited' | 'failed' | 'handoff' | 'mail' | 'done';

/**
 * Whether a lane needs its lead's attention. Every signal is a state fluentd already records — the
 * lane's process status, its tasks, its mail, its handoffs — so waiting never guesses from what a
 * terminal happens to print.
 */
export function laneReadiness(lane: SessionSummary, leadId: string, board: CoordinationState): LaneReadiness | undefined {
  if (!isLiveLane(lane)) return lane.status as 'stopped' | 'exited' | 'failed';
  if (board.handoffs.some(handoff => handoff.status === 'open' && handoff.fromSessionId === lane.id && handoff.toSessionId === leadId)) return 'handoff';
  if (board.messages.some(message => message.from === lane.id && message.to === leadId && !message.readAt)) return 'mail';
  const assigned = board.tasks.filter(task => task.sessionId === lane.id);
  if (assigned.length > 0 && assigned.every(task => task.status === 'done')) return 'done';
  return undefined;
}

function idleFor(since: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** A lead's lanes as compact rows (spec §11): the budget first, free text last on every row. */
export function renderLanes(lead: SessionSummary, lanes: readonly SessionSummary[], board: CoordinationState, now = Date.now()) {
  const lines = [`lanes ${lanes.filter(isLiveLane).length}/${lead.lead?.maxLanes ?? 0}`];
  if (lanes.length === 0) return lines.join('\n');
  lines.push('id provider status ready idle task');
  for (const lane of lanes) {
    const task = board.tasks.find(candidate => candidate.sessionId === lane.id && candidate.status !== 'done');
    lines.push(`${shortId(lane.id)} ${lane.provider} ${lane.status} ${laneReadiness(lane, lead.id, board) ?? '-'} ${idleFor(lane.updatedAt, now)} ${task ? `${shortId(task.id)} ${task.title}` : '-'}`);
  }
  return lines.join('\n');
}

export function renderWait(readyIds: readonly string[], timeoutSeconds: number, table: string) {
  const outcome = readyIds.length > 0 ? `ready ${readyIds.map(shortId).join(' ')}` : `timeout after ${timeoutSeconds}s — no lane is ready`;
  return `${outcome}\n${table}`;
}

/**
 * The end of a lane's screen as a person would read it. Full-screen CLIs redraw with cursor
 * movement and erase sequences, so stripping escape codes from the raw stream produces text the
 * lane never showed; replaying it through a headless terminal of the same size does not.
 */
export async function screenText(output: string, cols: number, rows: number, lines: number) {
  const terminal = new Terminal({cols, rows, scrollback: 1_000, allowProposedApi: true});
  try {
    await new Promise<void>(resolve => terminal.write(output, resolve));
    const buffer = terminal.buffer.active;
    const text: string[] = [];
    for (let index = 0; index < buffer.length; index++) text.push(buffer.getLine(index)?.translateToString(true) ?? '');
    while (text.length > 0 && !text.at(-1)!.trim()) text.pop();
    return text.slice(-lines).join('\n');
  } finally {
    terminal.dispose();
  }
}

/** Refuses a ticket a lane cannot legitimately take yet, before anything is started or pasted. */
export function assertTicketReady(board: CoordinationState, task: CoordinationTask) {
  if (task.status === 'done') throw new Error(`Ticket ${shortId(task.id)} is already done`);
  const blockers = (task.dependsOn ?? []).filter(id => board.tasks.find(candidate => candidate.id === id)?.status !== 'done');
  if (blockers.length > 0) throw new Error(`Ticket ${shortId(task.id)} is blocked by ${blockers.map(shortId).join(', ')}`);
}

/** What a lane is told when its lead gives it a ticket, ending with how to report back. */
export function ticketBrief(task: CoordinationTask, board: CoordinationState, leadId: string, command: string) {
  return [
    `Ticket ${shortId(task.id)} from lead lane ${shortId(leadId)}: ${task.title}`,
    task.description ? `Details: ${task.description}` : 'Details: inspect the relevant code and make the smallest complete change.',
    ...(board.masterBrief ? [`Project direction: ${board.masterBrief}`] : []),
    `Work only on this ticket, and claim files with \`${command} claim\` before editing them.`,
    `When you finish, run \`${command} task done ${shortId(task.id)}\`, then \`${command} send ${shortId(leadId)} SUMMARY\` saying what changed, which files, and how you verified it. If you are blocked, send your lead a message instead of guessing.`
  ].join('\n\n');
}
