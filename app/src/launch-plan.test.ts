import test from 'node:test';
import assert from 'node:assert/strict';
import {clampCount, defaultCounts, describePlan, launchPlan, parseBudgetUsd, providerReadiness} from './launch-plan';
import type {CredentialChainState, ProviderHealth} from './api';

const providers: ProviderHealth[] = [
  {id: 'claude', label: 'Claude Code', installed: true, version: '2.1'},
  {id: 'codex', label: 'Codex', installed: true},
  {id: 'gemini', label: 'Gemini CLI', installed: false},
  {id: 'glm', label: 'GLM via OpenCode', installed: true},
  {id: 'qwen', label: 'Qwen via OpenCode', installed: true},
  {id: 'nvidia', label: 'NVIDIA NIM via OpenCode', installed: false}
];
const chains: CredentialChainState[] = [
  {provider: 'glm', accounts: [{id: 'g', provider: 'glm', mode: 'api-key', label: 'z.ai', identityId: 'z', model: 'GLM-4.7'}], chain: ['g'], activeAccountId: 'g', fallbackPolicy: 'always-ask'},
  {provider: 'qwen', accounts: [], chain: [], fallbackPolicy: 'always-ask'}
];

test('readiness: native CLIs need only an install, OpenCode providers need a keyed account with a model', () => {
  const readiness = providerReadiness(providers, chains);
  const byId = Object.fromEntries(readiness.map(entry => [entry.id, entry]));
  assert.equal(byId.claude!.ready, true);
  assert.equal(byId.codex!.ready, true);
  assert.equal(byId.gemini!.ready, false);
  assert.equal(byId.gemini!.blocker, 'not installed');
  assert.equal(byId.glm!.ready, true);
  assert.equal(byId.glm!.model, 'GLM-4.7');
  assert.equal(byId.qwen!.ready, false);
  assert.equal(byId.qwen!.blocker, 'needs an API key');
  assert.equal(byId.nvidia!.blocker, 'not installed');
});

test('plan interleaves providers so every provider gets an early lane, capped at 20', () => {
  const readiness = providerReadiness(providers, chains);
  assert.deepEqual(launchPlan({claude: 2, codex: 2, glm: 1}, readiness), ['claude', 'codex', 'glm', 'claude', 'codex']);
  assert.deepEqual(launchPlan({claude: 1, qwen: 3}, readiness), ['claude']);
  assert.equal(launchPlan({claude: 10, codex: 10, glm: 10}, readiness).length, 20);
  assert.deepEqual(launchPlan({}, readiness), []);
});

test('counts clamp to 0..10 and tolerate junk', () => {
  assert.equal(clampCount('5'), 5);
  assert.equal(clampCount(-3), 0);
  assert.equal(clampCount(40), 10);
  assert.equal(clampCount('x'), 0);
  assert.equal(clampCount(undefined), 0);
});

test('default counts: remembered counts for ready providers, otherwise one lane on the first ready provider', () => {
  const readiness = providerReadiness(providers, chains);
  assert.deepEqual(defaultCounts(readiness, {claude: 5, codex: 5, qwen: 5}), {claude: 5, codex: 5});
  assert.deepEqual(defaultCounts(readiness, {}), {claude: 1});
  assert.deepEqual(defaultCounts(readiness, {gemini: 3}), {claude: 1});
});

test('plan description reads as a short sentence', () => {
  assert.equal(describePlan(['claude', 'codex', 'claude'], id => id), '3 lanes · 2 claude · 1 codex');
  assert.equal(describePlan(['glm'], id => id), '1 lane · 1 glm');
  assert.equal(describePlan([], id => id), 'no lanes');
});

test('budget field: blank means no cap; bad or out-of-range values are dropped', () => {
  assert.equal(parseBudgetUsd(''), undefined);
  assert.equal(parseBudgetUsd('   '), undefined);
  assert.equal(parseBudgetUsd('5'), 5);
  assert.equal(parseBudgetUsd('5.50'), 5.5);
  assert.equal(parseBudgetUsd('0'), undefined);
  assert.equal(parseBudgetUsd('-3'), undefined);
  assert.equal(parseBudgetUsd('abc'), undefined);
  assert.equal(parseBudgetUsd('20000'), undefined);
  assert.equal(parseBudgetUsd('10000'), 10000);
});
