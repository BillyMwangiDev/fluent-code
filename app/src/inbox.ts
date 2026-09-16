// The attention inbox: a bell in the top bar listing lanes that need the user (needs input,
// failed, over budget, finished) and credential notices, newest first. Clicking a row focuses the
// lane or opens credentials, and clears the entry.
import type {SessionAttention} from './api';
import {prefs} from './prefs';
import {navigate} from './router';
import {store, type InboxItem} from './store';
import {button, h, icon, providerLabel, providerShort, relativeTime, sessionName} from './ui';

const attentionLabel: Record<SessionAttention['reason'], string> = {
  finished: 'finished', failed: 'failed', 'needs-input': 'needs you', budget: 'over budget'
};

/** finished lanes still count toward the badge total, but only these make it read as urgent
 * (coral) rather than neutral — a credential notice is always urgent (spec §2.4: "the one thing
 * the user must never miss"). */
function isUrgent(item: InboxItem): boolean {
  return item.kind === 'notice' || item.reason !== 'finished';
}

export function renderInboxButton(): HTMLElement {
  const badge = h('span', {class: 'inbox-badge'});
  const btn = button([icon('bell'), badge], () => openInboxPopover(btn), {class: 'btn ghost icon-button inbox-button', 'aria-label': 'attention inbox', title: 'attention inbox'});
  const sync = () => {
    const items = store.inbox();
    badge.hidden = items.length === 0;
    badge.textContent = items.length ? String(items.length) : '';
    badge.classList.toggle('warn', items.some(isUrgent));
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  // The button is rebuilt with every route render (main.ts wipes and re-renders the topbar); stop
  // polling once it leaves the document rather than leak a subscription per navigation.
  const observer = new MutationObserver(() => {
    if (!btn.isConnected) { unsubscribe(); observer.disconnect(); }
  });
  observer.observe(document.body, {childList: true, subtree: true});
  return btn;
}

function openInboxPopover(anchor: HTMLElement) {
  const dialog = h('dialog', {class: 'menu inbox-pop', 'aria-label': 'attention inbox'});
  const draw = () => {
    dialog.innerHTML = '';
    const items = store.inbox();
    if (items.length === 0) { dialog.append(h('p', {class: 'inbox-empty'}, ['nothing needs you'])); return; }
    for (const item of items) dialog.append(inboxRow(item, dialog));
  };
  draw();
  const unsubscribe = store.subscribe(draw);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { unsubscribe(); dialog.remove(); });
  document.body.append(dialog);
  const rect = anchor.getBoundingClientRect();
  const width = 340;
  dialog.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 8)}px`;
  dialog.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  dialog.showModal();
}

function inboxRow(item: InboxItem, dialog: HTMLDialogElement): HTMLElement {
  if (item.kind === 'lane') {
    const row = h('button', {type: 'button', class: 'inbox-row'}, [
      h('span', {class: 'inbox-row-title'}, [`${providerShort[item.summary.provider]} · ${sessionName(item.summary)}`]),
      h('span', {class: `pill attention-${item.reason}`}, [attentionLabel[item.reason]]),
      h('span', {class: 'muted'}, [relativeTime(item.at)])
    ]);
    row.addEventListener('click', () => {
      dialog.close();
      store.clearAttention(item.sessionId);
      prefs.workspacePath = item.summary.projectDirectory ?? item.summary.directory;
      navigate({name: 'orchestration', focus: item.sessionId});
    });
    return row;
  }
  const notice = item.notice;
  const row = h('button', {type: 'button', class: 'inbox-row'}, [
    h('span', {class: 'inbox-row-title'}, [`${providerLabel[notice.provider]} · ${notice.message}`]),
    h('span', {class: `pill ${notice.kind === 'switched' ? 'attention-finished' : 'attention-needs-input'}`}, [notice.kind === 'switched' ? 'switched' : 'notice']),
    h('span', {class: 'muted'}, [relativeTime(notice.at)])
  ]);
  row.addEventListener('click', () => {
    dialog.close();
    store.dismissNotice(notice.id);
    navigate({name: 'credentials'});
  });
  return row;
}
