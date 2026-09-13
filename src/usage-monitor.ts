import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {UsageSnapshot} from './daemon-protocol.js';

type Point = {capturedAt: string; inputTokens?: number; outputTokens?: number; contextPercent?: number; costUsd?: number};
type SessionUsage = {sessionId: string; provider: 'claude'; model?: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; contextPercent?: number; costUsd?: number; cacheHitRatio?: number; fiveHourPercent?: number; fiveHourResetsAt?: string; sevenDayPercent?: number; sevenDayResetsAt?: string; updatedAt: string; history: Point[]};

export class UsageMonitor {
  private sessions = new Map<string, SessionUsage>();
  private stateFile: string;
  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) { this.stateFile = join(stateDirectory, 'usage.json'); }
  async restore() {
    try { for (const item of JSON.parse(await readFile(this.stateFile, 'utf8')) as SessionUsage[]) this.sessions.set(item.sessionId, item); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  snapshot(): UsageSnapshot { return {sessions: [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))}; }
  async recordClaude(sessionId: string, payload: Record<string, unknown>) {
    const object = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const context = object(payload.context_window); const cost = object(payload.cost); const model = object(payload.model);
    const limits = object(payload.rate_limits); const five = object(limits.five_hour); const seven = object(limits.seven_day);
    const cache = object(payload.prompt_cache); const now = new Date().toISOString();
    const prior = this.sessions.get(sessionId);
    const point: Point = {capturedAt: now, inputTokens: number(context.total_input_tokens), outputTokens: number(context.total_output_tokens), contextPercent: number(context.used_percentage), costUsd: number(cost.total_cost_usd)};
    this.sessions.set(sessionId, {
      sessionId, provider: 'claude', model: typeof model.display_name === 'string' ? model.display_name : prior?.model,
      inputTokens: point.inputTokens, outputTokens: point.outputTokens, contextWindow: number(context.context_window_size), contextPercent: point.contextPercent, costUsd: point.costUsd,
      cacheHitRatio: number(cache.hit_ratio), fiveHourPercent: number(five.used_percentage), fiveHourResetsAt: epoch(five.resets_at), sevenDayPercent: number(seven.used_percentage), sevenDayResetsAt: epoch(seven.resets_at), updatedAt: now,
      history: [...(prior?.history ?? []), point].slice(-60)
    });
    await this.persist();
  }
  private async persist() { await mkdir(dirname(this.stateFile), {recursive: true}); const temporary = `${this.stateFile}.tmp`; await writeFile(temporary, JSON.stringify([...this.sessions.values()], null, 2)); await rename(temporary, this.stateFile); }
}
function epoch(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined; }
