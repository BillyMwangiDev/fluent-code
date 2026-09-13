import {execFile} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {skillContent, skillName} from './collab-skill.js';
import type {EvalCaseResult, EvalPlan, EvalRun} from './daemon-protocol.js';

const run = promisify(execFile);
const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Where the authored eval cases live in this repository. */
export const evalSuiteDirectory = join(packageRoot, 'plugin', skillName, 'evals');

/**
 * Builds a complete plugin directory for the evaluator: the skill exactly as a user would have it
 * installed, plus the authored eval suite.
 *
 * Assembled rather than checked in whole, because `SKILL.md` is generated — it has to name the
 * resolved `fluent-coord` invocation for this machine. Checking in a second copy would let the
 * evaluated skill drift from the installed one, which would make every score a measurement of the
 * wrong thing.
 */
export async function materializePlugin(directory: string) {
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, 'SKILL.md'), skillContent(), 'utf8');
  await cp(evalSuiteDirectory, join(directory, 'evals'), {recursive: true});
  return directory;
}

/** The evaluator's own defaults: three runs per case, and a second no-plugin arm whenever a plugin
 * resolves — which it always does here, since the target is the assembled plugin directory. */
const defaultRunsPerCase = 3;
const ablationArms = 2;

/**
 * How much work a run is about to be, counted before anything is spent.
 *
 * Worth counting separately from cost because cost is the wrong unit on a subscription: a
 * subscription is billed in quota, not dollars, so `--max-cost-usd` never trips and the real
 * question is how much of a five-hour window eighteen agent runs will take.
 */
export async function planEvals(suiteDirectory = evalSuiteDirectory): Promise<EvalPlan> {
  const entries = await readdir(suiteDirectory, {withFileTypes: true}).catch(() => []);
  const cases = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  return {cases, runsPerCase: defaultRunsPerCase, arms: ablationArms, totalRuns: cases.length * defaultRunsPerCase * ablationArms};
}

/**
 * Reads `claude plugin eval --json`. Defensive on purpose: the payload carries a `schemaVersion`
 * and will grow, so anything unrecognized is ignored rather than treated as a failure, and a
 * version this code has not seen is reported rather than silently mis-parsed.
 */
export function parseEvalRun(payload: unknown, reportPath?: string): EvalRun {
  const source = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const object = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  const aggregates = object(source.aggregates);
  const suite = object(source.suite);

  const cases: EvalCaseResult[] = Array.isArray(source.cases) ? source.cases.map(entry => {
    const item = object(entry);
    return {
      name: text(item.name) ?? text(item.case) ?? 'unnamed case',
      score: number(item.score),
      passRate: number(item.passRate ?? item.pass_rate),
      runs: number(item.runs),
      costUsd: number(item.costUsd ?? item.cost_usd),
      // Under with/without ablation this is what the skill was worth on this case.
      delta: typeof item.delta === 'number' ? item.delta : undefined,
      notes: text(item.notes)
    };
  }) : [];

  return {
    schemaVersion: number(source.schemaVersion, 0),
    claudeVersion: text(source.claudeVersion),
    startedAt: text(source.startedAt) ?? new Date().toISOString(),
    durationSeconds: number(source.durationSeconds),
    costUsd: number(source.costUsd),
    partial: source.partial === true,
    ablation: text(suite.ablation),
    threshold: number(suite.threshold, 1),
    casesTotal: number(aggregates.casesTotal, cases.length),
    casesPassed: number(aggregates.casesPassed),
    overallScore: number(aggregates.overallScore),
    overallPassRate: number(aggregates.overallPassRate),
    cases,
    reportPath
  };
}

/**
 * Runs Fluent Code's own eval suite against the collaboration skill.
 *
 * This answers a question the test suite structurally cannot: the tests prove `fluent-coord` works,
 * but not that an agent *uses* it. A skill is a prompt, and the only way to know whether a prompt
 * changes behaviour is to run agents with and without it and score what they did — which is what
 * `claude plugin eval`'s with/without ablation is for.
 *
 * Three things to be plain about. Every run spawns a real `claude` child on the credential Fluent
 * has active, so it is never automatic. What that spends depends on which credential: platform
 * credits and an API key are spent in dollars, where `--max-cost-usd` is a real ceiling, while a
 * subscription is spent in quota, where the ceiling never trips and the honest figure is the run
 * count (see `planEvals`). And it evaluates the Claude side only — Codex has no equivalent
 * harness, so a passing score says the skill works for Claude lanes, not for every lane.
 */
export class EvalRunner {
  private latest?: EvalRun;
  private running = false;
  private readonly stateFile: string;

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.stateFile = join(stateDirectory, 'evals.json');
  }

  async restore() {
    try {
      this.latest = JSON.parse(await readFile(this.stateFile, 'utf8')) as EvalRun;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  last() {
    return this.latest;
  }

  isRunning() {
    return this.running;
  }

  /**
   * `env` is the credential Fluent has active for Claude, resolved by the broker. Without it the
   * evaluator's child processes would quietly use whatever `claude` itself is logged into, which
   * would mean the app says one credential and the run bills another — and it would make it
   * impossible to evaluate on an API key at all.
   */
  async run({maxCostUsd = 2, caseGlob, concurrency = 2, env}: {maxCostUsd?: number; caseGlob?: string; concurrency?: number; env?: Record<string, string>} = {}) {
    if (this.running) throw new Error('An eval run is already in progress');
    this.running = true;
    const workspace = await mkdtemp(join(tmpdir(), 'fluent-eval-'));
    const pluginDirectory = join(workspace, skillName);
    const jsonPath = join(workspace, 'result.json');
    const reportDirectory = join(dirname(this.stateFile), 'eval-reports');
    const reportPath = join(reportDirectory, `${Date.now()}.html`);

    try {
      await materializePlugin(pluginDirectory);
      await mkdir(reportDirectory, {recursive: true});
      const args = [
        'plugin', 'eval', pluginDirectory,
        '--json', jsonPath,
        '--report', reportPath,
        // Local-first, like everything else fluentd records (spec §2 principle 5): the report is a
        // file on this machine, not something published on the user's behalf.
        '--no-publish',
        // The suite's own graders need the agent to be able to try the command it is being graded
        // on; nothing here opts into scaffold scripts or real MCP servers.
        '--allow-tools', 'Bash',
        // This is Fluent Code's own suite, authored in this repository — the assertion is true.
        '--trust-plugin',
        '--max-cost-usd', String(maxCostUsd),
        '--concurrency', String(concurrency)
      ];
      if (caseGlob) args.push('--case', caseGlob);

      // A non-zero exit is expected whenever a case scores below threshold, and a below-threshold
      // score is a result rather than an error — so the JSON is read either way, and only a run
      // that produced no JSON at all counts as a failure.
      await run('claude', args, {timeout: 45 * 60_000, maxBuffer: 16_000_000, env: {...process.env, ...env}}).catch(() => undefined);

      const payload = await readFile(jsonPath, 'utf8').catch(() => undefined);
      if (payload === undefined) throw new Error('The evaluator produced no result — is `claude` installed and logged in?');
      this.latest = parseEvalRun(JSON.parse(payload), reportPath);
      await this.persist();
      return this.latest;
    } finally {
      this.running = false;
      await rm(workspace, {recursive: true, force: true}).catch(() => undefined);
    }
  }

  private async persist() {
    await mkdir(dirname(this.stateFile), {recursive: true});
    const temporary = `${this.stateFile}.tmp`;
    await writeFile(temporary, JSON.stringify(this.latest, null, 2), 'utf8');
    await rename(temporary, this.stateFile);
  }
}
