import assert from 'node:assert/strict';
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {after, before, describe, it} from 'node:test';
import {daemonRequest} from './daemon-client.js';
import type {SessionSummary} from './daemon-protocol.js';

const run = promisify(execFile);
const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const directories: string[] = [];
let daemon: ChildProcess | undefined;
let project = '';
let laneA: SessionSummary;
let laneB: SessionSummary;

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-coord-'));
  directories.push(directory);
  return directory;
}

/** A stand-in provider CLI: it holds its PTY open so the lane stays running, and does nothing. */
async function fakeProvider() {
  const bin = await scratch();
  const path = join(bin, 'claude');
  await writeFile(path, `#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n`);
  await chmod(path, 0o755);
  return bin;
}

async function waitFor(condition: () => Promise<boolean>, what: string, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await condition().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Runs the real CLI the way an agent would: from inside its own working directory.
 *
 * Deliberately the built `dist/coord-cli.js` rather than the source through tsx — an agent runs
 * the installed binary, and running it from a directory outside this package is exactly the case
 * where a loader resolved relative to the cwd would not be found.
 */
async function coord(cwd: string, ...args: string[]) {
  const result = await run(process.execPath, [join(sourceDirectory, '..', 'dist', 'coord-cli.js'), ...args], {
    cwd,
    env: {...process.env, FLUENT_SOCKET: process.env.FLUENT_SOCKET},
    timeout: 30_000
  });
  return result.stdout.trim();
}

before(async () => {
  // The CLI under test is the built one, so build it here rather than depending on the order
  // someone happened to run scripts in.
  await run('npx', ['tsc', '-p', join(sourceDirectory, '..', 'tsconfig.build.json')], {cwd: join(sourceDirectory, '..'), timeout: 180_000});
  const state = await scratch();
  process.env.FLUENT_SOCKET = join(await scratch(), 'fluent.sock');
  project = await scratch();
  await run('git', ['-C', project, 'init', '--initial-branch=main']);
  await run('git', ['-C', project, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', project, 'config', 'user.name', 'Test']);
  await writeFile(join(project, 'README.md'), '# fixture\n');
  await run('git', ['-C', project, 'add', '-A']);
  await run('git', ['-C', project, 'commit', '-m', 'base']);

  daemon = spawn(process.execPath, ['--import', 'tsx', join(sourceDirectory, 'daemon.ts')], {
    env: {
      ...process.env,
      FLUENT_STATE_DIR: state,
      FLUENT_WORKTREE_DIR: await scratch(),
      PATH: [await fakeProvider(), process.env.PATH].join(delimiter)
    },
    stdio: 'ignore'
  });
  await waitFor(async () => (await daemonRequest<{ok: boolean}>('ping')).ok, 'fluentd to start');

  laneA = await daemonRequest<SessionSummary>('sessions.create', {provider: 'claude', directory: project, isolate: true, task: 'lane A work'});
  laneB = await daemonRequest<SessionSummary>('sessions.create', {provider: 'claude', directory: project, isolate: true, task: 'lane B work'});
  await waitFor(async () => {
    const sessions = await daemonRequest<SessionSummary[]>('sessions.list');
    return sessions.filter(session => session.status === 'running').length === 2;
  }, 'both lanes to be running');
});

after(async () => {
  daemon?.kill('SIGTERM');
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('an agent coordinating from its own working directory', () => {
  it('identifies the lane without being told which one it is', async () => {
    const status = await coord(laneA.directory, 'status');

    assert.match(status, new RegExp(`^lane ${laneA.id.slice(0, 8)} claude `, 'm'));
    assert.match(status, /^conflicts 0$/m);
    assert.match(status, /^cursor [0-9a-f]{12}$/m);
  });

  it('claims paths, and tells the next lane who holds them', async () => {
    assert.equal(await coord(laneA.directory, 'claim', 'src/router.ts'), 'claimed src/router.ts');

    const refused = await coord(laneB.directory, 'claim', 'src/router.ts');

    assert.match(refused, /^refused src\/router\.ts$/m);
    assert.match(refused, new RegExp(`^src/router\\.ts ${laneA.id.slice(0, 8)} same `, 'm'));
    assert.match(refused, /coordinate before editing/);
  });

  it('shows the other lane\'s claim in status', async () => {
    const status = await coord(laneB.directory, 'status');

    assert.match(status, /^claims 1 mine 0$/m);
    assert.match(status, new RegExp(`^src/router\\.ts ${laneA.id.slice(0, 8)} declared$`, 'm'));
  });

  it('answers an unchanged check in one line', async () => {
    const status = await coord(laneA.directory, 'status');
    const cursor = status.split('\n').find(line => line.startsWith('cursor '))!.slice(7);

    assert.equal(await coord(laneA.directory, 'status', '--since', cursor), `unchanged ${cursor}`);
  });

  it('gives a path back', async () => {
    assert.equal(await coord(laneA.directory, 'release', 'src/router.ts'), 'released src/router.ts');
    assert.match(await coord(laneB.directory, 'status'), /^claims 0 mine 0$/m);
  });

  it('shares a task through the board and takes it by short id', async () => {
    const added = await coord(laneA.directory, 'task', 'add', 'Wire the preview panel');
    const id = added.replace('added ', '');

    assert.match(await coord(laneB.directory, 'status'), new RegExp(`^${id} todo - Wire the preview panel$`, 'm'));
    assert.equal(await coord(laneB.directory, 'task', 'start', id), `started ${id}`);
    assert.match(await coord(laneA.directory, 'status'), new RegExp(`^${id} active ${laneB.id.slice(0, 8)} `, 'm'));
  });

  it('records a decision without it becoming a task', async () => {
    assert.equal(await coord(laneA.directory, 'note', 'Chose', 'the', 'existing', 'router'), 'noted');
    const state = await daemonRequest<{decisions: Array<{summary: string; sessionId?: string}>}>('coordination.get', {project});
    assert.equal(state.decisions[0]?.summary, 'Chose the existing router');
    assert.equal(state.decisions[0]?.sessionId, laneA.id);
  });

  it('only proposes a handoff, never imposes one', async () => {
    const reply = await coord(laneA.directory, 'handoff', laneB.id.slice(0, 8), 'please review the router change');

    assert.match(reply, /^proposed handoff to /);
    assert.match(reply, /waiting for the user to accept it/);
    const state = await daemonRequest<{handoffs: Array<{status: string}>}>('coordination.get', {project});
    assert.equal(state.handoffs[0]?.status, 'open', 'the other lane cannot be given work without the user');
  });

  it('refuses to guess when run somewhere no lane is working', async () => {
    await assert.rejects(() => coord(project, 'status'), /No running Fluent lane/);
  });

  it('prints usage rather than failing when asked for help', async () => {
    assert.match(await coord(laneA.directory, 'help'), /fluent-coord status/);
  });
});
