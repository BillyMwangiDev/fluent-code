import {hostname, platform, release} from 'node:os';
import {join} from 'node:path';
import {markdownReport, type BenchmarkSample} from '../src/perf/statistics.js';
import {TraceWriter} from '../src/perf/trace.js';
import {writePrivateFile} from '../src/security/secure-state.js';

const output = process.env.FLUENT_BENCHMARK_DIR ?? join(process.cwd(), 'benchmarks', 'results', new Date().toISOString().replaceAll(':', '-'));
const repetitions = Number(process.env.FLUENT_BENCHMARK_REPETITIONS ?? 30);
if (!Number.isInteger(repetitions) || repetitions < 5) throw new Error('FLUENT_BENCHMARK_REPETITIONS must be an integer of at least 5');

// This is deliberately a local control-plane measurement, not a claim about provider latency.
// Provider arms are added only through a registered comparator and explicit budget authorization.
const samples: BenchmarkSample[] = [];
for (let index = 0; index < repetitions; index += 1) {
  const started = performance.now();
  JSON.parse(JSON.stringify({schemaVersion: 1, run: index, event: 'control-plane'}));
  samples.push({id: `control-${index}`, pairId: `control-${index}`, arm: 'fluent', durationMs: performance.now() - started, outcome: 'success'});
}

const trace = new TraceWriter(output);
for (const sample of samples) await trace.sample(sample);
const host = {hostname: hostname(), platform: platform(), release: release(), node: process.version, connection: 'local-process-control'};
const manifest = await trace.finalize({fixture: 'control-plane', comparator: 'local-control-plane-v1', host});
await writePrivateFile(join(output, 'report.md'), markdownReport({title: 'Fluent local control-plane benchmark', samples, host}));
console.log(JSON.stringify({output, manifest, samples: samples.length}, null, 2));
