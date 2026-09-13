import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {distribution, markdownReport, pairedComparison, percentile, type BenchmarkSample} from './statistics.js';

const samples: BenchmarkSample[] = [
  {id: 'b1', pairId: '1', arm: 'bare', durationMs: 100, outcome: 'success'},
  {id: 'f1', pairId: '1', arm: 'fluent', durationMs: 80, outcome: 'success'},
  {id: 'b2', pairId: '2', arm: 'bare', durationMs: 120, outcome: 'success'},
  {id: 'f2', pairId: '2', arm: 'fluent', durationMs: 110, outcome: 'success'},
  {id: 'f3', pairId: '3', arm: 'fluent', durationMs: 999, outcome: 'timeout'}
];

describe('benchmark statistics', () => {
  it('reports quantiles without inventing values for an empty collection', () => {
    assert.equal(percentile([1, 5, 9], 0.5), 5);
    assert.equal(distribution([]).medianMs, undefined);
    assert.equal(distribution([1, 2, 3]).p95Ms, 2.9);
  });

  it('only compares complete successful randomized pairs', () => {
    const comparison = pairedComparison(samples, 20);
    assert.equal(comparison.pairs, 2);
    assert.equal(comparison.medianDeltaMs, -15);
    assert.equal(comparison.fluentWins, 2);
    assert.ok(comparison.bootstrap95!.highMs <= -10);
  });

  it('includes failures and timeouts in the human-readable receipt', () => {
    const report = markdownReport({title: 'control plane', samples, host: {node: 'test'}});
    assert.match(report, /4 successes, 0 failures, 1 timeouts/);
    assert.match(report, /Human approval\/review time/);
  });
});
