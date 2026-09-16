import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {delimiter, join} from 'node:path';

/**
 * One-click installs for the CLIs Fluent orchestrates. Every recipe is the vendor's own documented
 * installer, run visibly and only after the user has approved the exact command; Fluent never
 * bundles or patches a provider CLI (CLAUDE.md's one rule). Native installers that need no Node
 * or Homebrew are preferred, so a fresh machine gets Claude Code, Codex and OpenCode with nothing
 * else installed first; the tools that only ship through Homebrew or npm say so plainly.
 */

export type InstallableTool = 'claude' | 'codex' | 'gemini' | 'opencode' | 'gh' | 'open-design' | 'pen';
export type InstallAgent = 'claude' | 'codex';

export type InstallPlan =
  | {tool: InstallableTool; label: string; ready: true; command: string; summary: string; docsUrl: string; alsoConfigures?: string}
  | {tool: InstallableTool; label: string; ready: false; unavailable: string; docsUrl: string};

export type InstallResult = {tool: InstallableTool; ok: boolean; exitCode: number | null; output: string; command: string; durationMs: number};

export type InstallFacts = {platform: NodeJS.Platform; hasBrew: boolean; hasNpm: boolean};

export const installableTools: readonly InstallableTool[] = ['claude', 'codex', 'gemini', 'opencode', 'gh', 'open-design', 'pen'];

const labels: Record<InstallableTool, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', gh: 'GitHub CLI', 'open-design': 'OpenDesign CLI', pen: 'pen.dev CLI'
};

const docs: Record<InstallableTool, string> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://github.com/openai/codex#installing-and-running-codex-cli',
  gemini: 'https://geminicli.com/docs/get-started/installation/',
  opencode: 'https://opencode.ai/docs/',
  gh: 'https://github.com/cli/cli#installation',
  'open-design': 'https://github.com/nexu-io/open-design#readme',
  pen: 'https://pen.dev'
};

/** gh publishes signed release archives; without Homebrew this puts the binary in ~/.local/bin, no sudo. */
const ghFromRelease = [
  'set -eu',
  'version=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n \'s/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p\' | head -n1)',
  '[ -n "$version" ] || { echo "could not read the latest gh release"; exit 1; }',
  'arch=$(uname -m); case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac',
  'tmp=$(mktemp -d); mkdir -p "$HOME/.local/bin"',
  'if [ "$(uname -s)" = Darwin ]; then',
  '  curl -fsSL "https://github.com/cli/cli/releases/download/v$version/gh_${version}_macOS_${arch}.zip" -o "$tmp/gh.zip" && unzip -oq "$tmp/gh.zip" -d "$tmp"',
  'else',
  '  curl -fsSL "https://github.com/cli/cli/releases/download/v$version/gh_${version}_linux_${arch}.tar.gz" | tar -xz -C "$tmp"',
  'fi',
  'cp "$tmp"/gh_*/bin/gh "$HOME/.local/bin/gh" && chmod +x "$HOME/.local/bin/gh" && rm -rf "$tmp"',
  '"$HOME/.local/bin/gh" --version'
].join('\n');

function ready(tool: InstallableTool, command: string, summary: string, extra: {alsoConfigures?: string} = {}): InstallPlan {
  return {tool, label: labels[tool], ready: true, command, summary, docsUrl: docs[tool], ...extra};
}

function unavailable(tool: InstallableTool, reason: string): InstallPlan {
  return {tool, label: labels[tool], ready: false, unavailable: reason, docsUrl: docs[tool]};
}

/** The exact command Fluent would run for this tool on this machine, or why it cannot. */
export function installPlan(tool: InstallableTool, facts: InstallFacts, options: {agent?: InstallAgent} = {}): InstallPlan {
  if (facts.platform === 'win32') {
    if (tool === 'claude') return ready(tool, 'irm https://claude.ai/install.ps1 | iex', 'Anthropic’s native Windows installer; no Node.js needed.');
    return unavailable(tool, 'Windows installs are not automated yet — follow the documentation link.');
  }
  switch (tool) {
    case 'claude':
      return ready(tool, 'curl -fsSL https://claude.ai/install.sh | bash', 'Anthropic’s native installer: a standalone binary in ~/.local/bin that keeps itself updated. No Node.js needed.');
    case 'codex':
      return ready(tool, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'OpenAI’s standalone installer: a prebuilt binary in ~/.local/bin. No Node.js needed.');
    case 'opencode':
      return ready(tool, 'curl -fsSL https://opencode.ai/install | bash', 'OpenCode’s installer picks the binary for this machine and adds it to PATH. No Node.js needed.');
    case 'gemini':
      if (facts.hasBrew) return ready(tool, 'brew install gemini-cli', 'Google ships Gemini CLI through Homebrew and npm only; Homebrew is on this machine.');
      if (facts.hasNpm) return ready(tool, 'npm install -g @google/gemini-cli', 'Google ships Gemini CLI through Homebrew and npm only; npm is on this machine.');
      return unavailable(tool, 'Gemini CLI ships only through Homebrew or npm (Node.js 20+). Install one of those first, then come back here.');
    case 'gh':
      if (facts.hasBrew) return ready(tool, 'brew install gh', 'GitHub’s official CLI through Homebrew; afterwards sign in with `gh auth login`.');
      return ready(tool, ghFromRelease, 'GitHub’s signed release archive, unpacked into ~/.local/bin; afterwards sign in with `gh auth login`.');
    case 'open-design': {
      const agent = options.agent ?? 'claude';
      return ready(tool, `curl -fsSL https://open-design.ai/install.sh | sh -s ${agent}`, 'OpenDesign’s own installer for its `od` CLI and MCP server.', {alsoConfigures: `adds the OpenDesign MCP server to ${agent === 'claude' ? 'Claude Code' : 'Codex'}’s configuration (the installer wires one agent at a time)`});
    }
    case 'pen':
      if (facts.hasNpm) return ready(tool, 'npm install -g @pen.dev/cli', 'pen.dev ships its CLI through npm; npm is on this machine. Sign in afterwards with `pen login`.');
      return unavailable(tool, 'The pen.dev CLI ships through npm only. Install Node.js first, then come back here.');
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

/** Whether `name` resolves on this process's PATH (after the login-shell PATH has been adopted). */
export function hasExecutable(name: string, path = process.env.PATH ?? ''): boolean {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  return path.split(delimiter).some(directory => directory && names.some(candidate => existsSync(join(directory, candidate))));
}

export function installFacts(): InstallFacts {
  return {platform: process.platform, hasBrew: hasExecutable('brew'), hasNpm: hasExecutable('npm')};
}

const outputCap = 64 * 1024;

/** Runs an approved plan to completion. Never interactive: stdin is closed, so an installer that
 * insists on asking fails visibly instead of hanging. */
export function runInstall(plan: Extract<InstallPlan, {ready: true}>, options: {timeoutMs?: number; env?: NodeJS.ProcessEnv} = {}): Promise<InstallResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const [executable, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', plan.command]]
    : ['/bin/sh', ['-c', plan.command]];
  return new Promise(resolve => {
    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-outputCap);
    };
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...(options.env ?? process.env), NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1', TERM: 'dumb'}
    });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      append(Buffer.from(`\nfluent: installer still running after ${Math.round(timeoutMs / 60_000)} minutes; stopped.\n`));
      child.kill('SIGTERM');
    }, timeoutMs);
    const finish = (exitCode: number | null, ok: boolean) => {
      clearTimeout(timer);
      resolve({tool: plan.tool, ok, exitCode, output: output.trim(), command: plan.command, durationMs: Date.now() - startedAt});
    };
    child.on('error', error => {
      append(Buffer.from(`\n${error.message}\n`));
      finish(null, false);
    });
    child.on('close', code => finish(code, code === 0));
  });
}
