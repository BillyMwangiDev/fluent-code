// One live picture of every session, shared by the rail, the workspace, and the session list.
// fluentd pushes a session's status only to sockets subscribed to that session, so lanes started
// elsewhere (a lead, another window) surface through a short poll while anything is listening.
import {api, onSessionAttention, type SessionAttention, type SessionSummary, type UsageSnapshot} from './api';

export type LaneUsage = UsageSnapshot['sessions'][number];
type Listener = () => void;

const pollMs = 4_000;
const usagePollMs = 8_000;

class SessionStore {
  sessions: SessionSummary[] = [];
  usage = new Map<string, LaneUsage>();
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
      const snapshot = await api.usageSnapshot();
      this.usage = new Map(snapshot.sessions.map(item => [item.sessionId, item]));
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

  get(sessionId: string) { return this.sessions.find(session => session.id === sessionId); }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

export const store = new SessionStore();

void onSessionAttention(attention => store.markAttention(attention)).catch(() => undefined);
