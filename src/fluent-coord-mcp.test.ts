import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {callFluentCoord, fluentCoordTool} from './fluent-coord-mcp.js';

describe('the compact Fluent coordination MCP tool', () => {
  it('exposes one schema-validated tool instead of duplicating the CLI command catalogue', () => {
    assert.equal(fluentCoordTool.name, 'fluent_coord');
    assert.deepEqual(fluentCoordTool.inputSchema.properties.action.enum, ['status', 'claim', 'release', 'note', 'task', 'send', 'inbox', 'handoff', 'lane']);
    assert.equal(fluentCoordTool.execution.taskSupport, 'forbidden');
  });

  it('uses the host working directory as lane identity and returns only compact generated text', async () => {
    const calls: Array<{method: string; params: Record<string, unknown>}> = [];
    const request = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({method, params});
      return {text: 'unchanged cursor-7'} as T;
    };

    const result = await callFluentCoord({action: 'status', since: 'cursor-6'}, '/repo/lane-a', request);

    assert.deepEqual(calls, [{method: 'agent.status', params: {cwd: '/repo/lane-a', since: 'cursor-6'}}]);
    assert.deepEqual(result.structuredContent, {text: 'unchanged cursor-7'});
  });

  it('keeps task mutations typed and rejects incomplete calls before they reach fluentd', async () => {
    const unreachable = async <T>() => ({text: 'unreachable'} as T);
    await assert.rejects(() => callFluentCoord({action: 'claim', paths: []}, '/repo', unreachable), /paths/);
    await assert.rejects(() => callFluentCoord({action: 'task', taskAction: 'start'}, '/repo', unreachable), /taskId/);
  });

  it('maps a lead\'s lane operations onto the one lane RPC', async () => {
    const calls: Array<{method: string; params: Record<string, unknown>}> = [];
    const request = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({method, params});
      return {text: 'ok'} as T;
    };

    await callFluentCoord({action: 'lane', laneAction: 'start', provider: 'codex', prompt: 'write the parser', taskId: 'ab12', shared: true}, '/repo/lead', request);
    await callFluentCoord({action: 'lane', laneAction: 'wait', lanes: ['a1', 'b2'], timeoutSeconds: 30}, '/repo/lead', request);
    await callFluentCoord({action: 'lane', laneAction: 'read', lane: 'a1', lines: 80}, '/repo/lead', request);

    assert.deepEqual(calls, [
      {method: 'agent.lane', params: {cwd: '/repo/lead', action: 'start', provider: 'codex', prompt: 'write the parser', taskId: 'ab12', shared: true}},
      {method: 'agent.lane', params: {cwd: '/repo/lead', action: 'wait', lanes: ['a1', 'b2'], timeoutSeconds: 30}},
      {method: 'agent.lane', params: {cwd: '/repo/lead', action: 'read', lane: 'a1', lines: 80}}
    ]);
    const unreachable = async <T>() => ({text: 'unreachable'} as T);
    await assert.rejects(() => callFluentCoord({action: 'lane', laneAction: 'assign', lane: 'a1'}, '/repo', unreachable), /taskId/);
    await assert.rejects(() => callFluentCoord({action: 'lane', laneAction: 'dance'}, '/repo', unreachable), /laneAction/);
  });
});
