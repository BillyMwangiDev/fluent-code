import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {budgetVerdict, inheritedBudget, validBudgetUsd} from './budget.js';

describe('budget verdict', () => {
  it('is over exactly at the cap, not only past it', () => {
    const verdict = budgetVerdict({costUsd: 5, costSource: 'modelPriced'}, 5);

    assert.equal(verdict.enforceable, true);
    assert.equal(verdict.over, true);
  });

  it('is not over below the cap', () => {
    const verdict = budgetVerdict({costUsd: 4.99, costSource: 'modelPriced'}, 5);

    assert.equal(verdict.over, false);
  });

  it('is not enforceable without a budget', () => {
    const verdict = budgetVerdict({costUsd: 50, costSource: 'providerReported'}, undefined);

    assert.equal(verdict.enforceable, false);
    assert.equal(verdict.over, false, 'never stop on a guess of zero');
  });

  it('is not enforceable when the cost is unpriced', () => {
    const verdict = budgetVerdict({costUsd: 0, costSource: 'unpriced'}, 5);

    assert.equal(verdict.enforceable, false);
  });

  it('is not enforceable when there is no usage at all', () => {
    const verdict = budgetVerdict(undefined, 5);

    assert.equal(verdict.enforceable, false);
  });

  it('rounds percent to a whole number', () => {
    const verdict = budgetVerdict({costUsd: 1, costSource: 'modelPriced'}, 3);

    assert.equal(verdict.percent, 33);
  });
});

describe('budget inheritance', () => {
  it('a subagent with no requested budget inherits its lead\'s', () => {
    assert.equal(inheritedBudget(undefined, {budgetUsd: 5}), 5);
  });

  it('an explicit request on the subagent wins over the lead\'s', () => {
    assert.equal(inheritedBudget(2, {budgetUsd: 5}), 2);
  });

  it('is undefined when neither the request nor a lead sets one', () => {
    assert.equal(inheritedBudget(undefined, undefined), undefined);
  });
});

describe('validating a budget cap', () => {
  it('accepts a plain positive number', () => {
    assert.equal(validBudgetUsd(12.5), 12.5);
  });

  it('leaves no cap alone', () => {
    assert.equal(validBudgetUsd(undefined), undefined);
  });

  it('rejects zero', () => {
    assert.throws(() => validBudgetUsd(0));
  });

  it('rejects a negative number', () => {
    assert.throws(() => validBudgetUsd(-5));
  });

  it('rejects NaN', () => {
    assert.throws(() => validBudgetUsd(NaN));
  });

  it('rejects a string', () => {
    assert.throws(() => validBudgetUsd('10'));
  });

  it('rejects more than 10,000', () => {
    assert.throws(() => validBudgetUsd(10_001));
  });

  it('accepts exactly 10,000', () => {
    assert.equal(validBudgetUsd(10_000), 10_000);
  });
});
