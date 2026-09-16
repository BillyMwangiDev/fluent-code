// --- Design workspace ---------------------------------------------------------
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {offerInstall} from '../install';
import {metricCard, sparklineChart, lineChart} from '../charts';

import {currentProject} from '../project-scope';

export async function renderDesignWorkspace(main: HTMLElement) {
  const sessions = await api.listSessions();
  const project = currentProject(prefs.workspacePath, sessions);
  const [openDesign, openDesignStatus] = await Promise.all([
    api.openDesign().catch(() => ({url: 'http://127.0.0.1:7456', enabled: false})),
    api.openDesignStatus().catch(() => ({url: 'http://127.0.0.1:7456', enabled: false, reachable: false, status: undefined, error: 'fluentd could not check OpenDesign'}))
  ]);
  const designTools = await api.listDesignTools().catch(() => []);
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'design workspace']), h('p', {class: 'section-sub'}, ['OpenDesign is optional and local; Fluent keeps its design-to-build handoff tied to this repository.'])]),
      button('open preview', () => navigate({name: 'preview'}))
    ])
  );
  const endpoint = h('input', {type: 'url', value: openDesign.url, placeholder: 'http://127.0.0.1:7456'});
  const endpointStatus = h('p', {class: openDesignStatus.reachable ? 'success' : 'section-sub'}, [
    openDesignStatus.reachable
      ? `OpenDesign connected · HTTP ${openDesignStatus.status ?? 'ok'}${openDesign.enabled ? ' · embedding enabled' : ' · embedding disabled until you save this origin'}`
      : `OpenDesign is not running at this URL${openDesignStatus.error ? ` · ${openDesignStatus.error}` : ''}`
  ]);
  const connect = h('button', {class: 'btn primary'}, ['connect OpenDesign']);
  connect.addEventListener('click', async () => {
    try { await api.saveOpenDesign(endpoint.value); void refresh(); }
    catch (error: unknown) { endpointStatus.textContent = error instanceof Error ? error.message : 'Could not save OpenDesign URL'; endpointStatus.className = 'error'; }
  });
  main.append(h('div', {class: 'card'}, [
    h('h3', {}, ['OpenDesign connector']),
    endpointStatus,
    h('div', {class: 'field'}, [endpoint, connect]),
    h('p', {class: 'section-sub'}, ['Local loopback only. OpenDesign keeps control of its agents and credentials; Fluent does not proxy design traffic.'])
  ]));
  const toolRows = designTools.map(tool => {
    const status = tool.installed ? `connected CLI${tool.version ? ` · ${tool.version}` : ''}` : tool.desktopApp ? 'desktop app installed · CLI not installed' : 'not installed';
    const row = h('div', {class: 'option-row'}, [
      h('span', {class: tool.installed ? 'label' : 'meta'}, [`● ${tool.label}`]),
      h('span', {class: 'meta'}, [status]),
      h('span', {class: 'section-sub'}, [tool.detail])
    ]);
    if (!tool.installed) {
      const install = h('button', {class: 'btn'}, [tool.desktopApp ? 'install CLI' : `install ${tool.id === 'pen' ? 'CLI' : 'OpenDesign CLI'}`]);
      install.addEventListener('click', () => void offerInstall(tool.id, install, {agent: 'claude', afterInstall: () => refresh()}));
      row.append(install);
    }
    if (tool.id === 'open-design' && tool.installed) {
      for (const target of ['claude', 'codex'] as const) {
        const install = h('button', {class: 'btn'}, [`install MCP for ${target}`]);
        install.addEventListener('click', async () => {
          if (!(await askConfirm({title: `install OpenDesign MCP for ${target}`, body: `OpenDesign will update ${target}'s MCP configuration.`, confirmLabel: 'install'}))) return;
          try { const result = await api.installOpenDesignMcp(target); row.append(h('p', {class: 'success'}, [result.output])); }
          catch (error: unknown) { row.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : 'MCP install failed'])); }
        });
        row.append(install);
      }
    }
    return row;
  });
  main.append(h('div', {class: 'card'}, [
    h('h3', {}, ['design CLI & MCP bridge']),
    ...toolRows,
    h('p', {class: 'section-sub'}, ['MCP setup is explicit: Fluent never alters agent configuration until you confirm an install. pen.dev’s desktop app owns its local MCP toggle; OpenDesign provides the CLI installer.'])
  ]));
  if (openDesignStatus.reachable && openDesign.enabled) {
    const openOpenDesign = h('button', {class: 'btn primary', type: 'button'}, ['open OpenDesign']);
    const openNotice = h('p', {class: 'section-sub'}, ['This saved local origin opens in a separate guarded window. It cannot navigate to another origin or receive Fluent’s desktop privileges.']);
    openOpenDesign.addEventListener('click', async () => {
      openOpenDesign.disabled = true;
      try {
        const origin = await api.openEmbeddedContent('open-design', openDesign.url);
        openNotice.textContent = `OpenDesign is open at ${origin}.`;
        openNotice.className = 'success';
      } catch (error) {
        openNotice.textContent = `OpenDesign could not open: ${actionErrorText(error)}`;
        openNotice.className = 'error';
      } finally {
        openOpenDesign.disabled = false;
      }
    });
    main.append(h('div', {class: 'card'}, [
      h('div', {class: 'toolbar'}, [h('div', {}, [h('h3', {}, ['OpenDesign']), h('p', {class: 'section-sub'}, ['Edit in its guarded local window, then create a repository-bound implementation handoff here.'])]), openOpenDesign]),
      openNotice
    ]));
  }
  if (!project) {
    main.append(h('div', {class: 'empty-state'}, ['Start a session to bind design work and implementation handoffs to a repository.']));
    return;
  }
  const state = await api.coordination(project);
  const designLanes = sessions.filter(session => (session.projectDirectory ?? session.directory) === project && session.status === 'running');
  const title = h('input', {type: 'text', placeholder: 'design task, e.g. credential fallback states'}) as HTMLInputElement;
  const sourceRef = h('input', {type: 'text', value: 'design/pen/fluent-code.pen', placeholder: 'repo-relative source, e.g. design/pen/fluent-code.pen'}) as HTMLInputElement;
  const componentSpec = h('textarea', {placeholder: 'component specification', rows: '2'}) as HTMLTextAreaElement;
  const tokenSpec = h('textarea', {placeholder: 'token and interaction notes', rows: '2'}) as HTMLTextAreaElement;
  const previewUrl = h('input', {type: 'url', placeholder: 'local preview, e.g. http://127.0.0.1:4173'}) as HTMLInputElement;
  const paths = h('textarea', {placeholder: 'intended implementation paths, one per line', rows: '3'}) as HTMLTextAreaElement;
  const owner = h('select', {'aria-label': 'Design handoff owner'}) as HTMLSelectElement;
  owner.append(h('option', {value: ''}, ['assign later — no lane']));
  for (const lane of designLanes) owner.append(h('option', {value: lane.id}, [`${lane.provider} · ${lane.id.slice(0, 8)}`]));
  const reviewer = h('select', {'aria-label': 'Design handoff reviewer'}) as HTMLSelectElement;
  reviewer.append(h('option', {value: ''}, ['no reviewer handoff yet']));
  for (const lane of designLanes) reviewer.append(h('option', {value: lane.id}, [`${lane.provider} · ${lane.id.slice(0, 8)}`]));
  const reservePaths = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const designNotice = h('p', {class: 'section-sub'}, ['Intended paths are not claims. Reserve them only for the selected active lane.']);
  const add = h('button', {class: 'btn primary'}, ['create design task']);
  add.addEventListener('click', async () => {
    if (!title.value.trim()) return title.focus();
    if (reservePaths.checked && !owner.value) {
      designNotice.textContent = 'Choose an active owner before reserving files.';
      designNotice.className = 'error';
      return owner.focus();
    }
    if (reviewer.value && (!owner.value || reviewer.value === owner.value)) {
      designNotice.textContent = 'A reviewer handoff needs a different active owner and reviewer.';
      designNotice.className = 'error';
      return reviewer.focus();
    }
    add.disabled = true;
    try {
      const implementationPaths = paths.value.split(/[,\n]/).map(path => path.trim()).filter(Boolean);
      await api.createTask(project, {
        title: `design: ${title.value.trim()}`,
        role: 'design',
        source: 'manual',
        sessionId: owner.value || undefined,
        designHandoff: {
          sourceRef: sourceRef.value,
          componentSpec: componentSpec.value,
          tokenSpec: tokenSpec.value,
          previewUrl: previewUrl.value,
          implementationPaths
        }
      });
      const claims: string[] = [];
      if (reservePaths.checked && owner.value) {
        for (const path of implementationPaths) {
          const result = await api.claimFile(project, path, owner.value);
          claims.push(result.granted ? `${path} reserved` : `${path} overlaps an existing claim`);
        }
      }
      if (reviewer.value && owner.value) await api.createHandoff(project, owner.value, reviewer.value, `Design review: ${title.value.trim()} (${sourceRef.value.trim() || 'source not recorded'})`);
      designNotice.textContent = [
        'Design task created.',
        claims.length ? claims.join(' · ') : '',
        reviewer.value ? 'Review handoff proposed.' : ''
      ].filter(Boolean).join(' ');
      designNotice.className = 'success';
      void refresh();
    } catch (error: unknown) {
      designNotice.textContent = error instanceof Error ? error.message : 'Could not create design task';
      designNotice.className = 'error';
    } finally {
      add.disabled = false;
    }
  });
  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [
      h('h3', {}, ['design tasks']),
      ...state.tasks.filter(task => task.title.startsWith('design:')).map(task => h('div', {class: 'option-row'}, [
        h('span', {class: 'label'}, [`● ${task.title.slice(8)}`]),
        h('span', {class: 'meta'}, [`${task.status}${task.designHandoff?.sourceRef ? ` · ${task.designHandoff.sourceRef}` : ''}${task.designHandoff?.implementationPaths?.length ? ` · ${task.designHandoff.implementationPaths.length} paths` : ''}`])
      ])),
      h('div', {class: 'field'}, [title, sourceRef, componentSpec, tokenSpec, previewUrl, paths, owner, reviewer, h('label', {class: 'section-sub'}, [reservePaths, ' reserve intended paths for owner']), add, designNotice])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['handoff contract']),
      h('p', {class: 'section-sub'}, ['Each design task records its source, component and token notes, loopback preview, and intended implementation paths. Claims stay advisory and lane-owned.']),
      h('p', {class: 'section-sub'}, [`${state.claims.length} claimed files · ${state.handoffs.filter(handoff => handoff.status === 'open').length} reviews open`])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['source of truth']),
      h('p', {class: 'section-sub'}, ['Fluent design source: design/pen/fluent-code.pen']),
      h('p', {class: 'section-sub'}, [openDesignStatus.reachable ? 'OpenDesign is connected for design work; use Preview to inspect the running local app.' : 'Use Preview to inspect the running local app without leaving Fluent.'])
    ])
  ]));
}
