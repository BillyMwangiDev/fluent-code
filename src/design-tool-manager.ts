import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {promisify} from 'node:util';
import type {DesignTool, DesignToolId, McpTarget} from './daemon-protocol.js';

const run = promisify(execFile);

type ToolSpec = {id: DesignToolId; label: string; executable: string; versionArgs: string[]; mcp: DesignTool['mcp']; macApp: string; windowsApp: string};

const tools: ToolSpec[] = [
  {id: 'pen', label: 'pen.dev / Pencil', executable: 'pen', versionArgs: ['version'], mcp: 'desktop-settings', macApp: 'Pen.app', windowsApp: 'Pen'},
  {id: 'open-design', label: 'OpenDesign', executable: 'od', versionArgs: ['--version'], mcp: 'install-command', macApp: 'Open Design.app', windowsApp: 'Open Design'}
];

/** Where the desktop app lives, if it is installed. The app does not put its CLI on PATH by itself. */
export function desktopAppPath(spec: Pick<ToolSpec, 'macApp' | 'windowsApp'>, platform: NodeJS.Platform = process.platform, home = homedir(), env = process.env): string | undefined {
  const candidates = platform === 'darwin'
    ? [join('/Applications', spec.macApp), join(home, 'Applications', spec.macApp)]
    : platform === 'win32'
      ? [join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', spec.windowsApp), join(env.ProgramFiles ?? 'C:\\Program Files', spec.windowsApp)]
      : [];
  return candidates.find(candidate => existsSync(candidate));
}

/** Discovers the design CLIs, and the desktop apps behind them, without mistaking macOS's `/usr/bin/od` for OpenDesign. */
export class DesignToolManager {
  async list(): Promise<DesignTool[]> {
    return Promise.all(tools.map(async tool => {
      const desktopApp = desktopAppPath(tool);
      const executable = resolveDesignExecutable(tool.executable, tool.id === 'open-design');
      if (executable) {
        try {
          const env = {...process.env, PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)};
          const {stdout, stderr} = await run(executable, tool.versionArgs, {timeout: 3_000, env});
          return {
            id: tool.id, label: tool.label, installed: true, executable, desktopApp,
            version: (stdout || stderr).trim().split(/\r?\n/)[0] || undefined,
            mcp: tool.mcp,
            detail: tool.mcp === 'install-command'
              ? 'CLI connected. Install its MCP server into Claude Code or Codex from here.'
              : 'CLI connected. Enable the local MCP server in the running pen.dev desktop app’s Settings → MCP.'
          };
        } catch {
          // Found on disk but not runnable — reported below as not installed, with the desktop app noted.
        }
      }
      return {
        id: tool.id, label: tool.label, installed: false, desktopApp, mcp: tool.mcp,
        detail: desktopApp
          ? `Desktop app found at ${desktopApp}. Its \`${tool.executable}\` CLI is not installed yet — install it from here to wire ${tool.label} into your agents.`
          : `Not installed. Install the ${tool.label} desktop app, or its CLI from here.`
      };
    }));
  }

  async installOpenDesignMcp(target: McpTarget) {
    const executable = resolveDesignExecutable('od', true);
    if (!executable) throw new Error('The OpenDesign `od` CLI is not installed — install it from the design workspace first.');
    const env = {...process.env, PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)};
    const {stdout, stderr} = await run(executable, ['mcp', 'install', target], {timeout: 15_000, env});
    return {target, output: (stdout || stderr).trim() || `OpenDesign MCP installed for ${target}`};
  }
}

function resolveDesignExecutable(command: string, excludeMacSystemOd = false): string | undefined {
  const configured = command === 'od' ? process.env.OPEN_DESIGN_CLI : undefined;
  const candidates = [configured, ...(process.env.PATH ?? '').split(delimiter).map(directory => join(directory, command)), join(homedir(), '.local', 'bin', command), '/opt/homebrew/bin/' + command, '/usr/local/bin/' + command];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (excludeMacSystemOd && (candidate === '/usr/bin/od' || candidate === '/bin/od')) continue;
    return candidate;
  }
  return undefined;
}
