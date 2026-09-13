import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {callFluentCoord, fluentCoordTool} from './fluent-coord-mcp.js';

describe('the compact Fluent coordination MCP tool', () => {
  it('exposes one schema-validated tool instead of duplicating the CLI command catalogue', () => {
    assert.equal(fluentCoordTool.name, 'fluent_coord');
    assert.deepEqual(fluentCoordTool.inputSchema.properties.action.enum, ['status', 'claim', 'release', 'note', 'task', 'send', 'inbox', 'handoff']);
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
});
