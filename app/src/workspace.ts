// The orchestration workspace: every lane in the project as a live pane, one composer to talk to
// them, and the coordination sidebar. It fills the viewport and never rebuilds itself — tiles are
// added, updated, and removed in place, and terminals stay mounted through every action.
import {api, type AdmissionVerdict, type SessionSummary} from './api';
import {coordinationPanel, type CoordinationCounts, type CoordinationPanel} from './coordination-panel';
import {launchForm, loadReadiness, openLaunchSheet, runLaunch, type LaunchOutcome, type LaunchProgress} from './launch';
import {diffById, gridShape, nextFocus} from './lane-layout';
import {prefs, type LaneLayout} from './prefs';
import {currentProject} from './project-scope';
import {navigate, setRouteCleanup} from './router';
import {setPageCommands, type Command} from './shell';
import {store, type LaneUsage} from './store';
import {attachLaneTerminal, type LaneTerminal} from './terminal';
import {actionErrorText, admissionLabel, askConfirm, button, formatTokens, h, icon, isLive, isMod, kbd, openMenu, providerShort, sessionName, showActionError, showNotice, verificationPill, workspaceFolderName} from './ui';

type Tile = {
  id: string;
  el: HTMLElement;
  summary: SessionSummary;
  pick: HTMLInputElement;
  dot: HTMLElement;
  provider: HTMLElement;
  title: HTMLElement;
  tokens: HTMLElement;
  checks: HTMLElement;
  attention: HTMLElement;
  foot: HTMLElement;
  screen: HTMLElement;
  terminal?: LaneTerminal;
  attaching?: Promise<void>;
};

const tileFontSize = 12;

/** Which sessions the workspace shows for a project: the live ones, plus lanes that ended while
 * the workspace was open so their final screen stays readable until dismissed. */
function projectLanes(sessions: readonly SessionSummary[], project: string, retained: ReadonlySet<string>): SessionSummary[] {
  const lanes = sessions
    .filter(session => (session.projectDirectory ?? session.directory) === project && !session.archivedAt && (isLive(session) || retained.has(session.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A main agent comes first with its subagents directly after it, so the workspace reads as the
  // orchestration it is: who directs, and who is being directed.
  const ordered: SessionSummary[] = [];
  const placed = new Set<string>();
  for (const lead of lanes.filter(lane => lane.lead)) {
    ordered.push(lead);
    placed.add(lead.id);
    for (const child of lanes.filter(lane => lane.parentSessionId === lead.id)) { ordered.push(child); placed.add(child.id); }
  }
  for (const lane of lanes) if (!placed.has(lane.id)) ordered.push(lane);
  return ordered;
}

export async function renderWorkspace(main: HTMLElement, options: {focus?: string} = {}) {
  if (!store.loaded) await store.refresh();
  const projects = [...new Set(store.sessions.filter(session => !session.archivedAt).map(session => session.projectDirectory ?? session.directory))];
  let project = currentProject(prefs.workspacePath, store.sessions);
  if (project && !projects.includes(project) && projects.length > 0 && store.sessions.every(session => (session.projectDirectory ?? session.directory) !== project)) {
    // The rail's workspace has no lanes yet; stay on it so the empty state launches there.
  }

  const retained = new Set<string>();
  const dismissed = new Set<string>();
  const tiles = new Map<string, Tile>();
  let order: string[] = [];
  let focused: string | undefined = options.focus;
  let firstSync = true;
  let layout: LaneLayout = options.focus ? 'focus' : prefs.laneLayout;
  let sidebarOpen = prefs.sidebarOpen;
  let panel: CoordinationPanel | undefined;
  let launching: LaunchProgress | undefined;
  let admission: AdmissionVerdict | undefined;
  let disposed = false;

  // --- Strip ------------------------------------------------------------------------------------
  const projectName = h('strong', {class: 'ws-project-name'}, [project ? workspaceFolderName(project) : 'no project']);
  const projectPath = h('span', {class: 'ws-project-path muted'}, [project ? (projects.length > 1 ? `${projects.length} projects` : '') : 'choose a folder below']);
  const projectButton = h('button', {type: 'button', class: 'ws-project', title: project ?? 'no project selected'}, [projectName, projectPath, projects.length > 1 ? icon('chevron') : null]);
  projectButton.addEventListener('click', () => {
    if (projects.length < 2) return;
    openMenu(projectButton, projects.map(candidate => ({label: `${workspaceFolderName(candidate)}  ${candidate}`, onSelect: () => { prefs.workspacePath = candidate; navigate({name: 'orchestration'}); }})));
  });
  const stats = h('div', {class: 'ws-stats'});
  const headroom = h('span', {class: 'ws-headroom muted'});
  const progress = h('span', {class: 'ws-progress'});
  const layoutControl = h('div', {class: 'segmented', role: 'group', 'aria-label': 'Lane layout'});
  const gridButton = h('button', {type: 'button', class: 'seg', title: 'grid — every lane at once'}, [icon('grid'), 'grid']);
  const rowsButton = h('button', {type: 'button', class: 'seg', title: 'rows — full-width lanes, scroll through them'}, [icon('rows'), 'rows']);
  const focusButton = h('button', {type: 'button', class: 'seg', title: 'focus — one lane large (⌘⏎)'}, [icon('focus'), 'focus']);
  gridButton.addEventListener('click', () => setLayout('grid'));
  rowsButton.addEventListener('click', () => setLayout('rows'));
  focusButton.addEventListener('click', () => setLayout('focus'));
  layoutControl.append(gridButton, rowsButton, focusButton);
  const sidebarButton = button([icon('panel')], () => setSidebar(!sidebarOpen), {class: 'btn ghost icon-button', title: 'coordination sidebar (⌘J)', 'aria-label': 'toggle coordination sidebar', 'aria-pressed': sidebarOpen ? 'true' : 'false'});
  const stopAll = button('stop all', async () => {
    const live = order.map(id => tiles.get(id)!.summary).filter(isLive);
    if (!live.length) return;
    if (!(await askConfirm({title: 'stop every lane', body: `Stop ${live.length} running lane${live.length === 1 ? '' : 's'} in ${workspaceFolderName(project ?? '')}? Their worktrees and records are kept.`, confirmLabel: 'stop lanes', danger: true}))) return;
    await Promise.all(live.map(lane => api.stop(lane.id).catch(showActionError)));
    void store.refresh();
  }, {class: 'btn ghost'});
  const addLanes = button([icon('plus'), 'agents'], () => openLaunch(), {class: 'btn primary', title: 'start agents (⌘N)'});
  const strip = h('header', {class: 'ws-strip'}, [
    projectButton,
    stats,
    headroom,
    progress,
    h('div', {class: 'ws-actions'}, [layoutControl, sidebarButton, stopAll, addLanes])
  ]);

  // --- Plane -----------------------------------------------------------------------------------
  const stage = h('div', {class: 'lane-stage'});
  const stripList = h('div', {class: 'lane-strip', role: 'list', 'aria-label': 'Other lanes'});
  const grid = h('div', {class: 'lane-grid'}, [stripList, stage]);
  const emptyState = h('div', {class: 'ws-empty'});
  emptyState.hidden = true;
  const composer = buildComposer();
  const plane = h('div', {class: 'ws-plane'}, [grid, emptyState, composer.el]);
  const body = h('div', {class: 'ws-body'}, [plane]);
  const root = h('section', {class: 'workspace'}, [strip, body]);
  main.append(root);

  // --- Sidebar -----------------------------------------------------------------------------------
  function mountSidebar() {
    if (!project) return;
    panel = coordinationPanel({
      project,
      lanes: () => order.map(id => tiles.get(id)!.summary),
      onFocusLane: id => { if (tiles.has(id)) focusLane(id, {stage: layout === 'focus'}); else navigate({name: 'active-session', sessionId: id}); },
      onCountsChange: counts => syncStats(counts)
    });
    body.append(panel.el);
    void panel.refresh();
  }
  function setSidebar(open: boolean) {
    sidebarOpen = open;
    prefs.sidebarOpen = open;
    root.classList.toggle('sidebar-open', open);
    sidebarButton.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open && panel) void panel.refresh();
    requestAnimationFrame(fitAll);
  }

  // --- Tiles -------------------------------------------------------------------------------------
  function createTile(summary: SessionSummary): Tile {
    const pick = h('input', {type: 'checkbox', class: 'lane-pick', 'aria-label': `include ${providerShort[summary.provider]} lane in send targets`}) as HTMLInputElement;
    pick.checked = true;
    pick.addEventListener('change', () => composer.sync());
    pick.addEventListener('click', event => event.stopPropagation());
    const dot = h('span', {class: 'lane-dot'});
    const provider = h('span', {class: 'lane-provider'});
    const title = h('span', {class: 'lane-title'});
    const tokens = h('span', {class: 'lane-tokens muted'});
    const checks = h('span', {class: 'lane-checks'});
    const attention = h('span', {class: 'lane-attention'});
    const menu = button(icon('more'), event => { event.stopPropagation(); openTileMenu(tile, menu); }, {class: 'btn ghost icon-button lane-menu', 'aria-label': 'lane actions'});
    // Quick actions surface on hover; the menu holds the rest.
    const expand = button(icon('expand'), event => { event.stopPropagation(); focusLane(summary.id, {stage: true}); setLayout(layout === 'focus' && focused === summary.id ? 'grid' : 'focus'); }, {class: 'btn ghost icon-button lane-quick', 'aria-label': 'focus this lane', title: 'focus this lane (⌘⏎)'});
    const head = h('header', {class: 'lane-head'}, [pick, dot, provider, title, attention, tokens, checks, expand, menu]);
    const screen = h('div', {class: 'lane-screen loading', 'data-provider': providerShort[summary.provider]});
    const foot = h('footer', {class: 'lane-foot'});
    foot.hidden = true;
    const el = h('article', {class: 'lane', 'data-session-id': summary.id, tabindex: '0', role: 'group', 'aria-label': `${providerShort[summary.provider]} lane`}, [head, screen, foot]);
    const tile: Tile = {id: summary.id, el, summary, pick, dot, provider, title, tokens, checks, attention, foot, screen};
    head.addEventListener('click', () => focusLane(summary.id, {stage: layout === 'focus'}));
    head.addEventListener('dblclick', () => { focusLane(summary.id, {stage: true}); setLayout(layout === 'focus' && focused === summary.id ? 'grid' : 'focus'); });
    screen.addEventListener('mousedown', () => focusLane(summary.id, {stage: layout === 'focus', keepTerminalFocus: true}));
    el.addEventListener('focus', () => { if (focused !== summary.id) focusLane(summary.id, {stage: layout === 'focus'}); });
    el.addEventListener('keydown', event => {
      if (event.target !== el) return;
      if (event.key === 'Enter') { event.preventDefault(); focusLane(summary.id, {stage: true}); setLayout('focus'); tile.terminal?.focus(); }
    });
    updateTile(tile, summary);
    tile.attaching = attachLaneTerminal(summary.id, screen, {
      fontSize: tileFontSize,
      scaleWithWidth: true,
      onStatus: next => store.patch(next)
    }).then(terminal => {
      if (disposed || !tiles.has(summary.id)) { terminal.dispose(); return; }
      tile.terminal = terminal;
      screen.classList.remove('loading');
      terminal.terminal.options.cursorBlink = focused === summary.id;
      if (focused === summary.id && layout === 'focus') terminal.focus();
    }, error => {
      screen.classList.remove('loading');
      screen.append(h('p', {class: 'lane-error error'}, [actionErrorText(error)]));
    });
    return tile;
  }

  function updateTile(tile: Tile, summary: SessionSummary) {
    tile.summary = summary;
    const live = isLive(summary);
    const usage = store.usage.get(summary.id);
    tile.el.classList.toggle('ended', !live);
    tile.el.classList.toggle('lead', Boolean(summary.lead));
    tile.dot.className = `lane-dot status-${summary.status}`;
    tile.dot.title = summary.status;
    tile.provider.textContent = summary.model ? `${providerShort[summary.provider]} · ${summary.model}` : providerShort[summary.provider];
    tile.title.textContent = sessionName(summary);
    tile.title.title = summary.task ?? summary.directory;
    tile.tokens.textContent = usageText(usage);
    tile.checks.innerHTML = '';
    if (summary.verification && summary.verification !== 'unavailable') tile.checks.append(verificationPill(summary.verification));
    const attention = store.attention.get(summary.id);
    tile.attention.innerHTML = '';
    tile.el.classList.toggle('needs-you', attention?.reason === 'needs-input');
    if (attention) tile.attention.append(h('span', {class: `pill attention-${attention.reason}`}, [{finished: 'finished', failed: 'failed', 'needs-input': 'needs you'}[attention.reason]]));
    if (summary.lead) tile.attention.append(h('span', {class: 'pill lead-pill', title: summary.lead.pool ? `subagent pool: ${Object.entries(summary.lead.pool).map(([id, count]) => `${count} ${id}`).join(', ')}` : 'main agent'}, [`main · ${store.sessions.filter(session => session.parentSessionId === summary.id && isLive(session)).length}/${summary.lead.maxLanes} subagents`]));
    if (summary.parentSessionId) tile.attention.append(h('span', {class: 'pill', title: `started by the main agent ${summary.parentSessionId.slice(0, 8)}`}, ['↳ subagent']));
    tile.foot.hidden = live;
    if (!live) {
      tile.foot.innerHTML = '';
      const canResume = summary.provider === 'claude' || summary.provider === 'codex';
      tile.foot.append(
        h('span', {class: 'muted'}, [summary.status === 'failed' ? `failed${summary.error ? ` · ${summary.error}` : ''}` : summary.exitCode ? `exited · code ${summary.exitCode}` : 'finished']),
        h('span', {class: 'actions'}, [
          button('review', () => navigate({name: 'active-session', sessionId: summary.id}), {class: 'btn ghost small'}),
          canResume ? button('resume', async () => {
            try { await api.resumeSession(summary); void store.refresh(); } catch (error) { showActionError(error); }
          }, {class: 'btn ghost small'}) : null,
          button('dismiss', () => { dismissed.add(summary.id); retained.delete(summary.id); sync(); }, {class: 'btn ghost small'})
        ])
      );
    }
  }

  function usageText(usage: LaneUsage | undefined): string {
    if (!usage) return '';
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    const parts: string[] = [];
    if (total > 0) parts.push(formatTokens(total));
    if (usage.contextPercent !== undefined) parts.push(`${usage.contextPercent.toFixed(0)}% ctx`);
    return parts.join(' · ');
  }

  function openTileMenu(tile: Tile, anchor: HTMLElement) {
    const summary = tile.summary;
    const live = isLive(summary);
    openMenu(anchor, [
      {label: layout === 'focus' && focused === summary.id ? 'back to grid' : 'focus this lane', onSelect: () => { if (layout === 'focus' && focused === summary.id) setLayout('grid'); else { focusLane(summary.id, {stage: true}); setLayout('focus'); } }},
      {label: 'open full view', onSelect: () => navigate({name: 'active-session', sessionId: summary.id})},
      {label: 'review changes', onSelect: () => navigate({name: 'active-session', sessionId: summary.id, review: 'diff'})},
      'divider',
      {label: tile.pick.checked ? 'exclude from send targets' : 'include in send targets', onSelect: () => { tile.pick.checked = !tile.pick.checked; composer.sync(); }},
      'divider',
      live
        ? {label: 'stop lane', danger: true, onSelect: async () => { await api.stop(summary.id).catch(showActionError); void store.refresh(); }}
        : {label: 'dismiss', onSelect: () => { dismissed.add(summary.id); retained.delete(summary.id); sync(); }}
    ]);
  }

  function removeTile(id: string) {
    const tile = tiles.get(id);
    if (!tile) return;
    tiles.delete(id);
    tile.terminal?.dispose();
    void tile.attaching?.then(() => tile.terminal?.dispose());
    tile.el.remove();
  }

  // --- Sync and layout ----------------------------------------------------------------------------
  function sync() {
    if (disposed) return;
    const next = project ? projectLanes(store.sessions, project, retained).filter(session => !dismissed.has(session.id)) : [];
    for (const session of next) if (isLive(session)) retained.add(session.id);
    const previous = order.map(id => tiles.get(id)!.summary);
    const diff = diffById(previous, next);
    for (const id of diff.removed) removeTile(id);
    for (const session of diff.kept) updateTile(tiles.get(session.id)!, session);
    for (const session of diff.added) tiles.set(session.id, createTile(session));
    order = next.map(session => session.id);
    // On arrival the orchestrator's terminal is the natural place to be: it is where the user
    // talks, and its subagents line up beside it.
    if (firstSync && !focused) focused = next.find(session => session.lead && isLive(session))?.id;
    firstSync = false;
    focused = nextFocus(order, focused, diff.removed);
    applyLayout();
    composer.sync();
    syncStats(panel?.counts());
    if (diff.added.length || diff.removed.length) void panel?.refresh();
  }

  function applyLayout() {
    const showEmpty = order.length === 0;
    emptyState.hidden = !showEmpty;
    grid.hidden = showEmpty;
    composer.el.hidden = showEmpty;
    if (showEmpty) { renderEmptyState(); return; }
    grid.classList.toggle('focus', layout === 'focus');
    grid.classList.toggle('rows', layout === 'rows');
    gridButton.classList.toggle('active', layout === 'grid');
    rowsButton.classList.toggle('active', layout === 'rows');
    focusButton.classList.toggle('active', layout === 'focus');
    if (layout === 'focus' && (!focused || !tiles.has(focused))) focused = order[0];
    const staged = layout === 'focus' ? [focused!] : order;
    const stripped = layout === 'focus' ? order.filter(id => id !== focused) : [];
    // Reparent in order; an element already in the right place is left alone so its terminal is
    // not disturbed.
    reconcileChildren(stage, staged.map(id => tiles.get(id)!.el));
    reconcileChildren(stripList, stripped.map(id => tiles.get(id)!.el));
    stripList.hidden = layout !== 'focus';
    const shape = layout === 'rows' ? {columns: 1, rows: staged.length} : gridShape(staged.length, stage.clientWidth || plane.clientWidth || 1200, stage.clientHeight || plane.clientHeight || 700);
    stage.style.setProperty('--cols', String(shape.columns));
    stage.style.setProperty('--rows', String(shape.rows));
    for (const [id, tile] of tiles) {
      tile.el.classList.toggle('focused', id === focused);
      tile.el.classList.toggle('in-strip', stripped.includes(id));
    }
    requestAnimationFrame(fitAll);
  }

  function reconcileChildren(parent: HTMLElement, children: HTMLElement[]) {
    children.forEach((child, index) => {
      if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
    });
    for (const extra of [...parent.children]) if (!children.includes(extra as HTMLElement)) parent.removeChild(extra);
  }

  function fitAll() {
    for (const tile of tiles.values()) tile.terminal?.fit();
  }

  function setLayout(next: LaneLayout) {
    layout = next;
    prefs.laneLayout = next;
    applyLayout();
    if (next === 'focus' && focused) tiles.get(focused)?.terminal?.focus();
  }

  function focusLane(id: string, options: {stage?: boolean; keepTerminalFocus?: boolean} = {}) {
    if (!tiles.has(id)) return;
    focused = id;
    store.clearAttention(id);
    // The cursor blinks only where keystrokes will land.
    for (const [tileId, tile] of tiles) if (tile.terminal) tile.terminal.terminal.options.cursorBlink = tileId === id;
    if (options.stage && layout === 'focus') applyLayout();
    else for (const [tileId, tile] of tiles) tile.el.classList.toggle('focused', tileId === id);
    composer.sync();
    if (!options.keepTerminalFocus && layout === 'focus') tiles.get(id)?.terminal?.focus();
  }

  function syncStats(counts?: CoordinationCounts) {
    const lanes = order.map(id => tiles.get(id)!.summary);
    const running = lanes.filter(isLive).length;
    const needsYou = lanes.filter(lane => store.attention.get(lane.id)?.reason === 'needs-input').length;
    const parts: Array<[string, string]> = [[String(running), 'running']];
    // The line ellipsizes from the right at narrow widths, so the one part the user must not miss
    // comes before the long main-agent summary.
    if (needsYou) parts.push([String(needsYou), needsYou === 1 ? 'needs you' : 'need you']);
    const mains = lanes.filter(lane => lane.lead && isLive(lane));
    if (mains.length) parts.push([String(mains.length), mains.length === 1 ? `main agent · ${mains.reduce((sum, lead) => sum + store.sessions.filter(session => session.parentSessionId === lead.id && isLive(session)).length, 0)}/${mains[0]!.lead!.maxLanes} subagents` : 'main agents']);
    if (counts) {
      if (counts.tasks) parts.push([`${counts.active}/${counts.tasks}`, 'tasks active']);
      if (counts.overlaps) parts.push([String(counts.overlaps), counts.overlaps === 1 ? 'overlap' : 'overlaps']);
      if (counts.handoffs) parts.push([String(counts.handoffs), counts.handoffs === 1 ? 'review' : 'reviews']);
    }
    stats.innerHTML = '';
    parts.forEach(([value, label], index) => {
      const warn = label.includes('need') || label.includes('overlap');
      if (label.includes('need')) {
        const jump = button([h('strong', {}, [value]), ` ${label}`], () => {
          const waiting = order.find(id => store.attention.get(id)?.reason === 'needs-input');
          if (waiting) { focusLane(waiting, {stage: true}); if (layout !== 'focus') setLayout('focus'); tiles.get(waiting)?.terminal?.focus(); }
        }, {class: 'btn link ws-stat warn', title: 'jump to the lane waiting on you'});
        stats.append(jump);
      } else {
        stats.append(h('span', {class: `ws-stat${warn ? ' warn' : ''}`}, [h('strong', {}, [value]), ` ${label}`]));
      }
      if (index < parts.length - 1) stats.append(h('span', {class: 'ws-sep'}, ['·']));
    });
    stopAll.disabled = running === 0;
    const total = [...store.usage.values()].filter(usage => order.includes(usage.sessionId)).reduce((sum, usage) => sum + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), 0);
    if (total > 0) stats.append(h('span', {class: 'ws-sep'}, ['·']), h('span', {class: 'ws-stat muted'}, [`${formatTokens(total)} tokens`]));
  }

  async function refreshHeadroom() {
    try {
      admission = await api.assessAdmission('claude');
      headroom.textContent = admission.decision === 'over' ? 'no headroom' : admission.decision === 'tight' ? '~1 more lane fits' : `~${admission.recommendedLanes} more lanes fit`;
      headroom.classList.toggle('warn', admission.decision === 'over');
    } catch { headroom.textContent = ''; }
  }

  // --- Launching ------------------------------------------------------------------------------------
  function onProgress(step: LaunchProgress) {
    launching = step;
    progress.textContent = `starting lane ${step.index + 1} of ${step.total} · ${providerShort[step.provider]}…`;
    progress.hidden = false;
  }
  /** fluentd records a project by its real path (a folder picked as `/tmp/x` comes back as
   * `/private/tmp/x`). The workspace adopts that canonical path so the lanes it just started are
   * its own, instead of silently belonging to a project it never matches. */
  function onLaunched(outcome: LaunchOutcome) {
    launching = undefined;
    progress.textContent = '';
    progress.hidden = true;
    const canonical = outcome.created[0] ? outcome.created[0].projectDirectory ?? outcome.created[0].directory : undefined;
    if (canonical && canonical !== project) {
      prefs.workspacePath = canonical;
      navigate({name: 'orchestration'});
      return;
    }
    void store.refresh();
    void refreshHeadroom();
  }
  function openLaunch() {
    void openLaunchSheet({directory: project ?? prefs.workspacePath, onProgress, onLaunched});
  }

  async function renderEmptyState() {
    if (emptyState.childElementCount > 0) return;
    const directory = project ?? prefs.workspacePath;
    emptyState.append(h('p', {class: 'muted'}, ['loading providers…']));
    try {
      const {readiness, chains} = await loadReadiness();
      if (disposed) return;
      emptyState.innerHTML = '';
      const form = launchForm({
        directory,
        readiness,
        chains,
        variant: 'empty',
        onLaunch: async request => {
          const outcome = await runLaunch(request, readiness, onProgress);
          if (outcome.failures.length) showActionError(new Error(`${outcome.failures.length} lane${outcome.failures.length === 1 ? '' : 's'} did not start — ${outcome.failures[0]}`));
          onLaunched(outcome);
        }
      });
      emptyState.append(
        h('div', {class: 'ws-empty-inner'}, [
          h('h1', {}, [project ? `start agents on ${workspaceFolderName(project)}` : 'start agents']),
          h('p', {class: 'muted'}, [project ? project : 'Pick a folder, brief a main agent, and give it a pool of subagents from any model — or send one brief to several lanes.']),
          form.el
        ])
      );
      form.focus();
    } catch (error) {
      emptyState.innerHTML = '';
      emptyState.append(h('p', {class: 'error'}, [actionErrorText(error)]));
    }
  }

  // --- Composer --------------------------------------------------------------------------------------
  function buildComposer() {
    type Mode = 'focused' | 'picked' | 'all';
    let mode: Mode = 'all';
    let modeChosen = false;
    const input = h('textarea', {class: 'composer-input', rows: '1', placeholder: 'message the lanes…', 'aria-label': 'Message to lanes'}) as HTMLTextAreaElement;
    const hint = h('span', {class: 'composer-hint muted'}, [kbd('↵'), ' send ', kbd('⇧↵'), ' line']);
    const submit = h('input', {type: 'checkbox', checked: ''}) as HTMLInputElement;
    const send = h('button', {type: 'button', class: 'btn primary composer-send'}, [icon('send'), 'send']);
    const targetsGroup = h('div', {class: 'segmented composer-targets', role: 'group', 'aria-label': 'Send to'});
    const status = h('span', {class: 'composer-status muted', role: 'status'});
    const targetButtons: Record<Mode, HTMLButtonElement> = {
      focused: h('button', {type: 'button', class: 'seg'}, ['focused']),
      picked: h('button', {type: 'button', class: 'seg'}, ['checked']),
      all: h('button', {type: 'button', class: 'seg'}, ['all'])
    };
    for (const [key, element] of Object.entries(targetButtons) as Array<[Mode, HTMLButtonElement]>) {
      element.addEventListener('click', () => { mode = key; modeChosen = true; sync(); });
      targetsGroup.append(element);
    }
    const targets = (): string[] => {
      const live = order.filter(id => isLive(tiles.get(id)!.summary));
      if (mode === 'focused') return focused && live.includes(focused) ? [focused] : [];
      if (mode === 'picked') return live.filter(id => tiles.get(id)!.pick.checked);
      return live;
    };
    const sync = () => {
      const live = order.filter(id => isLive(tiles.get(id)!.summary));
      const picked = live.filter(id => tiles.get(id)!.pick.checked);
      const focusedTile = focused ? tiles.get(focused) : undefined;
      targetButtons.focused.textContent = focusedTile ? `${providerShort[focusedTile.summary.provider]} · ${sessionName(focusedTile.summary).slice(0, 24)}` : 'focused';
      targetButtons.focused.disabled = !focusedTile || !isLive(focusedTile.summary);
      targetButtons.picked.textContent = `checked · ${picked.length}`;
      targetButtons.all.textContent = `all · ${live.length}`;
      if (mode === 'focused' && targetButtons.focused.disabled) mode = 'all';
      // Talking to the orchestrator is the default when one is focused; a broadcast to its
      // subagents is a deliberate choice, since they are meant to hear from the main agent.
      if (!modeChosen && focusedTile?.summary.lead && isLive(focusedTile.summary)) mode = 'focused';
      for (const [key, element] of Object.entries(targetButtons) as Array<[Mode, HTMLButtonElement]>) {
        element.classList.toggle('active', key === mode);
        element.setAttribute('aria-pressed', key === mode ? 'true' : 'false');
      }
      const count = targets().length;
      send.disabled = count === 0;
      const target = mode === 'focused' && focusedTile ? (focusedTile.summary.lead ? 'message the main agent…' : `message ${providerShort[focusedTile.summary.provider]} · ${sessionName(focusedTile.summary).slice(0, 24)}…`) : count === 1 ? 'message this lane…' : `message ${count} lanes…`;
      input.placeholder = count === 0 ? 'no running lane to send to' : target;
    };
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void deliver(); }
    });
    send.addEventListener('click', () => void deliver());
    async function deliver() {
      const text = input.value;
      const ids = targets();
      if (!text.trim() || ids.length === 0) return input.focus();
      send.disabled = true;
      status.textContent = `sending to ${ids.length}…`;
      const results = await Promise.allSettled(ids.map(id => api.inject(id, text, submit.checked)));
      const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${providerShort[tiles.get(ids[index]!)!.summary.provider]} ${ids[index]!.slice(0, 6)}: ${actionErrorText(result.reason)}`] : []);
      status.className = `composer-status ${failed.length ? 'error' : 'muted'}`;
      status.textContent = failed.length ? `sent to ${ids.length - failed.length} of ${ids.length} — ${failed[0]}` : `sent to ${ids.length} lane${ids.length === 1 ? '' : 's'}`;
      if (!failed.length) { input.value = ''; grow(); }
      window.setTimeout(() => { if (status.textContent?.startsWith('sent to')) status.textContent = ''; }, 4000);
      sync();
      input.focus();
    }
    const el = h('form', {class: 'composer'}, [
      h('div', {class: 'composer-row'}, [targetsGroup, status]),
      h('div', {class: 'composer-row'}, [h('div', {class: 'composer-field'}, [input, hint]), h('label', {class: 'check-label composer-submit', title: 'press Enter in the lane after pasting'}, [submit, ' enter']), send])
    ]);
    el.addEventListener('submit', event => event.preventDefault());
    return {el, sync, focus: () => input.focus()};
  }

  // --- Keyboard ------------------------------------------------------------------------------------
  // A handled shortcut is consumed here, in the capture phase, so it never reaches xterm: xterm
  // would otherwise turn ⌘⏎ into a carriage return typed into the lane.
  const consume = (event: KeyboardEvent, run: () => void) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    run();
  };
  const onKey = (event: KeyboardEvent) => {
    if (disposed) return;
    const target = event.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable || target.closest('.xterm'));
    if (isMod(event) && /^[1-9]$/.test(event.key)) {
      const id = order[Number(event.key) - 1];
      if (!id) return;
      consume(event, () => {
        focusLane(id, {stage: true});
        if (layout === 'grid') tiles.get(id)?.el.scrollIntoView({block: 'nearest'});
        tiles.get(id)?.terminal?.focus();
      });
      return;
    }
    if (isMod(event) && event.key === 'Enter') return consume(event, () => setLayout(layout === 'focus' ? 'grid' : 'focus'));
    if (isMod(event) && event.key.toLowerCase() === 'j') return consume(event, () => setSidebar(!sidebarOpen));
    if (isMod(event) && event.shiftKey && event.key.toLowerCase() === 'l') return consume(event, () => setLayout(layout === 'grid' ? 'rows' : layout === 'rows' ? 'focus' : 'grid'));
    if (isMod(event) && event.key === '/') return consume(event, () => composer.focus());
    if (event.key === 'Escape' && !typing && layout === 'focus') { setLayout('grid'); return; }
  };
  // Capture phase: xterm stops propagation of keys it handles, and these are app shortcuts.
  document.addEventListener('keydown', onKey, true);
  const onResize = () => applyLayout();
  window.addEventListener('resize', onResize);
  const unsubscribe = store.subscribe(sync);
  setPageCommands((): Command[] => [
    {id: 'ws-layout-grid', label: 'layout: grid', keys: 'mod ⇧L', run: () => setLayout('grid')},
    {id: 'ws-layout-rows', label: 'layout: rows', run: () => setLayout('rows')},
    {id: 'ws-layout-focus', label: 'layout: focus', keys: 'mod ⏎', run: () => setLayout('focus')},
    {id: 'ws-sidebar', label: sidebarOpen ? 'hide coordination sidebar' : 'show coordination sidebar', keys: 'mod J', run: () => setSidebar(!sidebarOpen)},
    {id: 'ws-compose', label: 'send a message to lanes…', keys: 'mod /', run: () => composer.focus()},
    {id: 'ws-stop-all', label: 'stop every lane in this project', run: () => stopAll.click()},
    ...order.map((id, index) => {
      const tile = tiles.get(id)!;
      return {id: `ws-focus-${id}`, label: `focus lane ${index + 1}: ${providerShort[tile.summary.provider]} · ${sessionName(tile.summary)}`, keys: index < 9 ? `mod ${index + 1}` : undefined, run: () => { focusLane(id, {stage: true}); setLayout('focus'); tile.terminal?.focus(); }};
    })
  ]);

  setRouteCleanup(main, () => {
    disposed = true;
    setPageCommands(() => []);
    unsubscribe();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    panel?.dispose();
    for (const id of [...tiles.keys()]) removeTile(id);
  });

  root.classList.toggle('sidebar-open', sidebarOpen);
  mountSidebar();
  progress.hidden = true;
  sync();
  void refreshHeadroom();
  // Shortcut help lives in the strip's title text rather than a legend; the palette lists them.
  strip.title = `⌘1–9 focus a lane · ⌘⏎ grid/focus · ⌘⇧L cycle layouts · ⌘J sidebar · ⌘/ composer · ⌘N start lanes · ${kbd('mod K').textContent} palette`;
}
