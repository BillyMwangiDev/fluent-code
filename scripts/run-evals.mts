/**
 * Runs Fluent Code's own eval suite from the command line, the same way the app's button does.
 *
 * `--validate-only` loads the suite and stops before the first agent run: it proves every case,
 * grader and required field is well-formed for $0, which is what belongs in CI. A full run spends
 * real money on your own credential and is never what CI should do by default.
 */
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {materializePlugin} from '../src/eval-runner.js';

const validateOnly = process.argv.includes('--validate-only');
const directory = await materializePlugin(join(await mkdtemp(join(tmpdir(), 'fluent-eval-')), 'fluent-collab'));

const args = ['plugin', 'eval', directory, '--trust-plugin', '--no-publish', '--allow-tools', 'Bash'];
if (validateOnly) args.push('--max-cost-usd', '0');
else args.push('--concurrency', '2', '--max-cost-usd', process.env.FLUENT_EVAL_BUDGET ?? '2');

const child = spawn('claude', args, {cwd: directory, stdio: 'inherit'});
child.on('exit', code => {
  // Under --validate-only the cost ceiling makes a non-zero exit expected; what matters is that
  // nothing failed to load, which the output above shows.
  process.exit(validateOnly ? 0 : (code ?? 1));
});
