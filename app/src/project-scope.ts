import type {SessionSummary} from './api';

type ProjectSession = Pick<SessionSummary, 'directory' | 'projectDirectory' | 'archivedAt' | 'updatedAt'>;

/** A worktree lane belongs to the Git project it was isolated from, not to its checkout path. */
function sessionProject(session: ProjectSession): string {
  return session.projectDirectory ?? session.directory;
}

const withoutTrailingSeparators = (path: string) => path.replace(/(?<=.)[\\/]+$/, '');

/**
 * The project a screen acts on: the workspace the user selected in the rail. Only when no workspace
 * is selected does it fall back to the most recently active session's project — never to whichever
 * session a list happens to return first.
 */
export function currentProject(workspacePath: string, sessions: readonly ProjectSession[]): string | undefined {
  const workspace = withoutTrailingSeparators(workspacePath.trim());
  if (workspace) {
    return sessions.map(sessionProject).find(project => withoutTrailingSeparators(project) === workspace) ?? workspace;
  }
  return [...sessions]
    .filter(session => !session.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(sessionProject)[0];
}
