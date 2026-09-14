import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {ensureClaudeHooks, relayCommand} from './hooks-config.js';
import {coordCommand} from './agent-briefing.js';
import {collaborationMcpAddArgs, coordinationMcpName} from './collab-skill.js';

async function projectWith(settings?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-hooks-'));
  if (settings) {
    await mkdir(join(directory, '.claude'));
    await writeFile(join(directory, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  return directory;
}

async function settingsOf(directory: string) {
  return JSON.parse(await readFile(join(directory, '.claude', 'settings.json'), 'utf8'));
}

describe('Claude Code hook configuration', () => {
  it('replaces Fluent\'s own stale relay entries instead of adding a second one beside them', async () => {
    const stale = 'node "/snapshot/fluent-code/dist/hook-relay.js" SessionStart';
    const directory = await projectWith({
      hooks: {SessionStart: [{hooks: [{type: 'command', command: stale}]}, {hooks: [{type: 'command', command: 'echo users-own-hook'}]}]},
      statusLine: {type: 'command', command: 'node "/snapshot/fluent-code/dist/hook-relay.js" StatusLine'}
    });
    try {
      await ensureClaudeHooks(directory);
      const settings = await settingsOf(directory);
      const commands = settings.hooks.SessionStart.flatMap((entry: {hooks: Array<{command: string}>}) => entry.hooks.map(hook => hook.command));

      assert.deepEqual(commands, ['echo users-own-hook', relayCommand('SessionStart')]);
      assert.equal(settings.statusLine.command, relayCommand('StatusLine'));
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('leaves another tool\'s hook alone even when its script has the same file name', async () => {
    const foreign = 'node /opt/other-tool/hook-relay.js SessionStart';
    const directory = await projectWith({hooks: {SessionStart: [{hooks: [{type: 'command', command: foreign}]}]}});
    try {
      await ensureClaudeHooks(directory);
      const commands = (await settingsOf(directory)).hooks.SessionStart.flatMap((entry: {hooks: Array<{command: string}>}) => entry.hooks.map(hook => hook.command));

      assert.deepEqual(commands, [foreign, relayCommand('SessionStart')]);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('never replaces a status line the user configured', async () => {
    const directory = await projectWith({statusLine: {type: 'command', command: 'my-status-line'}});
    try {
      await ensureClaudeHooks(directory);
      assert.equal((await settingsOf(directory)).statusLine.command, 'my-status-line');
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('is unchanged by a second run', async () => {
    const directory = await projectWith();
    try {
      await ensureClaudeHooks(directory);
      const first = await readFile(join(directory, '.claude', 'settings.json'), 'utf8');
      await ensureClaudeHooks(directory);
      assert.equal(await readFile(join(directory, '.claude', 'settings.json'), 'utf8'), first);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});

describe('running Fluent\'s scripts from the packaged daemon', () => {
  it('runs them with plain node from a checkout', () => {
    assert.match(relayCommand('StatusLine'), /^node "[^"]+hook-relay\.js" StatusLine$/);
  });

  it('runs them through the packaged binary itself, which has no dist folder on disk', () => {
    const packaged = process as NodeJS.Process & {pkg?: unknown};
    packaged.pkg = {};
    try {
      const binary = JSON.stringify(process.execPath);
      assert.ok(relayCommand('StatusLine').startsWith(`PKG_EXECPATH=${binary} ${binary} `));
      if (!coordCommand().startsWith('fluent-coord')) assert.ok(coordCommand().startsWith(`PKG_EXECPATH=${binary} ${binary} `));
      // Each CLI's own env flag carries it to the MCP server it launches, after the server name.
      const pair = `PKG_EXECPATH=${process.execPath}`;
      assert.deepEqual(collaborationMcpAddArgs('claude').slice(0, 8), ['mcp', 'add', '--scope', 'user', coordinationMcpName, '-e', pair, '--']);
      assert.deepEqual(collaborationMcpAddArgs('codex').slice(0, 6), ['mcp', 'add', coordinationMcpName, '--env', pair, '--']);
    } finally {
      delete packaged.pkg;
    }
  });
});
