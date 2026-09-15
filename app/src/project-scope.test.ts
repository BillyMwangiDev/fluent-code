import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {currentProject} from './project-scope.js';
import type {SessionSummary} from './api.js';

function session(id: string, directory: string, updatedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {id, provider: 'codex', command: 'codex', directory, status: 'running', createdAt: updatedAt, updatedAt, ...extra};
}

describe('current project', () => {
  const older = session('older', '/work/api', '2026-09-14T01:00:00.000Z');
  const newer = session('newer', '/work/web/.fluent-worktrees/web/newer', '2026-09-14T02:00:00.000Z', {projectDirectory: '/work/web'});

  it('is the selected workspace, not whichever session is listed first', () => {
    assert.equal(currentProject('/work/api', [newer, older]), '/work/api');
  });

  it('is the selected workspace even before any session runs there', () => {
    assert.equal(currentProject('/work/new-repo', [newer, older]), '/work/new-repo');
  });

  it('uses the session project spelling when the workspace differs only by a trailing slash', () => {
    assert.equal(currentProject('/work/web/', [newer]), '/work/web');
  });

  it('falls back to the most recently active session project when no workspace is selected', () => {
    assert.equal(currentProject('', [older, newer]), '/work/web');
  });

  it('ignores archived sessions in that fallback', () => {
    const archived = session('archived', '/work/old', '2026-09-14T03:00:00.000Z', {status: 'stopped', archivedAt: '2026-09-14T03:00:00.000Z'});
    assert.equal(currentProject('', [older, archived]), '/work/api');
  });

  it('is undefined with no workspace and no sessions', () => {
    assert.equal(currentProject('', []), undefined);
  });
});
