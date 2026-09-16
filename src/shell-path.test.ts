import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {conventionalBinDirectories, loginShellPath, mergePath} from './shell-path.js';

describe('PATH merging', () => {
  it('keeps the inherited entries first, appends the new ones, and drops duplicates and blanks', () => {
    const merged = mergePath('/usr/bin:/bin::/usr/sbin', ['/opt/homebrew/bin', '/usr/bin', '/Users/me/.local/bin', ''], ':');
    assert.equal(merged, '/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/Users/me/.local/bin');
  });

  it('never reorders what was there — a stand-in placed first stays first', () => {
    assert.equal(mergePath('/stand-ins:/usr/bin', ['/Users/me/.local/bin', '/usr/bin'], ':'), '/stand-ins:/usr/bin:/Users/me/.local/bin');
    assert.equal(mergePath('/a:/b', ['/b', '/a'], ':'), '/a:/b');
  });

  it('knows where the common installers put binaries on macOS', () => {
    const dirs = conventionalBinDirectories('/Users/me', 'darwin');
    assert.ok(dirs.includes('/Users/me/.local/bin'), 'native installers (Claude Code, Codex, gh zip) use ~/.local/bin');
    assert.ok(dirs.includes('/opt/homebrew/bin'), 'Apple Silicon Homebrew');
    assert.ok(dirs.includes('/usr/local/bin'), 'Intel Homebrew and npm -g defaults');
  });
});

describe('asking the login shell for its PATH', () => {
  it('reads PATH from a real shell process and ignores anything else the rc files print', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fluent-shell-'));
    try {
      // A stand-in shell: prints a banner (as chatty rc files do), then runs the command with a PATH
      // that a GUI-launched process would never inherit.
      const shell = join(dir, 'fakesh');
      await writeFile(shell, '#!/bin/sh\necho "welcome banner"\nPATH=/from/login/bin:/usr/bin exec /bin/sh -c "$2"\n');
      await chmod(shell, 0o755);
      assert.equal(await loginShellPath(shell), '/from/login/bin:/usr/bin');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('gives up quietly when the shell is missing or hangs', async () => {
    assert.equal(await loginShellPath('/definitely/not/a/shell'), undefined);
    const dir = await mkdtemp(join(tmpdir(), 'fluent-shell-'));
    try {
      const shell = join(dir, 'hangsh');
      await writeFile(shell, '#!/bin/sh\nsleep 30\n');
      await chmod(shell, 0o755);
      assert.equal(await loginShellPath(shell, 300), undefined);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
