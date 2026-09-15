import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {leadLoad, sessionTree} from './session-tree.js';
import type {SessionSummary} from './api.js';

function session(id: string, updatedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {id, provider: 'codex', command: 'codex', directory: '/work', status: 'running', createdAt: updatedAt, updatedAt, ...extra};
}

describe('session tree', () => {
  it('lists a lead\'s lanes directly under it, most recently active first', () => {
    const rows = sessionTree([
      session('solo', '2026-09-15T10:00:00.000Z'),
      session('lead', '2026-09-15T09:00:00.000Z', {lead: {maxLanes: 3}}),
      session('lane-old', '2026-09-15T08:00:00.000Z', {parentSessionId: 'lead'}),
      session('lane-new', '2026-09-15T09:30:00.000Z', {parentSessionId: 'lead'}),
      session('latest', '2026-09-15T11:00:00.000Z')
    ]);

    assert.deepEqual(rows.map(row => [row.session.id, row.depth]), [
      ['latest', 0], ['solo', 0], ['lead', 0], ['lane-new', 1], ['lane-old', 1]
    ]);
  });

  it('keeps a lane at the top level when its lead is not in this list', () => {
    const rows = sessionTree([
      session('orphan', '2026-09-15T09:00:00.000Z', {parentSessionId: 'archived-lead'}),
      session('solo', '2026-09-15T10:00:00.000Z')
    ]);

    assert.deepEqual(rows.map(row => [row.session.id, row.depth]), [['solo', 0], ['orphan', 0]]);
  });
});

describe('lead load', () => {
  it('counts the lead\'s starting and running lanes against its budget', () => {
    const lead = session('lead', '2026-09-15T09:00:00.000Z', {lead: {maxLanes: 3}});
    const sessions = [
      lead,
      session('a', '2026-09-15T09:00:00.000Z', {parentSessionId: 'lead'}),
      session('b', '2026-09-15T09:00:00.000Z', {parentSessionId: 'lead', status: 'starting'}),
      session('c', '2026-09-15T09:00:00.000Z', {parentSessionId: 'lead', status: 'stopped'}),
      session('d', '2026-09-15T09:00:00.000Z', {parentSessionId: 'someone-else'})
    ];

    assert.equal(leadLoad(lead, sessions), 'lead · 2/3');
    assert.equal(leadLoad(sessions[1]!, sessions), undefined, 'a session the user did not start as a lead has no load');
  });
});
