import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {marketplacePolicySource, mcpCommandArgs, mcpPolicySource, mcpTrustForConfig, validateMarketplaceSource} from './catalog-manager.js';

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

  it('validates untrusted transport and scope values at runtime', () => {
    assert.throws(() => mcpCommandArgs('claude', {name: 'bad', transport: 'pipe' as 'stdio', command: 'tool'}), /transport/);
    assert.throws(() => mcpCommandArgs('claude', {name: 'bad-scope', transport: 'stdio', command: 'tool', scope: 'machine' as 'user'}), /scope/);
  });

  it('rejects remote URL credentials, query tokens, and fragments before a provider sees them', () => {
    for (const url of ['http://example.test/mcp', 'https://person:secret@example.test/mcp', 'https://example.test/mcp?token=secret', 'https://example.test/mcp#fragment']) {
      assert.throws(() => mcpCommandArgs('claude', {name: 'remote', transport: 'http', url}), /credential-free https URL|https URL/, url);
    }
  });

  it('uses an exact opaque identity for a trusted MCP declaration while redacting its display label', () => {
    const first = mcpPolicySource({name: 'tools', transport: 'stdio', command: 'npx', args: ['-y', '@scope/one']});
    const second = mcpPolicySource({name: 'tools', transport: 'stdio', command: 'npx', args: ['-y', '@scope/two']});
    assert.notEqual(first.id, second.id);
    assert.match(first.source, /local MCP process: npx/);
  });

  it('labels a local process and a remote endpoint with only the boundary Fluent knows', () => {
    const local = mcpTrustForConfig({transport: 'stdio', command: 'npx'});
    assert.equal(local.level, 'local');
    assert.match(local.disclosures[0]!, /Launches this local process/);

    const remote = mcpTrustForConfig({transport: 'http', url: 'https://person:password@example.test/mcp?token=hidden#fragment'});
    assert.equal(remote.level, 'unverified');
    assert.equal(remote.source, 'https://example.test/mcp');
    assert.match(remote.disclosures[0]!, /does not launch a local process/);
  });
});

describe('marketplace source validation', () => {
  it('accepts explicit local paths and canonical GitHub repository forms', () => {
    assert.deepEqual(validateMarketplaceSource('/opt/fluent/plugins'), {source: '/opt/fluent/plugins', kind: 'local-path'});
    for (const source of ['owner/repo', 'owner/repo.git', 'https://github.com/owner/repo', 'git@github.com:owner/repo.git']) {
      assert.equal(validateMarketplaceSource(source).kind, 'github-repository', source);
    }
  });

  it('refuses ambiguous, credentialed, option-like, relative, and non-GitHub remote sources before any CLI invocation', () => {
    for (const source of [
      '', '  ', '-x', './plugins', '../plugins', 'github.com.evil/owner/repo', 'https://github.com.evil/owner/repo',
      'https://github.com@evil.test/owner/repo', 'https://user:token@github.com/owner/repo',
      'https://github.com/owner/repo?token=secret', 'https://github.com/owner/repo#fragment',
      'git@evil.test:owner/repo', 'https://gitlab.com/owner/repo', 'owner/repo/extra', 'owner/repo\n--flag'
    ]) {
      assert.throws(() => validateMarketplaceSource(source), /marketplace|use an absolute/i, source);
    }
  });

  it('canonicalizes alternate GitHub spellings to one policy identity without resolving local source outside its absolute boundary', () => {
    const direct = marketplacePolicySource(validateMarketplaceSource('Owner/Repo.git'));
    const https = marketplacePolicySource(validateMarketplaceSource('https://github.com/owner/repo'));
    assert.deepEqual(direct, https);
    assert.deepEqual(marketplacePolicySource(validateMarketplaceSource('/opt/fluent/../plugins')), {
      id: 'marketplace:local:/opt/plugins', kind: 'marketplace', source: '/opt/plugins'
    });
  });
});
