import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {ProviderId, ProviderQuota, QuotaWindow, UsageSnapshot} from './daemon-protocol.js';

type Point = {capturedAt: string; inputTokens?: number; outputTokens?: number; contextPercent?: number; costUsd?: number};
type SessionUsage = {sessionId: string; provider: ProviderId; model?: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; contextPercent?: number; costUsd?: number; cacheHitRatio?: number; quota?: ProviderQuota; updatedAt: string; history: Point[]};

const object = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Merges a sparse quota report into what is already known.
 *
 * Providers send partial updates: Codex's app-server documents its rate-limit payload as a rolling
 * update where a window may simply be absent, and there are periods where only the weekly bucket
 * comes back. Absent has to mean "unchanged" — reading it as "cleared" would tell a user they have
 * full headroom at exactly the moment they do not.
 */
export function mergeQuota(previous: ProviderQuota | undefined, update: Partial<ProviderQuota>): ProviderQuota {
  const window = (before?: QuotaWindow, after?: QuotaWindow) => {
    if (!after) return before;
    if (!before) return after;
    return {
      usedPercent: after.usedPercent ?? before.usedPercent,
      windowMinutes: after.windowMinutes ?? before.windowMinutes,
      resetsAt: after.resetsAt ?? before.resetsAt
    };
  };
  return {
    primary: window(previous?.primary, update.primary),
    secondary: window(previous?.secondary, update.secondary),
    observedAt: update.observedAt ?? new Date().toISOString()
  };
}

export class UsageMonitor {
  private sessions = new Map<string, SessionUsage>();
  private stateFile: string;
  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) { this.stateFile = join(stateDirectory, 'usage.json'); }
  async restore() {
    try { for (const item of JSON.parse(await readFile(this.stateFile, 'utf8')) as SessionUsage[]) this.sessions.set(item.sessionId, item); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  snapshot(): UsageSnapshot { return {sessions: [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))}; }

  get(sessionId: string) { return this.sessions.get(sessionId); }

  /** Quota reported by any provider's own channel, merged rather than replaced (see `mergeQuota`). */
  async recordQuota(sessionId: string, provider: ProviderId, update: Partial<ProviderQuota>) {
    const prior = this.sessions.get(sessionId);
    const now = new Date().toISOString();
    this.sessions.set(sessionId, {
      ...(prior ?? {sessionId, provider, updatedAt: now, history: []}),
      provider,
      quota: mergeQuota(prior?.quota, update),
      updatedAt: now
    });
    await this.persist();
  }

  async recordClaude(sessionId: string, payload: Record<string, unknown>) {
    const context = object(payload.context_window); const cost = object(payload.cost); const model = object(payload.model);
    const limits = object(payload.rate_limits); const five = object(limits.five_hour); const seven = object(limits.seven_day);
    const cache = object(payload.prompt_cache); const now = new Date().toISOString();
    const prior = this.sessions.get(sessionId);
    const point: Point = {capturedAt: now, inputTokens: number(context.total_input_tokens), outputTokens: number(context.total_output_tokens), contextPercent: number(context.used_percentage), costUsd: number(cost.total_cost_usd)};
    // Claude Code's five-hour and seven-day windows are the same two windows Codex calls primary
    // and secondary; naming them by duration is what lets one screen show both providers.
    const quota = mergeQuota(prior?.quota, {
      primary: limits.five_hour ? {usedPercent: number(five.used_percentage), windowMinutes: 300, resetsAt: epoch(five.resets_at)} : undefined,
      secondary: limits.seven_day ? {usedPercent: number(seven.used_percentage), windowMinutes: 10_080, resetsAt: epoch(seven.resets_at)} : undefined,
      observedAt: now
    });
    this.sessions.set(sessionId, {
      sessionId, provider: 'claude', model: typeof model.display_name === 'string' ? model.display_name : prior?.model,
      inputTokens: point.inputTokens, outputTokens: point.outputTokens, contextWindow: number(context.context_window_size), contextPercent: point.contextPercent, costUsd: point.costUsd,
      cacheHitRatio: number(cache.hit_ratio), quota, updatedAt: now,
      history: [...(prior?.history ?? []), point].slice(-60)
    });
    await this.persist();
  }

  private async persist() { await mkdir(dirname(this.stateFile), {recursive: true}); const temporary = `${this.stateFile}.tmp`; await writeFile(temporary, JSON.stringify([...this.sessions.values()], null, 2)); await rename(temporary, this.stateFile); }
}
function epoch(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined; }
