export type BenchmarkSample = {
  id: string;
  pairId: string;
  arm: 'bare' | 'fluent';
  durationMs: number;
  outcome: 'success' | 'failure' | 'timeout';
  humanApprovalMs?: number;
  humanReviewMs?: number;
};

export type Distribution = {count: number; medianMs?: number; p95Ms?: number; p99Ms?: number};
export type PairedComparison = {pairs: number; medianDeltaMs?: number; bootstrap95?: {lowMs: number; highMs: number}; fluentWins: number};

function sorted(values: readonly number[]) { return [...values].filter(value => Number.isFinite(value)).sort((a, b) => a - b); }

export function percentile(values: readonly number[], percentileValue: number) {
  const ordered = sorted(values);
  if (ordered.length === 0) return undefined;
  const index = (ordered.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (index - lower);
}

export function distribution(values: readonly number[]): Distribution {
  const usable = sorted(values);
  return {count: usable.length, medianMs: percentile(usable, 0.5), p95Ms: percentile(usable, 0.95), p99Ms: percentile(usable, 0.99)};
}

/** Deterministic PRNG so a report is reproducible from its raw samples and manifest. */
function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

export function pairedComparison(samples: readonly BenchmarkSample[], bootstrapIterations = 2_000): PairedComparison {
  const byPair = new Map<string, Partial<Record<BenchmarkSample['arm'], BenchmarkSample>>>();
  for (const sample of samples) {
    if (sample.outcome !== 'success') continue;
    const arms = byPair.get(sample.pairId) ?? {};
    arms[sample.arm] = sample;
    byPair.set(sample.pairId, arms);
  }
  const deltas = [...byPair.values()].flatMap(pair => pair.bare && pair.fluent ? [pair.fluent.durationMs - pair.bare.durationMs] : []);
  if (deltas.length === 0) return {pairs: 0, fluentWins: 0};
  const bootstrap: number[] = [];
  const next = random(0x46554e54);
  for (let iteration = 0; iteration < bootstrapIterations; iteration += 1) {
    const resample = Array.from({length: deltas.length}, () => deltas[Math.floor(next() * deltas.length)]!);
    bootstrap.push(percentile(resample, 0.5)!);
  }
  return {
    pairs: deltas.length,
    medianDeltaMs: percentile(deltas, 0.5),
    bootstrap95: {lowMs: percentile(bootstrap, 0.025)!, highMs: percentile(bootstrap, 0.975)!},
    fluentWins: deltas.filter(delta => delta < 0).length
  };
}

export function markdownReport(input: {title: string; samples: BenchmarkSample[]; host: Record<string, string | number | undefined>}) {
  const bare = input.samples.filter(sample => sample.arm === 'bare');
  const fluent = input.samples.filter(sample => sample.arm === 'fluent');
  const comparison = pairedComparison(input.samples);
  const outcomeCount = (outcome: BenchmarkSample['outcome']) => input.samples.filter(sample => sample.outcome === outcome).length;
  const format = (value: number | undefined) => value === undefined ? 'unavailable' : `${Math.round(value)} ms`;
  return [
    `# ${input.title}`,
    '',
    `Host: ${Object.entries(input.host).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    '',
    '| Arm | Samples | Median | p95 | p99 |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| bare | ${distribution(bare.map(sample => sample.durationMs)).count} | ${format(distribution(bare.map(sample => sample.durationMs)).medianMs)} | ${format(distribution(bare.map(sample => sample.durationMs)).p95Ms)} | ${format(distribution(bare.map(sample => sample.durationMs)).p99Ms)} |`,
    `| fluent | ${distribution(fluent.map(sample => sample.durationMs)).count} | ${format(distribution(fluent.map(sample => sample.durationMs)).medianMs)} | ${format(distribution(fluent.map(sample => sample.durationMs)).p95Ms)} | ${format(distribution(fluent.map(sample => sample.durationMs)).p99Ms)} |`,
    '',
    `Paired complete-success comparisons: ${comparison.pairs}; median Fluent − bare: ${format(comparison.medianDeltaMs)}; bootstrap 95% CI: ${comparison.bootstrap95 ? `${format(comparison.bootstrap95.lowMs)} to ${format(comparison.bootstrap95.highMs)}` : 'unavailable'}; Fluent wins: ${comparison.fluentWins}.`,
    `All trials: ${outcomeCount('success')} successes, ${outcomeCount('failure')} failures, ${outcomeCount('timeout')} timeouts. Human approval/review time is intentionally excluded from latency and must be reported separately.`,
    ''
  ].join('\n');
}
