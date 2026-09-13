import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {after, describe, it} from 'node:test';
import {VerificationRunner, discoverCommand, oracleWarnings} from './verification.js';

const run = promisify(execFile);
const directories: string[] = [];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'fluent-verify-'));
  directories.push(root);
  return root;
}

/** A real Git repo, because caching is keyed on the tree Git reports. */
async function repository(command: string) {
  const root = await workspace();
  await run('git', ['-C', root, 'init', '--initial-branch=main']);
  await run('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', root, 'config', 'user.name', 'Test']);
  await writeFile(join(root, 'Makefile'), `test:\n\t${command}\n`);
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, 'commit', '-m', 'fixture']);
  return root;
}

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('command discovery', () => {
  it('prefers an explicitly configured command over anything it could find', async () => {
    const root = await workspace();
    await writeFile(join(root, 'package.json'), JSON.stringify({scripts: {test: 'jest'}}));

    assert.deepEqual(await discoverCommand(root, ' just verify '), {command: 'just verify', source: 'configured'});
  });

  it('prefers verify, then test, then check among package scripts', async () => {
    const root = await workspace();
    await writeFile(join(root, 'package.json'), JSON.stringify({scripts: {check: 'tsc', test: 'node --test', verify: 'make ci'}}));
    assert.equal((await discoverCommand(root))?.command, 'npm run verify');

    const withoutVerify = await workspace();
    await writeFile(join(withoutVerify, 'package.json'), JSON.stringify({scripts: {check: 'tsc', test: 'node --test'}}));
    assert.equal((await discoverCommand(withoutVerify))?.command, 'npm run test');

    const onlyCheck = await workspace();
    await writeFile(join(onlyCheck, 'package.json'), JSON.stringify({scripts: {check: 'tsc'}}));
    assert.equal((await discoverCommand(onlyCheck))?.command, 'npm run check');
  });

  it('runs the script through the package manager the lockfile names', async () => {
    const root = await workspace();
    await writeFile(join(root, 'package.json'), JSON.stringify({scripts: {test: 'node --test'}}));
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    assert.equal((await discoverCommand(root))?.command, 'pnpm test');
  });

  it('falls back to language defaults and Makefile targets', async () => {
    const cargo = await workspace();
    await writeFile(join(cargo, 'Cargo.toml'), '[package]\nname = "x"\n');
    assert.deepEqual(await discoverCommand(cargo), {command: 'cargo test', source: 'cargo'});

    const go = await workspace();
    await writeFile(join(go, 'go.mod'), 'module x\n');
    assert.deepEqual(await discoverCommand(go), {command: 'go test ./...', source: 'go'});

    const make = await workspace();
    await writeFile(join(make, 'Makefile'), 'build:\n\techo build\ncheck:\n\techo check\n');
    assert.deepEqual(await discoverCommand(make), {command: 'make check', source: 'makefile'});
  });

  it('reports nothing rather than inventing a check for a project that has none', async () => {
    assert.equal(await discoverCommand(await workspace()), undefined);
  });
});

describe('oracle warnings', () => {
  it('flags a pass that rests partly on tests the lane itself changed', () => {
    const warnings = oracleWarnings(['src/coordination.ts', 'src/coordination.test.ts'], 'pnpm test');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /include ones it wrote/);
    assert.match(warnings[0]!, /coordination\.test\.ts/);
  });

  it('recognizes test layouts across ecosystems', () => {
    assert.equal(oracleWarnings(['tests/api.py'], 'x').length, 1);
    assert.equal(oracleWarnings(['pkg/thing_test.go'], 'x').length, 1);
    assert.equal(oracleWarnings(['spec/models/user_spec.rb'], 'x').length, 1);
    assert.equal(oracleWarnings(['app/__tests__/button.tsx'], 'x').length, 1);
  });

  it('flags a lane that changed the definition of the command judging it', () => {
    const warnings = oracleWarnings(['package.json'], 'pnpm test');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /defines the verification command/);
  });

  it('says nothing about a change that touches neither', () => {
    assert.deepEqual(oracleWarnings(['src/daemon.ts', 'README.md'], 'pnpm test'), []);
  });
});

describe('running a lane against its own checks', () => {
  it('records a pass with the command it actually ran', async () => {
    const root = await repository('true');
    const runner = new VerificationRunner(await workspace());

    const result = await runner.verify({sessionId: 'lane-a', directory: root});

    assert.equal(result.status, 'passed');
    assert.equal(result.command, 'make test');
    assert.equal(result.source, 'makefile');
    assert.equal(result.exitCode, 0);
    assert.equal(runner.get('lane-a')?.status, 'passed');
  });

  it('records a failure with its exit code and output instead of swallowing it', async () => {
    const root = await repository('sh -c "echo the suite is red >&2; exit 3"');
    const runner = new VerificationRunner(await workspace());

    const result = await runner.verify({sessionId: 'lane-b', directory: root});

    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 2, 'make reports its own exit code for a failed recipe');
    assert.match(result.output, /the suite is red/);
  });

  it('reuses a result for an unchanged tree and re-runs once the tree changes', async () => {
    const root = await repository('true');
    const runner = new VerificationRunner(await workspace());

    const first = await runner.verify({sessionId: 'lane-c', directory: root});
    const cached = await runner.verify({sessionId: 'lane-c', directory: root});
    assert.equal(cached.startedAt, first.startedAt, 'an unchanged tree is not re-run');

    await writeFile(join(root, 'new-file.txt'), 'changed\n');
    const rerun = await runner.verify({sessionId: 'lane-c', directory: root});
    assert.notEqual(rerun.startedAt, first.startedAt, 'a changed tree has to be re-checked');
  });

  it('re-runs on demand even when nothing changed', async () => {
    const root = await repository('true');
    const runner = new VerificationRunner(await workspace());

    const first = await runner.verify({sessionId: 'lane-d', directory: root});
    const forced = await runner.verify({sessionId: 'lane-d', directory: root, force: true});

    assert.notEqual(forced.startedAt, first.startedAt);
  });

  it('reports unavailable for a project with no check, rather than a vacuous pass', async () => {
    const runner = new VerificationRunner(await workspace());

    const result = await runner.verify({sessionId: 'lane-e', directory: await workspace()});

    assert.equal(result.status, 'unavailable');
    assert.equal(result.command, undefined);
    assert.match(result.detail ?? '', /no check/);
  });

  it('honours a per-project command override and clears it again', async () => {
    const root = await repository('false');
    const state = await workspace();
    const runner = new VerificationRunner(state);

    await runner.setCommand(root, 'true');
    assert.equal((await runner.verify({sessionId: 'lane-f', directory: root, project: root})).status, 'passed');

    await runner.setCommand(root, undefined);
    assert.equal(runner.commandFor(root), undefined);
    assert.equal((await runner.verify({sessionId: 'lane-f', directory: root, project: root, force: true})).status, 'failed');
  });

  it('does not bring an interrupted run back as still running', async () => {
    const state = await workspace();
    const root = await repository('true');
    const runner = new VerificationRunner(state);
    await runner.verify({sessionId: 'lane-g', directory: root});
    // Simulate a daemon restart mid-run.
    await runner.setCommand('unrelated', 'noop');
    const stored = runner.get('lane-g')!;
    stored.status = 'running';
    await runner.setCommand('unrelated', undefined);

    const restored = new VerificationRunner(state);
    await restored.restore();

    assert.equal(restored.get('lane-g')?.status, 'unavailable');
  });
});
