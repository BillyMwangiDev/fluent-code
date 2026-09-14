import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {applyCredentialEnvironment} from './session-manager.js';

describe('building a lane\'s environment', () => {
  it('removes a credential the user exported in their own shell', () => {
    process.env.FLUENT_TEST_STRAY_KEY = 'sk-ant-from-the-users-shell';
    try {
      const env = applyCredentialEnvironment({set: {CLAUDE_CONFIG_DIR: '/state/auth/claude/work-sub'}, unset: ['FLUENT_TEST_STRAY_KEY']});

      assert.equal(env.FLUENT_TEST_STRAY_KEY, undefined, 'a spread cannot do this, which is the whole point of unset');
      assert.equal(env.CLAUDE_CONFIG_DIR, '/state/auth/claude/work-sub');
    } finally {
      delete process.env.FLUENT_TEST_STRAY_KEY;
    }
  });

  it('keeps everything else the daemon inherited', () => {
    const env = applyCredentialEnvironment({set: {}, unset: []});

    assert.equal(env.PATH, process.env.PATH);
  });

  it('lets an override win over both', () => {
    const env = applyCredentialEnvironment({set: {PATH: '/from/credential'}, unset: []}, {PATH: '/from/override'});

    assert.equal(env.PATH, '/from/override');
  });

  it('drops the markers a parent agent session exports for its own children', () => {
    const names = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_SANDBOX', 'FLUENT_SESSION_ID'];
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) process.env[name] = 'from-the-parent-session';
    try {
      const env = applyCredentialEnvironment(undefined);

      for (const name of names) assert.equal(env[name], undefined, `${name} would make the lane think it is the parent's subprocess`);
    } finally {
      for (const name of names) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
    }
  });

  it('is safe with no credential at all', () => {
    assert.equal(applyCredentialEnvironment(undefined, {PATH: '/x'}).PATH, '/x');
  });

  it('unsets even when the same name is also set, setting winning', () => {
    process.env.FLUENT_TEST_BOTH = 'inherited';
    try {
      const env = applyCredentialEnvironment({set: {FLUENT_TEST_BOTH: 'chosen'}, unset: ['FLUENT_TEST_BOTH']});

      assert.equal(env.FLUENT_TEST_BOTH, 'chosen', 'an explicit choice outranks the removal of an inherited one');
    } finally {
      delete process.env.FLUENT_TEST_BOTH;
    }
  });
});
