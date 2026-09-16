import {readFile, readdir, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import type {ProviderId} from './daemon-protocol.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';

/**
 * Token/cost telemetry, forked from T3 Code's usage system (github.com/pingdotgg/t3code,
 * apps/server/src/usage/*, MIT licensed): it scans the provider CLIs' own on-disk session
 * transcripts rather than depending on Fluent's own orchestration, so a session run outside
 * Fluent entirely still counts. Ported to plain TypeScript (no Effect-TS — Fluent doesn't use
 * it) and trimmed to the two providers Fluent supports (T3 also reads Grok).
 *
 * Like T3, it never re-reads a transcript it has already parsed: each file's usage records are
 * kept in memory keyed by size and mtime, so a summary over a 2 GB corpus costs one stat per file
 * after the first pass. The first pass runs in the background shortly after fluentd starts, so
 * the spend screen is fast on its first open too. Parsing yields to the event loop every few
 * thousand lines so a big transcript cannot stall the daemon's socket.
 */

export type TokenTotals = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

function emptyTotals(): TokenTotals {
  return {uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0};
}

function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens
  };
}

/** reasoningTokens is a subset of outputTokens and must not be added again. */
function totalTokens(totals: TokenTotals): number {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens;
}

type UsageRecord = {
  provider: ProviderId;
  timestampMs: number;
  model: string;
  sessionId: string;
  totals: TokenTotals;
  reportedCostUsd: number | null;
  dedupeKey: string | null;
};

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Claude Code writes one transcript line per assistant *content block*, and every block in a
 * message repeats that message's complete `usage` object — summing them naively overcounts by
 * roughly 2.4x. Callers must dedupe by `dedupeKey` (message id : request id) and keep the first.
 */
function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'assistant') return null;

  const message = record.message;
  if (typeof message !== 'object' || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  const usage = messageRecord.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;
  const model = typeof messageRecord.model === 'string' ? messageRecord.model : '';
  if (model.length === 0) return null;

  const messageId = typeof messageRecord.id === 'string' ? messageRecord.id : null;
  const requestId = typeof record.requestId === 'string' ? record.requestId : null;
  const dedupeKey = messageId === null && requestId === null ? null : `${messageId ?? ''}:${requestId ?? ''}`;
  const cost = record.costUSD;

  return {
    provider: 'claude',
    timestampMs,
    model,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    totals: {
      uncachedInputTokens: int(usageRecord.input_tokens),
      cachedInputTokens: int(usageRecord.cache_read_input_tokens),
      cacheCreationTokens: int(usageRecord.cache_creation_input_tokens),
      outputTokens: int(usageRecord.output_tokens),
      reasoningTokens: 0 // Anthropic folds thinking tokens into output and does not break them out.
    },
    reportedCostUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    dedupeKey
  };
}

/** Rolling state for one Codex rollout file — Codex's `token_count` events carry no model, so
 * the model rides forward from the most recent `turn_context`. */
type CodexScanState = {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
};

function initialCodexScanState(): CodexScanState {
  return {model: '', sessionId: '', lastUsageSignature: null, sawSessionMeta: false, suppressingForkCopies: false, forkCopyAnchorMs: 0};
}

/** A forked/subagent rollout opens with the parent's full history re-stamped to the fork
 * instant, written in one synchronous burst; the child's first genuine usage event only lands
 * after a real model turn (observed 5s+). 1s of separation splits the two cleanly. */
const FORK_COPY_MAX_GAP_MS = 1_000;

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === 'string') return true;
  const source = payload.source;
  if (typeof source !== 'object' || source === null) return false;
  const subagent = (source as Record<string, unknown>).subagent;
  if (typeof subagent !== 'object' || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>).thread_spawn;
  if (typeof spawn !== 'object' || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>).parent_thread_id === 'string';
}

function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;

  if (record.type === 'session_meta') {
    if (state.sawSessionMeta) return null; // only the first meta describes this file's own session
    state.sawSessionMeta = true;
    const id = payloadRecord.id ?? payloadRecord.session_id;
    if (typeof id === 'string') state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record.timestamp);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record.type === 'turn_context') {
    if (typeof payloadRecord.model === 'string') state.model = payloadRecord.model;
    return null;
  }

  if (payloadRecord.type !== 'token_count') return null;
  const info = payloadRecord.info;
  if (typeof info !== 'object' || info === null) return null;
  const last = (info as Record<string, unknown>).last_token_usage;
  if (typeof last !== 'object' || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null; // a token_count before its turn_context has no model yet

  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null; // Codex re-emits unchanged token_count on some stream boundaries
  state.lastUsageSignature = signature;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(lastRecord.input_tokens);
  const cachedInputTokens = int(lastRecord.cached_input_tokens);
  const cacheCreationTokens = int(lastRecord.cache_write_input_tokens);
  const outputTokens = int(lastRecord.output_tokens);
  const totals: TokenTotals = {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(lastRecord.reasoning_output_tokens))
  };
  if (totalTokens(totals) === 0) return null;

  return {provider: 'codex', timestampMs, model: state.model, sessionId: state.sessionId, totals, reportedCostUsd: null, dedupeKey: null};
}

// --- Transcript discovery ---------------------------------------------------------------

async function listFilesRecursive(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) found.push(path);
    }
  }
  await walk(root);
  return found;
}

type TranscriptFile = {path: string; size: number; mtimeMs: number};
type ParsedTranscript = {size: number; mtimeMs: number; records: UsageRecord[]};
type TranscriptCache = Map<string, ParsedTranscript>;

const parseConcurrency = 2;
const yieldEveryLines = 2_000;

async function transcriptFiles(root: string): Promise<TranscriptFile[]> {
  const files = await listFilesRecursive(root);
  const withStats = await Promise.all(
    files.map(async path => {
      try {
        const details = await stat(path);
        return {path, size: details.size, mtimeMs: details.mtimeMs};
      } catch {
        return null;
      }
    })
  );
  return withStats.filter((entry): entry is TranscriptFile => entry !== null);
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

async function mapWithConcurrency<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/**
 * Records for every transcript under `root` touched since `sinceMs`, re-reading only the files
 * whose size or mtime changed since they were last parsed. Files that have disappeared leave the
 * cache; files outside the window stay cached for a wider window later.
 */
async function scanWithCache(root: string, sinceMs: number, cache: TranscriptCache, parse: (content: string) => Promise<UsageRecord[]>): Promise<{records: UsageRecord[]; parsedFiles: number; parsedBytes: number}> {
  const files = await transcriptFiles(root);
  const present = new Set(files.map(file => file.path));
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
  const wanted = files.filter(file => file.mtimeMs >= sinceMs);
  const stale = wanted.filter(file => {
    const cached = cache.get(file.path);
    return !cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs;
  });
  let parsedBytes = 0;
  await mapWithConcurrency(stale, parseConcurrency, async file => {
    try {
      const content = await readFile(file.path, 'utf8');
      parsedBytes += content.length;
      cache.set(file.path, {size: file.size, mtimeMs: file.mtimeMs, records: await parse(content)});
    } catch {
      cache.delete(file.path);
    }
  });
  const records: UsageRecord[] = [];
  for (const file of wanted) {
    const cached = cache.get(file.path);
    if (!cached) continue;
    for (const record of cached.records) if (record.timestampMs >= sinceMs) records.push(record);
  }
  return {records, parsedFiles: stale.length, parsedBytes};
}

async function parseClaudeTranscript(content: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let lines = 0;
  for (const line of content.split('\n')) {
    if (++lines % yieldEveryLines === 0) await yieldToEventLoop();
    if (!line.includes('"usage"')) continue; // cheap gate before JSON.parse
    const record = parseClaudeLine(line);
    if (!record) continue;
    if (record.dedupeKey) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    records.push(record);
  }
  return records;
}

async function parseCodexTranscript(content: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const state = initialCodexScanState();
  let lines = 0;
  for (const line of content.split('\n')) {
    if (++lines % yieldEveryLines === 0) await yieldToEventLoop();
    if (!line.includes('"token_count"')) continue;
    const record = parseCodexLine(line, state);
    if (record) records.push(record);
  }
  return records;
}

const claudeCache: TranscriptCache = new Map();
const codexCache: TranscriptCache = new Map();

async function scanClaude(sinceMs: number) {
  return scanWithCache(join(homedir(), '.claude', 'projects'), sinceMs, claudeCache, parseClaudeTranscript);
}

async function scanCodex(sinceMs: number) {
  return scanWithCache(join(homedir(), '.codex', 'sessions'), sinceMs, codexCache, parseCodexTranscript);
}

/** A forked Claude session copies its parent's transcript, so the same message can sit in two
 * files; keep the first occurrence across files, as within one. */
function dedupeAcrossFiles(records: readonly UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  return records.filter(record => {
    if (!record.dedupeKey) return true;
    if (seen.has(record.dedupeKey)) return false;
    seen.add(record.dedupeKey);
    return true;
  });
}

// --- LiteLLM pricing ---------------------------------------------------------------------

export type ModelRate = {inputCostPerToken: number; outputCostPerToken: number; cacheReadCostPerToken: number; cacheCreationCostPerToken: number};
export type PriceOverride = {inputCostPerMillionTokens: number; outputCostPerMillionTokens: number; cacheReadCostPerMillionTokens?: number; cacheWriteCostPerMillionTokens?: number};
export type CostSource = 'providerReported' | 'modelPriced' | 'unpriced';

const LITELLM_RATES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const RATES_TTL_MS = 24 * 60 * 60 * 1_000;

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}

/** Drops a bracketed variant suffix such as `claude-fable-5-1[1m]` (Claude Code's 1M-context
 * tier marker) — the rate table only knows the base name, and everything here prices at the
 * base tier since transcripts don't record which tier actually served a request. */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf('[');
  return bracket === -1 ? key : key.slice(0, bracket);
}

function parseRateTable(document: unknown): Map<string, ModelRate> {
  const table = new Map<string, ModelRate>();
  if (typeof document !== 'object' || document === null) return table;
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const input = typeof entry.input_cost_per_token === 'number' ? entry.input_cost_per_token : null;
    const output = typeof entry.output_cost_per_token === 'number' ? entry.output_cost_per_token : null;
    if (input === null || output === null) continue;
    const key = normalizeRateKey(name);
    if (!key) continue;
    table.set(key, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: typeof entry.cache_read_input_token_cost === 'number' ? entry.cache_read_input_token_cost : input,
      cacheCreationCostPerToken: typeof entry.cache_creation_input_token_cost === 'number' ? entry.cache_creation_input_token_cost : input
    });
  }
  return table;
}

function lookupRate(table: Map<string, ModelRate>, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  return table.get(key) ?? table.get(bareModelName(key)) ?? null;
}

function overrideToRate(override: PriceOverride): ModelRate {
  return {
    inputCostPerToken: override.inputCostPerMillionTokens / 1_000_000,
    outputCostPerToken: override.outputCostPerMillionTokens / 1_000_000,
    cacheReadCostPerToken: (override.cacheReadCostPerMillionTokens ?? override.inputCostPerMillionTokens) / 1_000_000,
    cacheCreationCostPerToken: (override.cacheWriteCostPerMillionTokens ?? override.inputCostPerMillionTokens) / 1_000_000
  };
}

function priceUsage(table: Map<string, ModelRate>, model: string, totals: TokenTotals, reportedCostUsd: number | null, override?: ModelRate): {costUsd: number; costSource: CostSource} {
  if (!override && reportedCostUsd !== null) return {costUsd: reportedCostUsd, costSource: 'providerReported'};
  const rate = override ?? lookupRate(table, model);
  if (!rate) return {costUsd: 0, costSource: 'unpriced'};
  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;
  return {costUsd, costSource: 'modelPriced'};
}

function cacheSavingsUsd(table: Map<string, ModelRate>, model: string, totals: TokenTotals, override?: ModelRate): number {
  const rate = override ?? lookupRate(table, model);
  if (!rate) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}

// --- Aggregation & public API --------------------------------------------------------------

export type SpendModelBucket = {
  provider: ProviderId;
  model: string;
  totals: TokenTotals;
  costUsd: number;
  costSource: CostSource;
  cacheSavingsUsd: number;
};

export type SpendDayBucket = {day: string; costUsd: number; totals: TokenTotals; models: SpendModelBucket[]};

export type SpendSummary = {
  rangeDays: number;
  totalCostUsd: number;
  totalCacheSavingsUsd: number;
  totals: TokenTotals;
  days: SpendDayBucket[];
  priceOverrides: Record<string, PriceOverride>;
  ratesUpdatedAt?: string;
  ratesError?: string;
};

function dayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export class SpendTracker {
  private readonly ratesCachePath: string;
  private readonly overridesPath: string;
  private rateTable = new Map<string, ModelRate>();
  private ratesUpdatedAt: string | undefined;
  private ratesError: string | undefined;
  private overrides: Record<string, PriceOverride> = {};
  private inflight = new Map<number, Promise<SpendSummary>>();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.ratesCachePath = join(stateDirectory, 'litellm-rates.json');
    this.overridesPath = join(stateDirectory, 'price-overrides.json');
  }

  async restore() {
    try {
      this.overrides = await readPrivateJson<Record<string, PriceOverride>>(this.overridesPath) ?? {};
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      const cached = await readPrivateJson<{fetchedAtMs: number; document: unknown}>(this.ratesCachePath);
      if (!cached) return undefined;
      this.rateTable = parseRateTable(cached.document);
      this.ratesUpdatedAt = new Date(cached.fetchedAtMs).toISOString();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async ensureRates() {
    const isStale = !this.ratesUpdatedAt || Date.now() - new Date(this.ratesUpdatedAt).getTime() > RATES_TTL_MS;
    if (!isStale) return;
    try {
      const response = await fetch(LITELLM_RATES_URL, {signal: AbortSignal.timeout(8_000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document = await response.json();
      this.rateTable = parseRateTable(document);
      this.ratesUpdatedAt = new Date().toISOString();
      this.ratesError = undefined;
      await writePrivateJson(this.ratesCachePath, {fetchedAtMs: Date.now(), document});
    } catch (error: unknown) {
      // Advisory: keep whatever rate table (possibly empty) is already loaded, note why it's stale.
      this.ratesError = error instanceof Error ? error.message : 'failed to fetch LiteLLM rates';
    }
  }

  async setPriceOverride(model: string, override: PriceOverride) {
    this.overrides[model.trim()] = override;
    await this.persistOverrides();
  }

  async clearPriceOverride(model: string) {
    delete this.overrides[model.trim()];
    await this.persistOverrides();
  }

  private async persistOverrides() {
    await writePrivateJson(this.overridesPath, this.overrides);
  }

  /** Parses the last month's transcripts ahead of the first spend screen; safe to call any time. */
  warm() {
    return this.summary(30);
  }

  summary(rangeDays = 30): Promise<SpendSummary> {
    // Two screens asking at once (or the warm-up racing the first open) share one scan.
    const pending = this.inflight.get(rangeDays);
    if (pending) return pending;
    const work = this.computeSummary(rangeDays).finally(() => this.inflight.delete(rangeDays));
    this.inflight.set(rangeDays, work);
    return work;
  }

  private async computeSummary(rangeDays: number): Promise<SpendSummary> {
    await this.ensureRates();
    const sinceMs = Date.now() - rangeDays * 24 * 60 * 60 * 1_000;
    const startedAt = Date.now();
    const [claude, codex] = await Promise.all([scanClaude(sinceMs), scanCodex(sinceMs)]);
    const parsedFiles = claude.parsedFiles + codex.parsedFiles;
    if (parsedFiles > 0) console.log(`fluentd spend: parsed ${parsedFiles} transcript(s), ${((claude.parsedBytes + codex.parsedBytes) / 1_048_576).toFixed(1)} MB, in ${Date.now() - startedAt}ms`);
    const claudeRecords = dedupeAcrossFiles(claude.records);
    const codexRecords = codex.records;

    const byDayModel = new Map<string, {provider: ProviderId; model: string; totals: TokenTotals; costUsd: number; costSource: CostSource; cacheSavingsUsd: number}>();
    for (const record of [...claudeRecords, ...codexRecords]) {
      const day = dayKey(record.timestampMs);
      const key = `${day}::${record.provider}::${record.model}`;
      const overrideConfig = this.overrides[record.model.trim()];
      const overrideRate = overrideConfig ? overrideToRate(overrideConfig) : undefined;
      const priced = priceUsage(this.rateTable, record.model, record.totals, record.reportedCostUsd, overrideRate);
      const savings = cacheSavingsUsd(this.rateTable, record.model, record.totals, overrideRate);
      const existing = byDayModel.get(key);
      if (existing) {
        existing.totals = addTotals(existing.totals, record.totals);
        existing.costUsd += priced.costUsd;
        existing.cacheSavingsUsd += savings;
        if (priced.costSource !== 'unpriced') existing.costSource = priced.costSource;
      } else {
        byDayModel.set(key, {provider: record.provider, model: record.model, totals: record.totals, costUsd: priced.costUsd, costSource: priced.costSource, cacheSavingsUsd: savings});
      }
    }

    const dayMap = new Map<string, SpendDayBucket>();
    for (const [key, bucket] of byDayModel) {
      const day = key.split('::')[0]!;
      let dayBucket = dayMap.get(day);
      if (!dayBucket) {
        dayBucket = {day, costUsd: 0, totals: emptyTotals(), models: []};
        dayMap.set(day, dayBucket);
      }
      dayBucket.costUsd += bucket.costUsd;
      dayBucket.totals = addTotals(dayBucket.totals, bucket.totals);
      dayBucket.models.push(bucket);
    }

    const days = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
    const totals = days.reduce((sum, day) => addTotals(sum, day.totals), emptyTotals());
    const totalCostUsd = days.reduce((sum, day) => sum + day.costUsd, 0);
    const totalCacheSavingsUsd = [...byDayModel.values()].reduce((sum, bucket) => sum + bucket.cacheSavingsUsd, 0);

    return {
      rangeDays,
      totalCostUsd,
      totalCacheSavingsUsd,
      totals,
      days,
      priceOverrides: this.overrides,
      ratesUpdatedAt: this.ratesUpdatedAt,
      ratesError: this.ratesError
    };
  }
}
