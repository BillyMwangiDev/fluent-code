import {execFile} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, dirname, isAbsolute, join} from 'node:path';
import {promisify} from 'node:util';
import type {DesignTool, DesignToolId, McpTarget} from './daemon-protocol.js';

const run = promisify(execFile);

const tools: Array<{id: DesignToolId; label: string; executable: string; versionArgs: string[]; mcp: 'desktop-settings' | 'install-command'}> = [
  {id: 'pen', label: 'pen.dev / Pencil', executable: 'pen', versionArgs: ['version'], mcp: 'desktop-settings'},
  {id: 'open-design', label: 'OpenDesign', executable: 'od', versionArgs: ['--version'], mcp: 'install-command'}
];

/** Discovers the documented design CLIs without treating macOS's `/usr/bin/od` as OpenDesign. */
export class DesignToolManager {
  async list(): Promise<DesignTool[]> {
    return Promise.all(tools.map(async tool => {
      try {
        const executable = resolveDesignExecutable(tool.executable, tool.id === 'open-design');
        const env = {...process.env, PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)};
        const {stdout, stderr} = await run(executable, tool.versionArgs, {timeout: 3_000, env});
        return {
          id: tool.id, label: tool.label, installed: true, executable,
          version: (stdout || stderr).trim().split(/\r?\n/)[0] || undefined,
          mcp: tool.mcp,
          detail: tool.mcp === 'install-command'
            ? 'Install its MCP server into Claude Code or Codex from Fluent.'
            : 'Enable the local MCP server in the running pen.dev desktop app’s Settings → MCP.'
        };
      } catch (error: unknown) {
        return {
          id: tool.id, label: tool.label, installed: false, mcp: tool.mcp,
          detail: tool.id === 'open-design'
            ? 'Not found. Do not use macOS /usr/bin/od; install OpenDesign or set OPEN_DESIGN_CLI to its executable.'
            : 'Not found. Install @pen.dev/cli, then sign in with `pen login`.'
        };
      }
    }));
  }

  async installOpenDesignMcp(target: McpTarget) {
    const executable = resolveDesignExecutable('od', true);
    const env = {...process.env, PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)};
    const {stdout, stderr} = await run(executable, ['mcp', 'install', target], {timeout: 15_000, env});
    return {target, output: (stdout || stderr).trim() || `OpenDesign MCP installed for ${target}`};
  }
}

function resolveDesignExecutable(command: string, excludeMacSystemOd = false): string {
  const configured = command === 'od' ? process.env.OPEN_DESIGN_CLI : undefined;
  const candidates = [configured, ...(process.env.PATH ?? '').split(delimiter).map(directory => join(directory, command)), join(homedir(), '.local', 'bin', command), '/opt/homebrew/bin/' + command];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = isAbsolute(candidate) ? candidate : candidate;
    if (!existsSync(resolved)) continue;
    if (excludeMacSystemOd && resolved === '/usr/bin/od') continue;
    return resolved;
  }
  throw new Error(`${command} is not installed`);
}
