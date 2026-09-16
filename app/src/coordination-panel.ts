// The coordination sidebar: what the lanes share, as compact lists with per-item actions. Reading
// is the default; every add form is closed until asked for. Deeper setup (master brief, planner,
// skill, evals) sits behind the `setup` tab so the board stays glanceable.
import {api, type CoordinationState, type ProviderId, type RankedConflict, type SessionSummary, type SkillInstallState, type EvalReadiness} from './api';
import {plannerPrompt, ticketBlockers, ticketPrompt, type Ticket} from './coordination-prompts';
import {retainedCoordinationHistory} from './coordination-explorer';
import {navigate} from './router';
import {store} from './store';
import {actionErrorText, askConfirm, button, h, icon, isLive, openMenu, pickSpecFile, providerShort, relativeTime, sessionName, showActionError, showNotice, verificationPill, workspaceFolderName} from './ui';

export type CoordinationCounts = {tasks: number; active: number; claims: number; overlaps: number; handoffs: number; unread: number};

export type CoordinationPanel = {
  el: HTMLElement;
  refresh: () => Promise<void>;
  counts: () => CoordinationCounts;
  dispose: () => void;
};

type PanelOptions = {
  project: string;
  lanes: () => SessionSummary[];
  onFocusLane: (sessionId: string) => void;
  onCountsChange?: (counts: CoordinationCounts) => void;
};

const providerChoices: ProviderId[] = ['claude', 'codex', 'gemini', 'glm', 'qwen', 'nvidia'];

function providerSelect(selected: ProviderId, label: string): HTMLSelectElement {
  const select = h('select', {'aria-label': label}) as HTMLSelectElement;
  for (const provider of providerChoices) select.append(h('option', {value: provider}, [providerShort[provider]]));
  select.value = selected;
  return select;
}

export function coordinationPanel(options: PanelOptions): CoordinationPanel {
  const {project} = options;
  let state: CoordinationState = {project, tasks: [], claims: [], decisions: [], messages: [], handoffs: [], events: []};
  let conflicts: RankedConflict[] = [];
  let skills: SkillInstallState[] = [];
  let evals: EvalReadiness | undefined;
  let tab: 'board' | 'setup' = 'board';
  const openForms = new Set<string>();
  let disposed = false;

  const boardTab = h('button', {type: 'button', class: 'coord-tab active'}, ['board']);
  const setupTab = h('button', {type: 'button', class: 'coord-tab'}, ['setup']);
  const body = h('div', {class: 'coord-scroll'});
  const el = h('aside', {class: 'coord', 'aria-label': 'Coordination'}, [
    h('div', {class: 'coord-tabs'}, [boardTab, setupTab]),
    body
  ]);
  boardTab.addEventListener('click', () => { tab = 'board'; draw(); });
  setupTab.addEventListener('click', () => { tab = 'setup'; void loadSetup().then(draw); });

  const laneLabel = (sessionId: string) => {
    const lane = store.get(sessionId);
    return lane ? `${providerShort[lane.provider]} · ${sessionId.slice(0, 6)}` : sessionId.slice(0, 6);
  };
  const laneLink = (sessionId: string) => {
    const link = h('button', {type: 'button', class: 'object-link lane-link'}, [laneLabel(sessionId)]);
    link.addEventListener('click', () => options.onFocusLane(sessionId));
    return link;
  };

  function counts(): CoordinationCounts {
    return {
      tasks: state.tasks.filter(task => task.status !== 'done').length,
      active: state.tasks.filter(task => task.status === 'active').length,
      claims: state.claims.length,
      overlaps: conflicts.length,
      handoffs: state.handoffs.filter(handoff => handoff.status === 'open').length,
      unread: state.messages.filter(message => !message.readAt).length
    };
  }

  async function act(work: () => Promise<unknown>) {
    try {
      await work();
      await refresh();
    } catch (error) {
      showActionError(error);
    }
  }

  async function refresh() {
    if (disposed) return;
    try {
      [state, conflicts] = await Promise.all([api.coordination(project), api.conflicts(project)]);
    } catch (error) {
      body.innerHTML = '';
      body.append(h('p', {class: 'error coord-empty'}, [actionErrorText(error)]));
      return;
    }
    draw();
    options.onCountsChange?.(counts());
  }

  async function loadSetup() {
    [skills, evals] = await Promise.all([api.skillStatus().catch(() => []), api.evalReadiness().catch(() => undefined)]);
  }

  // --- Building blocks --------------------------------------------------------------------------

  function section(id: string, title: string, meta: string, children: HTMLElement[], addForm?: HTMLElement): HTMLElement {
    const add = addForm ? button(icon('plus'), () => {
      if (openForms.has(id)) openForms.delete(id); else openForms.add(id);
      addForm.hidden = !openForms.has(id);
      if (!addForm.hidden) (addForm.querySelector('input, textarea') as HTMLElement | null)?.focus();
    }, {class: 'btn ghost icon-button', 'aria-label': `add ${title}`, 'aria-expanded': openForms.has(id) ? 'true' : 'false'}) : null;
    if (addForm) addForm.hidden = !openForms.has(id);
    return h('section', {class: 'coord-section'}, [
      h('header', {class: 'coord-head'}, [h('h3', {}, [title]), h('span', {class: 'coord-meta'}, [meta]), add]),
      addForm ?? null,
      ...children
    ]);
  }

  const empty = (text: string) => h('p', {class: 'coord-empty muted'}, [text]);

  function inlineForm(fields: HTMLElement[], submitLabel: string, onSubmit: () => Promise<void>): HTMLElement {
    const submit = h('button', {type: 'submit', class: 'btn primary small'}, [submitLabel]);
    const form = h('form', {class: 'coord-form'}, [...fields, h('div', {class: 'actions'}, [submit])]);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      try { await onSubmit(); } finally { submit.disabled = false; }
    });
    return form;
  }

  // --- Tasks ------------------------------------------------------------------------------------

  function ticketRow(task: Ticket): HTMLElement {
    const blockers = ticketBlockers(task, state.tasks);
    const blocked = blockers.length > 0;
    const lanes = options.lanes().filter(isLive);
    const lane = task.sessionId ? store.get(task.sessionId) : undefined;
    const editor = h('div', {class: 'coord-form'});
    editor.hidden = true;

    const launchOn = async (provider: ProviderId) => act(async () => {
      const session = await api.createSession({provider, directory: project, task: ticketPrompt(task, state), isolate: true});
      store.patch(session);
      await api.assignTask(project, task.id, {sessionId: session.id, provider, role: task.role});
      showNotice(`started a ${providerShort[provider]} lane for “${task.title}”`);
    });
    const assignTo = async (sessionId: string) => act(async () => {
      // Delivery first: the board never claims a lane has a ticket if its terminal did not accept
      // the focused brief.
      await api.inject(sessionId, ticketPrompt(task, state));
      const target = lanes.find(candidate => candidate.id === sessionId);
      await api.assignTask(project, task.id, {sessionId, provider: target?.provider ?? task.provider, role: task.role});
    });
    const showEditor = (kind: 'edit' | 'prerequisites') => {
      editor.innerHTML = '';
      editor.hidden = false;
      if (kind === 'edit') {
        const title = h('input', {type: 'text', value: task.title, 'aria-label': 'Title'}) as HTMLInputElement;
        const role = h('input', {type: 'text', value: task.role ?? '', placeholder: 'role, e.g. frontend', 'aria-label': 'Role'}) as HTMLInputElement;
        const provider = providerSelect(task.provider ?? 'claude', 'Provider');
        const description = h('textarea', {rows: '3', placeholder: 'ticket-local brief', 'aria-label': 'Brief'}) as HTMLTextAreaElement;
        description.value = task.description ?? '';
        editor.append(inlineForm([title, h('div', {class: 'field-row'}, [role, provider]), description], 'save', async () => {
          await act(async () => {
            await api.editTask(project, task.id, {title: title.value, description: description.value, role: role.value});
            if (provider.value !== (task.provider ?? '')) await api.assignTask(project, task.id, {sessionId: task.sessionId, provider: provider.value as ProviderId, role: role.value});
          });
        }));
      } else {
        const picker = h('select', {multiple: 'multiple', size: '4', 'aria-label': `Prerequisites for ${task.title}`}) as HTMLSelectElement;
        for (const candidate of state.tasks) {
          if (candidate.id === task.id) continue;
          const option = h('option', {value: candidate.id}, [`${candidate.status} · ${candidate.title}`]);
          option.selected = Boolean(task.dependsOn?.includes(candidate.id));
          picker.append(option);
        }
        editor.append(h('p', {class: 'muted'}, ['tickets this one waits for']), inlineForm([picker], 'save prerequisites', () => act(() => api.setTaskDependencies(project, task.id, [...picker.selectedOptions].map(option => option.value)))));
      }
    };
    const menu = button(icon('more'), () => {
      const provider = task.provider ?? 'claude';
      openMenu(menu, [
        {label: `start a clean ${providerShort[provider]} lane`, disabled: blocked, onSelect: () => void launchOn(provider)},
        ...providerChoices.filter(candidate => candidate !== provider).slice(0, 2).map(candidate => ({label: `start on ${providerShort[candidate]} instead`, disabled: blocked, onSelect: () => void launchOn(candidate)})),
        ...(lanes.length ? [{label: 'assign to a running lane…', disabled: blocked, onSelect: () => openMenu(menu, lanes.map(candidate => ({label: `${providerShort[candidate.provider]} · ${sessionName(candidate).slice(0, 40)}`, onSelect: () => void assignTo(candidate.id)})))}] : []),
        'divider',
        {label: task.status === 'todo' ? 'mark in progress' : task.status === 'active' ? 'mark done' : 'reopen', disabled: task.status === 'todo' && blocked, onSelect: () => void act(() => api.updateTask(project, task.id, task.status === 'todo' ? 'active' : task.status === 'active' ? 'done' : 'todo', task.sessionId))},
        ...(task.sessionId ? [{label: 'open its lane', onSelect: () => navigate({name: 'active-session', sessionId: task.sessionId!})}] : []),
        {label: 'edit…', onSelect: () => showEditor('edit')},
        {label: 'prerequisites…', disabled: task.status !== 'todo', onSelect: () => showEditor('prerequisites')},
        'divider',
        {label: 'delete', danger: true, onSelect: async () => {
          if (!(await askConfirm({title: 'delete ticket', body: `Delete “${task.title}” from the board? Tickets that list it as a prerequisite stop waiting for it. A lane already working on it keeps running.`, confirmLabel: 'delete ticket', danger: true}))) return;
          void act(() => api.deleteTask(project, task.id));
        }}
      ]);
    }, {class: 'btn ghost icon-button row-menu', 'aria-label': `actions for ${task.title}`});
    const meta = [task.role, task.provider ? providerShort[task.provider] : undefined, task.source && task.source !== 'manual' ? task.source : undefined].filter(Boolean).join(' · ');
    return h('div', {class: `coord-row ticket ticket-${task.status}${blocked ? ' blocked' : ''}`}, [
      h('span', {class: `state-dot ${task.status}`, title: task.status}),
      h('div', {class: 'coord-row-body'}, [
        h('div', {class: 'coord-row-title'}, [task.title]),
        h('div', {class: 'coord-row-meta muted'}, [
          meta || 'generalist',
          lane ? h('span', {}, [' · ', laneLink(lane.id)]) : null,
          blocked ? h('span', {class: 'warn'}, [` · waits for ${blockers.map(dependency => dependency ? dependency.title : 'a missing ticket').join(', ')}`]) : null
        ]),
        task.description ? h('p', {class: 'coord-row-desc muted'}, [task.description]) : null,
        editor
      ]),
      menu
    ]);
  }

  function tasksSection(): HTMLElement {
    const title = h('input', {type: 'text', placeholder: 'ticket title', 'aria-label': 'Ticket title'}) as HTMLInputElement;
    const role = h('input', {type: 'text', placeholder: 'role (optional)', 'aria-label': 'Role'}) as HTMLInputElement;
    const provider = providerSelect('claude', 'Provider');
    const description = h('textarea', {rows: '2', placeholder: 'brief, constraints, acceptance checks (optional)', 'aria-label': 'Ticket brief'}) as HTMLTextAreaElement;
    const form = inlineForm([title, h('div', {class: 'field-row'}, [role, provider]), description], 'create ticket', async () => {
      if (!title.value.trim()) return title.focus();
      await act(() => api.createTask(project, {title: title.value.trim(), description: description.value, role: role.value, provider: provider.value as ProviderId, source: 'manual'}));
      openForms.delete('tasks');
    });
    const groups: Array<{status: Ticket['status']; label: string}> = [{status: 'active', label: 'in progress'}, {status: 'todo', label: 'ready'}, {status: 'done', label: 'done'}];
    const children: HTMLElement[] = [];
    for (const group of groups) {
      const tickets = state.tasks.filter(task => task.status === group.status);
      if (tickets.length === 0) continue;
      if (group.status === 'done') {
        const details = h('details', {class: 'coord-group'}, [h('summary', {}, [`${group.label} · ${tickets.length}`]), ...tickets.map(ticketRow)]);
        children.push(details);
      } else {
        children.push(h('div', {class: 'coord-group-label muted'}, [`${group.label} · ${tickets.length}`]), ...tickets.map(ticketRow));
      }
    }
    if (state.tasks.length === 0) children.push(empty('No tickets yet. Add one, or let a spec planner break a document into tickets from setup.'));
    const c = counts();
    return section('tasks', 'tasks', c.tasks ? `${c.active} in progress · ${c.tasks - c.active} ready` : '0', children, form);
  }

  // --- Claims and overlaps ---------------------------------------------------------------------

  function claimsSection(): HTMLElement {
    const lanes = options.lanes().filter(isLive);
    const path = h('input', {type: 'text', placeholder: 'path to claim, e.g. src/auth/', 'aria-label': 'Path to claim'}) as HTMLInputElement;
    const lane = h('select', {'aria-label': 'Lane for this claim'}) as HTMLSelectElement;
    for (const candidate of lanes) lane.append(h('option', {value: candidate.id}, [`${providerShort[candidate.provider]} · ${sessionName(candidate).slice(0, 30)}`]));
    const form = inlineForm([path, lane], 'claim', async () => {
      if (!path.value.trim() || !lane.value) return path.focus();
      await act(async () => {
        const result = await api.claimFile(project, path.value.trim(), lane.value);
        if (!result.granted) showNotice(`overlap — ${result.conflicts.map(conflict => `${conflict.claimedPath} is claimed by ${laneLabel(conflict.sessionId)}`).join(' · ')}`);
        path.value = '';
      });
    });
    const overlapRows = conflicts.map(conflict => h('div', {class: 'coord-row overlap'}, [
      h('span', {class: 'state-dot overlap'}),
      h('div', {class: 'coord-row-body'}, [
        h('div', {class: 'coord-row-title'}, [conflict.overlap === 'same' ? conflict.path : `${conflict.path} ↔ ${conflict.claimedPath}`]),
        h('div', {class: 'coord-row-meta muted'}, [conflict.hotspot ? 'hotspot · ' : '', 'also held by ', laneLink(conflict.sessionId)])
      ])
    ]));
    const claimRows = state.claims.map(claim => {
      const release = button('release', () => void act(() => api.releaseClaim(project, claim.path, claim.sessionId)), {class: 'btn ghost small row-action'});
      return h('div', {class: 'coord-row'}, [
        h('span', {class: `state-dot ${claim.origin}`, title: claim.origin}),
        h('div', {class: 'coord-row-body'}, [
          h('div', {class: 'coord-row-title path'}, [claim.path]),
          h('div', {class: 'coord-row-meta muted'}, [laneLink(claim.sessionId), ` · ${claim.origin}`])
        ]),
        release
      ]);
    });
    const children = [...overlapRows, ...claimRows];
    if (children.length === 0) children.push(empty('No claims. A lane claims a path with `fluent-coord claim`; overlaps show here while both lanes hold them.'));
    return section('claims', 'files', `${state.claims.length} claimed${conflicts.length ? ` · ${conflicts.length} overlap` : ''}`, children, lanes.length ? form : undefined);
  }

  // --- Handoffs ---------------------------------------------------------------------------------

  function handoffsSection(): HTMLElement {
    const lanes = options.lanes().filter(isLive);
    const summary = h('input', {type: 'text', placeholder: 'what should be reviewed', 'aria-label': 'Handoff summary'}) as HTMLInputElement;
    const from = h('select', {'aria-label': 'From lane'}) as HTMLSelectElement;
    const to = h('select', {'aria-label': 'To lane'}) as HTMLSelectElement;
    for (const candidate of lanes) {
      from.append(h('option', {value: candidate.id}, [`from ${providerShort[candidate.provider]} · ${candidate.id.slice(0, 6)}`]));
      to.append(h('option', {value: candidate.id}, [`to ${providerShort[candidate.provider]} · ${candidate.id.slice(0, 6)}`]));
    }
    if (lanes[1]) to.value = lanes[1].id;
    const form = inlineForm([summary, h('div', {class: 'field-row'}, [from, to])], 'request review', async () => {
      if (!summary.value.trim()) return summary.focus();
      if (from.value === to.value) { showNotice('choose two different lanes for a review handoff'); return; }
      await act(() => api.createHandoff(project, from.value, to.value, summary.value.trim()));
    });
    const rows = [...state.handoffs].reverse().slice(0, 12).map(handoff => {
      const open = handoff.status === 'open';
      return h('div', {class: `coord-row handoff-${handoff.status}`}, [
        h('span', {class: `state-dot ${open ? 'open' : handoff.status}`}),
        h('div', {class: 'coord-row-body'}, [
          h('div', {class: 'coord-row-title'}, [handoff.summary]),
          h('div', {class: 'coord-row-meta muted'}, [laneLink(handoff.fromSessionId), ' → ', laneLink(handoff.toSessionId), ` · ${handoff.status}`])
        ]),
        open ? h('span', {class: 'row-actions'}, [
          button(icon('check'), () => void act(() => api.acceptHandoff(project, handoff.id)), {class: 'btn ghost icon-button', 'aria-label': 'accept'}),
          button(icon('x'), () => void act(() => api.declineHandoff(project, handoff.id)), {class: 'btn ghost icon-button', 'aria-label': 'decline'})
        ]) : null
      ]);
    });
    if (rows.length === 0) rows.push(empty('No handoffs. A lane asks another to review with `fluent-coord handoff`.'));
    return section('handoffs', 'handoffs', `${counts().handoffs} open`, rows, lanes.length >= 2 ? form : undefined);
  }

  // --- Messages and memory ----------------------------------------------------------------------

  function messagesSection(): HTMLElement {
    const lanes = options.lanes().filter(isLive);
    const to = h('select', {'aria-label': 'Lane to message'}) as HTMLSelectElement;
    for (const candidate of lanes) to.append(h('option', {value: candidate.id}, [`${providerShort[candidate.provider]} · ${sessionName(candidate).slice(0, 30)}`]));
    const text = h('textarea', {rows: '2', placeholder: 'the lane reads this when it next checks its inbox', 'aria-label': 'Message'}) as HTMLTextAreaElement;
    const form = inlineForm([to, text], 'send', async () => {
      if (!text.value.trim() || !to.value) return text.focus();
      await act(() => api.sendLaneMessage(project, to.value, text.value));
      text.value = '';
    });
    const rows = [...state.messages].reverse().slice(0, 12).map(message => h('div', {class: `coord-row${message.readAt ? '' : ' unread'}`}, [
      h('span', {class: `state-dot ${message.readAt ? 'read' : 'unread'}`}),
      h('div', {class: 'coord-row-body'}, [
        h('div', {class: 'coord-row-title'}, [message.body]),
        h('div', {class: 'coord-row-meta muted'}, [message.from === 'user' ? 'you' : laneLink(message.from), ' → ', laneLink(message.to), ` · ${relativeTime(message.createdAt)}${message.readAt ? '' : ' · unread'}`])
      ])
    ]));
    if (rows.length === 0) rows.push(empty('No messages between lanes yet — an agent sends one with `fluent-coord send`.'));
    return section('messages', 'messages', counts().unread ? `${counts().unread} unread` : String(state.messages.length), rows, lanes.length ? form : undefined);
  }

  function memorySection(): HTMLElement {
    const text = h('input', {type: 'text', placeholder: 'a decision every lane should know', 'aria-label': 'Decision'}) as HTMLInputElement;
    const form = inlineForm([text], 'record', async () => {
      if (!text.value.trim()) return text.focus();
      await act(() => api.addDecision(project, text.value.trim()));
      text.value = '';
    });
    const rows = [...state.decisions].reverse().slice(0, 10).map(decision => h('div', {class: 'coord-row'}, [
      h('span', {class: 'state-dot decision'}),
      h('div', {class: 'coord-row-body'}, [
        h('div', {class: 'coord-row-title'}, [decision.summary || 'decision']),
        h('div', {class: 'coord-row-meta muted'}, [decision.sessionId ? laneLink(decision.sessionId) : 'you', ` · ${relativeTime(decision.createdAt)}`])
      ])
    ]));
    if (rows.length === 0) rows.push(empty('Decisions recorded here are shown to every lane through `fluent-coord status`.'));
    return section('memory', 'memory', String(state.decisions.length), rows, form);
  }

  function activitySection(): HTMLElement {
    const items = retainedCoordinationHistory(state, 10);
    const rows = items.map(item => h('div', {class: 'coord-row activity'}, [
      h('span', {class: 'activity-time muted'}, [Number.isFinite(Date.parse(item.at)) ? relativeTime(item.at) : '—']),
      h('div', {class: 'coord-row-body'}, [h('span', {class: 'muted'}, [item.label, ' · ']), item.detail])
    ]));
    if (rows.length === 0) rows.push(empty('Board changes will show here.'));
    return section('activity', 'activity', String(items.length), rows);
  }

  function verificationSection(): HTMLElement {
    const lanes = options.lanes().filter(isLive);
    const rows = lanes.map(lane => h('div', {class: 'coord-row'}, [
      h('span', {class: `state-dot ${lane.status}`}),
      h('div', {class: 'coord-row-body'}, [h('div', {class: 'coord-row-title'}, [laneLink(lane.id), ' ', h('span', {class: 'muted'}, [sessionName(lane).slice(0, 40)])])]),
      verificationPill(lane.verification)
    ]));
    if (rows.length === 0) rows.push(empty('No running lanes.'));
    return section('verification', 'checks', `${lanes.filter(lane => lane.verification === 'passed').length} verified`, rows);
  }

  // --- Setup tab ---------------------------------------------------------------------------------

  function setupView(): HTMLElement[] {
    const brief = h('textarea', {rows: '6', placeholder: 'Master brief: product goal, constraints, acceptance criteria, relevant links. Every ticket prompt starts with this.', 'aria-label': 'Master brief'}) as HTMLTextAreaElement;
    brief.value = state.masterBrief ?? '';
    const saveBrief = button('save brief', async () => {
      saveBrief.disabled = true;
      try { await act(() => api.setMasterBrief(project, brief.value)); showNotice('master brief saved'); } finally { saveBrief.disabled = false; }
    }, {class: 'btn primary small'});
    const briefSection = h('section', {class: 'coord-section'}, [
      h('header', {class: 'coord-head'}, [h('h3', {}, ['master brief']), h('span', {class: 'coord-meta'}, [state.masterBriefUpdatedAt ? `saved ${relativeTime(state.masterBriefUpdatedAt)}` : 'not set'])]),
      h('div', {class: 'coord-form'}, [brief, h('div', {class: 'actions'}, [saveBrief])])
    ]);

    const specPath = h('input', {type: 'text', placeholder: 'a .md, .txt, or .rst spec', 'aria-label': 'Specification file'}) as HTMLInputElement;
    const browse = button('choose…', async () => {
      const selected = await pickSpecFile('Choose specification document', specPath.value);
      if (selected) specPath.value = selected;
    });
    const plannerProvider = providerSelect('claude', 'Planner provider');
    const launchPlanner = button('start planner', async () => {
      if (!specPath.value.trim()) return specPath.focus();
      launchPlanner.disabled = true;
      try {
        await act(async () => {
          const provider = plannerProvider.value as ProviderId;
          const plannerState = await api.createTask(project, {title: `Plan spec: ${workspaceFolderName(specPath.value)}`, description: `Read and break down the selected specification: ${specPath.value.trim()}`, role: 'master orchestrator', provider, source: 'planner'});
          const plannerTask = plannerState.tasks[0]!;
          const session = await api.createSession({provider, directory: project, task: plannerPrompt(specPath.value.trim(), plannerState.masterBrief), isolate: true});
          store.patch(session);
          await api.assignTask(project, plannerTask.id, {sessionId: session.id, provider, role: 'master orchestrator'});
        });
      } finally { launchPlanner.disabled = false; }
    }, {class: 'btn primary small'});
    const plannerSection = h('section', {class: 'coord-section'}, [
      h('header', {class: 'coord-head'}, [h('h3', {}, ['spec → tickets']), h('span', {class: 'coord-meta'}, ['planner lane'])]),
      h('p', {class: 'muted'}, ['Starts an isolated planner with the file path and the saved brief. It creates a visible planner ticket first and never edits files on its own.']),
      h('div', {class: 'coord-form'}, [h('div', {class: 'field-row'}, [specPath, browse]), h('div', {class: 'field-row'}, [plannerProvider, launchPlanner])])
    ]);

    const missing = skills.filter(skill => !skill.current || skill.mcpConfigured !== true);
    const install = button(skills.some(skill => skill.installed) ? 'update bundle' : 'install bundle', async () => {
      install.disabled = true;
      try { await api.installSkill(); await loadSetup(); draw(); } catch (error) { showActionError(error); } finally { install.disabled = false; }
    }, {class: 'btn small'});
    const skillSection = h('section', {class: 'coord-section'}, [
      h('header', {class: 'coord-head'}, [h('h3', {}, ['collaboration skill']), h('span', {class: 'coord-meta'}, [missing.length === 0 ? 'current' : `${missing.length} missing`])]),
      h('p', {class: 'muted'}, [missing.length === 0
        ? 'Every installed provider has the current skill and the compact MCP coordination tool.'
        : `${missing.map(skill => providerShort[skill.provider]).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing part of the bundle. Installing writes user-scoped skills and MCP configuration only; it never touches this repository.`]),
      h('div', {class: 'actions'}, [install])
    ]);

    const run = evals?.run;
    const spendsDollars = evals?.mode === 'platform-credits' || evals?.mode === 'api-key';
    const runCount = evals?.plan.totalRuns ?? 0;
    const costSentence = spendsDollars
      ? `${runCount} real agent runs on ${evals?.accountLabel ?? 'this credential'}, stopping at a $2 ceiling.`
      : `${runCount} real agent runs against ${evals?.accountLabel ? `${evals.accountLabel}'s` : 'your subscription'} quota — not billed in dollars, so the cost ceiling will not stop it.${evals?.quotaUsedPercent === undefined ? '' : ` The current window is at ${Math.round(evals.quotaUsedPercent)}%.`}`;
    const runEvals = button(evals?.running ? 'eval running…' : 'run evals', async () => {
      if (!(await askConfirm({title: 'run the eval suite', body: costSentence, confirmLabel: 'run evals'}))) return;
      runEvals.disabled = true;
      try { await api.runEvals(2); } catch (error) { showActionError(error); } finally { await loadSetup(); draw(); }
    }, {class: 'btn small'});
    runEvals.disabled = evals?.running ?? true;
    const evalSection = h('section', {class: 'coord-section'}, [
      h('header', {class: 'coord-head'}, [h('h3', {}, ['eval suite']), h('span', {class: 'coord-meta'}, [run ? `${run.casesPassed}/${run.casesTotal} · ${Math.round(run.overallScore * 100)}%` : 'not run'])]),
      h('p', {class: 'muted'}, [run
        ? `${Math.round(run.overallScore * 100)}% overall · $${run.costUsd.toFixed(2)} · ${relativeTime(run.startedAt)}${run.partial ? ' · partial' : ''}${run.ablation === 'with-without' ? ' · Δ is the skill’s contribution' : ''}`
        : 'Measures whether agents actually use the coordination surface. Each case runs with and without the skill.']),
      ...(run ? run.cases.map(result => h('div', {class: 'coord-row'}, [
        h('span', {class: `state-dot ${result.score >= run.threshold ? 'done' : 'overlap'}`}),
        h('div', {class: 'coord-row-body'}, [h('div', {class: 'coord-row-title'}, [result.name]), h('div', {class: 'coord-row-meta muted'}, [`${Math.round(result.score * 100)}% · ${result.runs} runs${result.delta === undefined ? '' : ` · Δ ${result.delta >= 0 ? '+' : ''}${Math.round(result.delta * 100)}`}`])])
      ])) : []),
      h('div', {class: 'actions'}, [runEvals])
    ]);
    return [briefSection, plannerSection, skillSection, evalSection];
  }

  function draw() {
    if (disposed) return;
    boardTab.classList.toggle('active', tab === 'board');
    setupTab.classList.toggle('active', tab === 'setup');
    body.innerHTML = '';
    if (tab === 'board') body.append(tasksSection(), claimsSection(), handoffsSection(), messagesSection(), memorySection(), verificationSection(), activitySection());
    else body.append(...setupView());
  }

  draw();
  return {
    el,
    refresh,
    counts,
    dispose: () => { disposed = true; }
  };
}
