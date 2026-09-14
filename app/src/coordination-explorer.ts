import type {CoordinationEvent, CoordinationState, RankedConflict, SessionSummary} from './api';

export const explorerScopes = ['overview', 'tasks', 'files', 'reviews'] as const;
export type ExplorerScope = (typeof explorerScopes)[number];

export function isExplorerScope(value: unknown): value is ExplorerScope {
  return typeof value === 'string' && (explorerScopes as readonly string[]).includes(value);
}

export type CoordinationSubject =
  | {kind: 'lane'; sessionId: string}
  | {kind: 'task'; id: string}
  | {kind: 'claim'; id: string}
  | {kind: 'decision'; id: string}
  | {kind: 'handoff'; id: string}
  | {kind: 'message'; id: string}
  | {kind: 'conflict'; path: string; claimedPath: string; sessionId: string};

/** A stable internal key for the current snapshot. Labels and shortened ids never identify records. */
export function coordinationSubjectKey(subject: CoordinationSubject): string {
  switch (subject.kind) {
    case 'lane': return `lane:${subject.sessionId}`;
    case 'task': case 'decision': case 'handoff': case 'message': return `${subject.kind}:${subject.id}`;
    case 'claim': return `claim:${subject.id}`;
    case 'conflict': return `conflict:${subject.sessionId}\u0000${subject.path}\u0000${subject.claimedPath}`;
  }
}

export type CoordinationActivity = {
  at: string;
  sortAt: number;
  key: string;
  label: string;
  detail: string;
  /** An historic event only links when the referred current record still exists. */
  subject?: CoordinationSubject;
};

function sortAt(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function eventActivity(event: CoordinationEvent, state: CoordinationState): CoordinationActivity {
  const base = {at: event.at, sortAt: sortAt(event.at), key: `event:${event.id}`};
  const task = event.taskId ? state.tasks.find(item => item.id === event.taskId) : undefined;
  const claim = event.claimId ? state.claims.find(item => item.id === event.claimId) : undefined;
  const decision = event.decisionId ? state.decisions.find(item => item.id === event.decisionId) : undefined;
  const handoff = event.handoffId ? state.handoffs.find(item => item.id === event.handoffId) : undefined;
  const message = event.messageId ? state.messages.find(item => item.id === event.messageId) : undefined;
  switch (event.kind) {
    case 'task.created': return {...base, label: 'task created', detail: task?.title ?? 'task no longer retained', subject: task ? {kind: 'task', id: task.id} : undefined};
    case 'task.assigned': return {...base, label: 'task assigned', detail: task?.title ?? 'task no longer retained', subject: task ? {kind: 'task', id: task.id} : undefined};
    case 'task.status_changed': return {...base, label: `task ${event.toStatus ?? 'updated'}`, detail: task?.title ?? 'task no longer retained', subject: task ? {kind: 'task', id: task.id} : undefined};
    case 'task.dependencies_changed': {
      const count = event.dependsOn?.length ?? 0;
      return {...base, label: 'task prerequisites updated', detail: `${task?.title ?? 'task no longer retained'} · ${count === 0 ? 'no prerequisites' : `${count} prerequisite${count === 1 ? '' : 's'}`}`, subject: task ? {kind: 'task', id: task.id} : undefined};
    }
    case 'master_brief.set': return {...base, label: 'master brief updated', detail: state.masterBrief ? 'Project direction saved on the board' : 'Project direction cleared'};
    case 'claim.declared': return {...base, label: 'claim declared', detail: event.path ?? 'path unavailable', subject: claim ? {kind: 'claim', id: claim.id} : undefined};
    case 'claim.observed': return {...base, label: 'path observed', detail: event.path ?? 'path unavailable', subject: claim ? {kind: 'claim', id: claim.id} : undefined};
    case 'claim.conflicted': return {...base, label: 'claim conflicted', detail: event.path ?? 'path unavailable'};
    case 'claim.released': {
      const labels = {released: 'claim released', observed_cleared: 'observed path cleared', session_ended: 'claim released when lane ended', lease_expired: 'claim lease expired'} as const;
      return {...base, label: labels[event.releaseReason ?? 'released'], detail: event.path ?? 'path unavailable'};
    }
    case 'decision.recorded': return {...base, label: 'decision recorded', detail: decision?.summary ?? 'decision no longer retained', subject: decision ? {kind: 'decision', id: decision.id} : undefined};
    case 'handoff.requested': return {...base, label: 'handoff requested', detail: handoff?.summary ?? 'handoff no longer retained', subject: handoff ? {kind: 'handoff', id: handoff.id} : undefined};
    case 'handoff.accepted': return {...base, label: 'handoff accepted', detail: handoff?.summary ?? 'handoff no longer retained', subject: handoff ? {kind: 'handoff', id: handoff.id} : undefined};
    case 'message.sent': return {...base, label: 'lane message sent', detail: message?.body ?? 'message no longer retained', subject: message ? {kind: 'message', id: message.id} : undefined};
  }
}

/** A bounded projection of Fluent's retained coordination journal, resolved against the current
 * board. Events whose records have since disappeared stay readable but intentionally are not
 * linked to a newer object with a matching path. */
export function retainedCoordinationHistory(state: CoordinationState, limit = 12): CoordinationActivity[] {
  return (state.events ?? [])
    .map(event => eventActivity(event, state))
    .sort((left, right) => right.sortAt - left.sortAt || left.key.localeCompare(right.key))
    .slice(0, Math.max(0, limit));
}

export type CoordinationInspection = {
  subject: CoordinationSubject;
  title: string;
  relationshipNote: string;
  lanes: SessionSummary[];
  missingLaneIds: string[];
  tasks: CoordinationState['tasks'];
  claims: CoordinationState['claims'];
  decisions: CoordinationState['decisions'];
  handoffs: CoordinationState['handoffs'];
  messages: CoordinationState['messages'];
  conflicts: RankedConflict[];
};

function subjectExists(subject: CoordinationSubject, state: CoordinationState, sessions: readonly SessionSummary[], conflicts: readonly RankedConflict[]) {
  switch (subject.kind) {
    case 'lane': return sessions.some(session => session.id === subject.sessionId);
    case 'task': return state.tasks.some(task => task.id === subject.id);
    case 'claim': return state.claims.some(claim => claim.id === subject.id);
    case 'decision': return state.decisions.some(decision => decision.id === subject.id);
    case 'handoff': return state.handoffs.some(handoff => handoff.id === subject.id);
    case 'message': return state.messages.some(message => message.id === subject.id);
    case 'conflict': return conflicts.some(conflict => conflict.path === subject.path && conflict.claimedPath === subject.claimedPath && conflict.sessionId === subject.sessionId);
  }
}

function subjectLaneIds(subject: CoordinationSubject, state: CoordinationState): string[] {
  switch (subject.kind) {
    case 'lane': case 'conflict': return [subject.sessionId];
    case 'claim': return state.claims.find(claim => claim.id === subject.id) ? [state.claims.find(claim => claim.id === subject.id)!.sessionId] : [];
    case 'task': return state.tasks.find(task => task.id === subject.id)?.sessionId ? [state.tasks.find(task => task.id === subject.id)!.sessionId!] : [];
    case 'decision': return state.decisions.find(decision => decision.id === subject.id)?.sessionId ? [state.decisions.find(decision => decision.id === subject.id)!.sessionId!] : [];
    case 'handoff': {
      const handoff = state.handoffs.find(item => item.id === subject.id);
      return handoff ? [handoff.fromSessionId, handoff.toSessionId] : [];
    }
    case 'message': {
      const message = state.messages.find(item => item.id === subject.id);
      return message ? [message.from, message.to] : [];
    }
  }
}

function subjectPaths(subject: CoordinationSubject, state: CoordinationState): string[] {
  if (subject.kind === 'claim') {
    const claim = state.claims.find(item => item.id === subject.id);
    return claim ? [claim.path] : [];
  }
  if (subject.kind === 'conflict') return [subject.path, subject.claimedPath];
  return [];
}

function subjectTitle(subject: CoordinationSubject, state: CoordinationState, sessions: readonly SessionSummary[], conflicts: readonly RankedConflict[]): string {
  switch (subject.kind) {
    case 'lane': return `lane ${subject.sessionId.slice(0, 8)}`;
    case 'task': return state.tasks.find(task => task.id === subject.id)?.title ?? 'task';
    case 'claim': return state.claims.find(claim => claim.id === subject.id)?.path ?? 'claim';
    case 'decision': return state.decisions.find(decision => decision.id === subject.id)?.summary ?? 'decision';
    case 'handoff': return state.handoffs.find(handoff => handoff.id === subject.id)?.summary ?? 'handoff';
    case 'message': return state.messages.find(message => message.id === subject.id)?.body ?? 'lane message';
    case 'conflict': return conflicts.some(conflict => conflict.path === subject.path && conflict.claimedPath === subject.claimedPath && conflict.sessionId === subject.sessionId)
      ? `${subject.path} ↔ ${subject.claimedPath}` : 'file overlap';
  }
}

function relationshipNote(subject: CoordinationSubject, laneCount: number) {
  if (subject.kind === 'lane') return 'Direct references to this lane in the current coordination board.';
  if (subject.kind === 'conflict') return 'Current path overlap and the lane holding the earlier claim.';
  if (subject.kind === 'handoff' || subject.kind === 'message') return 'Direct lane endpoints; surrounding records are related through those lanes.';
  return laneCount > 0
    ? 'Related records share this lane. Tasks, claims and decisions do not have a direct link in the current model.'
    : 'This record has no assigned lane, so no lane-based relationships can be inferred.';
}

/** Resolve one present snapshot only. A caller should clear a selection when this returns undefined. */
export function inspectCoordination(
  subject: CoordinationSubject,
  state: CoordinationState,
  sessions: readonly SessionSummary[],
  conflicts: readonly RankedConflict[]
): CoordinationInspection | undefined {
  if (!subjectExists(subject, state, sessions, conflicts)) return undefined;
  const laneIds = new Set(subjectLaneIds(subject, state));
  const paths = new Set(subjectPaths(subject, state));
  const claims = state.claims.filter(claim => laneIds.has(claim.sessionId) || paths.has(claim.path));
  for (const claim of claims) paths.add(claim.path);
  const tasks = state.tasks.filter(task => coordinationSubjectKey(subject) === `task:${task.id}` || (task.sessionId !== undefined && laneIds.has(task.sessionId)));
  const decisions = state.decisions.filter(decision => coordinationSubjectKey(subject) === `decision:${decision.id}` || (decision.sessionId !== undefined && laneIds.has(decision.sessionId)));
  const handoffs = state.handoffs.filter(handoff => coordinationSubjectKey(subject) === `handoff:${handoff.id}` || laneIds.has(handoff.fromSessionId) || laneIds.has(handoff.toSessionId));
  for (const handoff of handoffs) { laneIds.add(handoff.fromSessionId); laneIds.add(handoff.toSessionId); }
  const messages = state.messages.filter(message => coordinationSubjectKey(subject) === `message:${message.id}` || laneIds.has(message.from) || laneIds.has(message.to));
  const relatedConflicts = conflicts.filter(conflict =>
    coordinationSubjectKey(subject) === coordinationSubjectKey({kind: 'conflict', path: conflict.path, claimedPath: conflict.claimedPath, sessionId: conflict.sessionId}) ||
    laneIds.has(conflict.sessionId) || paths.has(conflict.path) || paths.has(conflict.claimedPath)
  );
  const lanes = sessions.filter(session => laneIds.has(session.id));
  const available = new Set(lanes.map(session => session.id));
  return {
    subject,
    title: subjectTitle(subject, state, sessions, conflicts),
    relationshipNote: relationshipNote(subject, laneIds.size),
    lanes,
    missingLaneIds: [...laneIds].filter(id => !available.has(id)).sort(),
    tasks,
    claims,
    decisions,
    handoffs,
    messages,
    conflicts: relatedConflicts
  };
}
