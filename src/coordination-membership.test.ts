import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {requireSessionInProject} from './coordination-membership.js';
import type {SessionSummary} from './daemon-protocol.js';

function lane(id: string, directory: string): SessionSummary {
  return {
    id,
    provider: 'codex',
    command: 'codex',
    directory,
    status: 'running',
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z'
  };
}

describe('coordination session membership', () => {
  it('returns the lane when it belongs to the requested project', () => {
    const session = lane('lane-a', '/project-a/worktree');
    session.projectDirectory = '/project-a';

    assert.equal(requireSessionInProject('/project-a', session.id, [session]), session);
  });

  it('rejects a lane from a different project without mutating coordination state', () => {
    const a = lane('lane-a', '/project-a');
    const b = lane('lane-b', '/project-b');

    assert.throws(() => requireSessionInProject('/project-a', b.id, [a, b]), /does not belong to this project/);
  });

  it('rejects an unknown lane rather than treating its id as project metadata', () => {
    assert.throws(() => requireSessionInProject('/project-a', 'lane-missing', [lane('lane-a', '/project-a')]), /Unknown coordination lane/);
  });
});
