import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {mcpCommandArgs} from './catalog-manager.js';

describe('portable MCP registration', () => {
  const config = {name: 'github', transport: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], scope: 'user' as const};

  it('preserves structured executable arguments for every provider rather than splitting a shell string', () => {
    assert.deepEqual(mcpCommandArgs('claude', config), ['mcp', 'add', '--scope', 'user', 'github', '--', 'npx', '-y', '@modelcontextprotocol/server-github']);
    assert.deepEqual(mcpCommandArgs('codex', config), ['mcp', 'add', 'github', '--', 'npx', '-y', '@modelcontextprotocol/server-github']);
    assert.deepEqual(mcpCommandArgs('gemini', config), ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'github', 'npx', '-y', '@modelcontextprotocol/server-github']);
  });

  it('does not invent unsupported Codex SSE registration', () => {
    assert.throws(() => mcpCommandArgs('codex', {name: 'events', transport: 'sse', url: 'https://example.test/mcp'}), /Streamable HTTP/);
  });
});
