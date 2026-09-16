// --- Catalog --------------------------------------------------------------------
// Browse and one-click install Claude Code / Codex skills, plugins, MCP servers — orchestrating
// each CLI's own plugin/marketplace/MCP subcommands rather than reimplementing them (see
// src/catalog-manager.ts). "Favor installing what already exists" applied to the whole agent
// ecosystem, not just provider sessions.
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';

import type {CatalogPlugin, ExtensionSourcePolicyState, ExtensionTrust, MarketplaceEntry, McpServerEntry, McpTransport, ProviderId} from '../api';

function trustLabel(trust: ExtensionTrust) {
  switch (trust.level) {
    case 'provider-bundled': return 'provider bundled';
    case 'provider-owned': return 'provider-owned source';
    case 'local': return 'local source';
    case 'third-party': return 'third-party source';
    case 'unverified': return 'unverified source';
  }
}

function trustPill(trust: ExtensionTrust) {
  return h('span', {class: `pill${trust.reviewRequired ? ' status-default' : ' status-running'}`}, [trustLabel(trust)]);
}

function pluginRow(plugin: CatalogPlugin, onInstall: () => void): HTMLElement {
  const meta = [providerLabel[plugin.target], plugin.marketplace, plugin.version ? `v${plugin.version}` : null, `source: ${plugin.source}`].filter(Boolean).join(' · ');
  const installButton = h('button', {class: `btn${plugin.installed ? '' : ' primary'}`}, [plugin.installed ? 'installed' : 'install']);
  installButton.toggleAttribute('disabled', plugin.installed);
  if (!plugin.installed) installButton.addEventListener('click', onInstall);
  return h('div', {class: 'option-row'}, [
    h('div', {}, [
      h('div', {class: 'label'}, [plugin.name]),
      h('div', {class: 'meta'}, [plugin.description ? `${plugin.description} — ${meta}` : meta]),
      h('div', {class: 'meta'}, [plugin.trust.disclosures[0] ?? 'Review extension source before use.'])
    ]),
    trustPill(plugin.trust),
    installButton
  ]);
}

function mcpServerRow(server: McpServerEntry): HTMLElement {
  const endpoint = server.transport === 'stdio' ? server.displayCommand : server.displayUrl;
  const args = server.displayArgs?.length ? `args: ${JSON.stringify(server.displayArgs)}` : undefined;
  const meta = [providerLabel[server.target], server.transport, endpoint, args].filter(Boolean).join(' · ');
  const status = server.needsAuth
    ? h('span', {class: 'pill status-default'}, ['needs auth'])
    : server.connected === false
      ? h('span', {class: 'pill status-failed'}, ['disabled'])
      : h('span', {class: 'pill status-running'}, ['connected']);
  return h('div', {class: 'option-row'}, [
    h('div', {}, [h('div', {class: 'label'}, [server.name]), h('div', {class: 'meta'}, [meta]), h('div', {class: 'meta'}, [server.trust.disclosures[0] ?? 'Review server source before use.'])]),
    trustPill(server.trust),
    status
  ]);
}

function marketplaceRow(marketplace: MarketplaceEntry, onTrust?: () => void): HTMLElement {
  const trustSource = h('button', {class: 'btn', type: 'button'}, ['trust source']);
  trustSource.disabled = !onTrust;
  if (onTrust) trustSource.addEventListener('click', onTrust);
  return h('div', {class: 'option-row'}, [
    h('div', {}, [
      h('div', {class: 'label'}, [`${providerLabel[marketplace.target]} · ${marketplace.name}`]),
      h('div', {class: 'meta'}, [marketplace.source]),
      h('div', {class: 'meta'}, [marketplace.trust.disclosures[0] ?? 'Review marketplace source before use.'])
    ]),
    trustPill(marketplace.trust),
    trustSource
  ]);
}

export async function renderCatalog(main: HTMLElement) {
  // Plugins and MCP servers live in their own dedicated sections — switched by a tab rather than
  // stacked into one long scroll — so neither crowds the other and the plugin list's own filters
  // don't sit visually on top of the MCP form below it.
  let section: 'plugins' | 'mcp' = 'plugins';
  let targetFilter: ProviderId | 'all' = 'all';
  let installedFilter: 'all' | 'installed' | 'available' = 'all';
  let search = '';
  const container = h('div', {});
  main.append(container);
  container.append(h('div', {class: 'empty-state'}, ['reading installed plugins, marketplaces, and MCP servers…']));

  let plugins: CatalogPlugin[];
  let servers: McpServerEntry[];
  let marketplaces: MarketplaceEntry[];
  let sourcePolicy: ExtensionSourcePolicyState;
  try {
    [plugins, servers, marketplaces, sourcePolicy] = await Promise.all([api.catalogPlugins(), api.catalogMcpServers(), api.catalogMarketplaces(), api.catalogSourcePolicy()]);
  } catch (error) {
    container.innerHTML = '';
    container.append(h('div', {class: 'empty-state'}, [error instanceof Error ? error.message : String(error)]));
    return;
  }

  function drawPlugins(): HTMLElement {
    const wrap = h('div', {});

    // Plugins card: search + target/installed filters over the full merged catalog.
    const pluginsCard = h('div', {class: 'card'});
    pluginsCard.append(h('h3', {}, [`plugins (${plugins.length})`]));

    const targetToggle = h('div', {class: 'segmented'});
    for (const option of ['all', 'claude', 'codex', 'gemini'] as const) {
      const button = h('button', {class: `btn${targetFilter === option ? ' primary' : ''}`}, [option === 'all' ? 'all' : providerLabel[option]]);
      button.addEventListener('click', () => {
        targetFilter = option;
        draw();
      });
      targetToggle.append(button);
    }
    const installedToggle = h('div', {class: 'segmented'});
    for (const option of ['all', 'installed', 'available'] as const) {
      const button = h('button', {class: `btn${installedFilter === option ? ' primary' : ''}`}, [option]);
      button.addEventListener('click', () => {
        installedFilter = option;
        draw();
      });
      installedToggle.append(button);
    }
    const searchInput = h('input', {type: 'text', placeholder: 'search plugins…', value: search});
    searchInput.addEventListener('input', () => {
      search = searchInput.value;
      draw();
    });
    pluginsCard.append(h('div', {class: 'catalog-filter-row'}, [targetToggle, installedToggle]), searchInput);

    const needle = search.trim().toLowerCase();
    const filtered = plugins.filter(plugin => {
      if (targetFilter !== 'all' && plugin.target !== targetFilter) return false;
      if (installedFilter === 'installed' && !plugin.installed) return false;
      if (installedFilter === 'available' && plugin.installed) return false;
      if (!needle) return true;
      return plugin.name.toLowerCase().includes(needle) || (plugin.description ?? '').toLowerCase().includes(needle) || plugin.marketplace.toLowerCase().includes(needle);
    });

    const pluginList = h('div', {class: 'plugin-list'});
    if (filtered.length === 0) {
      pluginList.append(h('p', {class: 'section-sub'}, ['No plugins match.']));
    } else {
      const shown = filtered.slice(0, 200);
      for (const plugin of shown) {
        pluginList.append(
        pluginRow(plugin, async () => {
            const sourceNotice = `${trustLabel(plugin.trust)}: ${plugin.source}. ${plugin.trust.disclosures.join(' ')}`;
            if (!(await askConfirm({title: `install ${plugin.name}`, body: `Install ${plugin.name} for ${providerLabel[plugin.target]}? ${sourceNotice} This runs the provider CLI and may add extension code.`, confirmLabel: 'install'}))) return;
            const result = await api.installCatalogPlugin(plugin.target, plugin.id);
            if (result.ok) {
              plugin.installed = true;
              draw();
            } else {
              showActionError(`Install failed: ${result.output}`);
            }
          })
        );
      }
      if (filtered.length > shown.length) {
        pluginList.append(h('p', {class: 'section-sub'}, [`+${filtered.length - shown.length} more — narrow your search to see them.`]));
      }
    }
    pluginsCard.append(pluginList);
    wrap.append(pluginsCard);

    const policyCard = h('div', {class: 'card'}, [
      h('h3', {}, ['extension source policy']),
      h('p', {class: 'section-sub'}, [sourcePolicy.mode === 'trusted-only'
        ? 'Trusted-only is active: provider-bundled plugins still work, while every other marketplace source and every exact MCP declaration must be listed below in addition to its install approval.'
        : 'Review-each is active: every extension action still requires approval, and trusted sources are retained for a future trusted-only policy.'])
    ]);
    const policyMode = h('select', {'aria-label': 'Extension source policy'}) as HTMLSelectElement;
    policyMode.append(h('option', {value: 'review-each'}, ['review each extension']), h('option', {value: 'trusted-only'}, ['trusted sources only']));
    policyMode.value = sourcePolicy.mode;
    const savePolicy = h('button', {class: 'btn'}, ['save policy']);
    savePolicy.addEventListener('click', async () => {
      savePolicy.disabled = true;
      try {
        sourcePolicy = await api.setCatalogSourcePolicyMode(policyMode.value as ExtensionSourcePolicyState['mode']);
        draw();
      } catch (error) {
        showActionError(`Could not save extension source policy: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        savePolicy.disabled = false;
      }
    });
    const trustedList = h('div', {class: 'plugin-list'});
    if (sourcePolicy.sources.length === 0) {
      trustedList.append(h('p', {class: 'section-sub'}, ['No sources are trusted yet. Trust a configured marketplace below or select “remember this exact declaration” when adding an MCP server.']));
    } else {
      for (const source of sourcePolicy.sources) {
        const remove = h('button', {class: 'btn danger', type: 'button'}, ['remove trust']);
        remove.addEventListener('click', async () => {
          if (!(await askConfirm({title: 'remove trusted source', body: `Remove ${source.source} from the trusted extension allowlist? This does not uninstall anything.`, confirmLabel: 'remove trust', danger: true}))) return;
          remove.disabled = true;
          try {
            sourcePolicy = await api.removeCatalogTrustedSource(source.id);
            draw();
          } catch (error) {
            showActionError(`Could not remove trusted source: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            remove.disabled = false;
          }
        });
        trustedList.append(h('div', {class: 'option-row'}, [h('div', {}, [h('div', {class: 'label'}, [source.kind]), h('div', {class: 'meta'}, [source.source])]), remove]));
      }
    }
    policyCard.append(h('div', {class: 'actions'}, [policyMode, savePolicy]), trustedList);
    wrap.append(policyCard);

    const marketplaceListCard = h('div', {class: 'card'}, [
      h('h3', {}, [`configured marketplaces (${marketplaces.length})`]),
      h('p', {class: 'section-sub'}, ['Source provenance is evidence from the provider configuration, not a permission manifest or safety guarantee.'])
    ]);
    marketplaceListCard.append(...(marketplaces.length ? marketplaces.map(marketplace => marketplaceRow(marketplace, async () => {
      if (!(await askConfirm({title: 'trust marketplace source', body: `Trust ${marketplace.source} for future marketplace plugin installs? This does not install code or bypass the per-install approval.`, confirmLabel: 'trust source'}))) return;
      try {
        sourcePolicy = await api.trustCatalogMarketplaceSource(marketplace.source);
        draw();
      } catch (error) {
        showActionError(`Could not trust marketplace source: ${error instanceof Error ? error.message : String(error)}`);
      }
    })) : [h('p', {class: 'section-sub'}, ['No provider marketplaces were reported.'])]));
    wrap.append(marketplaceListCard);

    // Add-marketplace card — a new marketplace source unlocks more plugins in the list above.
    const marketplaceCard = h('div', {class: 'card'}, [
      h('h3', {}, ['add a marketplace']),
      h('p', {class: 'section-sub'}, ['Use a GitHub repo (owner/repo, HTTPS, or Git SSH) or an absolute local path that publishes a Claude Code or Codex marketplace.'])
    ]);
    const marketplaceTargetSelect = h('select', {}, [h('option', {value: 'claude'}, ['Claude Code']), h('option', {value: 'codex'}, ['Codex'])]);
    const marketplaceSourceInput = h('input', {type: 'text', placeholder: 'owner/repo or path'});
    const trustNewMarketplace = h('input', {type: 'checkbox'}) as HTMLInputElement;
    const trustNewMarketplaceLabel = h('label', {class: 'section-sub'}, [trustNewMarketplace, ' remember this source in the trusted allowlist']);
    const marketplaceAddButton = h('button', {class: 'btn primary'}, ['add']);
    marketplaceAddButton.addEventListener('click', async () => {
      const source = marketplaceSourceInput.value.trim();
      if (!source) return;
      const target = marketplaceTargetSelect.value as ProviderId;
      if (!(await askConfirm({title: 'add marketplace', body: `Add marketplace “${source}” for ${providerLabel[target]}? Fluent will validate the source before the provider CLI is allowed to fetch it. Review any local or third-party code before installing plugins.`, confirmLabel: 'add marketplace'}))) return;
      const result = await api.addCatalogMarketplace(target, source, trustNewMarketplace.checked);
      if (result.ok) {
        [plugins, marketplaces, sourcePolicy] = await Promise.all([api.catalogPlugins(), api.catalogMarketplaces(), api.catalogSourcePolicy()]);
        marketplaceSourceInput.value = '';
        trustNewMarketplace.checked = false;
        draw();
      } else {
        showActionError(`Add marketplace failed: ${result.output}`);
      }
    });
    marketplaceCard.append(h('div', {class: 'marketplace-form'}, [marketplaceTargetSelect, marketplaceSourceInput, marketplaceAddButton]), trustNewMarketplaceLabel);
    wrap.append(marketplaceCard);
    return wrap;
  }

  function drawMcp(): HTMLElement {
    const mcpCard = h('div', {class: 'card'}, [h('h3', {}, [`MCP servers (${servers.length})`])]);
    if (servers.length === 0) {
      mcpCard.append(h('p', {class: 'section-sub'}, ['No MCP servers configured yet.']));
    } else {
      for (const server of servers) mcpCard.append(mcpServerRow(server));
    }
    const mcpTargetSelect = h('select', {}, [h('option', {value: 'all'}, ['all supported agents']), h('option', {value: 'claude'}, ['Claude Code']), h('option', {value: 'codex'}, ['Codex']), h('option', {value: 'gemini'}, ['Gemini CLI'])]);
    const mcpTransportSelect = h('select', {}, [h('option', {value: 'stdio'}, ['stdio']), h('option', {value: 'http'}, ['http']), h('option', {value: 'sse'}, ['sse'])]);
    const mcpNameInput = h('input', {type: 'text', placeholder: 'server name'});
    const mcpCommandInput = h('input', {type: 'text', placeholder: 'executable, or https:// URL'});
    const mcpArgsInput = h('input', {type: 'text', placeholder: 'arguments JSON array (optional)'});
    const trustMcpSource = h('input', {type: 'checkbox'}) as HTMLInputElement;
    const trustMcpSourceLabel = h('label', {class: 'section-sub'}, [trustMcpSource, ' remember this exact declaration in the trusted allowlist']);
    const mcpAddButton = h('button', {class: 'btn primary'}, ['add']);
    mcpAddButton.addEventListener('click', async () => {
      const name = mcpNameInput.value.trim();
      const endpoint = mcpCommandInput.value.trim();
      const transport = mcpTransportSelect.value as McpTransport;
      if (!name || !endpoint) return;
      let args: string[] = [];
      try {
        const parsed = mcpArgsInput.value.trim() ? JSON.parse(mcpArgsInput.value) : [];
        if (!Array.isArray(parsed) || parsed.some(arg => typeof arg !== 'string')) throw new Error();
        args = parsed;
      } catch {
        showActionError('Arguments must be a JSON array of strings, for example ["-y", "@scope/server"].');
        return;
      }
      const selection = mcpTargetSelect.value as ProviderId | 'all';
      const targets: ProviderId[] = selection === 'all' ? ['claude', 'codex', 'gemini'] : [selection];
      const config = transport === 'stdio'
        ? {name, transport, command: endpoint, args, scope: 'user' as const}
        : {name, transport, url: endpoint, scope: 'user' as const};
      const boundary = transport === 'stdio'
        ? `This launches the local process “${endpoint}” with ${args.length} structured argument${args.length === 1 ? '' : 's'} when used by an agent.`
        : 'This connects to a remote HTTPS endpoint when used by an agent; it does not launch a local process.';
      if (!(await askConfirm({title: 'add MCP server', body: `Add MCP server “${name}” for ${targets.map(target => providerLabel[target]).join(', ')}? ${boundary} Review the server source before use.`, confirmLabel: 'add server'}))) return;
      const results = await api.addCatalogMcpServer(targets, config, trustMcpSource.checked);
      const failures = results.filter(result => !result.ok);
      if (failures.length === 0) {
        [servers, sourcePolicy] = await Promise.all([api.catalogMcpServers(), api.catalogSourcePolicy()]);
        trustMcpSource.checked = false;
        draw();
      } else {
        showActionError(`MCP setup failed for ${failures.map(result => `${providerLabel[result.target]}: ${result.output}`).join('\n')}`);
      }
    });
    mcpCard.append(
      h('p', {class: 'section-sub'}, ['Portable MCP servers can be registered at user scope for every installed agent. Native marketplace plugins remain provider-specific.']),
      h('div', {class: 'mcp-form'}, [mcpTargetSelect, mcpTransportSelect, mcpNameInput, mcpCommandInput, mcpArgsInput, mcpAddButton]),
      trustMcpSourceLabel
    );
    return mcpCard;
  }

  function draw() {
    container.innerHTML = '';
    const sectionTabs = h('div', {class: 'segmented catalog-sections'});
    const tabs: Array<{id: 'plugins' | 'mcp'; label: string}> = [
      {id: 'plugins', label: `plugins (${plugins.length})`},
      {id: 'mcp', label: `MCP servers (${servers.length})`}
    ];
    for (const tab of tabs) {
      const button = h('button', {class: `btn${section === tab.id ? ' primary' : ''}`}, [tab.label]);
      button.addEventListener('click', () => {
        section = tab.id;
        draw();
      });
      sectionTabs.append(button);
    }
    container.append(
      h('div', {class: 'toolbar'}, [
        h('div', {}, [
          h('h1', {class: 'section-title'}, [markEl(), 'catalog']),
          h('p', {class: 'section-sub'}, ['browse and install Claude Code / Codex / Gemini skills, plugins, and MCP servers — orchestrated through each CLI\'s own catalog'])
        ])
      ]),
      sectionTabs,
      section === 'plugins' ? drawPlugins() : drawMcp()
    );
  }

  draw();
}
