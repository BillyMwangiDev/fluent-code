import {createHash} from 'node:crypto';
import type {CoordinationState, LaneMessage, ProviderId, RankedConflict} from './daemon-protocol.js';

/** Enough of a UUID to name a thing, short enough to be worth sending into a context window. */
export const shortId = (id: string) => id.slice(0, 8);

export type AgentLane = {sessionId: string; provider: ProviderId; project: string; branch?: string};

export type AgentView = {
  lane: AgentLane;
  tasks: CoordinationState['tasks'];
  claims: CoordinationState['claims'];
  conflicts: RankedConflict[];
  handoffs: CoordinationState['handoffs'];
  /** Unread messages waiting for this lane. Counted in the status a lane already asks for, so mail
   * is noticed without inventing a second thing to poll. */
  unread: number;
  /** Fingerprint of everything above, so a lane can ask "anything new?" and be told no cheaply. */
  cursor: string;
};

/**
 * Resolves a short id back to the thing it names. Ambiguity is an error rather than a guess: two
 * tasks sharing a prefix is rare, and picking one silently is the kind of mistake that is very
 * hard to see afterwards.
 */
export function resolveId<T extends {id: string}>(items: readonly T[], prefix: string): T {
  const matches = items.filter(item => item.id === prefix || item.id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`Nothing here matches id ${prefix}`);
  throw new Error(`${prefix} matches ${matches.length} items — use more of the id`);
}

export function viewCursor(view: Omit<AgentView, 'cursor'>) {
  const material = JSON.stringify([
    view.tasks.map(task => [task.id, task.status, task.sessionId, task.title]),
    view.claims.map(claim => [claim.path, claim.sessionId, claim.origin]),
    view.conflicts.map(conflict => [conflict.path, conflict.claimedPath, conflict.sessionId]),
    view.handoffs.map(handoff => [handoff.id, handoff.status]),
    // Mail has to move the cursor, or a lane polling with --since would never hear about it.
    view.unread
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/**
 * Renders the whole coordination picture as compact tabular text for an agent's context window.
 *
 * The rules here are from spec §11, and they are about cost: this output goes into a model's
 * context, sometimes repeatedly, so it is CSV-shaped rather than JSON (no braces, no quotes, no
 * repeated keys), carries minimal per-item fields, shortens ids, and states empty sets as an
 * explicit `0` rather than leaving a section out — a missing section reads as "unknown", and an
 * agent that has to guess whether it has conflicts will either ask again or assume wrong.
 *
 * Free-text columns go last on every row so the rest stays unambiguously space-separated.
 */
export function renderAgentView(view: AgentView) {
  const lines: string[] = [];
  const lane = shortId(view.lane.sessionId);
  lines.push(`lane ${lane} ${view.lane.provider}${view.lane.branch ? ` ${view.lane.branch}` : ''} ${view.lane.project}`);

  lines.push(`tasks ${view.tasks.length}`);
  if (view.tasks.length > 0) {
    lines.push('id status lane title');
    for (const task of view.tasks) {
      lines.push(`${shortId(task.id)} ${task.status} ${task.sessionId ? shortId(task.sessionId) : '-'} ${task.title}`);
    }
  }

  const mine = view.claims.filter(claim => claim.sessionId === view.lane.sessionId).length;
  lines.push(`claims ${view.claims.length} mine ${mine}`);
  if (view.claims.length > 0) {
    lines.push('path lane origin');
    for (const claim of view.claims) lines.push(`${claim.path} ${shortId(claim.sessionId)} ${claim.origin}`);
  }

  lines.push(`conflicts ${view.conflicts.length}`);
  if (view.conflicts.length > 0) {
    lines.push('path held-by overlap hotspot');
    for (const conflict of view.conflicts) {
      lines.push(`${conflict.path} ${shortId(conflict.sessionId)} ${conflict.overlap} ${conflict.hotspot ? 'yes' : 'no'}`);
    }
  }

  const open = view.handoffs.filter(handoff => handoff.status === 'open');
  lines.push(`handoffs ${open.length}`);
  if (open.length > 0) {
    lines.push('id from to summary');
    for (const handoff of open) {
      lines.push(`${shortId(handoff.id)} ${shortId(handoff.fromSessionId)} ${shortId(handoff.toSessionId)} ${handoff.summary}`);
    }
  }

  lines.push(`inbox ${view.unread}`);
  lines.push(`cursor ${view.cursor}`);
  return lines.join('\n');
}

/**
 * Renders a lane's unread mail. Sender first on every row, body last, one message per block — an
 * agent has to be able to tell where one message ends and the next begins without parsing.
 */
export function renderInbox(messages: readonly LaneMessage[]) {
  if (messages.length === 0) return 'inbox 0';
  const lines = [`inbox ${messages.length}`];
  for (const message of messages) {
    lines.push(`from ${shortId(message.from)} at ${message.createdAt}`);
    lines.push(message.body);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * What a lane is told when it claims paths. A refusal is information the agent should act on — not
 * an error — so it reads as an outcome line, and names the lane it has to coordinate with.
 */
export function renderClaimResult(paths: readonly string[], granted: boolean, conflicts: readonly RankedConflict[]) {
  if (granted) return `claimed ${paths.join(' ')}`;
  const lines = [`refused ${paths.join(' ')}`, 'path held-by overlap hotspot'];
  for (const conflict of conflicts) {
    lines.push(`${conflict.claimedPath} ${shortId(conflict.sessionId)} ${conflict.overlap} ${conflict.hotspot ? 'yes' : 'no'}`);
  }
  lines.push('another lane is already working here — coordinate before editing, or claim different paths');
  return lines.join('\n');
}
