import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {describe, it} from 'node:test';
import {SessionManager, bracketedPasteMode, initialPromptArgs, pastePayload} from './session-manager.js';

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the lane');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('a lane\'s starting task', () => {
  it('is passed as the CLI\'s own prompt argument', () => {
    assert.deepEqual(initialPromptArgs('claude', 'fix the flaky test'), ['fix the flaky test']);
    assert.deepEqual(initialPromptArgs('codex', '  fix the flaky test \n'), ['fix the flaky test']);
    assert.deepEqual(initialPromptArgs('gemini', 'fix it'), ['--prompt-interactive', 'fix it']);
  });

  it('adds nothing when there is no task', () => {
    assert.deepEqual(initialPromptArgs('claude'), []);
    assert.deepEqual(initialPromptArgs('codex', '   '), []);
  });

  it('cannot be read as an option', () => {
    assert.deepEqual(initialPromptArgs('claude', '--dangerously-skip-permissions'), [' --dangerously-skip-permissions']);
  });
});

describe('injecting context', () => {
  it('follows the CLI turning bracketed paste on and off, including combined mode sequences', () => {
    assert.equal(bracketedPasteMode(false, 'banner\x1b[?2004h'), true);
    assert.equal(bracketedPasteMode(true, '\x1b[?2004l'), false);
    assert.equal(bracketedPasteMode(false, '\x1b[?1004;2004h'), true);
    assert.equal(bracketedPasteMode(false, '\x1b[?2004h then \x1b[?2004l'), false, 'the last toggle wins');
    assert.equal(bracketedPasteMode(true, '\x1b[?25l unrelated modes'), true);
  });

  it('wraps a multi-line brief as one paste', () => {
    assert.equal(pastePayload('line one\nline two', true), '\x1b[200~line one\nline two\x1b[201~');
    assert.equal(pastePayload('plain', false), 'plain');
  });

  it('cannot close the paste early from inside the text', () => {
    assert.equal(pastePayload('before\x1b[201~after', true), '\x1b[200~before[201~after\x1b[201~');
    // A marker nested inside a marker survived a one-pass filter and closed the paste, after which
    // the rest was typed into the lane as keystrokes — here, a submit and a shell command.
    const nested = pastePayload('safe\x1b[20\x1b[201~1~\rrm -rf x\r', true);
    assert.equal(nested.indexOf('\x1b[201~'), nested.length - '\x1b[201~'.length, 'the only paste-end marker is the real one');
    assert.equal(nested.includes('\r'), false);
  });

  it('joins lines when the CLI has no bracketed paste, so a brief is not submitted line by line', () => {
    assert.equal(pastePayload('line one\r\nline two\n\nline three', false), 'line one line two line three');
    assert.equal(pastePayload('tab\there', false), 'tab here');
  });

  it('launches a real terminal with the task, names the lane, and delivers injected context whole', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fluent-inject-'));
    const bin = join(root, 'bin');
    const capture = join(root, 'capture');
    await mkdir(bin);
    // Stands in for a provider CLI: reports how it was launched, enables bracketed paste the way a
    // TUI does, then records every byte it is sent.
    await writeFile(join(bin, 'codex'), [
      '#!/bin/sh',
      'printf "args:%s\\n" "$*"',
      'printf "lane:%s\\n" "$FLUENT_SESSION_ID"',
      'stty raw -echo',
      'printf "\\033[?2004hready\\n"',
      'exec cat > "$FLUENT_TEST_CAPTURE"'
    ].join('\n'));
    await chmod(join(bin, 'codex'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    process.env.FLUENT_TEST_CAPTURE = capture;
    const manager = new SessionManager(join(root, 'state'));
    let sessionId: string | undefined;
    try {
      const summary = await manager.create({provider: 'codex', directory: root, task: 'fix the flaky test'});
      sessionId = summary.id;
      await waitFor(() => manager.get(summary.id).output.includes('ready'));
      const output = manager.get(summary.id).output;
      assert.match(output, /args:fix the flaky test/);
      assert.ok(output.includes(`lane:${summary.id}`), 'the lane can name itself to fluent-coord');

      const result = await manager.inject(summary.id, 'line one\nline two');

      assert.deepEqual(result, {injected: true, submitted: true, bracketedPaste: true});
      await waitFor(async () => (await readFile(capture, 'utf8').catch(() => '')).endsWith('\r'));
      assert.equal(await readFile(capture, 'utf8'), '\x1b[200~line one\nline two\x1b[201~\r');

      // A terminal's reply to a CLI query and a lone keystroke are input, but not a dispatched prompt.
      await manager.send(summary.id, '\x1b[12;1R');
      await manager.send(summary.id, 'x');
      const dispatches = manager.runStore.eventsSince(summary.id).events.filter(event => event.type === 'prompt.dispatch_intended');
      assert.equal(dispatches.length, 1, 'only the Enter that submitted the injected brief is a dispatch');
    } finally {
      if (sessionId) {
        await manager.stop(sessionId);
        await waitFor(() => manager.get(sessionId!).pid === undefined).catch(() => undefined);
      }
      process.env.PATH = previousPath;
      delete process.env.FLUENT_TEST_CAPTURE;
      // Durable writes are coalesced, so a snapshot can still land while this directory is removed.
      await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    }
  });

  it('ends its lanes when the daemon shuts down instead of leaving them running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fluent-shutdown-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    // Ignores the hangup a closing terminal sends, the way Claude Code outlives its PTY.
    await writeFile(join(bin, 'codex'), ['#!/bin/sh', 'trap "" HUP', 'printf "ready\\n"', 'while true; do sleep 1; done'].join('\n'));
    await chmod(join(bin, 'codex'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    const manager = new SessionManager(join(root, 'state'));
    try {
      const summary = await manager.create({provider: 'codex', directory: root});
      await waitFor(() => manager.get(summary.id).output.includes('ready'));
      const pid = manager.get(summary.id).pid!;

      assert.equal(await manager.shutdown(), 1);

      await waitFor(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      });
      assert.equal(manager.get(summary.id).status, 'stopped');
      await assert.rejects(manager.create({provider: 'codex', directory: root}), /shutting down/, 'no lane can start once shutdown has begun');
    } finally {
      process.env.PATH = previousPath;
      // Durable writes are coalesced, so a snapshot can still land while this directory is removed.
      await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    }
  });

  it('refuses a lane that is not running', async () => {
    const manager = new SessionManager(await mkdtemp(join(tmpdir(), 'fluent-inject-state-')));
    await assert.rejects(manager.inject('missing', 'context'), /not accepting input/);
  });
});
