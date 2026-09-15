import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {leadLoad, sessionMatches, sessionTotals, sessionTree} from './session-tree.js';
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

describe('session list views and search', () => {
  const running = session('lane-1', '2026-09-15T10:00:00.000Z', {task: 'Refactor the router', directory: '/work/api'});
  const starting = session('lane-2', '2026-09-15T10:00:00.000Z', {status: 'starting', task: 'Write docs'});
  const stopped = session('lane-3', '2026-09-15T10:00:00.000Z', {status: 'stopped', task: 'Fix payment webhook'});
  const archived = session('lane-4', '2026-09-15T10:00:00.000Z', {status: 'stopped', task: 'Old audit', archivedAt: '2026-09-15T11:00:00.000Z'});

  it('splits sessions into all current, active, and archived views', () => {
    const all = [running, starting, stopped, archived];
    assert.deepEqual(all.filter(item => sessionMatches(item, 'all', '')).map(item => item.id), ['lane-1', 'lane-2', 'lane-3']);
    assert.deepEqual(all.filter(item => sessionMatches(item, 'active', '')).map(item => item.id), ['lane-1', 'lane-2']);
    assert.deepEqual(all.filter(item => sessionMatches(item, 'archived', '')).map(item => item.id), ['lane-4']);
  });

  it('searches what the table shows, ignoring case, and needs every word to match', () => {
    assert.equal(sessionMatches(running, 'all', 'ROUTER'), true);
    assert.equal(sessionMatches(running, 'all', '/work/api'), true, 'the working directory is searchable');
    assert.equal(sessionMatches(running, 'all', 'work subscription', ['Claude Code', 'work subscription']), true, 'labels the table renders are searchable');
    assert.equal(sessionMatches(running, 'all', 'router payment'), false);
    assert.equal(sessionMatches(stopped, 'all', '  '), true, 'a blank search matches everything in the view');
  });
});

describe('session totals', () => {
  it('counts sessions and active ones, and sums only the tokens a provider reported', () => {
    const sessions = [
      session('lane-1', '2026-09-15T10:00:00.000Z'),
      session('lane-2', '2026-09-15T10:00:00.000Z', {status: 'stopped'}),
      session('lane-3', '2026-09-15T10:00:00.000Z', {status: 'starting'})
    ];
    const usage = new Map([['lane-1', {inputTokens: 1200, outputTokens: 300}], ['lane-2', {outputTokens: 50}]]);

    assert.deepEqual(sessionTotals(sessions, usage), {count: 3, active: 2, tokens: 1550});
    assert.deepEqual(sessionTotals(sessions, new Map()), {count: 3, active: 2, tokens: undefined}, 'no reported usage is unknown, not zero');
  });
});
