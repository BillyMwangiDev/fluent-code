import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
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
  /** Safe-to-display marketplace source; credentials/query values are redacted. */
  source: string;
  trust: ExtensionTrust;
};

export type ExtensionTrustLevel = 'provider-bundled' | 'provider-owned' | 'local' | 'third-party' | 'unverified';
/** Provenance and boundary facts Fluent can establish. This is not a plugin permission manifest
 * or a claim that an extension is safe. */
export type ExtensionTrust = {
  level: ExtensionTrustLevel;
  source: string;
  reviewRequired: boolean;
  disclosures: string[];
};

export type MarketplaceEntry = {name: string; target: ProviderId; source: string; trust: ExtensionTrust};

export type McpServerEntry = {
  name: string;
  target: ProviderId;
  transport: McpTransport;
  /** Safe display values preserve structure without returning URL credentials or secret-like args. */
  displayCommand?: string;
  displayArgs?: string[];
  displayUrl?: string;
  trust: ExtensionTrust;
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

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function redactArgument(value: string) {
  const assignment = value.match(/^((?:--)?(?:api[-_]?key|token|secret|password|authorization)[^=]*=).+$/i)
    ?? value.match(/^([^=]*(?:token|secret|password|api[-_]?key)[^=]*=).+$/i);
  if (assignment) return `${assignment[1]}<redacted>`;
  if (/^(?:bearer|basic)\s/i.test(value) || /^(?:sk-|gh[pousr]_?|AIza)/.test(value)) return '<redacted>';
  return redactUrl(value);
}

function githubOwner(source: string) {
  const direct = source.match(/^([^/\s]+)\//)?.[1];
  const url = source.match(/github\.com[:/]([^/\s]+)\//i)?.[1];
  return (url ?? direct)?.toLowerCase();
}

function trust(level: ExtensionTrustLevel, source: string, disclosures: string[]): ExtensionTrust {
  return {level, source: redactUrl(source), reviewRequired: level !== 'provider-bundled', disclosures};
}

function localSourceTrust(source: string) {
  return trust('local', source, ['Reads extension code from this local filesystem source.', 'Review code before the provider runs or installs it.']);
}

function githubSourceTrust(source: string, providerOrg?: string) {
  if (providerOrg && githubOwner(source) === providerOrg) {
    return trust('provider-owned', source, [`Source is under the ${providerOrg} GitHub organization.`, 'Provider plugin behavior still belongs to the provider runtime.']);
  }
  return trust('third-party', source, ['Provider fetches or installs code from this third-party source.', 'Review source and manifest before use.']);
}

function unknownSourceTrust(source: string, disclosure = 'Fluent could not verify the marketplace source reported by the provider.') {
  return trust('unverified', source, [disclosure, 'Review source and manifest before use.']);
}

function claudeMarketplaceTrust(marketplace: ClaudeMarketplace): ExtensionTrust {
  if (marketplace.path) return localSourceTrust(marketplace.path);
  if (marketplace.repo) return githubSourceTrust(marketplace.repo, 'anthropics');
  if (/^https?:\/\//.test(marketplace.source)) return unknownSourceTrust(marketplace.source);
  return githubSourceTrust(marketplace.source);
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
      const sourceTrust = claudeMarketplaceTrust(marketplace);
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
          source: sourceTrust.source,
          trust: sourceTrust
        });
      }
    })
  );
  // A plugin installed from a source without a locally-readable manifest (e.g. a directory
  // marketplace whose file layout differs) still belongs in the list — it's already installed.
  for (const plugin of installed) {
    if (seenIds.has(plugin.id)) continue;
    const [name, marketplaceName] = plugin.id.split('@');
    const marketplace = marketplaces.find(candidate => candidate.name === marketplaceName);
    const sourceTrust = marketplace ? claudeMarketplaceTrust(marketplace) : unknownSourceTrust(`Claude marketplace ${marketplaceName ?? 'unknown'}`);
    catalog.push({
      id: plugin.id,
      name: name ?? plugin.id,
      marketplace: marketplaceName ?? 'unknown',
      target: 'claude',
      installed: true,
      enabled: plugin.enabled,
      version: plugin.version,
      source: sourceTrust.source,
      trust: sourceTrust
    });
  }
  return catalog.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
}

export async function claudeMarketplaceList(): Promise<MarketplaceEntry[]> {
  const marketplaces = await claudeMarketplaces();
  return marketplaces.map(marketplace => {
    const sourceTrust = claudeMarketplaceTrust(marketplace);
    return {name: marketplace.name, target: 'claude', source: sourceTrust.source, trust: sourceTrust};
  });
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

/** Codex does not expose an authoritative marketplace trust flag. A catalog with no source is
 * bundled by the CLI; local paths and GitHub organization strings are reported as those factual
 * sources, not upgraded to a blanket safety or provider-maintenance claim. */
function codexMarketplaceTrust(entry: CodexMarketplace): ExtensionTrust {
  const src = entry.marketplaceSource;
  if (!src) {
    return trust('provider-bundled', 'Codex bundled marketplace', ['Catalog is bundled with the Codex CLI.']);
  }
  const source = src.source ?? entry.root ?? `Codex marketplace ${entry.name}`;
  if (src.sourceType === 'local' || isAbsolute(source)) return localSourceTrust(source);
  if (/github\.com[:/]/i.test(source)) return githubSourceTrust(source, 'openai');
  if (/^https?:\/\//.test(source)) return unknownSourceTrust(source);
  return unknownSourceTrust(source);
}

export async function codexMarketplaceList(): Promise<MarketplaceEntry[]> {
  const marketplaces = await codexMarketplaces();
  return marketplaces.map(marketplace => {
    const sourceTrust = codexMarketplaceTrust(marketplace);
    return {name: marketplace.name, target: 'codex', source: sourceTrust.source, trust: sourceTrust};
  });
}

export async function allMarketplaces(): Promise<MarketplaceEntry[]> {
  const [claude, codex] = await Promise.all([claudeMarketplaceList(), codexMarketplaceList()]);
  return [...claude, ...codex].sort((left, right) => left.target.localeCompare(right.target) || left.name.localeCompare(right.name));
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
    const trustByMarketplace = new Map(marketplaces.map(entry => [entry.name, codexMarketplaceTrust(entry)]));
    const result = JSON.parse(stdout) as CodexPluginListResult;
    const toEntry = (entry: CodexPluginEntry, installed: boolean): CatalogPlugin => ({
      id: entry.pluginId,
      name: entry.name,
      marketplace: entry.marketplaceName,
      target: 'codex',
      installed,
      enabled: entry.enabled,
      version: entry.version,
      // CLI list endpoints sometimes disagree on names (for example, openai-curated versus
      // openai-curated-remote). Do not upgrade that ambiguity to provider provenance: it stays
      // explicitly unverified until Codex reports an exact marketplace match.
      source: (trustByMarketplace.get(entry.marketplaceName) ?? unknownSourceTrust(`Codex marketplace ${entry.marketplaceName}`, 'Codex did not report a matching marketplace source.')).source,
      trust: trustByMarketplace.get(entry.marketplaceName) ?? unknownSourceTrust(`Codex marketplace ${entry.marketplaceName}`, 'Codex did not report a matching marketplace source.')
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

export type ValidatedMarketplaceSource = {source: string; kind: 'local-path' | 'github-repository'};

const githubSegment = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function validGithubRepository(owner: string, repository: string) {
  const repo = repository.endsWith('.git') ? repository.slice(0, -4) : repository;
  return Boolean(owner && repo && githubSegment.test(owner) && githubSegment.test(repo));
}

/**
 * Provider marketplace commands accept a broad range of source strings. Fluent intentionally
 * accepts the two forms its UI promises — an absolute local directory or a GitHub repository —
 * so a value that looks like a CLI flag, shell fragment, credential URL or unrelated network host
 * never reaches a provider command. Relative paths are refused because fluentd's cwd is not a
 * stable user project reference.
 */
export function validateMarketplaceSource(input: string): ValidatedMarketplaceSource {
  const source = input.trim();
  if (!source) throw new Error('A marketplace source is required');
  if (/[\u0000-\u001F\u007F]/.test(source)) throw new Error('Marketplace sources cannot contain control characters');
  if (source.startsWith('-')) throw new Error('Marketplace sources cannot start with a CLI option; use a GitHub repository or absolute local path');
  if (isAbsolute(source)) return {source, kind: 'local-path'};
  if (source.startsWith('./') || source.startsWith('../') || source === '.' || source === '..') {
    throw new Error('Use an absolute local marketplace path; relative paths depend on fluentd’s working directory');
  }

  const direct = source.match(/^([^/]+)\/([^/]+)$/);
  if (direct && validGithubRepository(direct[1]!, direct[2]!)) return {source, kind: 'github-repository'};

  const ssh = source.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh && validGithubRepository(ssh[1]!, ssh[2]!)) return {source, kind: 'github-repository'};

  try {
    const url = new URL(source);
    const segments = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'github.com'
      && !url.port
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && segments.length === 2
      && validGithubRepository(segments[0]!, segments[1]!)
    ) return {source, kind: 'github-repository'};
  } catch {
    // The error below is intentionally stable and explains the supported forms.
  }
  throw new Error('Marketplace sources must be an absolute local path, GitHub owner/repo, https://github.com/owner/repo, or git@github.com:owner/repo.git');
}

export async function addMarketplace(target: ProviderId, source: string): Promise<{ok: boolean; output: string}> {
  if (target === 'gemini') return {ok: false, output: 'Gemini CLI uses portable skills and MCP servers; it does not use the Claude/Codex marketplace format.'};
  const validated = validateMarketplaceSource(source);
  const [cli, args] = target === 'claude' ? ['claude', ['plugin', 'marketplace', 'add', validated.source]] : ['codex', ['plugin', 'marketplace', 'add', validated.source]];
  try {
    const {stdout, stderr} = await run(cli as string, args as string[], {timeout: 30_000});
    return {ok: true, output: (stdout + stderr).trim()};
  } catch (error) {
    return {ok: false, output: error instanceof Error ? error.message : String(error)};
  }
}

// --- MCP servers -----------------------------------------------------------------------

export function mcpTrustForConfig(config: Pick<McpServerConfig, 'transport' | 'command' | 'url'>): ExtensionTrust {
  if (config.transport === 'stdio') {
    const command = redactArgument(config.command?.trim() || 'unknown executable');
    return trust('local', command, ['Launches this local process when the provider uses the server.', 'Its filesystem and network behavior is determined by the process code; review it before use.']);
  }
  const endpoint = redactUrl(config.url?.trim() || 'unknown HTTPS endpoint');
  return trust('unverified', endpoint, ['Connects to this remote HTTPS endpoint; it does not launch a local process.', 'Fluent has not verified the remote endpoint or its behavior.']);
}

function mcpDisplay(config: Pick<McpServerConfig, 'transport' | 'command' | 'args' | 'url'>) {
  return {
    displayCommand: config.command ? redactArgument(config.command) : undefined,
    displayArgs: config.args?.map(redactArgument),
    displayUrl: config.url ? redactUrl(config.url) : undefined,
    trust: mcpTrustForConfig(config)
  };
}

type ClaudeDotJson = {mcpServers?: Record<string, {type?: string; command?: string; url?: string; args?: string[]}>};

async function claudeMcpServers(): Promise<McpServerEntry[]> {
  try {
    const raw = await readFile(join(homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as ClaudeDotJson;
    return Object.entries(parsed.mcpServers ?? {}).map(([name, server]) => ({
      name,
      target: 'claude' as ProviderId,
      transport: server.url ? 'http' : 'stdio',
      ...mcpDisplay({transport: server.url ? 'http' : 'stdio', command: server.command, args: server.args, url: server.url})
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
      ...mcpDisplay({transport: entry.transport.type, command: entry.transport.command, args: entry.transport.args, url: entry.transport.url}),
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
      ...mcpDisplay({transport: server.type ?? (server.command ? 'stdio' : 'http'), command: server.command, args: server.args, url: server.url ?? server.httpUrl})
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
  if (config.transport !== 'stdio' && config.transport !== 'http' && config.transport !== 'sse') throw new Error('MCP transport must be stdio, http, or sse');
  if (config.scope !== undefined && config.scope !== 'user' && config.scope !== 'local' && config.scope !== 'project') throw new Error('MCP scope must be user, local, or project');
  if (config.transport === 'stdio') {
    if (!config.command?.trim()) throw new Error('A stdio MCP server needs an executable');
    if (config.url) throw new Error('A stdio MCP server cannot also have a URL');
  } else if (!/^https:\/\//.test(config.url ?? '')) {
    throw new Error('Remote MCP servers must use an https URL');
  }
  if ((config.args ?? []).some(arg => typeof arg !== 'string')) throw new Error('MCP arguments must be strings');
}

export function mcpCommandArgs(target: ProviderId, config: McpServerConfig) {
  validateMcpConfig(config);
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
