import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {hasExecutable, installPlan, installableTools, runInstall} from './installer.js';

const mac = {platform: 'darwin' as const, hasBrew: false, hasNpm: false};

describe('install plans', () => {
  it('prefers native installers that need neither Node nor Homebrew', () => {
    for (const tool of ['claude', 'codex', 'opencode'] as const) {
      const plan = installPlan(tool, mac);
      assert.ok(plan.ready, `${tool} should install on a bare machine`);
      assert.match(plan.command, /^curl -fsSL https:\/\//);
      assert.doesNotMatch(plan.command, /npm|brew/);
    }
  });

  it('uses Homebrew, then npm, for the tools that only ship that way', () => {
    const viaBrew = installPlan('gemini', {...mac, hasBrew: true, hasNpm: true});
    assert.ok(viaBrew.ready && viaBrew.command === 'brew install gemini-cli');
    const viaNpm = installPlan('gemini', {...mac, hasNpm: true});
    assert.ok(viaNpm.ready && viaNpm.command === 'npm install -g @google/gemini-cli');
    const bare = installPlan('gemini', mac);
    assert.ok(!bare.ready && /Homebrew or npm/.test(bare.unavailable));
  });

  it('falls back to the signed gh release archive without Homebrew, and never asks for sudo', () => {
    const plan = installPlan('gh', mac);
    assert.ok(plan.ready);
    assert.match(plan.command, /releases\/download/);
    assert.doesNotMatch(plan.command, /sudo/);
    assert.match(plan.command, /\.local\/bin/);
  });

  it('says which agent the OpenDesign installer will also configure', () => {
    const plan = installPlan('open-design', mac, {agent: 'codex'});
    assert.ok(plan.ready);
    assert.match(plan.command, /sh -s codex$/);
    assert.match(plan.alsoConfigures ?? '', /Codex/);
  });

  it('has an answer for every tool on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const tool of installableTools) {
        const plan = installPlan(tool, {platform, hasBrew: false, hasNpm: false});
        assert.equal(plan.tool, tool);
        assert.ok(plan.docsUrl.startsWith('https://'));
      }
    }
  });
});

describe('running an installer', () => {
  it('finds executables on a given PATH', () => {
    assert.equal(hasExecutable('sh', '/bin:/usr/bin'), true);
    assert.equal(hasExecutable('definitely-not-a-binary', '/bin'), false);
  });

  it('captures output and the exit code of the real command it ran', async () => {
    const ok = await runInstall({tool: 'gh', label: 'x', ready: true, command: 'echo installed; echo warn >&2', summary: '', docsUrl: ''});
    assert.equal(ok.ok, true);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.output, /installed/);
    assert.match(ok.output, /warn/);
    const failed = await runInstall({tool: 'gh', label: 'x', ready: true, command: 'echo nope; exit 3', summary: '', docsUrl: ''});
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
  });

  it('stops an installer that hangs instead of waiting forever', async () => {
    const result = await runInstall({tool: 'gh', label: 'x', ready: true, command: 'sleep 30', summary: '', docsUrl: ''}, {timeoutMs: 200});
    assert.equal(result.ok, false);
    assert.match(result.output, /still running/);
  });
});
