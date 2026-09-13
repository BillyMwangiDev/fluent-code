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
};

export type MarketplaceEntry = {name: string; target: ProviderId; source: string};

export type McpServerEntry = {
  name: string;
  target: ProviderId;
  transport: string;
  command?: string;
  url?: string;
  connected?: boolean;
  needsAuth?: boolean;
};

type ClaudeInstalledPlugin = {id: string; version?: string; enabled: boolean};
type ClaudeMarketplace = {name: string; source: string; repo?: string; path?: string};
type MarketplaceManifestPlugin = {name: string; description?: string; category?: string; homepage?: string};
type MarketplaceManifest = {plugins?: MarketplaceManifestPlugin[]};

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
          version: installedEntry?.version
        });
      }
    })
  );
  // A plugin installed from a source without a locally-readable manifest (e.g. a directory
  // marketplace whose file layout differs) still belongs in the list — it's already installed.
  for (const plugin of installed) {
    if (seenIds.has(plugin.id)) continue;
    const [name, marketplace] = plugin.id.split('@');
    catalog.push({id: plugin.id, name: name ?? plugin.id, marketplace: marketplace ?? 'unknown', target: 'claude', installed: true, enabled: plugin.enabled, version: plugin.version});
  }
  return catalog.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
}

export async function claudeMarketplaceList(): Promise<MarketplaceEntry[]> {
  const marketplaces = await claudeMarketplaces();
  return marketplaces.map(marketplace => ({name: marketplace.name, target: 'claude', source: marketplace.repo ?? marketplace.path ?? marketplace.source}));
}

type CodexPluginEntry = {pluginId: string; name: string; marketplaceName: string; version?: string; installed: boolean; enabled?: boolean};
type CodexPluginListResult = {installed: CodexPluginEntry[]; available: CodexPluginEntry[]};

/** Codex's `plugin list --json` already merges installed + available in one call — no manifest
 * file reading needed. `available` can come back empty even when the CLI's own plain-text output
 * shows a large remote catalog (observed on codex-cli 0.154.0); this surfaces what the JSON
 * contract actually returns rather than parsing the text table to compensate. */
export async function codexPlugins(): Promise<CatalogPlugin[]> {
  try {
    const {stdout} = await run('codex', ['plugin', 'list', '--json'], {timeout: 15_000});
    const result = JSON.parse(stdout) as CodexPluginListResult;
    const toEntry = (entry: CodexPluginEntry, installed: boolean): CatalogPlugin => ({
      id: entry.pluginId,
      name: entry.name,
      marketplace: entry.marketplaceName,
      target: 'codex',
      installed,
      enabled: entry.enabled,
      version: entry.version
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
  const [cli, args] = target === 'claude' ? ['claude', ['plugin', 'install', pluginId]] : ['codex', ['plugin', 'add', pluginId]];
  try {
    const {stdout, stderr} = await run(cli as string, args as string[], {timeout: 120_000});
    return {ok: true, output: (stdout + stderr).trim()};
  } catch (error) {
    return {ok: false, output: error instanceof Error ? error.message : String(error)};
  }
}

export async function addMarketplace(target: ProviderId, source: string): Promise<{ok: boolean; output: string}> {
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
      url: server.url
    }));
  } catch {
    return [];
  }
}

type CodexMcpEntry = {name: string; enabled: boolean; disabled_reason: string | null; transport: {type: string; command?: string; url?: string}};

async function codexMcpServers(): Promise<McpServerEntry[]> {
  try {
    const {stdout} = await run('codex', ['mcp', 'list', '--json'], {timeout: 8_000});
    const entries = JSON.parse(stdout) as CodexMcpEntry[];
    return entries.map(entry => ({
      name: entry.name,
      target: 'codex' as ProviderId,
      transport: entry.transport.type,
      command: entry.transport.command,
      url: entry.transport.url,
      connected: entry.enabled,
      needsAuth: Boolean(entry.disabled_reason)
    }));
  } catch {
    return [];
  }
}

export async function mcpServers(): Promise<McpServerEntry[]> {
  const [claude, codex] = await Promise.all([claudeMcpServers(), codexMcpServers()]);
  return [...claude, ...codex];
}

export async function addMcpServer(target: ProviderId, name: string, commandOrUrl: string): Promise<{ok: boolean; output: string}> {
  const isUrl = /^https?:\/\//.test(commandOrUrl.trim());
  const args =
    target === 'claude'
      ? isUrl
        ? ['mcp', 'add', '--transport', 'http', name, commandOrUrl]
        : ['mcp', 'add', name, '--', ...commandOrUrl.split(' ')]
      : isUrl
        ? ['mcp', 'add', name, '--url', commandOrUrl]
        : ['mcp', 'add', name, '--', ...commandOrUrl.split(' ')];
  try {
    const {stdout, stderr} = await run(target === 'claude' ? 'claude' : 'codex', args, {timeout: 30_000});
    return {ok: true, output: (stdout + stderr).trim()};
  } catch (error) {
    return {ok: false, output: error instanceof Error ? error.message : String(error)};
  }
}
