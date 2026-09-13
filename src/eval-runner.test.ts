import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {after, describe, it} from 'node:test';
import {evalSuiteDirectory, materializePlugin, parseEvalRun} from './eval-runner.js';
import {skillContent} from './collab-skill.js';

const run = promisify(execFile);
const directories: string[] = [];

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-eval-test-'));
  directories.push(directory);
  return directory;
}

const claudeInstalled = await run('claude', ['--version']).then(() => true, () => false);

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('assembling the plugin under test', () => {
  it('pairs the generated skill with the authored suite', async () => {
    const directory = await materializePlugin(join(await scratch(), 'fluent-collab'));

    assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), skillContent(), 'the evaluated skill must be byte-identical to the installed one, or the score measures the wrong thing');
    assert.ok((await readdir(join(directory, 'evals'))).includes('claims-before-editing'));
  });

  it('has a grader on every authored case', async () => {
    for (const name of await readdir(evalSuiteDirectory)) {
      const graders = await readdir(join(evalSuiteDirectory, name, 'graders'));
      assert.ok(graders.length > 0, `${name} has no graders, so it cannot score anything`);
      const prompt = await readFile(join(evalSuiteDirectory, name, 'prompt.md'), 'utf8');
      assert.doesNotMatch(prompt, /TODO: describe/, `${name} is still the blank template`);
    }
  });
});

describe('the authored suite loads in the real evaluator', {skip: claudeInstalled ? false : 'claude is not installed here'}, () => {
  it('resolves the plugin and every case without spending anything', async () => {
    // `--max-cost-usd 0` aborts before the first agent run launches, so this validates the whole
    // suite — frontmatter, grader types, required fields — for $0 and no model calls.
    const directory = await materializePlugin(join(await scratch(), 'fluent-collab'));
    const {stdout, stderr} = await run('claude', [
      'plugin', 'eval', directory, '--trust-plugin', '--no-publish', '--allow-tools', 'Bash', '--max-cost-usd', '0'
    ], {cwd: directory, timeout: 180_000, maxBuffer: 8_000_000}).catch((error: {stdout?: string; stderr?: string}) => ({stdout: error.stdout ?? '', stderr: error.stderr ?? ''}));
    const output = `${stdout}${stderr}`;

    assert.match(output, /Plugin under test: "fluent-collab"/);
    assert.doesNotMatch(output, /invalid case\.yaml/, 'a malformed case must fail here rather than after someone has paid for a run');
    assert.doesNotMatch(output, /failed to load/);
    assert.doesNotMatch(output, /not granted/, 'the runner passes --allow-tools Bash; the suite must not need more than that');
    assert.match(output, /\$0\.00/);
  });
});

describe('reading a run', () => {
  // The envelope below is the real shape `claude plugin eval --json` wrote on this machine
  // (schemaVersion 1, Claude Code 2.1.270).
  const envelope = {
    schemaVersion: 1,
    claudeVersion: '2.1.270',
    startedAt: '2026-09-13T11:21:56.755Z',
    durationSeconds: 42,
    costUsd: 0.37,
    partial: false,
    suite: {root: '/tmp/x', ablation: 'with-without', threshold: 1, concurrency: 2, plugins: []},
    cases: [
      {name: 'claims-before-editing', score: 1, passRate: 1, runs: 3, costUsd: 0.12, delta: 0.66},
      {name: 'respects-a-refusal', score: 0.5, passRate: 0.33, runs: 3, costUsd: 0.13, delta: 0.5, notes: 'one run edited anyway'}
    ],
    aggregates: {casesTotal: 2, casesPassed: 1, overallScore: 0.75, overallPassRate: 0.66}
  };

  it('reads the envelope and the per-case scores', () => {
    const result = parseEvalRun(envelope, '/tmp/report.html');

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.claudeVersion, '2.1.270');
    assert.equal(result.ablation, 'with-without');
    assert.equal(result.casesPassed, 1);
    assert.equal(result.overallScore, 0.75);
    assert.equal(result.reportPath, '/tmp/report.html');
    assert.equal(result.cases[1]?.name, 'respects-a-refusal');
    assert.equal(result.cases[1]?.delta, 0.5, 'the delta is what the skill was worth on that case');
    assert.equal(result.cases[1]?.notes, 'one run edited anyway');
  });

  it('keeps a partial run marked partial rather than reporting it as a result', () => {
    assert.equal(parseEvalRun({...envelope, partial: true}).partial, true);
  });

  it('survives a payload from a newer schema without inventing numbers', () => {
    const result = parseEvalRun({schemaVersion: 99, cases: [{name: 'x', somethingNew: true}], aggregates: {}});

    assert.equal(result.schemaVersion, 99, 'the version is reported so a mismatch is visible rather than silent');
    assert.equal(result.cases[0]?.name, 'x');
    assert.equal(result.cases[0]?.score, 0);
    assert.equal(result.cases[0]?.delta, undefined, 'an absent delta is unknown, not zero');
  });

  it('does not fall over on an empty or malformed payload', () => {
    assert.equal(parseEvalRun({}).casesTotal, 0);
    assert.equal(parseEvalRun(null).cases.length, 0);
    assert.equal(parseEvalRun('nonsense').casesTotal, 0);
  });

  it('counts cases itself when the aggregate does not say', () => {
    assert.equal(parseEvalRun({cases: [{name: 'a'}, {name: 'b'}]}).casesTotal, 2);
  });
});
