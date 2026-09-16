import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {CoordinationState, SessionSummary} from './daemon-protocol.js';
import {leadDirection} from './agent-briefing.js';
import {parseLaneArguments} from './lane-commands.js';
import {laneReadiness, poolRefusal, renderLanes, screenText, ticketBrief, validLeadBudget, validLeadGrant, validLeadPool} from './lead-lanes.js';

const leadId = 'lead-0000-aaaa';
const now = Date.parse('2026-09-15T12:00:00.000Z');

function lane(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, provider: 'codex', command: 'codex', directory: `/work/${id}`, status: 'running',
    createdAt: '2026-09-15T11:00:00.000Z', updatedAt: '2026-09-15T11:59:30.000Z', parentSessionId: leadId, ...extra
  };
}

function board(extra: Partial<CoordinationState> = {}): CoordinationState {
  return {project: '/work', tasks: [], claims: [], decisions: [], handoffs: [], messages: [], events: [], ...extra};
}

const task = (id: string, sessionId: string | undefined, status: 'todo' | 'active' | 'done', title = 'Parse the config file') =>
  ({id, title, status, sessionId, createdAt: '2026-09-15T11:00:00.000Z'});

describe('lane command arguments', () => {
  it('takes a provider and flags for start, and the rest as the prompt', () => {
    assert.deepEqual(
      parseLaneArguments(['start', 'codex', '--task', 'ab12cd34', '--shared', 'write', 'the', 'parser']),
      {action: 'start', provider: 'codex', taskId: 'ab12cd34', shared: true, prompt: 'write the parser'}
    );
  });

  it('reads numeric options for read and wait', () => {
    assert.deepEqual(parseLaneArguments(['read', '9e01ab22', '--lines', '80']), {action: 'read', lane: '9e01ab22', lines: 80});
    assert.deepEqual(parseLaneArguments(['wait', 'a1', 'b2', '--timeout', '30']), {action: 'wait', lanes: ['a1', 'b2'], timeoutSeconds: 30});
    assert.deepEqual(parseLaneArguments(['wait']), {action: 'wait', lanes: []});
    assert.deepEqual(parseLaneArguments(['list']), {action: 'list'});
    assert.deepEqual(parseLaneArguments(['assign', 'a1', 't1']), {action: 'assign', lane: 'a1', taskId: 't1'});
    assert.deepEqual(parseLaneArguments(['stop', 'a1']), {action: 'stop', lane: 'a1'});
  });

  it('answers an incomplete or unknown command with its usage', () => {
    assert.throws(() => parseLaneArguments(['start']), /usage: fluent-coord lane start PROVIDER/);
    assert.throws(() => parseLaneArguments(['assign', 'a1']), /usage: fluent-coord lane assign LANE TASK/);
    assert.throws(() => parseLaneArguments(['read', 'a1', '--lines', 'many']), /--lines needs a number/);
    assert.throws(() => parseLaneArguments(['dance']), /usage: fluent-coord lane start\|list\|assign\|read\|wait\|stop/);
    assert.throws(() => parseLaneArguments([]), /usage: fluent-coord lane/);
  });
});

describe('lead budget', () => {
  it('accepts a whole number of lanes from 1 to 20', () => {
    assert.equal(validLeadBudget(1), 1);
    assert.equal(validLeadBudget(20), 20);
    for (const value of [0, 21, 2.5, '3', undefined]) assert.throws(() => validLeadBudget(value), /between 1 and 20/);
  });

  it('a pool names each provider\'s share, drops zeros, and totals into the budget', () => {
    assert.deepEqual(validLeadPool({codex: 5, glm: 5, claude: 0}), {codex: 5, glm: 5});
    assert.equal(validLeadPool(undefined), undefined);
    assert.deepEqual(validLeadGrant({pool: {codex: 5, glm: 5}}), {maxLanes: 10, pool: {codex: 5, glm: 5}});
    assert.deepEqual(validLeadGrant({maxLanes: 3}), {maxLanes: 3});
    assert.throws(() => validLeadPool({codex: 0}), /at least one lane/);
    assert.throws(() => validLeadPool({codex: 15, glm: 10}), /at most 20/);
    assert.throws(() => validLeadPool({gpt: 2}), /Unknown provider gpt/);
    assert.throws(() => validLeadPool({codex: 1.5}), /whole number/);
    assert.throws(() => validLeadPool([1, 2]), /map of provider/);
  });

  it('refuses a provider outside the pool, or beyond its share, before the total budget', () => {
    const grant = {maxLanes: 3, pool: {codex: 2, glm: 1}};
    const running = [lane('c1', {provider: 'codex'}), lane('c2', {provider: 'codex'})];
    assert.equal(poolRefusal(grant, 'glm', running), undefined);
    assert.match(poolRefusal(grant, 'codex', running) ?? '', /All 2 of your codex lanes are running \(2\/2\)/);
    assert.match(poolRefusal(grant, 'claude', running) ?? '', /Your pool has no claude lanes — it is 2 codex, 1 glm/);
    assert.match(poolRefusal(grant, 'glm', [...running, lane('g1', {provider: 'glm'})]) ?? '', /Lane budget reached: 3\/3/);
    assert.equal(poolRefusal({maxLanes: 3}, 'claude', running), undefined, 'no pool means any provider within the budget');
    assert.equal(poolRefusal(grant, 'codex', [lane('c1', {provider: 'codex', status: 'exited'}), lane('c2', {provider: 'codex', status: 'exited'})]), undefined, 'ended lanes free their share');
  });
});

describe('lane readiness', () => {
  it('is not ready while a running lane still has open work', () => {
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({tasks: [task('task-1111', 'child-aa', 'active')]})), undefined);
    assert.equal(laneReadiness(lane('child-aa'), leadId, board()), undefined, 'a lane with no ticket yet is still working on its prompt');
  });

  it('is ready once the lane has stopped, exited, or failed', () => {
    for (const status of ['stopped', 'exited', 'failed'] as const) {
      assert.equal(laneReadiness(lane('child-aa', {status}), leadId, board()), status);
    }
  });

  it('is ready when every task assigned to the lane is done', () => {
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({tasks: [task('task-1111', 'child-aa', 'done')]})), 'done');
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({tasks: [task('task-1111', 'child-aa', 'done'), task('task-2222', 'child-aa', 'active')]})), undefined);
  });

  it('is ready when the lane has unread mail or an open handoff for its lead', () => {
    const mail = {id: 'm1', from: 'child-aa', to: leadId, body: 'blocked on the schema', createdAt: '2026-09-15T11:59:00.000Z'};
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({messages: [mail]})), 'mail');
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({messages: [{...mail, readAt: '2026-09-15T11:59:10.000Z'}]})), undefined, 'mail the lead already read');
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({messages: [{...mail, to: 'someone-else'}]})), undefined, 'mail to another lane');
    const handoff = {id: 'h1', fromSessionId: 'child-aa', toSessionId: leadId, summary: 'parser ready for review', createdAt: '2026-09-15T11:59:00.000Z', status: 'open' as const};
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({handoffs: [handoff]})), 'handoff');
    assert.equal(laneReadiness(lane('child-aa'), leadId, board({handoffs: [{...handoff, status: 'accepted'}]})), undefined);
  });
});

describe('lane table', () => {
  const lead = lane(leadId, {provider: 'claude', parentSessionId: undefined, lead: {maxLanes: 3}});

  it('shows each provider\'s share when the lead has a pool', () => {
    const pooled = lane(leadId, {provider: 'claude', parentSessionId: undefined, lead: {maxLanes: 3, pool: {codex: 2, glm: 1}}});
    const table = renderLanes(pooled, [lane('child-aa-1111')], board(), now);
    assert.equal(table.split('\n')[0], 'lanes 1/3 · codex 1/2 · glm 0/1');
  });

  it('states the budget, then one compact row per lane with its open task last', () => {
    const table = renderLanes(lead, [
      lane('child-aa-1111'),
      lane('child-bb-2222', {provider: 'claude', status: 'stopped', updatedAt: '2026-09-15T10:30:00.000Z'})
    ], board({tasks: [task('task-1111-xxxx', 'child-aa-1111', 'active')]}), now);

    assert.equal(table, [
      'lanes 1/3',
      'id provider status ready idle task',
      'child-aa codex running - 30s task-111 Parse the config file',
      'child-bb claude stopped stopped 1h -'
    ].join('\n'));
  });

  it('says zero explicitly when the lead has no lanes', () => {
    assert.equal(renderLanes(lead, [], board(), now), 'lanes 0/3');
  });
});

describe('screen text', () => {
  it('renders what a full-screen CLI shows rather than its escape codes', async () => {
    const output = 'old line\r\n\x1b[2J\x1b[Hfresh screen\r\n\x1b[1mbold\x1b[0m done';
    assert.equal(await screenText(output, 40, 5, 10), 'fresh screen\nbold done');
  });

  it('keeps only the last lines asked for, including scrolled-off ones', async () => {
    const output = Array.from({length: 30}, (_, index) => `line ${index + 1}`).join('\r\n');
    assert.equal(await screenText(output, 20, 10, 3), 'line 28\nline 29\nline 30');
  });
});

describe('ticket brief', () => {
  it('names the ticket and tells the lane how to report back to its lead', () => {
    const brief = ticketBrief(
      {...task('task-1111-xxxx', undefined, 'todo'), description: 'Support TOML and JSON.'},
      board({masterBrief: 'Ship the config loader this week.'}),
      leadId,
      'fluent-coord'
    );
    assert.match(brief, /Parse the config file/);
    assert.match(brief, /Support TOML and JSON\./);
    assert.match(brief, /Ship the config loader this week\./);
    assert.match(brief, /fluent-coord task done task-111/);
    assert.match(brief, /fluent-coord send lead-000 /);
  });
});

describe('lead direction', () => {
  it('gives Claude Code the lead instructions through its system prompt, beside the coordination briefing', () => {
    const direction = leadDirection('claude', 3, 'refactor the router', 'fluent-coord');
    assert.equal(direction.prompt, 'refactor the router');
    assert.match(direction.systemPrompt ?? '', /fluent-coord status/);
    assert.match(direction.systemPrompt ?? '', /up to 3/);
    for (const command of ['lane start', 'lane list', 'lane assign', 'lane read', 'lane wait', 'lane stop']) {
      assert.match(direction.systemPrompt ?? '', new RegExp(`fluent-coord ${command}`));
    }
  });

  it('puts the lead instructions ahead of the first prompt for providers without that flag', () => {
    const direction = leadDirection('codex', 2, 'refactor the router', 'fluent-coord');
    assert.equal(direction.systemPrompt, undefined);
    assert.match(direction.prompt ?? '', /^You are the orchestrator of this project/);
    assert.match(direction.prompt ?? '', /up to 2/);
    assert.match(direction.prompt ?? '', /refactor the router$/);
  });
});
