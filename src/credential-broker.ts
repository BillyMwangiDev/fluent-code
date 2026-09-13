import {EventEmitter} from 'node:events';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {
  AccountAuthStatus,
  CredentialAccount,
  CredentialChainState,
  CredentialEnvironment,
  CredentialMode,
  FallbackGuidance,
  FallbackPolicy,
  ProviderId
} from './daemon-protocol.js';
import {SecretStore} from './secret-store.js';

const execute = promisify(execFile);

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

  /** Where an OAuth-based account keeps its own CLI login, so two of them can coexist. */
  configDirectory(provider: ProviderId, accountId: string) {
    return join(dirname(this.stateFile), 'auth', provider, accountId);
  }

  /**
   * How to connect an account, in the provider CLI's own words. Fluent never runs this itself: it
   * is an interactive browser flow, and spec §9's hard boundary is that credentials are the user's
   * business with their provider.
   */
  loginCommand(provider: ProviderId, account: CredentialAccount) {
    if (provider !== 'claude') return undefined;
    if (account.mode === 'api-key') return undefined;
    // Verified against Claude Code 2.1.270: `--claudeai` is the subscription, `--console` is
    // Anthropic Console API-usage billing. Both are OAuth logins, which is why they each need
    // their own config directory rather than an env var.
    const flag = account.mode === 'platform-credits' ? '--console' : '--claudeai';
    return `CLAUDE_CONFIG_DIR=${this.configDirectory(provider, account.id)} claude auth login ${flag}`;
  }

  /**
   * The environment that puts a session on one account — spec §7.5's "inject via that CLI's own
   * env vars", done for all three of spec §9's modes rather than only the third.
   *
   * The shape of the problem, confirmed against Claude Code 2.1.270 rather than assumed: a
   * subscription and Anthropic Console API credits are *both* OAuth logins (`claude auth login
   * --claudeai` versus `--console`), and the CLI holds one login per config directory. So they
   * cannot be told apart by an env var, and pointing both at the default directory would make
   * "platform credits" a label on whatever the user happened to log in as. Each OAuth account
   * therefore gets its own `CLAUDE_CONFIG_DIR`, which is what lets a subscription lane and a
   * credits lane run side by side.
   *
   * An API key is the one mode that *is* an env var, and it is also the one that can arrive
   * uninvited: a key exported in the user's shell would be inherited by every lane. So every
   * non-key account explicitly unsets it.
   */
  async resolveEnv(provider: ProviderId, accountId?: string): Promise<CredentialEnvironment> {
    const empty: CredentialEnvironment = {set: {}, unset: []};
    const state = this.providers.get(provider);
    const selectedAccountId = accountId ?? state?.activeAccountId;
    if (!state || !selectedAccountId) return empty;
    const account = state.accounts.find(candidate => candidate.id === selectedAccountId);
    if (!account) return empty;

    if (account.mode !== 'api-key') {
      if (provider !== 'claude') return empty;
      return {
        set: {CLAUDE_CONFIG_DIR: this.configDirectory(provider, account.id)},
        // Neither key may shadow the login this account is: a stray one in the environment is a
        // credential the user did not pick for this lane.
        unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
      };
    }

    const apiKey = await this.secrets.get(provider, account.id);
    if (!apiKey) throw new Error(`The API key for ${account.label} is unavailable in the system credential store`);
    // Codex's own key variable; unconfirmed against a real Codex install (spec §7.5).
    if (provider === 'codex') return {set: {OPENAI_API_KEY: apiKey}, unset: []};
    if (provider !== 'claude') return empty;
    if (account.baseUrl === 'https://openrouter.ai/api') {
      // OpenRouter authenticates on the bearer token, so the key variable must be gone rather than
      // empty — an empty one is still a value the CLI can prefer.
      return {set: {ANTHROPIC_BASE_URL: account.baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey}, unset: ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']};
    }
    const set: Record<string, string> = {ANTHROPIC_API_KEY: apiKey};
    if (account.baseUrl) set.ANTHROPIC_BASE_URL = account.baseUrl;
    // A key is meant to win over any OAuth login, so do not point it at an account's config dir.
    return {set, unset: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR']};
  }

  /**
   * What each account's CLI says about itself, read from `claude auth status --json` — the CLI's
   * own reported state, never its credential files (spec §7.5). This is how the credentials screen
   * can show "connected" without Fluent ever holding an OAuth token.
   */
  async authStatus(provider: ProviderId = 'claude'): Promise<AccountAuthStatus[]> {
    const state = this.providers.get(provider);
    if (!state) return [];
    return Promise.all(state.accounts.map(async account => {
      const base: AccountAuthStatus = {accountId: account.id, provider, mode: account.mode, loggedIn: false, loginCommand: this.loginCommand(provider, account)};
      if (account.mode === 'api-key') {
        return {...base, loggedIn: Boolean(account.hasSecret), authMethod: 'api_key', detail: account.hasSecret ? undefined : 'No key stored for this account yet.'};
      }
      if (provider !== 'claude') return {...base, detail: 'Fluent cannot read this provider\'s auth state yet.'};
      try {
        const {stdout} = await execute('claude', ['auth', 'status', '--json'], {
          timeout: 20_000,
          env: {...process.env, CLAUDE_CONFIG_DIR: this.configDirectory(provider, account.id), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: ''}
        });
        const report = JSON.parse(stdout) as {loggedIn?: boolean; authMethod?: string; apiProvider?: string};
        return {...base, loggedIn: report.loggedIn === true, authMethod: report.authMethod, apiProvider: report.apiProvider};
      } catch {
        return {...base, detail: 'Could not read `claude auth status` — is Claude Code installed?'};
      }
    }));
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
