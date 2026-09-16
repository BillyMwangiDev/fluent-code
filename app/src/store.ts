// One live picture of every session, shared by the rail, the workspace, and the session list.
// fluentd pushes a session's status only to sockets subscribed to that session, so lanes started
// elsewhere (a lead, another window) surface through a short poll while anything is listening.
import {api, onCredentialNotice, onCredentialSwitched, onSessionAttention, type CredentialChainState, type ProviderId, type SessionAttention, type SessionSummary, type UsageSnapshot} from './api';

export type LaneUsage = UsageSnapshot['sessions'][number];
/** A credential limit hit or a fallback taken, kept until the user dismisses it — the one thing
 * the attention inbox must never let the user miss (spec §2.4). */
export type Notice = {id: string; at: string; provider: ProviderId; message: string; resetAt?: string; kind: 'notice' | 'switched'};
/** What the top-bar inbox lists: lanes waiting on the user plus credential notices, newest first. */
export type InboxItem =
  | {kind: 'lane'; sessionId: string; reason: SessionAttention['reason']; at: string; summary: SessionSummary; detail?: string}
  | {kind: 'notice'; notice: Notice};

function inboxAt(item: InboxItem): string {
  return item.kind === 'lane' ? item.at : item.notice.at;
}

type Listener = () => void;

const pollMs = 4_000;
const usagePollMs = 8_000;

class SessionStore {
  sessions: SessionSummary[] = [];
  usage = new Map<string, LaneUsage>();
  /** Every provider's credential chain, refreshed alongside usage so the limits strip's account
   * labels stay current without a poll of its own. */
  chains: CredentialChainState[] = [];
  notices: Notice[] = [];
  /** Lanes that finished, failed, or asked for the user, until the user looks at them. */
  attention = new Map<string, SessionAttention>();
  loaded = false;
  private listeners = new Set<Listener>();
  private timer: number | undefined;
  private usageTimer: number | undefined;
  private inflight: Promise<void> | undefined;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start() {
    void this.refresh();
    void this.refreshUsage();
    this.timer = window.setInterval(() => void this.refresh(), pollMs);
    this.usageTimer = window.setInterval(() => void this.refreshUsage(), usagePollMs);
  }

  private stop() {
    if (this.timer) window.clearInterval(this.timer);
    if (this.usageTimer) window.clearInterval(this.usageTimer);
    this.timer = undefined;
    this.usageTimer = undefined;
  }

  /** Re-reads the session list. Concurrent callers share one request. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = api.listSessions(true).then(sessions => {
      this.sessions = sessions;
      this.loaded = true;
      this.notify();
    }, () => undefined).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  async refreshUsage() {
    try {
      const [snapshot, chains] = await Promise.all([api.usageSnapshot(), api.listCredentials().catch(() => this.chains)]);
      this.usage = new Map(snapshot.sessions.map(item => [item.sessionId, item]));
      this.chains = chains;
      this.notify();
    } catch { /* telemetry is optional; a lane without it just shows no tokens */ }
  }

  /** Folds a pushed status into the list without waiting for the next poll. */
  patch(summary: SessionSummary) {
    const index = this.sessions.findIndex(session => session.id === summary.id);
    if (index === -1) this.sessions = [...this.sessions, summary];
    else this.sessions = this.sessions.map(session => session.id === summary.id ? summary : session);
    this.notify();
  }

  markAttention(attention: SessionAttention) {
    this.attention.set(attention.sessionId, attention);
    this.patch(attention.summary);
  }

  clearAttention(sessionId: string) {
    if (!this.attention.delete(sessionId)) return;
    this.notify();
  }

  addNotice(notice: Omit<Notice, 'id' | 'at'>) {
    this.notices = [{id: `notice-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, at: new Date().toISOString(), ...notice}, ...this.notices];
    this.notify();
  }

  dismissNotice(id: string) {
    const next = this.notices.filter(notice => notice.id !== id);
    if (next.length === this.notices.length) return;
    this.notices = next;
    this.notify();
  }

  /** Lanes waiting on the user plus credential notices, newest first — backs the top-bar inbox. */
  inbox(): InboxItem[] {
    const laneItems: InboxItem[] = [...this.attention.values()].map(attention => ({kind: 'lane', sessionId: attention.sessionId, reason: attention.reason, at: attention.summary.updatedAt, summary: attention.summary, detail: attention.detail}));
    const noticeItems: InboxItem[] = this.notices.map(notice => ({kind: 'notice', notice}));
    return [...laneItems, ...noticeItems].sort((a, b) => inboxAt(b).localeCompare(inboxAt(a)));
  }

  get(sessionId: string) { return this.sessions.find(session => session.id === sessionId); }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

export const store = new SessionStore();

void onSessionAttention(attention => store.markAttention(attention)).catch(() => undefined);
void onCredentialNotice(event => store.addNotice({provider: event.provider, message: event.message, resetAt: event.resetAt, kind: 'notice'})).catch(() => undefined);
void onCredentialSwitched(event => store.addNotice({provider: event.provider, message: `switched to ${event.accountId} · ${event.reason}`, kind: 'switched'})).catch(() => undefined);
