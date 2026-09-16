// The persistent chrome: a top bar with the project and the two global actions, a rail with
// navigation and the live lanes, and the command palette that reaches everything by keyboard.
import {activeRemoteSocket} from './api';
import {openLaunchSheet} from './launch';
import {prefs} from './prefs';
import {navigate, onRouteChange, route, type Route, type RouteName} from './router';
import {store} from './store';
import {button, h, icon, isLive, isMod, kbd, markEl, openSheet, pickDirectory, providerShort, sessionName, workspaceFolderName} from './ui';

export type Command = {id: string; label: string; hint?: string; keys?: string; run: () => void};

const navItems: Array<{name: RouteName; label: string; group: 'work' | 'control' | 'tools'}> = [
  {name: 'orchestration', label: 'orchestrate', group: 'work'},
  {name: 'sessions', label: 'sessions', group: 'work'},
  {name: 'remote', label: 'remote', group: 'work'},
  {name: 'usage', label: 'usage', group: 'control'},
  {name: 'spend', label: 'spend', group: 'control'},
  {name: 'source-control', label: 'source control', group: 'control'},
  {name: 'credentials', label: 'credentials', group: 'control'},
  {name: 'catalog', label: 'catalog', group: 'control'},
  {name: 'design', label: 'design', group: 'tools'},
  {name: 'preview', label: 'preview', group: 'tools'},
  {name: 'themes', label: 'themes', group: 'tools'}
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
  const project = prefs.workspacePath;
  const palette = button([icon('search'), 'search or run…', kbd('mod K')], () => openPalette(), {class: 'btn ghost topbar-palette', 'aria-label': 'open command palette'});
  const launch = button([icon('plus'), 'agents'], () => startLanes(), {class: 'btn primary small', title: 'start agents (⌘N)'});
  return h('header', {class: 'topbar'}, [
    h('div', {class: 'brand'}, [markEl(), 'fluent code']),
    h('span', {class: 'topbar-project muted'}, [project ? `${workspaceFolderName(project)}  ${project}` : 'no workspace selected']),
    h('div', {class: 'topbar-actions'}, [palette, launch, target])
  ]);
}

export function renderRail(): HTMLElement {
  const groups: Record<'work' | 'control' | 'tools', HTMLElement> = {
    work: h('nav', {class: 'rail-nav', 'aria-label': 'Workspace'}),
    control: h('nav', {class: 'rail-nav', 'aria-label': 'Control plane'}),
    tools: h('nav', {class: 'rail-nav', 'aria-label': 'Tools'})
  };
  groups.work.append(h('span', {class: 'rail-label'}, ['workspace']));
  groups.control.append(h('span', {class: 'rail-label'}, ['control plane']));
  groups.tools.append(h('span', {class: 'rail-label'}, ['tools']));
  const buttons = new Map<RouteName, HTMLButtonElement>();
  for (const item of navItems) {
    const element = button(item.label, () => navigate({name: item.name} as Route), {class: 'rail-item'});
    buttons.set(item.name, element);
    groups[item.group].append(element);
  }
  const markActive = (current: Route) => {
    for (const [name, element] of buttons) {
      const active = current.name === name || (name === 'sessions' && current.name === 'active-session') || (name === 'sessions' && current.name === 'new-session');
      element.classList.toggle('active', active);
      if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
    }
  };
  markActive(route());
  const unlistenRoute = onRouteChange(markActive);

  const workspaceName = h('strong', {}, [prefs.workspacePath ? workspaceFolderName(prefs.workspacePath) : 'choose a workspace']);
  const workspaceLocation = h('span', {class: 'rail-project-path muted'}, [prefs.workspacePath || 'select a folder to begin']);
  const chooseWorkspace = button(icon('folder'), async () => {
    const selected = await pickDirectory('Choose workspace folder', prefs.workspacePath);
    if (!selected) return;
    prefs.workspacePath = selected;
    navigate({name: 'orchestration'});
  }, {class: 'btn ghost icon-button', 'aria-label': 'choose workspace folder', title: 'choose workspace folder'});

  // Live lanes, so any lane is one click away from any route. Lanes of the current workspace come
  // first; a lane that needs the user is marked.
  const lanesList = h('div', {class: 'rail-lanes', role: 'list'});
  const lanesLabel = h('span', {class: 'rail-label'}, ['lanes']);
  const drawLanes = () => {
    const live = store.sessions.filter(session => isLive(session) && !session.archivedAt);
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
      // Every project with running lanes is one click away, with its main agent named — this is
      // how several main agents on several projects stay in view at once.
      const head = button([h('span', {class: 'rail-project-name'}, [workspaceFolderName(project)]), h('span', {class: 'muted'}, [String(lanes.length)])], () => {
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
        }, {class: `rail-item rail-lane${lane.lead ? ' is-lead' : ''}${lane.parentSessionId ? ' is-sub' : ''}`, title: `${lane.lead ? 'main agent · ' : lane.parentSessionId ? 'subagent · ' : ''}${sessionName(lane)}\n${lane.directory}`});
        lanesList.append(row);
      }
      if (ordered.length > 8) lanesList.append(h('p', {class: 'rail-empty muted'}, [`+${ordered.length - 8} more`]));
    }
  };
  drawLanes();
  const unsubscribe = store.subscribe(drawLanes);

  const footer = h('div', {class: 'rail-footer muted'}, ['local-first · inspectable']);
  const rail = h('aside', {class: 'rail'}, [
    h('div', {class: 'rail-project'}, [h('div', {class: 'rail-project-text'}, [workspaceName, workspaceLocation]), chooseWorkspace]),
    h('div', {class: 'rail-scroll'}, [groups.work, h('div', {class: 'rail-lanes-block'}, [lanesLabel, lanesList]), groups.control, groups.tools]),
    footer
  ]);
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
    if (key !== 'k' && !(key === 'n' && !event.shiftKey)) return;
    // Consumed in the capture phase so a focused terminal never sees the keystroke.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === 'k') openPalette(); else startLanes();
  }, true);
}
