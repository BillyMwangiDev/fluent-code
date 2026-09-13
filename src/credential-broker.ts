import {EventEmitter} from 'node:events';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {
  CredentialAccount,
  CredentialChainState,
  CredentialMode,
  FallbackPolicy,
  ProviderId
} from './daemon-protocol.js';
import {SecretStore} from './secret-store.js';

const defaultRevertMs = 15 * 60_000;

type ProviderState = CredentialChainState & {revertTimer?: NodeJS.Timeout};

/**
 * Orchestrates *which already-connected credential* a session should use — never talks to a
 * provider itself (spec §9 principle 2). Emits 'switched' and 'notice' events that daemon.ts
 * re-broadcasts to subscribed clients as `credential.switched` / `credential.notice`.
 */
export class CredentialBroker extends EventEmitter {
  private readonly providers = new Map<ProviderId, ProviderState>();
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

  /** Fed by a Claude Code `StopFailure` hook (or another adapter's equivalent) — never invented
   * client-side; it's the CLI's own reported signal (spec §7.5/§9). */
  async reportUsageLimit(provider: ProviderId, options: {accountId?: string; resetAt?: string} = {}) {
    const state = this.ensure(provider);
    const limitedId = options.accountId ?? state.activeAccountId ?? state.chain[0];
    if (!limitedId) return this.publicState(state);

    if (state.fallbackPolicy === 'never-switch') {
      this.emit('notice', provider, `${limitedId} hit a usage limit; fallback is disabled, staying on it.`, options.resetAt);
      await this.persist();
      return this.publicState(state);
    }

    if (state.fallbackPolicy === 'always-ask') {
      // Deliberately does NOT mutate state yet — 'always-ask' means exactly that: the active
      // credential stays put until the user calls confirmFallback. Only 'always-switch' below
      // is allowed to flip activeAccountId without a human in the loop.
      this.emit('notice', provider, `${limitedId} hit a usage limit. Switch to the next credential?`, options.resetAt);
      return this.publicState(state);
    }

    this.applyFallback(state, limitedId, options.resetAt);
    this.emit('switched', provider, state.activeAccountId, 'fallback');
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
