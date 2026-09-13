import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {renderAgentView, renderClaimResult, resolveId, viewCursor, type AgentView} from './agent-view.js';
import {coordinationBriefing, briefingArgs} from './agent-briefing.js';

const lane = {sessionId: '3f2a1b0c-1111-2222-3333-444444444444', provider: 'claude' as const, project: '/repo', branch: 'main'};
const other = '9e01ab22-5555-6666-7777-888888888888';

function view(overrides: Partial<AgentView> = {}): AgentView {
  const partial = {
    lane,
    tasks: [],
    claims: [],
    conflicts: [],
    handoffs: [],
    ...overrides
  } as Omit<AgentView, 'cursor'>;
  return {...partial, cursor: viewCursor(partial)};
}

describe('what a lane is told', () => {
  it('states every section, including the empty ones', () => {
    const text = renderAgentView(view());

    assert.match(text, /^lane 3f2a1b0c claude main \/repo$/m);
    assert.match(text, /^tasks 0$/m);
    assert.match(text, /^claims 0 mine 0$/m);
    assert.match(text, /^conflicts 0$/m, 'an absent section would read as unknown, not as none');
    assert.match(text, /^handoffs 0$/m);
  });

  it('renders rows as space-separated columns with free text last', () => {
    const text = renderAgentView(view({
      tasks: [{id: 'a1c2d3e4-0000-0000-0000-000000000000', title: 'Add router tests', status: 'active', sessionId: lane.sessionId, createdAt: 'now'}]
    }));

    assert.match(text, /^tasks 1$/m);
    assert.match(text, /^id status lane title$/m);
    assert.match(text, /^a1c2d3e4 active 3f2a1b0c Add router tests$/m);
  });

  it('counts the lane\'s own claims separately from everyone\'s', () => {
    const text = renderAgentView(view({
      claims: [
        {path: 'src/a.ts', sessionId: lane.sessionId, origin: 'declared', createdAt: 'n', renewedAt: 'n', expiresAt: 'n'},
        {path: 'src/b.ts', sessionId: other, origin: 'observed', createdAt: 'n', renewedAt: 'n', expiresAt: 'n'}
      ]
    }));

    assert.match(text, /^claims 2 mine 1$/m);
    assert.match(text, /^src\/a\.ts 3f2a1b0c declared$/m);
  });

  it('marks a conflict on a hotspot so the agent can tell which one matters', () => {
    const text = renderAgentView(view({
      conflicts: [{path: 'src/router.ts', claimedPath: 'src/router.ts', sessionId: other, overlap: 'same', hotspot: true}]
    }));

    assert.match(text, /^conflicts 1$/m);
    assert.match(text, /^src\/router\.ts 9e01ab22 same yes$/m);
  });

  it('shows only handoffs still waiting', () => {
    const text = renderAgentView(view({
      handoffs: [
        {id: 'h1111111-0000-0000-0000-000000000000', fromSessionId: other, toSessionId: lane.sessionId, summary: 'please review', status: 'open', createdAt: 'n'},
        {id: 'h2222222-0000-0000-0000-000000000000', fromSessionId: other, toSessionId: lane.sessionId, summary: 'done already', status: 'accepted', createdAt: 'n'}
      ]
    }));

    assert.match(text, /^handoffs 1$/m);
    assert.match(text, /please review/);
    assert.doesNotMatch(text, /done already/);
  });

  it('carries no JSON punctuation at all', () => {
    const text = renderAgentView(view({
      tasks: [{id: 'a1c2d3e4-0000-0000-0000-000000000000', title: 'Add tests', status: 'todo', createdAt: 'n'}],
      claims: [{path: 'src/a.ts', sessionId: lane.sessionId, origin: 'declared', createdAt: 'n', renewedAt: 'n', expiresAt: 'n'}]
    }));

    assert.doesNotMatch(text, /[{}"]/, 'the point of the format is that it is not JSON');
  });
});

describe('the status cursor', () => {
  it('is stable for the same picture and changes when the picture does', () => {
    const before = view({claims: [{path: 'src/a.ts', sessionId: lane.sessionId, origin: 'declared', createdAt: 'n', renewedAt: 'n', expiresAt: 'n'}]});
    const same = view({claims: [{path: 'src/a.ts', sessionId: lane.sessionId, origin: 'declared', createdAt: 'n', renewedAt: 'n', expiresAt: 'n'}]});
    const after = view({claims: [{path: 'src/b.ts', sessionId: lane.sessionId, origin: 'declared', createdAt: 'n', renewedAt: 'n', expiresAt: 'n'}]});

    assert.equal(before.cursor, same.cursor);
    assert.notEqual(before.cursor, after.cursor);
  });

  it('ignores lease renewals, which change nothing an agent would act on', () => {
    const before = view({claims: [{path: 'src/a.ts', sessionId: lane.sessionId, origin: 'declared', createdAt: 'n', renewedAt: 'one', expiresAt: 'one'}]});
    const renewed = view({claims: [{path: 'src/a.ts', sessionId: lane.sessionId, origin: 'declared', createdAt: 'n', renewedAt: 'two', expiresAt: 'two'}]});

    assert.equal(before.cursor, renewed.cursor, 'otherwise every heartbeat would look like news');
  });
});

describe('refused claims', () => {
  it('reads as a result to act on, naming the lane to coordinate with', () => {
    const text = renderClaimResult(['src/router.ts'], false, [
      {path: 'src/router.ts', claimedPath: 'src/router.ts', sessionId: other, overlap: 'same', hotspot: true}
    ]);

    assert.match(text, /^refused src\/router\.ts$/m);
    assert.match(text, /^src\/router\.ts 9e01ab22 same yes$/m);
    assert.match(text, /coordinate before editing/);
  });

  it('confirms a granted claim in one line', () => {
    assert.equal(renderClaimResult(['src/a.ts', 'src/b.ts'], true, []), 'claimed src/a.ts src/b.ts');
  });
});

describe('short ids', () => {
  it('resolves a prefix back to the whole thing', () => {
    const items = [{id: 'a1c2d3e4-1111'}, {id: 'b9999999-2222'}];
    assert.equal(resolveId(items, 'a1c2d3e4').id, 'a1c2d3e4-1111');
  });

  it('refuses an ambiguous prefix rather than picking one', () => {
    const items = [{id: 'a1c2d3e4-1111'}, {id: 'a1c2d3e4-2222'}];
    assert.throws(() => resolveId(items, 'a1c2'), /use more of the id/);
  });

  it('says so when nothing matches', () => {
    assert.throws(() => resolveId([{id: 'a1c2'}], 'ffff'), /Nothing here matches/);
  });
});

describe('telling the lane the command exists', () => {
  it('says when to run it, not only that it exists', () => {
    const briefing = coordinationBriefing('fluent-coord');

    assert.match(briefing, /fluent-coord status/);
    assert.match(briefing, /before you start/);
    assert.match(briefing, /If a claim is refused/);
    assert.match(briefing, /advisory signals, not locks/);
  });

  it('reaches Claude Code through its own flag', () => {
    const args = briefingArgs('claude', 'BRIEFING');
    assert.deepEqual(args, ['--append-system-prompt', 'BRIEFING']);
  });

  it('passes nothing to a provider with no confirmed mechanism', () => {
    assert.deepEqual(briefingArgs('codex', 'BRIEFING'), [], 'a guessed flag would be worse than none');
  });
});
