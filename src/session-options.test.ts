import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {isRiskyPermission, permissionModes, sessionOptionArgs} from './session-options.js';

describe('session model and permission options', () => {
  it('passes Claude Code its own model and permission-mode flags', () => {
    assert.deepEqual(sessionOptionArgs('claude', {model: 'opus', permissionMode: 'acceptEdits'}), ['--model', 'opus', '--permission-mode', 'acceptEdits']);
    assert.deepEqual(sessionOptionArgs('claude', {}), []);
  });

  it('passes Codex its model and sandbox flags', () => {
    assert.deepEqual(sessionOptionArgs('codex', {model: 'gpt-6-astra', permissionMode: 'workspace-write'}), ['-m', 'gpt-6-astra', '-s', 'workspace-write']);
  });

  it('refuses values the CLI would not accept before anything launches', () => {
    assert.throws(() => sessionOptionArgs('claude', {permissionMode: 'yolo'}), /permission mode/);
    assert.throws(() => sessionOptionArgs('codex', {permissionMode: 'acceptEdits'}), /permission mode/);
    assert.throws(() => sessionOptionArgs('claude', {model: '--dangerously-skip-permissions'}), /model/);
    assert.throws(() => sessionOptionArgs('claude', {model: 'opus sonnet'}), /model/);
  });

  it('takes no model or permission choice for providers that get them elsewhere', () => {
    assert.throws(() => sessionOptionArgs('qwen', {model: 'qwen3-coder'}), /account/);
    assert.throws(() => sessionOptionArgs('gemini', {permissionMode: 'plan'}), /Gemini/);
    assert.deepEqual(sessionOptionArgs('gemini', {}), []);
  });

  it('marks the modes that remove the CLI\'s own safety prompts as risky', () => {
    assert.equal(isRiskyPermission('claude', 'bypassPermissions'), true);
    assert.equal(isRiskyPermission('codex', 'danger-full-access'), true);
    assert.equal(isRiskyPermission('claude', 'plan'), false);
    assert.equal(isRiskyPermission('codex', undefined), false);
  });

  it('lists the choices a picker offers for each provider', () => {
    assert.deepEqual(permissionModes('codex'), ['read-only', 'workspace-write', 'danger-full-access']);
    assert.ok(permissionModes('claude').includes('plan'));
    assert.deepEqual(permissionModes('gemini'), []);
  });
});
