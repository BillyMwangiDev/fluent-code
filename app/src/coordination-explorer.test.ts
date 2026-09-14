import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {inspectCoordination, isExplorerScope, retainedCoordinationHistory, type CoordinationSubject} from './coordination-explorer.js';
import type {CoordinationState, RankedConflict, SessionSummary} from './api.js';

const laneA: SessionSummary = {id: 'lane-a', provider: 'codex', command: 'codex', directory: '/project', status: 'running', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', verification: 'passed'};
const laneB: SessionSummary = {id: 'lane-b', provider: 'claude', command: 'claude', directory: '/project', status: 'running', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z'};

function state(): CoordinationState {
  return {
    project: '/project',
    tasks: [
      {id: 'task-a', title: 'wire explorer', status: 'active', sessionId: 'lane-a', createdAt: '2026-09-14T03:00:00.000Z'},
      {id: 'task-b', title: 'unassigned task', status: 'todo', createdAt: 'not-a-date'}
    ],
    claims: [
      {id: 'claim-a', path: 'app/src/main.ts', sessionId: 'lane-a', origin: 'declared', createdAt: '2026-09-14T02:00:00.000Z', renewedAt: '2026-09-14T04:00:00.000Z', expiresAt: '2026-09-14T05:00:00.000Z'},
      {id: 'claim-b', path: 'app/src', sessionId: 'lane-b', origin: 'observed', createdAt: '2026-09-14T01:00:00.000Z', renewedAt: '2026-09-14T04:00:00.000Z', expiresAt: '2026-09-14T05:00:00.000Z'}
    ],
    decisions: [{id: 'decision-a', summary: 'keep state local', sessionId: 'lane-a', createdAt: '2026-09-14T04:00:00.000Z'}],
    handoffs: [{id: 'handoff-a', fromSessionId: 'lane-a', toSessionId: 'lane-b', summary: 'review explorer', createdAt: '2026-09-14T05:00:00.000Z', status: 'accepted'}],
    messages: [{id: 'message-a', from: 'lane-b', to: 'lane-a', body: 'tests are ready', createdAt: '2026-09-14T06:00:00.000Z'}],
    events: [
      {id: 'event-task', at: '2026-09-14T03:00:00.000Z', kind: 'task.created', sessionIds: ['lane-a'], taskId: 'task-a'},
      {id: 'event-decision', at: '2026-09-14T04:00:00.000Z', kind: 'decision.recorded', sessionIds: ['lane-a'], decisionId: 'decision-a'},
      {id: 'event-handoff-request', at: '2026-09-14T05:00:00.000Z', kind: 'handoff.requested', sessionIds: ['lane-a', 'lane-b'], handoffId: 'handoff-a'},
      {id: 'event-handoff-accept', at: '2026-09-14T05:30:00.000Z', kind: 'handoff.accepted', sessionIds: ['lane-a', 'lane-b'], handoffId: 'handoff-a'},
      {id: 'event-message', at: '2026-09-14T06:00:00.000Z', kind: 'message.sent', actorSessionId: 'lane-b', sessionIds: ['lane-a', 'lane-b'], messageId: 'message-a'},
      {id: 'event-expired-claim', at: '2026-09-14T07:00:00.000Z', kind: 'claim.released', sessionIds: ['lane-b'], claimId: 'claim-gone', path: 'app/src/old.ts', releaseReason: 'lease_expired'}
    ]
  };
}

const conflicts: RankedConflict[] = [{path: 'app/src/main.ts', claimedPath: 'app/src', sessionId: 'lane-b', overlap: 'contained', hotspot: true}];

describe('coordination explorer helpers', () => {
  it('only accepts known persisted explorer scopes', () => {
    assert.equal(isExplorerScope('files'), true);
    assert.equal(isExplorerScope('freeform'), false);
    assert.equal(isExplorerScope({scope: 'tasks'}), false);
  });

  it('sorts and bounds retained history while leaving vanished records as non-links', () => {
    const activity = retainedCoordinationHistory(state(), 3);
    assert.deepEqual(activity.map(item => item.label), ['claim lease expired', 'lane message sent', 'handoff accepted']);
    assert.equal(activity[0]?.subject, undefined, 'a released claim cannot select a newer claim with a matching path');
    assert.deepEqual(activity[1]?.subject, {kind: 'message', id: 'message-a'});
    assert.equal(activity.length, 3);
    assert.equal(retainedCoordinationHistory(state(), -1).length, 0);
  });

  it('labels task backlinks as shared-lane inference rather than a direct task-to-claim link', () => {
    const subject: CoordinationSubject = {kind: 'task', id: 'task-a'};
    const inspection = inspectCoordination(subject, state(), [laneA, laneB], conflicts);
    assert.ok(inspection);
    assert.match(inspection.relationshipNote, /share this lane/);
    assert.deepEqual(inspection.claims.map(claim => claim.path), ['app/src/main.ts']);
    assert.deepEqual(inspection.messages.map(message => message.id), ['message-a'], 'lane backlinks include sent and received messages');
    assert.equal(inspection.lanes[0]?.verification, 'passed', 'verification is current lane state');
  });

  it('resolves path containment conflicts and missing lanes without inventing a replacement', () => {
    const subject: CoordinationSubject = {kind: 'claim', id: 'claim-a'};
    const inspection = inspectCoordination(subject, state(), [laneA], conflicts);
    assert.ok(inspection);
    assert.equal(inspection.conflicts[0]?.overlap, 'contained');
    assert.deepEqual(inspection.missingLaneIds, ['lane-b']);
  });

  it('clears a stale object selection when the current snapshot no longer contains it', () => {
    assert.equal(inspectCoordination({kind: 'handoff', id: 'handoff-missing'}, state(), [laneA, laneB], conflicts), undefined);
  });
});
