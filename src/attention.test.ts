import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {attentionDetail, attentionForStatus} from './attention.js';
import type {SessionSummary} from './daemon-protocol.js';

function summary(extra: Partial<SessionSummary>): SessionSummary {
  return {id: 'lane-1', provider: 'claude', command: 'claude', directory: '/work', status: 'running', createdAt: '2026-09-15T10:00:00.000Z', updatedAt: '2026-09-15T10:00:00.000Z', ...extra};
}

describe('when a lane needs the user', () => {
  it('flags a lane that ended on its own, once per ending', () => {
    assert.equal(attentionForStatus(summary({status: 'exited', exitCode: 0})), 'finished');
    assert.equal(attentionForStatus(summary({status: 'exited', exitCode: 2})), 'failed');
    assert.equal(attentionForStatus(summary({status: 'failed'})), 'failed');
    assert.equal(attentionForStatus(summary({status: 'exited', exitCode: 0}), 'exited'), undefined, 'the same ending is not announced twice');
  });

  it('does not interrupt for a stop the user asked for, or for a lane that is still working', () => {
    for (const status of ['stopped', 'running', 'starting'] as const) assert.equal(attentionForStatus(summary({status})), undefined);
  });

  it('uses Claude\'s own notification text, trimmed and bounded', () => {
    assert.equal(attentionDetail({message: '  Claude needs your permission to use Bash  '}), 'Claude needs your permission to use Bash');
    assert.equal(attentionDetail({message: 'x'.repeat(500)})?.length, 200);
    assert.equal(attentionDetail({}), undefined);
  });
});
