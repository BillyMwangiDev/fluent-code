import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ProviderId} from './daemon-protocol.js';

const run = promisify(execFile);

/**
 * Fluent should favor installing existing Claude Code / Codex skills, plugins, MCP servers, and
 * hooks over hand-rolling new functionality (spec §2 principle 1, "orchestrate, don't rebuild",
 * extended here from provider sessions to the providers' own extension ecosystems). Both CLIs
 * already have a real plugin/marketplace/MCP system; this module orchestrates them — shelling
 * out to `claude`/`codex`'s own subcommands and reading their own on-disk catalog files (a
 * documented, versioned schema — `$schema: https://anthropic.com/claude-code/marketplace.schema.json`
 * — not a private API) rather than reimplementing any of it.
 */

export type CatalogPlugin = {
  id: string;
  name: string;
  marketplace: string;
  target: ProviderId;
  description?: string;
  category?: string;
  homepage?: string;
  installed: boolean;
  enabled?: boolean;
  version?: string;
  /** Published by the provider's own vendor org (or bundled with the CLI itself), as opposed to
   * an arbitrary marketplace someone added. The daemon-side approval record (README's "extension
   * install" boundary) proves the user said yes; this tells them what they're saying yes *to*. */
  officialSource: boolean;
};

export type MarketplaceEntry = {name: string; target: ProviderId; source: string; officialSource: boolean};

export type McpServerEntry = {
  name: string;
  target: ProviderId;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  connected?: boolean;
  needsAuth?: boolean;
};

/** A structured server declaration is portable. A marketplace plugin is not: plugin formats,
 * trust prompts, and lifecycle all belong to the host runtime. */
export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpServerConfig = {
  name: string;
  transport: McpTransport;
  scope?: 'user' | 'local' | 'project';
  command?: string;
  args?: string[];
  url?: string;
};
export type McpInstallResult = {target: ProviderId; ok: boolean; output: string};

type ClaudeInstalledPlugin = {id: string; version?: string; enabled: boolean};
type ClaudeMarketplace = {name: string; source: string; repo?: string; path?: string};
type MarketplaceManifestPlugin = {name: string; description?: string; category?: string; homepage?: string};
type MarketplaceManifest = {plugins?: MarketplaceManifestPlugin[]};

// Neither CLI's own marketplace listing flags a source as vendor-published, so this is Fluent's
// own heuristic: a GitHub repo under the provider's own org. Anything else — a personal repo, a
// third-party org, or a local directory — is a real trust boundary the catalog should name rather
// than present identically to the provider's own default marketplace.
const OFFICIAL_CLAUDE_ORGS = ['anthropics'];

function isOfficialClaudeRepo(repo: string | undefined): boolean {
  const org = repo?.split('/')[0]?.toLowerCase();
  return org !== undefined && OFFICIAL_CLAUDE_ORGS.includes(org);
}

async function claudeInstalledPlugins(): Promise<ClaudeInstalledPlugin[]> {
  try {
    const {stdout} = await run('claude', ['plugin', 'list', '--json'], {timeout: 8_000});
    return JSON.parse(stdout) as ClaudeInstalledPlugin[];
  } catch {
    return [];
  }
}

async function claudeMarketplaces(): Promise<ClaudeMarketplace[]> {
  try {
    const {stdout} = await run('claude', ['plugin', 'marketplace', 'list', '--json'], {timeout: 8_000});
    return JSON.parse(stdout) as ClaudeMarketplace[];
  } catch {
    return [];
  }
}

async function readMarketplaceManifest(marketplaceName: string): Promise<MarketplaceManifestPlugin[]> {
  const manifestPath = join(homedir(), '.claude', 'plugins', 'marketplaces', marketplaceName, '.claude-plugin', 'marketplace.json');
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as MarketplaceManifest;
    return manifest.plugins ?? [];
  } catch {
    return [];
  }
}

/** The full browsable catalog for Claude Code: every plugin in every configured marketplace,
 * cross-referenced against what's actually installed. */
export async function claudePlugins(): Promise<CatalogPlugin[]> {
  const [installed, marketplaces] = await Promise.all([claudeInstalledPlugins(), claudeMarketplaces()]);
  const installedById = new Map(installed.map(plugin => [plugin.id, plugin]));

  const catalog: CatalogPlugin[] = [];
  const seenIds = new Set<string>();
  await Promise.all(
    marketplaces.map(async marketplace => {
      const plugins = await readMarketplaceManifest(marketplace.name);
      for (const plugin of plugins) {
        const id = `${plugin.name}@${marketplace.name}`;
        seenIds.add(id);
        const installedEntry = installedById.get(id);
        catalog.push({
          id,
          name: plugin.name,
          marketplace: marketplace.name,
          target: 'claude',
          description: plugin.description,
          category: plugin.category,
          homepage: plugin.homepage,
          installed: Boolean(installedEntry),
          enabled: installedEntry?.enabled,
          version: installedEntry?.version,
          officialSource: isOfficialClaudeRepo(marketplace.repo)
        });
      }
    })
  );
  // A plugin installed from a source without a locally-readable manifest (e.g. a directory
  // marketplace whose file layout differs) still belongs in the list — it's already installed.
  for (const plugin of installed) {
    if (seenIds.has(plugin.id)) continue;
    const [name, marketplaceName] = plugin.id.split('@');
    const source = marketplaces.find(candidate => candidate.name === marketplaceName);
    catalog.push({
      id: plugin.id,
      name: name ?? plugin.id,
      marketplace: marketplaceName ?? 'unknown',
      target: 'claude',
      installed: true,
      enabled: plugin.enabled,
      version: plugin.version,
      officialSource: isOfficialClaudeRepo(source?.repo)
    });
  }
  return catalog.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
}

export async function claudeMarketplaceList(): Promise<MarketplaceEntry[]> {
  const marketplaces = await claudeMarketplaces();
  return marketplaces.map(marketplace => ({
    name: marketplace.name,
    target: 'claude',
    source: marketplace.repo ?? marketplace.path ?? marketplace.source,
    officialSource: isOfficialClaudeRepo(marketplace.repo)
  }));
}

type CodexPluginEntry = {pluginId: string; name: string; marketplaceName: string; version?: string; installed: boolean; enabled?: boolean};
type CodexPluginListResult = {installed: CodexPluginEntry[]; available: CodexPluginEntry[]};
type CodexMarketplaceSource = {sourceType?: string; source?: string};
type CodexMarketplace = {name: string; root?: string; marketplaceSource?: CodexMarketplaceSource};
type CodexMarketplaceListResult = {marketplaces?: CodexMarketplace[]};

async function codexMarketplaces(): Promise<CodexMarketplace[]> {
  try {
    const {stdout} = await run('codex', ['plugin', 'marketplace', 'list', '--json'], {timeout: 8_000});
    const result = JSON.parse(stdout) as CodexMarketplaceListResult;
    return result.marketplaces ?? [];
  } catch {
    return [];
  }
}

/** Codex bundles its own default marketplaces under its own managed directories (no separate
 * "official" flag in its JSON output, same gap as Claude's) — a `local` source rooted there, or a
 * git/http source under OpenAI's own org, is the CLI's own catalog rather than something a user
 * (or a third party) pointed it at. */
function isOfficialCodexMarketplace(entry: CodexMarketplace): boolean {
  const src = entry.marketplaceSource;
  if (!src) return true; // openai-curated has no marketplaceSource at all — it's codex's own bundled catalog.
  const path = src.source ?? entry.root ?? '';
  if (src.sourceType === 'local') return path.includes('/.codex/') || path.includes('/.cache/codex-runtimes/');
  const org = path.match(/github\.com[:/]([^/]+)\//i)?.[1]?.toLowerCase();
  return org === 'openai';
}

/** Codex's `plugin list --json` already merges installed + available in one call — no manifest
 * file reading needed. `available` can come back empty even when the CLI's own plain-text output
 * shows a large remote catalog (observed on codex-cli 0.154.0); this surfaces what the JSON
 * contract actually returns rather than parsing the text table to compensate. */
export async function codexPlugins(): Promise<CatalogPlugin[]> {
  try {
    const [{stdout}, marketplaces] = await Promise.all([
      run('codex', ['plugin', 'list', '--json'], {timeout: 15_000}),
      codexMarketplaces()
    ]);
    const officialByMarketplace = new Map(marketplaces.map(entry => [entry.name, isOfficialCodexMarketplace(entry)]));
    const result = JSON.parse(stdout) as CodexPluginListResult;
    const toEntry = (entry: CodexPluginEntry, installed: boolean): CatalogPlugin => ({
      id: entry.pluginId,
      name: entry.name,
      marketplace: entry.marketplaceName,
      target: 'codex',
      installed,
      enabled: entry.enabled,
      version: entry.version,
      // `plugin list` and `plugin marketplace list` don't always agree on a name for the same
      // catalog (observed: "openai-curated" vs. "openai-curated-remote" on codex-cli 0.154.0) —
      // when the exact name isn't in the marketplace list, fall back to Codex's own "openai-"
      // naming convention for every vendor-bundled catalog rather than mislabeling it third-party.
      officialSource: officialByMarketplace.get(entry.marketplaceName) ?? entry.marketplaceName.startsWith('openai-')
    });
    return [...result.installed.map(entry => toEntry(entry, true)), ...result.available.map(entry => toEntry(entry, false))].sort(
      (a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)
    );
  } catch {
    return [];
  }
}

export async function allPlugins(): Promise<CatalogPlugin[]> {
  const [claude, codex] = await Promise.all([claudePlugins(), codexPlugins()]);
  return [...claude, ...codex];
}

export async function installPlugin(target: ProviderId, pluginId: string): Promise<{ok: boolean; output: string}> {
  if (target === 'gemini') return {ok: false, output: 'Gemini CLI uses portable skills and MCP servers; it does not use the Claude/Codex marketplace plugin format.'};
  const [cli, args] = target === 'claude' ? ['claude', ['plugin', 'install', pluginId]] : ['codex', ['plugin', 'add', pluginId]];
  try {
    const {stdout, stderr} = await run(cli as string, args as string[], {timeout: 120_000});
    return {ok: true, output: (stdout + stderr).trim()};
  } catch (error) {
    return {ok: false, output: error instanceof Error ? error.message : String(error)};
  }
}

export async function addMarketplace(target: ProviderId, source: string): Promise<{ok: boolean; output: string}> {
  if (target === 'gemini') return {ok: false, output: 'Gemini CLI uses portable skills and MCP servers; it does not use the Claude/Codex marketplace format.'};
  const [cli, args] = target === 'claude' ? ['claude', ['plugin', 'marketplace', 'add', source]] : ['codex', ['plugin', 'marketplace', 'add', source]];
  try {
    const {stdout, stderr} = await run(cli as string, args as string[], {timeout: 30_000});
    return {ok: true, output: (stdout + stderr).trim()};
  } catch (error) {
    return {ok: false, output: error instanceof Error ? error.message : String(error)};
  }
}

// --- MCP servers -----------------------------------------------------------------------

type ClaudeDotJson = {mcpServers?: Record<string, {type?: string; command?: string; url?: string; args?: string[]}>};

async function claudeMcpServers(): Promise<McpServerEntry[]> {
  try {
    const raw = await readFile(join(homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as ClaudeDotJson;
    return Object.entries(parsed.mcpServers ?? {}).map(([name, server]) => ({
      name,
      target: 'claude' as ProviderId,
      transport: server.url ? 'http' : 'stdio',
      command: server.command,
      args: server.args,
      url: server.url
    }));
  } catch {
    return [];
  }
}

type CodexMcpEntry = {name: string; enabled: boolean; disabled_reason: string | null; transport: {type: McpTransport; command?: string; args?: string[]; url?: string}};

async function codexMcpServers(): Promise<McpServerEntry[]> {
  try {
    const {stdout} = await run('codex', ['mcp', 'list', '--json'], {timeout: 8_000});
    const entries = JSON.parse(stdout) as CodexMcpEntry[];
    return entries.map(entry => ({
      name: entry.name,
      target: 'codex' as ProviderId,
      transport: entry.transport.type,
      command: entry.transport.command,
      args: entry.transport.args,
      url: entry.transport.url,
      connected: entry.enabled,
      needsAuth: Boolean(entry.disabled_reason)
    }));
  } catch {
    return [];
  }
}

type GeminiSettings = {mcpServers?: Record<string, {command?: string; args?: string[]; url?: string; httpUrl?: string; type?: McpTransport}>};

/** Gemini CLI's user-scoped settings are its documented portable MCP registry. Reading this
 * declared config is more stable than scraping the human-oriented `gemini mcp list` table. */
async function geminiMcpServers(): Promise<McpServerEntry[]> {
  try {
    const raw = await readFile(join(homedir(), '.gemini', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as GeminiSettings;
    return Object.entries(parsed.mcpServers ?? {}).map(([name, server]) => ({
      name,
      target: 'gemini' as ProviderId,
      transport: server.type ?? (server.command ? 'stdio' : 'http'),
      command: server.command,
      args: server.args,
      url: server.url ?? server.httpUrl
    }));
  } catch {
    return [];
  }
}

export async function mcpServers(): Promise<McpServerEntry[]> {
  const [claude, codex, gemini] = await Promise.all([claudeMcpServers(), codexMcpServers(), geminiMcpServers()]);
  return [...claude, ...codex, ...gemini];
}

function validateMcpConfig(config: McpServerConfig) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(config.name)) throw new Error('MCP server names may contain only letters, numbers, dot, underscore, and hyphen');
  if (config.transport === 'stdio') {
    if (!config.command?.trim()) throw new Error('A stdio MCP server needs an executable');
    if (config.url) throw new Error('A stdio MCP server cannot also have a URL');
  } else if (!/^https:\/\//.test(config.url ?? '')) {
    throw new Error('Remote MCP servers must use an https URL');
  }
  if ((config.args ?? []).some(arg => typeof arg !== 'string')) throw new Error('MCP arguments must be strings');
}

export function mcpCommandArgs(target: ProviderId, config: McpServerConfig) {
  const scope = config.scope ?? 'user';
  if (target === 'claude') {
    return config.transport === 'stdio'
      ? ['mcp', 'add', '--scope', scope, config.name, '--', config.command!, ...(config.args ?? [])]
      : ['mcp', 'add', '--scope', scope, '--transport', config.transport, config.name, config.url!];
  }
  if (target === 'codex') {
    if (config.transport === 'sse') throw new Error('Codex CLI registration currently supports stdio and HTTP MCP servers; use a Streamable HTTP endpoint instead of SSE.');
    return config.transport === 'stdio'
      ? ['mcp', 'add', config.name, '--', config.command!, ...(config.args ?? [])]
      : ['mcp', 'add', config.name, '--url', config.url!];
  }
  return config.transport === 'stdio'
    ? ['mcp', 'add', '--scope', scope, '--transport', 'stdio', config.name, config.command!, ...(config.args ?? [])]
    : ['mcp', 'add', '--scope', scope, '--transport', config.transport, config.name, config.url!];
}

export async function addMcpServer(target: ProviderId, config: McpServerConfig): Promise<McpInstallResult> {
  validateMcpConfig(config);
  try {
    const {stdout, stderr} = await run(target, mcpCommandArgs(target, config), {timeout: 30_000});
    return {target, ok: true, output: (stdout + stderr).trim()};
  } catch (error) {
    return {target, ok: false, output: error instanceof Error ? error.message : String(error)};
  }
}

/** Install a structured, portable MCP declaration everywhere the user selected. Results are
 * independent so a missing provider CLI never rolls back a host that configured successfully. */
export async function addMcpServerToTargets(targets: readonly ProviderId[], config: McpServerConfig) {
  const unique = [...new Set(targets)];
  if (unique.length === 0) throw new Error('Choose at least one agent runtime');
  return Promise.all(unique.map(target => addMcpServer(target, config)));
}
