import assert from 'node:assert/strict';
import {test} from 'node:test';
import {providerAdapter, providerLaunchArgs} from './providers.js';

test('Qwen, GLM, and NVIDIA use the local OpenCode bridge with explicit provider-model references', () => {
  for (const provider of ['qwen', 'glm', 'nvidia'] as const) {
    const adapter = providerAdapter(provider);
    assert.equal(adapter.executable, 'opencode');
    assert.equal(adapter.runtime, 'opencode');
    assert.ok(adapter.defaultModel);
    assert.ok(adapter.defaultBaseUrl);
    assert.deepEqual(
      providerLaunchArgs(provider, {set: {FLUENT_OPENCODE_MODEL: `fluent-${provider}/${adapter.defaultModel}`}}),
      ['--model', `fluent-${provider}/${adapter.defaultModel}`]
    );
  }
});

test('a model-link session cannot accidentally launch an arbitrary OpenCode profile', () => {
  assert.throws(
    () => providerLaunchArgs('glm', {set: {}}),
    /GLM via OpenCode needs a connected API-key account/
  );
});
