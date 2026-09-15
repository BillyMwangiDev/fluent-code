import type {SessionSummary} from './api';

export type SessionRow = {session: SessionSummary; depth: 0 | 1};

const mostRecentFirst = (a: SessionSummary, b: SessionSummary) => b.updatedAt.localeCompare(a.updatedAt);
const isLive = (session: SessionSummary) => session.status === 'running' || session.status === 'starting';

/**
 * Sessions as the list shows them: most recently active first, with each lead's lanes directly under
 * it. A lane whose lead is not in this list (archived, deleted, or on the other tab) stays at the top
 * level instead of disappearing.
 */
export function sessionTree(sessions: readonly SessionSummary[]): SessionRow[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const underLead = (session: SessionSummary) => {
    const lead = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
    return Boolean(lead && !lead.parentSessionId);
  };
  const sorted = [...sessions].sort(mostRecentFirst);
  return sorted
    .filter(session => !underLead(session))
    .flatMap(session => [
      {session, depth: 0 as const},
      ...sorted.filter(lane => lane.parentSessionId === session.id && underLead(lane)).map(lane => ({session: lane, depth: 1 as const}))
    ]);
}

/** A lead's running lanes against the budget the user gave it; nothing for any other session. */
export function leadLoad(lead: SessionSummary, sessions: readonly SessionSummary[]): string | undefined {
  if (!lead.lead) return undefined;
  const running = sessions.filter(session => session.parentSessionId === lead.id && isLive(session)).length;
  return `lead · ${running}/${lead.lead.maxLanes}`;
}

export type SessionView = 'all' | 'active' | 'archived';

/** Whether a session belongs in a list view and matches a search. The search covers what the table
 * shows — name, directory, and any rendered labels — and every word has to match. */
export function sessionMatches(session: SessionSummary, view: SessionView, query: string, labels: readonly string[] = []): boolean {
  const inView = view === 'archived' ? Boolean(session.archivedAt) : !session.archivedAt && (view === 'all' || isLive(session));
  if (!inView) return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [session.task, session.directory, session.model, session.provider, ...labels].filter(Boolean).join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}

type ReportedUsage = {inputTokens?: number; outputTokens?: number};

/** Totals for the sessions a view shows. Tokens count only what a provider reported: when nothing
 * was reported the total is unknown, not zero. */
export function sessionTotals(sessions: readonly SessionSummary[], usage: ReadonlyMap<string, ReportedUsage>) {
  let tokens: number | undefined;
  for (const session of sessions) {
    const reported = usage.get(session.id);
    if (!reported || (reported.inputTokens === undefined && reported.outputTokens === undefined)) continue;
    tokens = (tokens ?? 0) + (reported.inputTokens ?? 0) + (reported.outputTokens ?? 0);
  }
  return {count: sessions.length, active: sessions.filter(isLive).length, tokens};
}
