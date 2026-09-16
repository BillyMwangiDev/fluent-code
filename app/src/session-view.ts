// One lane, full size: a slim header with its identity and state, the terminal taking the plane,
// and a composer underneath. Review actions (merge, checks, checkpoint, diff, worktree, archive)
// sit in one menu so the terminal is never crowded by nine buttons.
import {api, onAdmissionWarning, onCredentialNotice, onCredentialSwitched, onSessionVerification, type MergeOutcome, type MergePlan, type Run, type SessionSummary, type VerificationResult} from './api';
import {navigate, refresh, setRouteCleanup} from './router';
import {leadLoad} from './session-tree';
import {store} from './store';
import {attachLaneTerminal} from './terminal';
import {accountLabel, actionErrorText, askConfirm, button, h, icon, isLive, kbd, openMenu, providerLabel, providerShort, sessionName, showActionError, verificationPill} from './ui';

export async function renderActiveSession(main: HTMLElement, sessionId: string, options: {review?: 'diff'} = {}) {
  const chains = await api.listCredentials().catch(() => []);
  const header = h('header', {class: 'session-head'});
  const banner = h('div', {class: 'session-banner'});
  const review = h('div', {class: 'review-panel'});
  const terminalContainer = h('div', {class: 'session-terminal', id: 'terminal'});
  const lanesPanel = h('div', {class: 'lead-lanes'});
  let currentRun: Run | undefined;
  let laneSessions: SessionSummary[] = [];
  const composer = buildComposer(sessionId);
  const root = h('section', {class: 'session-view'}, [header, banner, lanesPanel, review, terminalContainer, composer]);
  main.append(root);

  /** The lanes this lead started — each a full agent the user can open or stop from here. */
  function refreshLanes(summary: SessionSummary) {
    lanesPanel.innerHTML = '';
    if (!summary.lead) return;
    laneSessions = store.sessions.filter(session => session.parentSessionId === sessionId);
    const running = laneSessions.filter(isLive).length;
    const rows = laneSessions.map(lane => {
      const open = button('open', () => navigate({name: 'active-session', sessionId: lane.id}), {class: 'btn ghost small'});
      const stop = button('stop', async () => { stop.disabled = true; await api.stop(lane.id).catch(showActionError); }, {class: 'btn ghost small'});
      stop.disabled = !isLive(lane);
      return h('div', {class: 'coord-row'}, [
        h('span', {class: `lane-dot status-${lane.status}`}),
        h('div', {class: 'coord-row-body'}, [h('div', {class: 'coord-row-title'}, [`${providerShort[lane.provider]} · ${sessionName(lane)}`]), h('div', {class: 'coord-row-meta muted'}, [lane.status])]),
        h('span', {class: 'row-actions'}, [open, stop])
      ]);
    });
    lanesPanel.append(h('details', {class: 'lead-lanes-block', open: ''}, [
      h('summary', {}, [`lanes started by this lead · ${running}/${summary.lead.maxLanes} running`]),
      ...(rows.length ? rows : [h('p', {class: 'muted coord-empty'}, ['This lead has not started any lanes yet. It starts one with `fluent-coord lane start`.'])])
    ]));
  }

  function closeReview() { review.innerHTML = ''; }
  async function showDiff() {
    try {
      const diff = await api.sessionDiff(sessionId);
      reviewCard('Git change review', diff.status, [diff.patch ? h('pre', {class: 'diff'}, [diff.patch + (diff.truncated ? '\n\n… diff truncated' : '')]) : h('p', {class: 'muted'}, ['No tracked-file diff. Untracked files, if any, are listed above.'])]);
    } catch (error) { showActionError(error); }
  }
  function reviewCard(title: string, subtitle: string | undefined, body: HTMLElement[], actions: HTMLElement[] = []) {
    review.innerHTML = '';
    review.append(h('div', {class: 'review-card'}, [
      h('div', {class: 'review-head'}, [h('div', {}, [h('h3', {}, [title]), subtitle ? h('p', {class: 'muted'}, [subtitle]) : null]), h('div', {class: 'actions'}, [...actions, button(icon('x'), closeReview, {class: 'btn ghost icon-button', 'aria-label': 'close'})])]),
      ...body
    ]));
  }

  function showMergePlan(plan: MergePlan) {
    const blocked = plan.blockers.length > 0 || plan.conflicts.length > 0;
    const confirm = button(`merge into ${plan.base}`, async () => {
      confirm.disabled = true;
      try { showMergeOutcome(await api.mergeIntegrate(sessionId)); } catch (error) { review.append(h('p', {class: 'error'}, [actionErrorText(error)])); }
    }, {class: 'btn primary'});
    confirm.disabled = blocked;
    reviewCard(blocked ? 'this lane cannot merge yet' : `merge into ${plan.base}`,
      `${plan.ahead} commit${plan.ahead === 1 ? '' : 's'} ahead · ${plan.uncommittedFiles} uncommitted file${plan.uncommittedFiles === 1 ? '' : 's'} · checks run before anything merges`,
      [
        ...plan.blockers.map(blocker => h('p', {class: 'error'}, [blocker])),
        ...(plan.conflicts.length > 0 ? [h('p', {class: 'error'}, [`git predicts ${plan.conflicts.length} conflicting file${plan.conflicts.length === 1 ? '' : 's'}. Resolve them in the lane, then try again — fluentd will not resolve them for you.`]), h('pre', {class: 'diff'}, [plan.conflicts.join('\n')])] : [])
      ], [confirm]);
  }
  function showMergeOutcome(outcome: MergeOutcome) {
    reviewCard(outcome.status === 'merged' ? 'merged' : `not merged — ${outcome.status}`, undefined, [
      h('p', {class: outcome.status === 'merged' ? 'muted' : 'error'}, [outcome.detail]),
      ...(outcome.verification?.output && outcome.status === 'unverified' ? [h('pre', {class: 'diff'}, [outcome.verification.output])] : [])
    ]);
  }
  function showVerification(result: VerificationResult) {
    const heading = {running: 'checks running', passed: 'checks passed', failed: 'checks failed', unavailable: 'no checks to run'}[result.status];
    reviewCard(heading, result.command ? `${result.command} · ${result.source} · ${(result.durationMs / 1000).toFixed(1)}s` : result.detail, [
      ...result.warnings.map(warning => h('p', {class: 'error'}, [warning])),
      result.output ? h('pre', {class: 'diff'}, [result.output]) : h('p', {class: 'muted'}, ['The check produced no output.'])
    ]);
  }

  function showBanner(message: string, onSwitch?: () => void, recommendation?: 'switch' | 'wait') {
    banner.innerHTML = '';
    const actions = h('div', {class: 'actions'});
    if (onSwitch) {
      const preferWaiting = recommendation === 'wait';
      actions.append(
        button(preferWaiting ? 'switch anyway' : 'switch now', () => { onSwitch(); banner.innerHTML = ''; }, {class: preferWaiting ? 'btn' : 'btn primary'}),
        button('keep waiting', () => { banner.innerHTML = ''; }, {class: preferWaiting ? 'btn primary' : 'btn'})
      );
    } else actions.append(button(icon('x'), () => { banner.innerHTML = ''; }, {class: 'btn ghost icon-button', 'aria-label': 'dismiss'}));
    banner.append(h('div', {class: 'banner'}, [h('span', {}, [message]), actions]));
  }

  function renderHeader(summary: SessionSummary) {
    header.innerHTML = '';
    refreshLanes(summary);
    const name = sessionName(summary);
    const live = isLive(summary);
    const back = button([icon('chevron'), 'lanes'], () => navigate({name: 'orchestration', focus: summary.id}), {class: 'btn ghost back-link', title: 'back to the workspace'});
    const stop = button('stop', () => void api.stop(sessionId), {class: 'btn'});
    stop.disabled = summary.status !== 'running';
    const resume = button('resume', async () => {
      resume.disabled = true;
      try { await api.resumeSession(summary); void refresh(); } catch (error) { showActionError(error); resume.disabled = false; }
    }, {class: 'btn primary'});
    resume.hidden = live || Boolean(summary.archivedAt) || (summary.provider !== 'claude' && summary.provider !== 'codex');
    const more = button([icon('more'), 'actions'], () => openMenu(more, [
      {label: 'review changes (diff)', onSelect: () => void showDiff()},
      {label: 'run checks', onSelect: async () => { try { showVerification(await api.verifySession(sessionId)); } catch (error) { showActionError(error); } }},
      {label: 'merge lane…', disabled: !summary.worktreePath, onSelect: async () => { try { showMergePlan(await api.mergePlan(sessionId)); } catch (error) { showActionError(error); } }},
      {label: 'record checkpoint', disabled: !currentRun, onSelect: async () => {
        try {
          const saved = await api.checkpointRun(sessionId);
          if (currentRun && saved) currentRun = {...currentRun, checkpoint: saved};
          renderHeader(summary);
          reviewCard('checkpoint recorded', saved?.gitRef ? `${saved.gitRef.slice(0, 12)} · working tree ${saved.workingTree}` : `repository reference unavailable · working tree ${saved?.workingTree ?? 'unknown'}`, [h('p', {class: 'muted'}, ['This is a durable review marker only. Fluent did not commit, stash, reset, or automatically resume the provider session.'])]);
        } catch (error) { showActionError(error); }
      }},
      'divider',
      {label: 'remove worktree', disabled: !summary.worktreePath || live, onSelect: async () => {
        if (!(await askConfirm({title: 'remove worktree', body: 'Remove this stopped agent worktree? Uncommitted work is saved to the project first and stays restorable, but Git-ignored files in it — caches, and any local config carried in by .worktreeinclude — are deleted for good.', confirmLabel: 'remove worktree', danger: true}))) return;
        try { await api.removeWorktree(sessionId); void refresh(); } catch (error) { showActionError(error); }
      }},
      summary.archivedAt
        ? {label: 'restore session', onSelect: async () => { await api.restoreSession(sessionId); navigate({name: 'sessions'}); }}
        : {label: 'archive session', disabled: live, onSelect: async () => { await api.archiveSession(sessionId); navigate({name: 'sessions'}); }},
      {label: 'delete session record', danger: true, disabled: !summary.archivedAt, onSelect: async () => {
        if (!(await askConfirm({title: 'delete session record', body: `Delete the local record for “${name}”? Its project files and any isolated worktree will remain on disk.`, confirmLabel: 'delete', danger: true}))) return;
        await api.deleteSession(sessionId);
        navigate({name: 'sessions'});
      }}
    ]), {class: 'btn'});
    const pills = h('div', {class: 'session-pills'}, [
      h('span', {class: `lane-dot status-${summary.status}`, title: summary.status}),
      h('span', {class: 'pill'}, [summary.model ? `${providerLabel[summary.provider]} · ${summary.model}` : providerLabel[summary.provider]]),
      summary.accountId ? h('span', {class: 'pill'}, [accountLabel(summary.accountId, chains)]) : null,
      summary.permissionMode ? h('span', {class: 'pill'}, [`permission · ${summary.permissionMode}`]) : null,
      h('span', {class: `pill status-${summary.status}`}, [summary.status]),
      summary.lead ? h('span', {class: 'pill lead-pill'}, [leadLoad(summary, laneSessions) ?? 'lead']) : null,
      summary.parentSessionId ? button(`started by lead ${summary.parentSessionId.slice(0, 8)}`, () => navigate({name: 'active-session', sessionId: summary.parentSessionId!}), {class: 'btn pill-button'}) : null,
      currentRun ? h('span', {class: `pill status-${currentRun.state}`}, [`run · ${currentRun.state}${currentRun.delivery === 'unknown' ? ' · delivery review' : ''}`]) : null,
      currentRun?.checkpoint ? h('span', {class: 'pill'}, [`checkpoint · ${currentRun.checkpoint.gitRef?.slice(0, 8) ?? 'no git ref'} · ${currentRun.checkpoint.workingTree}`]) : null,
      summary.verification ? verificationPill(summary.verification) : null,
      summary.worktreeSnapshot ? h('span', {class: 'pill', title: `restore with: git worktree add <path> ${summary.worktreeSnapshot.ref}`}, [`snapshot · ${summary.worktreeSnapshot.commit.slice(0, 8)}`]) : null,
      h('span', {class: 'session-dir muted'}, [summary.worktreePath ? `isolated · ${summary.directory}` : summary.directory])
    ]);
    header.append(
      h('div', {class: 'session-ident'}, [
        h('div', {class: 'session-title-row'}, [back, h('h1', {class: 'session-title'}, [name])]),
        summary.error ? h('p', {class: 'error'}, [summary.error]) : null,
        pills
      ]),
      h('div', {class: 'actions'}, [more, resume, stop])
    );
  }

  const lane = await attachLaneTerminal(sessionId, terminalContainer, {
    onStatus: summary => {
      store.patch(summary);
      void api.getRun(sessionId).then(run => { currentRun = run; renderHeader(summary); }, () => renderHeader(summary));
    }
  });
  setRouteCleanup(main, lane.dispose);
  const initial = lane.snapshot;
  currentRun = await api.getRun(sessionId).catch(() => undefined);
  renderHeader(initial);
  store.clearAttention(sessionId);
  if (options.review === 'diff') void showDiff();
  const unsubscribeStore = store.subscribe(() => { const latest = store.get(sessionId); if (latest?.lead) refreshLanes(latest); });

  const unlistenNotice = await onCredentialNotice(event => {
    if (event.provider !== initial.provider) return;
    showBanner(event.message, () => { void api.confirmFallback(event.provider, true, event.resetAt); }, event.guidance?.recommendation);
  });
  const unlistenVerification = await onSessionVerification(event => { if (event.sessionId === sessionId) showVerification(event.result); });
  const unlistenAdmission = await onAdmissionWarning(event => { if (event.sessionId === sessionId) showBanner(`started without headroom — ${event.verdict.reasons[0]}`); });
  const unlistenSwitched = await onCredentialSwitched(event => { if (event.provider === initial.provider) showBanner(`switched to ${accountLabel(event.accountId, chains)} (${event.reason})`); });

  setRouteCleanup(main, () => {
    unsubscribeStore();
    unlistenNotice();
    unlistenSwitched();
    unlistenVerification();
    unlistenAdmission();
  });
  if (isLive(initial)) lane.focus();
}

function buildComposer(sessionId: string): HTMLElement {
  const input = h('textarea', {class: 'composer-input', rows: '1', placeholder: 'message this lane…', 'aria-label': 'Context to inject'}) as HTMLTextAreaElement;
  const hint = h('span', {class: 'composer-hint muted'}, [kbd('↵'), ' send ', kbd('⇧↵'), ' line']);
  const submit = h('input', {type: 'checkbox', checked: ''}) as HTMLInputElement;
  const status = h('span', {class: 'composer-status muted', role: 'status'});
  const send = h('button', {type: 'button', class: 'btn primary composer-send'}, [icon('send'), 'send']);
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
  input.addEventListener('input', grow);
  const deliver = async () => {
    const text = input.value;
    if (!text.trim()) return input.focus();
    send.disabled = true;
    status.className = 'composer-status muted';
    status.textContent = 'sending…';
    try {
      await api.inject(sessionId, text, submit.checked);
      status.textContent = submit.checked ? 'sent and submitted' : 'pasted';
      input.value = '';
      grow();
    } catch (error) {
      status.className = 'composer-status error';
      status.textContent = actionErrorText(error);
    } finally {
      send.disabled = false;
      window.setTimeout(() => { if (!status.classList.contains('error')) status.textContent = ''; }, 4000);
    }
  };
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void deliver(); } });
  send.addEventListener('click', () => void deliver());
  const form = h('form', {class: 'composer'}, [h('div', {class: 'composer-row'}, [status]), h('div', {class: 'composer-row'}, [h('div', {class: 'composer-field'}, [input, hint]), h('label', {class: 'check-label composer-submit'}, [submit, ' enter']), send])]);
  form.addEventListener('submit', event => event.preventDefault());
  return form;
}
