import type {SessionSummary} from './daemon-protocol.js';
import {canonicalProjectPath} from './coordination.js';

/**
 * Coordination state is keyed by project, while its mutable records refer to a session id. Keep
 * that association honest at the daemon boundary: otherwise a local caller could create a claim,
 * task assignment or handoff in project A that names a lane from project B.
 */
export function requireSessionInProject(
  project: string,
  sessionId: string,
  sessions: readonly SessionSummary[]
): SessionSummary {
  const session = sessions.find(candidate => candidate.id === sessionId);
  if (!session) throw new Error(`Unknown coordination lane ${sessionId}`);
  const sessionProject = session.projectDirectory ?? session.directory;
  if (canonicalProjectPath(project) !== canonicalProjectPath(sessionProject)) {
    throw new Error(`Coordination lane ${sessionId} does not belong to this project`);
  }
  return session;
}
