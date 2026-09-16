// The persistent chrome: a top bar with the project and the two global actions, a rail with
// navigation and the live lanes, and the command palette that reaches everything by keyboard.
import {activeRemoteSocket} from './api';
import {renderInboxButton} from './inbox';
import {openLaunchSheet} from './launch';
import {prefs} from './prefs';
import {currentProject} from './project-scope';
import {navigate, onRouteChange, route, type Route, type RouteName} from './router';
import {store} from './store';
import {button, h, icon, isLive, isMod, kbd, markEl, openMenu, openSheet, pickDirectory, providerShort, sessionName, workspaceFolderName, type IconName} from './ui';

export type Command = {id: string; label: string; hint?: string; keys?: string; run: () => void};

const navItems: Array<{name: RouteName; label: string; icon: IconName; group: 'work' | 'control' | 'tools'}> = [
  {name: 'orchestration', label: 'orchestrate', icon: 'grid', group: 'work'},
  {name: 'sessions', label: 'sessions', icon: 'list', group: 'work'},
  {name: 'remote', label: 'remote', icon: 'globe', group: 'work'},
  {name: 'usage', label: 'usage', icon: 'pulse', group: 'control'},
  {name: 'spend', label: 'spend', icon: 'coin', group: 'control'},
  {name: 'source-control', label: 'source control', icon: 'branch', group: 'control'},
  {name: 'credentials', label: 'credentials', icon: 'key', group: 'control'},
  {name: 'catalog', label: 'catalog', icon: 'package', group: 'control'},
  {name: 'design', label: 'design', icon: 'pen', group: 'tools'},
  {name: 'preview', label: 'preview', icon: 'eye', group: 'tools'},
  {name: 'themes', label: 'themes', icon: 'swatch', group: 'tools'}
];

let pageCommands: () => Command[] = () => [];
/** A page contributes its own palette commands while it is mounted. */
export function setPageCommands(provider: () => Command[]) { pageCommands = provider; }

export function startLanes() {
  void openLaunchSheet({directory: prefs.workspacePath, onLaunched: outcome => {
    const created = outcome.created[0];
    if (created) prefs.workspacePath = created.projectDirectory ?? created.directory;
    navigate({name: 'orchestration', focus: outcome.created.length === 1 ? created?.id : undefined});
  }});
}

export function renderTopbar(): HTMLElement {
  const target = activeRemoteSocket()
    ? h('span', {class: 'target-pill'}, ['● remote target'])
    : h('span', {class: 'target-pill local'}, ['● local'])
  // Sessions load asynchronously after this first render, so the label is kept live rather than
  // computed once — otherwise it reads "no workspace selected" even once the workspace strip
  // below already knows better (2026-09-17 audit).
  const projectLabel = h('span', {class: 'topbar-project muted'});
  const syncProject = () => {
    const project = currentProject(prefs.workspacePath, store.sessions);
    projectLabel.textContent = project ? `${workspaceFolderName(project)}  ${project}` : 'no workspace selected';
  };
  syncProject();
  const unsubscribe = store.subscribe(syncProject);
  const palette = button([icon('search'), 'search or run…', kbd('mod K')], () => openPalette(), {class: 'btn ghost topbar-palette', 'aria-label': 'open command palette'});
  const launch = button([icon('plus'), 'agents'], () => startLanes(), {class: 'btn primary small', title: 'start agents (⌘N)'});
  const topbar = h('header', {class: 'topbar'}, [
    projectLabel,
    h('div', {class: 'topbar-actions'}, [renderInboxButton(), palette, launch, target])
  ]);
  // The topbar is rebuilt whole on every route change (main.ts wipes root.innerHTML); release the
  // subscription once this instance leaves the document rather than leak one per navigation.
  const observer = new MutationObserver(() => {
    if (!topbar.isConnected) { unsubscribe(); observer.disconnect(); }
  });
  observer.observe(document.body, {childList: true, subtree: true});
  return topbar;
}

/** Collapses or expands the navigation rail, remembering the choice. Works whether or not a rail is mounted right now. */
export function toggleRail(next = !prefs.railCollapsed) {
  prefs.railCollapsed = next;
  document.querySelector('.app-shell')?.classList.toggle('rail-collapsed', next);
  const rail = document.querySelector<HTMLElement>('.rail');
  rail?.classList.toggle('collapsed', next);
  rail?.dispatchEvent(new CustomEvent('rail-toggle'));
}

export function renderRail(): HTMLElement {
  const collapsed = prefs.railCollapsed;

  // --- Brand + collapse ----------------------------------------------------------------------
  const wordmark = h('span', {class: 'rail-wordmark'}, ['fluent code']);
  const toggle = button(icon('panel-left'), () => toggleRail(), {class: 'btn ghost icon-button rail-toggle', 'aria-label': 'collapse navigation', title: 'collapse navigation (⌘B)'});
  const brandMark = button(markEl(), () => { if (prefs.railCollapsed) toggleRail(false); }, {class: 'rail-mark', 'aria-label': 'expand navigation', title: 'expand navigation (⌘B)'});
  const brand = h('div', {class: 'rail-brand'}, [brandMark, wordmark, toggle]);

  // --- Workspace switcher --------------------------------------------------------------------
  const switchName = h('span', {class: 'rail-switch-name'});
  const switchPath = h('span', {class: 'rail-switch-path'});
  const switcher = button([
    icon('folder'),
    h('span', {class: 'rail-switch-text'}, [switchName, switchPath]),
    h('span', {class: 'rail-switch-chevron'}, [icon('chevron')])
  ], async () => {
    const projects = [...new Set(store.sessions.filter(session => isLive(session) && !session.archivedAt).map(session => session.projectDirectory ?? session.directory))]
      .filter(project => project !== prefs.workspacePath);
    const browse = async () => {
      const selected = await pickDirectory('Choose workspace folder', prefs.workspacePath);
      if (!selected) return;
      prefs.workspacePath = selected;
      navigate({name: 'orchestration'});
    };
    if (projects.length === 0) { await browse(); return; }
    openMenu(switcher, [
      ...projects.map(project => ({label: `${workspaceFolderName(project)}  ${project}`, onSelect: () => { prefs.workspacePath = project; navigate({name: 'orchestration'}); }})),
      'divider',
      {label: 'browse for a folder…', onSelect: () => void browse()}
    ]);
  }, {class: 'rail-switch', title: prefs.workspacePath ? `${prefs.workspacePath}\nswitch workspace` : 'choose a workspace folder'});
  // Sessions load asynchronously after this first render, so the name/path stay live rather than
  // computed once (same fix as the topbar's project label, 2026-09-17 audit).
  const syncSwitcher = () => {
    const railProject = currentProject(prefs.workspacePath, store.sessions);
    switchName.textContent = railProject ? workspaceFolderName(railProject) : 'choose a workspace';
    switchPath.textContent = railProject || 'pick a folder to begin';
  };
  syncSwitcher();
  // Re-synced below alongside drawLanes(), by the same store subscription.

  // --- Navigation ------------------------------------------------------------------------------
  const groups: Record<'work' | 'control' | 'tools', HTMLElement> = {
    work: h('nav', {class: 'rail-group', 'aria-label': 'Workspace'}),
    control: h('nav', {class: 'rail-group', 'aria-label': 'Control plane'}),
    tools: h('nav', {class: 'rail-group', 'aria-label': 'Tools'})
  };
  groups.control.append(h('span', {class: 'rail-label'}, ['control plane']));
  groups.tools.append(h('span', {class: 'rail-label'}, ['tools']));
  const buttons = new Map<RouteName, HTMLButtonElement>();
  const counts = new Map<RouteName, HTMLElement>();
  for (const item of navItems) {
    const count = h('span', {class: 'rail-count'});
    counts.set(item.name, count);
    const element = button([icon(item.icon), h('span', {class: 'rail-item-label'}, [item.label]), count], () => navigate({name: item.name} as Route), {class: 'rail-item', title: item.label});
    buttons.set(item.name, element);
    groups[item.group].append(element);
  }
  const markActive = (current: Route) => {
    for (const [routeName, element] of buttons) {
      const active = current.name === routeName || (routeName === 'sessions' && (current.name === 'active-session' || current.name === 'new-session'));
      element.classList.toggle('active', active);
      if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
    }
  };
  markActive(route());
  const unlistenRoute = onRouteChange(markActive);

  // --- Live lanes ------------------------------------------------------------------------------
  // Every running lane, grouped by project with the main agent first, one click from any route.
  const lanesList = h('div', {class: 'rail-lanes', role: 'list'});
  const lanesLabel = h('span', {class: 'rail-label'}, ['lanes']);
  const drawLanes = () => {
    const live = store.sessions.filter(session => isLive(session) && !session.archivedAt);
    const needsYou = live.filter(lane => store.attention.get(lane.id)?.reason === 'needs-input').length;
    const orchestrateCount = counts.get('orchestration');
    if (orchestrateCount) {
      orchestrateCount.textContent = needsYou ? `${needsYou}!` : live.length ? String(live.length) : '';
      orchestrateCount.classList.toggle('warn', needsYou > 0);
      orchestrateCount.title = needsYou ? `${needsYou} lane${needsYou === 1 ? '' : 's'} waiting on you` : `${live.length} running`;
    }
    const current = prefs.workspacePath.replace(/[\\/]+$/, '');
    const projects = [...new Set(live.map(session => session.projectDirectory ?? session.directory))]
      .sort((a, b) => (a === current ? 0 : 1) - (b === current ? 0 : 1) || a.localeCompare(b));
    lanesLabel.textContent = live.length ? `lanes · ${live.length}` : 'lanes';
    lanesList.innerHTML = '';
    if (live.length === 0) {
      lanesList.append(h('p', {class: 'rail-empty muted'}, ['none running']));
      return;
    }
    let shown = 0;
    for (const project of projects) {
      const lanes = live.filter(session => (session.projectDirectory ?? session.directory) === project);
      const ordered = [...lanes.filter(lane => lane.lead), ...lanes.filter(lane => !lane.lead)];
      const head = button([h('span', {class: 'rail-project-name'}, [workspaceFolderName(project)]), h('span', {class: 'rail-count'}, [String(lanes.length)])], () => {
        prefs.workspacePath = project;
        navigate({name: 'orchestration'});
      }, {class: `rail-item rail-project-row${project === current ? ' active' : ''}`, title: project});
      lanesList.append(head);
      for (const lane of ordered.slice(0, 8)) {
        if (shown >= 14) break;
        shown += 1;
        const attention = store.attention.get(lane.id);
        const row = button([
          h('span', {class: `lane-dot status-${lane.status}${attention ? ' attention' : ''}`}),
          lane.lead ? icon('lead') : null,
          h('span', {class: 'rail-lane-provider'}, [providerShort[lane.provider]]),
          h('span', {class: 'rail-lane-name'}, [sessionName(lane)])
        ], () => {
          if (project !== prefs.workspacePath) prefs.workspacePath = project;
          navigate({name: 'orchestration', focus: lane.id});
        }, {class: `rail-item rail-lane${lane.lead ? ' is-lead' : ''}${lane.parentSessionId ? ' is-sub' : ''}${attention ? ' needs-you' : ''}`, title: `${lane.lead ? 'main agent · ' : lane.parentSessionId ? 'subagent · ' : ''}${providerShort[lane.provider]} · ${sessionName(lane)}${attention ? '\nwaiting on you' : ''}\n${lane.directory}`});
        lanesList.append(row);
      }
      if (ordered.length > 8) lanesList.append(h('p', {class: 'rail-empty muted'}, [`+${ordered.length - 8} more`]));
    }
  };
  const syncRail = () => { syncSwitcher(); drawLanes(); };
  syncRail();
  const unsubscribe = store.subscribe(syncRail);

  // --- Footer ----------------------------------------------------------------------------------
  const target = activeRemoteSocket() ? 'remote daemon' : 'local daemon';
  const footer = h('div', {class: 'rail-footer'}, [h('span', {class: `state-dot ${activeRemoteSocket() ? 'remote' : 'local'}`}), h('span', {class: 'rail-footer-text'}, [target, ' · ', kbd('mod B'), ' rail'])]);

  const rail = h('aside', {class: `rail${collapsed ? ' collapsed' : ''}`, 'aria-label': 'Navigation'}, [
    brand,
    h('div', {class: 'rail-workspace'}, [switcher]),
    h('div', {class: 'rail-scroll'}, [groups.work, h('div', {class: 'rail-group rail-lanes-block'}, [lanesLabel, lanesList]), groups.control, groups.tools]),
    footer
  ]);
  const syncToggle = () => {
    const isCollapsed = rail.classList.contains('collapsed');
    toggle.setAttribute('aria-label', isCollapsed ? 'expand navigation' : 'collapse navigation');
    toggle.title = `${isCollapsed ? 'expand' : 'collapse'} navigation (⌘B)`;
  };
  syncToggle();
  rail.addEventListener('rail-toggle', syncToggle);
  // The rail is rebuilt with every route render; release its store subscription then.
  const observer = new MutationObserver(() => {
    if (!rail.isConnected) { unsubscribe(); unlistenRoute(); observer.disconnect(); }
  });
  observer.observe(document.body, {childList: true, subtree: true});
  return rail;
}

// --- Command palette --------------------------------------------------------------------------------

let paletteOpen = false;

export function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const commands: Command[] = [
    {id: 'launch', label: 'start agents…', hint: 'a main agent with a subagent pool, or one brief to several lanes', keys: 'mod N', run: startLanes},
    ...navItems.map(item => ({id: `go-${item.name}`, label: `go to ${item.label}`, run: () => navigate({name: item.name} as Route)})),
    ...pageCommands(),
    // The workspace lists its own lanes with their positions; elsewhere the palette is the way to
    // reach any running lane.
    ...(route().name === 'orchestration' ? [] : store.sessions.filter(session => isLive(session))).map(session => ({
      id: `lane-${session.id}`,
      label: `focus ${providerShort[session.provider]} · ${sessionName(session)}`,
      hint: session.directory,
      run: () => { prefs.workspacePath = session.projectDirectory ?? session.directory; navigate({name: 'orchestration', focus: session.id}); }
    })),
    {id: 'shortcuts', label: 'keyboard shortcuts', hint: 'everything the keyboard can do here', run: showShortcuts},
    {id: 'rail', label: prefs.railCollapsed ? 'expand navigation' : 'collapse navigation', hint: 'the rail on the left', keys: 'mod B', run: () => toggleRail()},
    {id: 'workspace', label: 'choose workspace folder…', run: async () => {
      const selected = await pickDirectory('Choose workspace folder', prefs.workspacePath);
      if (selected) { prefs.workspacePath = selected; navigate({name: 'orchestration'}); }
    }}
  ];
  const input = h('input', {type: 'text', class: 'palette-input', placeholder: 'type a command, a screen, or a lane', 'aria-label': 'Command'}) as HTMLInputElement;
  const list = h('div', {class: 'palette-list', role: 'listbox'});
  const dialog = h('dialog', {class: 'palette', 'aria-label': 'Command palette'}, [input, list]);
  let selected = 0;
  let visible: Command[] = commands;
  const draw = () => {
    const needle = input.value.trim().toLowerCase();
    visible = commands.filter(command => !needle || `${command.label} ${command.hint ?? ''}`.toLowerCase().includes(needle)).slice(0, 12);
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    list.innerHTML = '';
    if (visible.length === 0) list.append(h('p', {class: 'palette-empty muted'}, ['nothing matches']));
    visible.forEach((command, index) => {
      const row = h('button', {type: 'button', class: `palette-item${index === selected ? ' active' : ''}`, role: 'option', 'aria-selected': index === selected ? 'true' : 'false'}, [
        h('span', {}, [command.label]),
        command.hint ? h('span', {class: 'palette-hint muted'}, [command.hint]) : null,
        command.keys ? kbd(command.keys) : null
      ]);
      row.addEventListener('click', () => { dialog.close(); command.run(); });
      row.addEventListener('mousemove', () => { if (selected !== index) { selected = index; draw(); } });
      list.append(row);
    });
  };
  input.addEventListener('input', () => { selected = 0; draw(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(selected + 1, visible.length - 1); draw(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(selected - 1, 0); draw(); }
    else if (event.key === 'Enter') { event.preventDefault(); const command = visible[selected]; if (command) { dialog.close(); command.run(); } }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); paletteOpen = false; });
  document.body.append(dialog);
  draw();
  dialog.showModal();
  input.focus();
}

export function showShortcuts() {
  const rows: Array<[string, string]> = [
    ['mod K', 'command palette — screens, lanes, and every workspace action'],
    ['mod B', 'collapse or expand the navigation rail'],
    ['mod N', 'start agents'],
    ['mod 1 … 9', 'focus a lane by its position'],
    ['mod ⏎', 'switch between grid and focus'],
    ['mod ⇧L', 'cycle grid → rows → focus'],
    ['mod J', 'show or hide the coordination sidebar'],
    ['mod /', 'jump to the composer'],
    ['⏎ in the composer', 'send to the selected lanes (⇧⏎ adds a line)'],
    ['Esc', 'leave focus mode'],
    ['click a terminal', 'type straight into that lane']
  ];
  openSheet({
    title: 'keyboard shortcuts',
    subtitle: 'the workspace is built to be driven without the mouse',
    body: h('div', {class: 'shortcut-list'}, rows.map(([keys, what]) => h('div', {class: 'shortcut-row'}, [kbd(keys), h('span', {}, [what])])))
  });
}

/** Global shortcuts that work on every route. Page-specific ones are registered by the page. */
export function installGlobalShortcuts() {
  document.addEventListener('keydown', event => {
    if (!isMod(event)) return;
    const key = event.key.toLowerCase();
    if (key !== 'k' && key !== 'b' && !(key === 'n' && !event.shiftKey)) return;
    if (key === 'b' && event.shiftKey) return;
    // Consumed in the capture phase so a focused terminal never sees the keystroke.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === 'k') openPalette(); else if (key === 'b') toggleRail(); else startLanes();
  }, true);
}
