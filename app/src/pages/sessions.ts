// --- Session list ------------------------------------------------------------
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';

import type {SessionSummary} from '../api';
import {leadLoad, sessionMatches, sessionTotals, sessionTree, type SessionView} from '../session-tree';

let sessionView: SessionView = 'all';
/** Kept across re-renders so a status update does not wipe what the user typed. */
let sessionQuery = '';

export function setSessionView(view: SessionView) { sessionView = view; }

export async function renderSessions(main: HTMLElement) {
  const [allSessions, chains, usage] = await Promise.all([api.listSessions(true), api.listCredentials(), api.usageSnapshot().catch(() => ({sessions: []}))]);
  const usageBySession = new Map(usage.sessions.map(item => [item.sessionId, item]));
  const sessions = allSessions.filter(session => sessionMatches(session, sessionView, ''));

  const newSessionButton = h('button', {class: 'btn primary'}, ['+ new session']);
  newSessionButton.addEventListener('click', () => navigate({name: 'new-session'}));
  // Bulk actions for the view you are looking at: archive everything finished, or delete every
  // archived record. Each is one confirmation, then the same per-session calls the row buttons use.
  const archivable = allSessions.filter(session => !session.archivedAt && !isLive(session));
  const archiveAll = h('button', {class: 'btn', type: 'button'}, [`archive all finished · ${archivable.length}`]);
  archiveAll.hidden = sessionView === 'archived' || archivable.length === 0;
  archiveAll.addEventListener('click', async () => {
    if (!(await askConfirm({title: 'archive finished sessions', body: `Archive ${archivable.length} finished session${archivable.length === 1 ? '' : 's'}? Running lanes are left alone. Archived records stay local, with their worktrees and project files, until you delete them.`, confirmLabel: `archive ${archivable.length}`}))) return;
    archiveAll.disabled = true;
    const results = await Promise.allSettled(archivable.map(session => api.archiveSession(session.id)));
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed) showActionError(new Error(`${failed} of ${archivable.length} could not be archived.`));
    void refresh();
  });
  const archived = allSessions.filter(session => session.archivedAt);
  const deleteAll = h('button', {class: 'btn danger', type: 'button'}, [`delete all archived · ${archived.length}`]);
  deleteAll.hidden = sessionView !== 'archived' || archived.length === 0;
  deleteAll.addEventListener('click', async () => {
    if (!(await askConfirm({title: 'delete archived session records', body: `Delete the local records of ${archived.length} archived session${archived.length === 1 ? '' : 's'}? Project files and any isolated worktrees stay on disk.`, confirmLabel: `delete ${archived.length}`, danger: true}))) return;
    deleteAll.disabled = true;
    const results = await Promise.allSettled(archived.map(session => api.deleteSession(session.id)));
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed) showActionError(new Error(`${failed} of ${archived.length} could not be deleted.`));
    void refresh();
  });
  const viewButtons = (['all', 'active', 'archived'] as const).map(view => {
    const count = allSessions.filter(session => sessionMatches(session, view, '')).length;
    const button = h('button', {class: `btn${sessionView === view ? ' primary' : ''}`, type: 'button', 'aria-pressed': sessionView === view ? 'true' : 'false'}, [`${view} · ${count}`]);
    button.addEventListener('click', () => { sessionView = view; void refresh(); });
    return button;
  });
  const search = h('input', {type: 'search', value: sessionQuery, placeholder: 'search sessions…', 'aria-label': 'Search sessions'}) as HTMLInputElement;
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), sessionView === 'archived' ? 'archived sessions' : 'sessions']), h('p', {class: 'section-sub'}, [sessionView === 'archived' ? 'Archived session records stay local until you restore or delete them.' : 'Archive finished sessions to clear this list without deleting their worktree or project files.'])]),
      h('div', {class: 'actions'}, [archiveAll, deleteAll, newSessionButton])
    ]),
    h('div', {class: 'session-filters'}, [h('div', {class: 'segmented', role: 'group', 'aria-label': 'Session views'}, viewButtons), search])
  );

  if (sessions.length === 0) {
    main.append(h('div', {class: 'empty-state'}, [sessionView === 'archived' ? 'No archived sessions.' : sessionView === 'active' ? 'No sessions are running.' : 'No sessions yet — start one with "+ new session".']));
    return;
  }

  const table = h('table', {class: 'sessions'});
  table.append(
    h('thead', {}, [h('tr', {}, ['session', 'provider', 'account', 'status', 'tokens', 'checks', 'checkout', 'ready in', 'last active', 'actions'].map(label => h('th', {}, [label])))])
  );
  const rows: Array<{row: HTMLElement; session: SessionSummary; labels: string[]}> = [];
  const tbody = h('tbody');
  for (const {session, depth} of sessionTree(sessions)) {
    const name = session.task?.trim() || session.directory.split('/').filter(Boolean).pop() || session.directory;
    const isLive = session.status === 'running' || session.status === 'starting';
    const actions = h('div', {class: 'session-actions'});
    const archive = h('button', {class: 'btn', type: 'button'}, ['archive']);
    archive.disabled = isLive || Boolean(session.archivedAt);
    archive.addEventListener('click', async event => {
      event.stopPropagation();
      await api.archiveSession(session.id);
      void refresh();
    });
    const restore = h('button', {class: 'btn', type: 'button'}, ['restore']);
    restore.disabled = !session.archivedAt;
    restore.addEventListener('click', async event => {
      event.stopPropagation();
      await api.restoreSession(session.id);
      sessionView = 'all';
      void refresh();
    });
    const remove = h('button', {class: 'btn danger', type: 'button'}, ['delete']);
    remove.disabled = !session.archivedAt;
    remove.addEventListener('click', async event => {
      event.stopPropagation();
      if (!(await askConfirm({title: 'delete session record', body: `Delete the local record for “${name}”? Its project files and any isolated worktree will remain on disk.`, confirmLabel: 'delete', danger: true}))) return;
      await api.deleteSession(session.id);
      void refresh();
    });
    const resume = h('button', {class: 'btn', type: 'button'}, ['resume']);
    resume.hidden = isLive || Boolean(session.archivedAt) || (session.provider !== 'claude' && session.provider !== 'codex');
    resume.addEventListener('click', async event => {
      event.stopPropagation();
      resume.disabled = true;
      try {
        await api.resumeSession(session.id);
        navigate({name: 'active-session', sessionId: session.id});
      } catch (error) {
        showActionError(error);
        resume.disabled = false;
      }
    });
    actions.append(resume, session.archivedAt ? restore : archive, remove);
    const reported = usageBySession.get(session.id);
    const tokens = reported && (reported.inputTokens !== undefined || reported.outputTokens !== undefined)
      ? formatTokens((reported.inputTokens ?? 0) + (reported.outputTokens ?? 0))
      : '—';
    const row = h('tr', {}, [
      h('td', {}, [h('div', {class: `session-name${depth ? ' session-lane' : ''}`}, [
        depth ? `↳ ${name}` : name,
        ...(session.lead ? [h('span', {class: 'pill lead-pill'}, [leadLoad(session, allSessions) ?? 'lead'])] : []),
        ...(session.parentSessionId ? [h('p', {class: 'meta'}, [`started by lead ${session.parentSessionId.slice(0, 8)}`])] : []),
        ...(session.error ? [h('p', {class: 'error'}, [session.error])] : [])
      ])]),
      h('td', {}, [session.model ? `${providerLabel[session.provider]} · ${session.model}` : providerLabel[session.provider]]),
      h('td', {}, [accountLabel(session.accountId, chains)]),
      h('td', {}, [h('span', {class: `pill status-${session.status}`}, [session.status])]),
      h('td', {}, [tokens]),
      h('td', {}, [verificationPill(session.verification)]),
      h('td', {}, [session.worktreePath ? 'isolated' : 'shared']),
      h('td', {title: laneReady(session)}, [session.prepareMs === undefined ? (session.worktreePath ? '—' : 'shared') : session.prepareMs < 1000 ? `${session.prepareMs}ms` : `${(session.prepareMs / 1000).toFixed(1)}s`]),
      h('td', {}, [relativeTime(session.updatedAt)]),
      h('td', {}, [actions])
    ]);
    row.addEventListener('click', () => navigate({name: 'active-session', sessionId: session.id}));
    tbody.append(row);
    rows.push({row, session, labels: [providerLabel[session.provider], accountLabel(session.accountId, chains)]});
  }
  table.append(tbody);
  const noMatches = h('div', {class: 'empty-state'}, ['No sessions match this search.']);
  const footer = h('p', {class: 'section-sub session-footer', role: 'status'}, []);
  // Search hides rows in place, so typing never rebuilds the page or loses the cursor.
  const applySearch = () => {
    sessionQuery = search.value;
    const visible = rows.filter(({row, session, labels}) => {
      row.hidden = !sessionMatches(session, sessionView, sessionQuery, labels);
      return !row.hidden;
    }).map(({session}) => session);
    noMatches.hidden = visible.length > 0;
    const totals = sessionTotals(visible, usageBySession);
    footer.textContent = `${totals.count} session${totals.count === 1 ? '' : 's'} · ${totals.active} active · ${totals.tokens === undefined ? 'no token usage reported' : `${formatTokens(totals.tokens)} tokens reported`}`;
  };
  search.addEventListener('input', applySearch);
  applySearch();
  main.append(table, noMatches, footer);
}
