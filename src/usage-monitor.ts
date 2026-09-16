import {dirname, join} from 'node:path';
import type {ProviderId, ProviderQuota, QuotaWindow, UsageSnapshot} from './daemon-protocol.js';
import type {CostSource, ModelRate} from './spend-tracker.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';

type Point = {capturedAt: string; inputTokens?: number; outputTokens?: number; contextPercent?: number; costUsd?: number};
type SessionUsage = {sessionId: string; provider: ProviderId; model?: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; contextPercent?: number; costUsd?: number; costSource?: CostSource; cacheHitRatio?: number; quota?: ProviderQuota; updatedAt: string; history: Point[]};

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
  /** Same override-then-LiteLLM-table lookup the spend page prices a transcript against, so a
   * lane's live cost estimate and its later 30-day summary never disagree about a model's price. */
  constructor(
    stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent'),
    private readonly rateForModel?: (model: string) => ModelRate | undefined
  ) { this.stateFile = join(stateDirectory, 'usage.json'); }
  async restore() {
    try {
      const stored = await readPrivateJson<SessionUsage[]>(this.stateFile);
      if (!stored) return;
      for (const item of stored) this.sessions.set(item.sessionId, item);
    }
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
    const modelName = typeof model.display_name === 'string' ? model.display_name : prior?.model;
    const inputTokens = number(context.total_input_tokens);
    const outputTokens = number(context.total_output_tokens);
    const {costUsd, costSource} = this.priceUsage(modelName, inputTokens, outputTokens, number(cost.total_cost_usd));
    const point: Point = {capturedAt: now, inputTokens, outputTokens, contextPercent: number(context.used_percentage), costUsd};
    // Claude Code's five-hour and seven-day windows are the same two windows Codex calls primary
    // and secondary; naming them by duration is what lets one screen show both providers.
    const quota = mergeQuota(prior?.quota, {
      primary: limits.five_hour ? {usedPercent: number(five.used_percentage), windowMinutes: 300, resetsAt: epoch(five.resets_at)} : undefined,
      secondary: limits.seven_day ? {usedPercent: number(seven.used_percentage), windowMinutes: 10_080, resetsAt: epoch(seven.resets_at)} : undefined,
      observedAt: now
    });
    this.sessions.set(sessionId, {
      sessionId, provider: 'claude', model: modelName,
      inputTokens: point.inputTokens, outputTokens: point.outputTokens, contextWindow: number(context.context_window_size), contextPercent: point.contextPercent, costUsd: point.costUsd, costSource,
      cacheHitRatio: number(cache.hit_ratio), quota, updatedAt: now,
      history: [...(prior?.history ?? []), point].slice(-60)
    });
    await this.persist();
  }

  /** Reported cost wins when Claude Code sends one. Otherwise, with tokens and a known rate, the
   * cost is estimated from them; with tokens but no rate it is unpriced rather than guessed at
   * zero. Codex has no equivalent live figure to price here: its app-server reports rate-limit
   * windows only (see codex-app-server.ts), never a per-turn token count, so a Codex lane's cost
   * stays unset until the app-server documents one — never invented from nothing. */
  private priceUsage(model: string | undefined, inputTokens: number | undefined, outputTokens: number | undefined, reportedCostUsd: number | undefined): {costUsd?: number; costSource?: CostSource} {
    if (reportedCostUsd !== undefined) return {costUsd: reportedCostUsd, costSource: 'providerReported'};
    if (inputTokens === undefined && outputTokens === undefined) return {};
    const rate = model ? this.rateForModel?.(model) : undefined;
    if (!rate) return {costSource: 'unpriced'};
    return {costUsd: (inputTokens ?? 0) * rate.inputCostPerToken + (outputTokens ?? 0) * rate.outputCostPerToken, costSource: 'modelPriced'};
  }

  private async persist() { await writePrivateJson(this.stateFile, [...this.sessions.values()]); }
}
function epoch(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined; }
