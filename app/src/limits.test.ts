import test from 'node:test';
import assert from 'node:assert/strict';
import {budgetPercent, laneCostText, windowLabel, windowLevel, windowsByProvider} from './limits';

test('windowLabel formats percent with a duration prefix and a reset countdown', () => {
  const now = new Date('2026-09-17T12:00:00Z');
  assert.equal(windowLabel({usedPercent: 41, windowMinutes: 300, resetsAt: '2026-09-17T14:12:00Z'}, now), '5h 41% · resets 2h12m');
  assert.equal(windowLabel({usedPercent: 12, windowMinutes: 10080}, now), '7d 12%');
});

test('windowLabel omits the duration prefix when windowMinutes is unknown', () => {
  assert.equal(windowLabel({usedPercent: 30}), '30%');
});

test('windowLabel omits the reset countdown when resetsAt is past or absent', () => {
  const now = new Date('2026-09-17T12:00:00Z');
  assert.equal(windowLabel({usedPercent: 41, windowMinutes: 300, resetsAt: '2026-09-17T10:00:00Z'}, now), '5h 41%');
  assert.equal(windowLabel({usedPercent: 41, windowMinutes: 300}, now), '5h 41%');
});

test('windowLabel is undefined when nothing is reported', () => {
  assert.equal(windowLabel(undefined), undefined);
  assert.equal(windowLabel({windowMinutes: 300}), undefined);
});

test('windowLevel thresholds at 70% and 90%', () => {
  assert.equal(windowLevel({usedPercent: 10}), 'ok');
  assert.equal(windowLevel({usedPercent: 70}), 'warn');
  assert.equal(windowLevel({usedPercent: 90}), 'critical');
  assert.equal(windowLevel({usedPercent: 100}), 'critical');
  assert.equal(windowLevel(undefined), undefined);
});

test('laneCostText labels reported, estimated and unpriced cost differently', () => {
  assert.equal(laneCostText({costUsd: 0.42, costSource: 'providerReported'}), '$0.42');
  assert.equal(laneCostText({costUsd: 0.42, costSource: 'modelPriced'}), '≈$0.42');
  assert.equal(laneCostText({costSource: 'unpriced'}), 'cost unknown');
  assert.equal(laneCostText(undefined), undefined);
  assert.equal(laneCostText({}), undefined);
});

test('budgetPercent rounds to a whole number and is undefined without both figures', () => {
  assert.equal(budgetPercent(4.1, 5), 82);
  assert.equal(budgetPercent(undefined, 5), undefined);
  assert.equal(budgetPercent(4, undefined), undefined);
  assert.equal(budgetPercent(4, 0), undefined);
});

test('windowsByProvider merges sessions into one window pair per provider, latest observedAt wins', () => {
  const sessions = [
    {provider: 'claude', quota: {primary: {usedPercent: 20}, observedAt: '2026-09-17T10:00:00Z'}},
    {provider: 'claude', quota: {primary: {usedPercent: 41}, observedAt: '2026-09-17T12:00:00Z'}},
    {provider: 'codex', quota: {secondary: {usedPercent: 5}, observedAt: '2026-09-17T11:00:00Z'}},
    {provider: 'gemini'}
  ];
  const result = windowsByProvider(sessions);
  assert.equal(result.size, 2);
  assert.equal(result.get('claude')?.primary?.usedPercent, 41);
  assert.equal(result.get('codex')?.secondary?.usedPercent, 5);
  assert.equal(result.has('gemini'), false);
});
