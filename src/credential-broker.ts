import {EventEmitter} from 'node:events';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {
  CredentialAccount,
  CredentialChainState,
  CredentialMode,
  FallbackGuidance,
  FallbackPolicy,
  ProviderId
} from './daemon-protocol.js';
import {SecretStore} from './secret-store.js';

const defaultRevertMs = 15 * 60_000;

/**
 * Below this much time left in a limited window, switching is worse than waiting: a new account
 * starts cold, and prefix-cache reuse is worth far more on a long coding-agent prompt than a few
 * minutes of headroom on a window that is about to reset anyway.
 */
const shortWindowMs = Number(process.env.FLUENT_SWITCH_MIN_WINDOW_MS ?? 5 * 60_000);

/** Cache observations older than this say nothing useful about the session running now. */
const observationTtlMs = 30 * 60_000;

type CacheObservation = {sessionId: string; accountId?: string; hitRatio?: number; observedAt: number};

type ProviderState = CredentialChainState & {revertTimer?: NodeJS.Timeout};

/**
 * Orchestrates *which already-connected credential* a session should use — never talks to a
 * provider itself (spec §9 principle 2). Emits 'switched' and 'notice' events that daemon.ts
 * re-broadcasts to subscribed clients as `credential.switched` / `credential.notice`.
 */
export class CredentialBroker extends EventEmitter {
  private readonly providers = new Map<ProviderId, ProviderState>();
  /** Deliberately in memory only: a cache hit ratio from a previous run of the daemon describes a
   * session that no longer exists, and stale advice is worse than none. */
  private readonly cacheObservations = new Map<ProviderId, Map<string, CacheObservation>>();
  private readonly stateFile: string;
  private readonly secrets = new SecretStore();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    super();
    this.stateFile = join(stateDirectory, 'credentials.json');
  }

  async restore() {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const stored = JSON.parse(raw) as Array<CredentialChainState & {accounts: Array<CredentialAccount & {apiKey?: string}>}>;
      let migrated = false;
      for (const state of stored) {
        const accounts: CredentialAccount[] = [];
        for (const account of state.accounts) {
          if (account.apiKey) {
            await this.secrets.set(account.provider, account.id, account.apiKey);
            migrated = true;
          }
          const {apiKey: _apiKey, ...safeAccount} = account;
          accounts.push({...safeAccount, hasSecret: account.mode === 'api-key' ? Boolean(account.apiKey) || account.hasSecret : undefined});
        }
        this.providers.set(state.provider, {...state, accounts});
        if (state.revertAt) this.scheduleRevert(state.provider, new Date(state.revertAt).getTime() - Date.now());
      }
      if (migrated) await this.persist();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list(): CredentialChainState[] {
    return [...this.providers.values()].map(({revertTimer: _revertTimer, ...state}) => state);
  }

  /**
   * The env overrides `sessions.create` should merge in for the provider's currently active
   * account — the actual mechanism behind spec §7.5's "inject an API key/base URL override via
   * that CLI's own env vars." Subscription/platform-credits accounts rely on the CLI's own
   * already-logged-in state and need no override. Only Claude Code's env var names are
   * confirmed (spec §7.5); Codex's API-key path is a v2 gap, left undefined here rather than
   * guessed.
   */
  async resolveEnv(provider: ProviderId, accountId?: string): Promise<Record<string, string> | undefined> {
    const state = this.providers.get(provider);
    const selectedAccountId = accountId ?? state?.activeAccountId;
    if (!state || !selectedAccountId) return undefined;
    const account = state.accounts.find(candidate => candidate.id === selectedAccountId);
    if (!account || account.mode !== 'api-key') return undefined;
    const apiKey = await this.secrets.get(provider, account.id);
    if (!apiKey) throw new Error(`The API key for ${account.label} is unavailable in the system credential store`);
    if (provider === 'codex') return {OPENAI_API_KEY: apiKey};
    if (provider !== 'claude') return undefined;
    if (account.baseUrl === 'https://openrouter.ai/api') {
      return {
        ANTHROPIC_BASE_URL: account.baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_API_KEY: ''
      };
    }
    const env: Record<string, string> = {ANTHROPIC_API_KEY: apiKey};
    if (account.baseUrl) env.ANTHROPIC_BASE_URL = account.baseUrl;
    return env;
  }

  private ensure(provider: ProviderId): ProviderState {
    let state = this.providers.get(provider);
    if (!state) {
      state = {provider, accounts: [], chain: [], fallbackPolicy: 'always-ask'};
      this.providers.set(provider, state);
    }
    return state;
  }

  async upsertAccount(provider: ProviderId, id: string, mode: CredentialMode, label: string, apiKey?: string, baseUrl?: string) {
    const state = this.ensure(provider);
    const existing = state.accounts.findIndex(candidate => candidate.id === id);
    const previous = existing >= 0 ? state.accounts[existing] : undefined;
    if (mode === 'api-key' && apiKey) await this.secrets.set(provider, id, apiKey);
    if (mode !== 'api-key' && previous?.hasSecret) await this.secrets.delete(provider, id);
    const account: CredentialAccount = {
      id,
      provider,
      mode,
      label,
      baseUrl,
      hasSecret: mode === 'api-key' ? Boolean(apiKey) || previous?.hasSecret : undefined
    };
    if (existing >= 0) state.accounts[existing] = account;
    else state.accounts.push(account);
    if (!state.chain.includes(id)) state.chain.push(id);
    this.recomputeActive(state);
    await this.persist();
    return this.publicState(state);
  }

  async setChain(provider: ProviderId, accountIds: string[]) {
    const state = this.ensure(provider);
    const known = new Set(state.accounts.map(account => account.id));
    state.chain = accountIds.filter(id => known.has(id));
    this.recomputeActive(state);
    await this.persist();
    return this.publicState(state);
  }

  async setFallbackPolicy(provider: ProviderId, policy: FallbackPolicy) {
    const state = this.ensure(provider);
    state.fallbackPolicy = policy;
    await this.persist();
    return this.publicState(state);
  }

  /**
   * Records what a provider's own reporting says about prompt-cache reuse in a live session — fed
   * from the Claude Code status line's `prompt_cache.hit_ratio` (see usage-monitor.ts), never
   * estimated here. It is the only local evidence of what a credential switch is about to throw
   * away, so the fallback notice can say so instead of presenting the switch as free.
   */
  observeCache(provider: ProviderId, observation: {sessionId: string; accountId?: string; hitRatio?: number}) {
    let observations = this.cacheObservations.get(provider);
    if (!observations) {
      observations = new Map();
      this.cacheObservations.set(provider, observations);
    }
    observations.set(observation.sessionId, {...observation, observedAt: Date.now()});
    for (const [sessionId, existing] of observations) {
      if (Date.now() - existing.observedAt > observationTtlMs) observations.delete(sessionId);
    }
  }

  forgetSession(provider: ProviderId, sessionId: string) {
    this.cacheObservations.get(provider)?.delete(sessionId);
  }

  /**
   * What switching would cost right now, and whether it is worth it.
   *
   * Two things make a switch less attractive than it looks. A new account starts with a cold
   * prefix cache, which on a long coding-agent prompt is the difference between a cheap fast turn
   * and an expensive slow one. And a switch only changes what *new* sessions get: sessions already
   * running keep the credential they were created with, so it buys room for the next lane rather
   * than rescuing the one that hit the wall. Both belong in front of the user before they answer.
   *
   * This advises; it never overrides. A user who set 'always-switch' gets the switch they asked
   * for, with the cost stated (spec §2 principle 4).
   */
  guidance(provider: ProviderId, options: {accountId?: string; resetAt?: string; activeSessions?: number} = {}): FallbackGuidance {
    const state = this.ensure(provider);
    const limitedId = options.accountId ?? state.activeAccountId ?? state.chain[0];
    const observations = [...(this.cacheObservations.get(provider)?.values() ?? [])].filter(observation => Date.now() - observation.observedAt <= observationTtlMs);
    const relevant = observations.filter(observation => !observation.accountId || observation.accountId === limitedId);
    const ratios = relevant.map(observation => observation.hitRatio).filter((ratio): ratio is number => typeof ratio === 'number');
    const cacheHitRatio = ratios.length > 0 ? ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length : undefined;
    const activeSessions = options.activeSessions ?? relevant.length;
    const resetsInMs = options.resetAt ? new Date(options.resetAt).getTime() - Date.now() : undefined;

    const next = state.chain.find(id => id !== limitedId);
    const parts: string[] = [];
    if (!next) parts.push('No other credential is connected for this provider, so there is nothing to switch to.');
    if (cacheHitRatio !== undefined) parts.push(`The current account is reusing ${Math.round(cacheHitRatio * 100)}% of its prompt cache; a different account starts cold.`);
    if (activeSessions > 0) parts.push(`${activeSessions} running session${activeSessions === 1 ? '' : 's'} will keep the current credential either way — a switch applies to sessions started from now on.`);

    if (resetsInMs !== undefined && resetsInMs > 0 && resetsInMs <= shortWindowMs) {
      const minutes = Math.max(1, Math.round(resetsInMs / 60_000));
      return {
        recommendation: 'wait',
        resetsInMs,
        cacheHitRatio,
        activeSessions,
        detail: [`The limit resets in about ${minutes} minute${minutes === 1 ? '' : 's'} — waiting it out costs less than starting cold on another account.`, ...parts].join(' ')
      };
    }

    return {
      recommendation: next ? 'switch' : 'wait',
      resetsInMs,
      cacheHitRatio,
      activeSessions,
      detail: (parts.length > 0 ? parts : ['Switching starts the next session on the following credential in your chain.']).join(' ')
    };
  }

  /** Fed by a Claude Code `StopFailure` hook (or another adapter's equivalent) — never invented
   * client-side; it's the CLI's own reported signal (spec §7.5/§9). */
  async reportUsageLimit(provider: ProviderId, options: {accountId?: string; resetAt?: string; activeSessions?: number} = {}) {
    const state = this.ensure(provider);
    const limitedId = options.accountId ?? state.activeAccountId ?? state.chain[0];
    if (!limitedId) return this.publicState(state);
    const guidance = this.guidance(provider, {...options, accountId: limitedId});

    if (state.fallbackPolicy === 'never-switch') {
      this.emit('notice', provider, `${limitedId} hit a usage limit; fallback is disabled, staying on it.`, options.resetAt, guidance);
      await this.persist();
      return this.publicState(state);
    }

    if (state.fallbackPolicy === 'always-ask') {
      // Deliberately does NOT mutate state yet — 'always-ask' means exactly that: the active
      // credential stays put until the user calls confirmFallback. Only 'always-switch' below
      // is allowed to flip activeAccountId without a human in the loop.
      const question = guidance.recommendation === 'wait' ? 'Switch anyway?' : 'Switch to the next credential?';
      this.emit('notice', provider, `${limitedId} hit a usage limit. ${guidance.detail} ${question}`, options.resetAt, guidance);
      return this.publicState(state);
    }

    // 'always-switch' is an instruction, not a suggestion: honour it even when waiting would cost
    // less, and say what it cost rather than quietly substituting our own judgement.
    this.applyFallback(state, limitedId, options.resetAt);
    this.emit('switched', provider, state.activeAccountId, 'fallback');
    if (guidance.recommendation === 'wait') this.emit('notice', provider, `Switched away from ${limitedId} as configured. ${guidance.detail}`, options.resetAt, guidance);
    await this.persist();
    return this.publicState(state);
  }

  /** UI response to an 'always-ask' notice. Only here — never inside reportUsageLimit's
   * 'always-ask' branch — does the account actually switch, keeping the policy's promise that
   * nothing changes without an explicit, visible user action (spec §2 principle 3). */
  async confirmFallback(provider: ProviderId, accept: boolean, options: {accountId?: string; resetAt?: string} = {}) {
    const state = this.ensure(provider);
    if (!accept) return this.publicState(state);
    const limitedId = options.accountId ?? state.activeAccountId ?? state.chain[0];
    if (!limitedId) return this.publicState(state);
    this.applyFallback(state, limitedId, options.resetAt);
    this.emit('switched', provider, state.activeAccountId, 'manual');
    await this.persist();
    return this.publicState(state);
  }

  private applyFallback(state: ProviderState, limitedId: string, resetAt?: string) {
    state.limitedAccountId = limitedId;
    const revertMs = resetAt ? new Date(resetAt).getTime() - Date.now() : defaultRevertMs;
    state.revertAt = new Date(Date.now() + Math.max(revertMs, 0)).toISOString();
    this.scheduleRevert(state.provider, revertMs);
    this.recomputeActive(state);
  }

  private scheduleRevert(provider: ProviderId, delayMs: number) {
    const state = this.ensure(provider);
    if (state.revertTimer) clearTimeout(state.revertTimer);
    state.revertTimer = setTimeout(() => void this.revert(provider), Math.max(delayMs, 0));
    state.revertTimer.unref();
  }

  private async revert(provider: ProviderId) {
    const state = this.ensure(provider);
    state.limitedAccountId = undefined;
    state.revertAt = undefined;
    state.revertTimer = undefined;
    this.recomputeActive(state);
    this.emit('switched', provider, state.activeAccountId, 'revert');
    await this.persist();
  }

  private recomputeActive(state: ProviderState) {
    state.activeAccountId = state.chain.find(id => id !== state.limitedAccountId) ?? state.chain[0];
  }

  private publicState(state: ProviderState): CredentialChainState {
    const {revertTimer: _revertTimer, ...publicState} = state;
    return publicState;
  }

  private async persist() {
    const operation = this.persistQueue.then(() => this.persistNow());
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persistNow() {
    await mkdir(dirname(this.stateFile), {recursive: true});
    const serialized = JSON.stringify(this.list(), null, 2);
    const temporary = `${this.stateFile}.tmp`;
    await writeFile(temporary, serialized, 'utf8');
    await rename(temporary, this.stateFile);
  }
}
