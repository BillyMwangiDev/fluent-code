# Account Identity Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the credential broker an explicit `identityId` concept so automatic fallback
(`setChain` + `fallbackPolicy`) can never silently mix two different logins into one chain, per
`docs/superpowers/specs/2026-09-13-account-identity-safety-design.md` §2/§6/§7.

**Architecture:** `CredentialAccount` gains an `identityId` field. `upsertAccount` resolves it —
reuse an existing account's identity when told to (`sameIdentityAs`), otherwise default to the
provider's sole existing identity for a non-subscription credential, otherwise mint a new one
(covers "first account" and "second subscription-mode login" — the one case that structurally
cannot share a login). `setChain` refuses to accept a chain spanning more than one identity.
`restore()` backfills one identity per provider for state files written before this field existed.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `node:assert/strict` (existing
convention in `src/credential-broker.test.ts`), `pnpm test` / `pnpm check`.

**Scope note:** This plan is backend/protocol-only, matching the design doc's §6/§7 scope exactly.
There is currently no frontend flow that creates a `subscription`- or `platform-credits`-mode
credential at all (`app/src/main.ts`'s onboarding and Credentials screens only have an "add API
key account" form) — so there is nothing to attach a "same account or different?" prompt to yet.
Building that UI is out of scope here; it wasn't asked for and would be new, unrequested surface.
The default-inference rule in Task 1 is deliberately chosen so the *existing* "add API key account"
form keeps working correctly with zero frontend changes (a new key defaults to the provider's one
existing identity, which is the common case).

---

### Task 1: `identityId` field + default resolution on `upsertAccount`

**Files:**
- Modify: `src/daemon-protocol.ts:389-397` (`CredentialAccount` type)
- Modify: `src/credential-broker.ts:1-16` (imports), `:202-222` (`upsertAccount`)
- Test: `src/credential-broker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `src/credential-broker.test.ts`, right after the `usage limits`
block (after the closing `});` that currently ends the file at line 259):

```ts
describe('account identity', () => {
  it('gives the first two credentials on a provider the same identity by default', async () => {
    const instance = await broker();

    const [state] = instance.list().filter(entry => entry.provider === 'claude');
    const byId = Object.fromEntries(state!.accounts.map(account => [account.id, account]));

    assert.ok(byId['work-sub']!.identityId, 'a real account must get a real identityId, not undefined');
    assert.equal(byId['work-sub']!.identityId, byId['work-credits']!.identityId, 'a subscription and its own platform credits are one login');
  });

  it('gives a second subscription-mode credential a new identity by default', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-sub', 'subscription', 'personal · subscription');

    const [state] = instance.list().filter(entry => entry.provider === 'claude');
    const byId = Object.fromEntries(state!.accounts.map(account => [account.id, account]));

    assert.notEqual(byId['personal-sub']!.identityId, byId['work-sub']!.identityId, 'a second subscription cannot be the same login as the first');
  });

  it('honours an explicit sameIdentityAs even for a second subscription', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'linked-sub', 'subscription', 'linked', undefined, undefined, 'work-sub');

    const [state] = instance.list().filter(entry => entry.provider === 'claude');
    const byId = Object.fromEntries(state!.accounts.map(account => [account.id, account]));

    assert.ok(byId['linked-sub']!.identityId, 'a real account must get a real identityId, not undefined');
    assert.equal(byId['linked-sub']!.identityId, byId['work-sub']!.identityId);
  });

  it('defaults an ambiguous new credential to a fresh identity rather than guessing', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-sub', 'subscription', 'personal · subscription');
    // Two identities now exist (work-*, personal-sub). A third, untagged credential must not
    // silently pick one of them.
    await instance.upsertAccount('claude', 'mystery-key', 'api-key', 'mystery', 'sk-ant-test');

    const [state] = instance.list().filter(entry => entry.provider === 'claude');
    const byId = Object.fromEntries(state!.accounts.map(account => [account.id, account]));

    assert.notEqual(byId['mystery-key']!.identityId, byId['work-sub']!.identityId);
    assert.notEqual(byId['mystery-key']!.identityId, byId['personal-sub']!.identityId);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test 2>&1 | grep -A5 "account identity"`

Expected: all four new tests fail with `AssertionError [ERR_ASSERTION]`, each on the first
`assert.ok(...identityId...)` line — `identityId` is `undefined` on every account because the
field doesn't exist yet. Also confirm the type-level gap:

Run: `pnpm check 2>&1 | grep credential-broker.test`

Expected: an error like `Expected 4-6 arguments, but got 7.` on the `sameIdentityAs` call — this
is the signal that step 1 is correctly ahead of the implementation.

- [ ] **Step 3: Add `identityId` to the type**

In `src/daemon-protocol.ts`, change (around line 389):

```ts
export type CredentialAccount = {
  id: string;
  provider: ProviderId;
  mode: CredentialMode;
  label: string;
  /** API key material is held in the operating system credential store, never in Fluent state. */
  hasSecret?: boolean;
  baseUrl?: string;
};
```

to:

```ts
export type CredentialAccount = {
  id: string;
  provider: ProviderId;
  mode: CredentialMode;
  label: string;
  /**
   * Groups credentials that belong to one real login, at the granularity the provider's own CLI
   * uses (what `CLAUDE_CONFIG_DIR`/its equivalent actually isolates) — not "one human," since one
   * person can deliberately hold two logins. Automatic fallback (setChain/fallbackPolicy) only
   * ever moves within one identityId; moving work to a different one is always a manual, explicit
   * action (docs/superpowers/specs/2026-09-13-account-identity-safety-design.md §2).
   */
  identityId: string;
  /** API key material is held in the operating system credential store, never in Fluent state. */
  hasSecret?: boolean;
  baseUrl?: string;
};
```

Also add the optional `sameIdentityAs` param to the RPC request type, around line 327:

```ts
  | {id: string; method: 'credentials.upsertAccount'; params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string; approvalId?: string}}
```

to:

```ts
  | {id: string; method: 'credentials.upsertAccount'; params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string; sameIdentityAs?: string; approvalId?: string}}
```

- [ ] **Step 4: Implement identity resolution in `upsertAccount`**

In `src/credential-broker.ts`, add `randomUUID` to the imports (line 1-4 currently reads):

```ts
import {EventEmitter} from 'node:events';
import {dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
```

change to:

```ts
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
```

Then replace the whole `upsertAccount` method (currently lines 202-222):

```ts
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
```

with:

```ts
  async upsertAccount(provider: ProviderId, id: string, mode: CredentialMode, label: string, apiKey?: string, baseUrl?: string, sameIdentityAs?: string) {
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
      identityId: this.resolveIdentity(state, mode, previous, sameIdentityAs),
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

  /**
   * Which login a credential belongs to. Editing an existing account never moves it to a
   * different login. A new account joins an explicitly named one (`sameIdentityAs`) when given,
   * otherwise defaults to the provider's sole existing identity — *except* a second
   * subscription-mode credential, which structurally cannot be the same OAuth login as an
   * existing one, and except when more than one identity already exists and the caller didn't say
   * which — both get a fresh identity rather than a guess (spec §2.2).
   */
  private resolveIdentity(state: ProviderState, mode: CredentialMode, previous: CredentialAccount | undefined, sameIdentityAs?: string): string {
    if (previous) return previous.identityId;
    if (sameIdentityAs) {
      const match = state.accounts.find(account => account.id === sameIdentityAs);
      if (match) return match.identityId;
    }
    const identities = new Set(state.accounts.map(account => account.identityId));
    if (mode !== 'subscription' && identities.size === 1) return [...identities][0]!;
    return randomUUID();
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test 2>&1 | grep -B2 -A8 "account identity"`

Expected: all four new tests pass, and no previously-passing test in `credential-broker.test.ts`
regresses. Confirm the whole suite: `pnpm test` — expected: `# pass 33` or higher, `# fail 0` (the
file had 29 `it` blocks before this task; count is illustrative, just confirm `# fail 0`).

Also run: `pnpm check` — expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/daemon-protocol.ts src/credential-broker.ts src/credential-broker.test.ts
git commit -m "feat(credentials): give credential accounts an explicit identity"
```

---

### Task 2: `setChain` refuses to mix identities

**Files:**
- Modify: `src/credential-broker.ts:224-231` (`setChain`)
- Test: `src/credential-broker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `src/credential-broker.test.ts`, after the `account identity` block
added in Task 1:

```ts
describe('credential chains stay within one identity', () => {
  it('refuses a chain that spans two different logins', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-sub', 'subscription', 'personal · subscription');

    await assert.rejects(
      instance.setChain('claude', ['work-sub', 'personal-sub']),
      /different logins/
    );
  });

  it('leaves the existing chain untouched after a refused setChain', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-sub', 'subscription', 'personal · subscription');

    await assert.rejects(instance.setChain('claude', ['work-sub', 'personal-sub']));

    const [state] = instance.list().filter(entry => entry.provider === 'claude');
    assert.deepEqual(state!.chain, ['work-sub', 'work-credits'], 'a rejected setChain must not partially apply');
  });

  it('still accepts a chain within one identity', async () => {
    const instance = await broker();

    const state = await instance.setChain('claude', ['work-credits', 'work-sub']);

    assert.deepEqual(state.chain, ['work-credits', 'work-sub']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test 2>&1 | grep -A5 "credential chains stay within one identity"`

Expected: the first two tests fail because `setChain` currently accepts any chain (no rejection
happens, so `assert.rejects` fails with "Missing expected rejection"). The third test passes
already — that's fine, it's here as a regression guard for the next step.

- [ ] **Step 3: Implement the check**

In `src/credential-broker.ts`, replace `setChain` (currently lines 224-231):

```ts
  async setChain(provider: ProviderId, accountIds: string[]) {
    const state = this.ensure(provider);
    const known = new Set(state.accounts.map(account => account.id));
    state.chain = accountIds.filter(id => known.has(id));
    this.recomputeActive(state);
    await this.persist();
    return this.publicState(state);
  }
```

with:

```ts
  async setChain(provider: ProviderId, accountIds: string[]) {
    const state = this.ensure(provider);
    const known = new Map(state.accounts.map(account => [account.id, account]));
    const filtered = accountIds.filter(id => known.has(id));
    const identities = new Set(filtered.map(id => known.get(id)!.identityId));
    if (identities.size > 1) {
      throw new Error('A credential chain cannot mix accounts from different logins — assign a lane to the other account directly instead of adding it to this chain.');
    }
    state.chain = filtered;
    this.recomputeActive(state);
    await this.persist();
    return this.publicState(state);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test 2>&1 | grep -B2 -A8 "credential chains stay within one identity"`

Expected: all three tests pass. Then run the full suite: `pnpm test` — expected `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/credential-broker.ts src/credential-broker.test.ts
git commit -m "feat(credentials): refuse a credential chain spanning two logins"
```

---

### Task 3: Migrate state files written before `identityId` existed

**Files:**
- Modify: `src/credential-broker.ts:55-77` (`restore`)
- Test: `src/credential-broker.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `src/credential-broker.test.ts`, after the block added in Task 2. It
needs `writePrivateJson`, so add that import alongside the existing `node:fs/promises` import at
the top of the file — change:

```ts
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {after, describe, it} from 'node:test';
import {CredentialBroker} from './credential-broker.js';
import {join} from 'node:path';
import type {FallbackGuidance, FallbackPolicy} from './daemon-protocol.js';
```

to:

```ts
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {after, describe, it} from 'node:test';
import {CredentialBroker} from './credential-broker.js';
import {join} from 'node:path';
import type {FallbackGuidance, FallbackPolicy} from './daemon-protocol.js';
import {writePrivateJson} from './security/secure-state.js';
```

Then add:

```ts
describe('migrating state written before identityId existed', () => {
  it('backfills one identity per provider for every pre-existing account', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-broker-'));
    directories.push(directory);
    // Shaped exactly like a v1 credentials.json, written before identityId was added.
    await writePrivateJson(join(directory, 'credentials.json'), [{
      provider: 'claude',
      accounts: [
        {id: 'work-sub', provider: 'claude', mode: 'subscription', label: 'work · subscription'},
        {id: 'work-credits', provider: 'claude', mode: 'platform-credits', label: 'work · credits'}
      ],
      chain: ['work-sub', 'work-credits'],
      fallbackPolicy: 'always-ask'
    }]);

    const instance = new CredentialBroker(directory);
    await instance.restore();

    const [state] = instance.list().filter(entry => entry.provider === 'claude');
    const byId = Object.fromEntries(state!.accounts.map(account => [account.id, account]));
    assert.ok(byId['work-sub']!.identityId, 'a backfilled account must get a real identityId, not undefined');
    assert.equal(byId['work-sub']!.identityId, byId['work-credits']!.identityId, 'pre-existing accounts on one provider were one identity');
  });

  it('persists the backfilled identityId so it is stable across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-broker-'));
    directories.push(directory);
    await writePrivateJson(join(directory, 'credentials.json'), [{
      provider: 'claude',
      accounts: [{id: 'work-sub', provider: 'claude', mode: 'subscription', label: 'work · subscription'}],
      chain: ['work-sub'],
      fallbackPolicy: 'always-ask'
    }]);

    const first = new CredentialBroker(directory);
    await first.restore();
    const firstIdentity = first.list()[0]!.accounts[0]!.identityId;

    const second = new CredentialBroker(directory);
    await second.restore();
    const secondIdentity = second.list()[0]!.accounts[0]!.identityId;

    assert.equal(firstIdentity, secondIdentity, 'restoring twice from the same persisted file must not mint a new identity each time');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test 2>&1 | grep -A5 "migrating state written before identityId existed"`

Expected: `assert.ok(byId['work-sub']!.identityId, ...)` fails — `identityId` is `undefined` because
`restore()` doesn't backfill it yet.

- [ ] **Step 3: Implement the backfill**

In `src/credential-broker.ts`, replace the body of `restore()` (currently lines 55-77):

```ts
  async restore() {
    try {
      const stored = await readPrivateJson<Array<CredentialChainState & {accounts: Array<CredentialAccount & {apiKey?: string}>}>>(this.stateFile);
      if (!stored) return;
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
```

with:

```ts
  async restore() {
    try {
      const stored = await readPrivateJson<Array<CredentialChainState & {accounts: Array<CredentialAccount & {apiKey?: string; identityId?: string}>}>>(this.stateFile);
      if (!stored) return;
      let migrated = false;
      for (const state of stored) {
        const accounts: CredentialAccount[] = [];
        // Every account stored before identityId existed was, by construction, one provider's
        // one login — so one freshly-minted identity backfills all of them.
        const legacyIdentityId = randomUUID();
        for (const account of state.accounts) {
          if (account.apiKey) {
            await this.secrets.set(account.provider, account.id, account.apiKey);
            migrated = true;
          }
          if (!account.identityId) migrated = true;
          const {apiKey: _apiKey, ...safeAccount} = account;
          accounts.push({
            ...safeAccount,
            identityId: account.identityId ?? legacyIdentityId,
            hasSecret: account.mode === 'api-key' ? Boolean(account.apiKey) || account.hasSecret : undefined
          });
        }
        this.providers.set(state.provider, {...state, accounts});
        if (state.revertAt) this.scheduleRevert(state.provider, new Date(state.revertAt).getTime() - Date.now());
      }
      if (migrated) await this.persist();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test 2>&1 | grep -B2 -A8 "migrating state written before identityId existed"`

Expected: both tests pass. Then the full suite: `pnpm test` — expected `# fail 0`. Then `pnpm check`
— expected no errors.

- [ ] **Step 5: Commit**

```bash
git add src/credential-broker.ts src/credential-broker.test.ts
git commit -m "feat(credentials): backfill identityId for state written before it existed"
```

---

### Task 4: Wire `sameIdentityAs` through the RPC layer

No new behavior to test here — this only makes the capability Task 1 built reachable from outside
`CredentialBroker` (the daemon's RPC dispatch and the app's typed client), which the existing
`credentials.upsertAccount` call sites already exercise for every other optional field the same
way. Verified by type-checking, not a new runtime test.

**Files:**
- Modify: `src/daemon.ts:592-595`
- Modify: `src/daemon-client.ts:174`
- Modify: `app/src/api.ts:358-361`

- [ ] **Step 1: Update the daemon's RPC handler**

In `src/daemon.ts`, find (around line 592):

```ts
    case 'credentials.upsertAccount': {
      ...
      return broker.upsertAccount(request.params.provider, request.params.id, request.params.mode, request.params.label, request.params.apiKey, request.params.baseUrl);
    }
```

Change the `return` line to:

```ts
      return broker.upsertAccount(request.params.provider, request.params.id, request.params.mode, request.params.label, request.params.apiKey, request.params.baseUrl, request.params.sameIdentityAs);
```

(Leave whatever approval-check line already sits above the `return` inside that `case` block
untouched — only the `return` line itself changes.)

- [ ] **Step 2: Update the daemon client**

In `src/daemon-client.ts`, change line 174 from:

```ts
  upsertAccount: (params: {provider: ProviderId; id: string; mode: CredentialMode; label: string}) => request<CredentialChainState>('credentials.upsertAccount', params),
```

to:

```ts
  upsertAccount: (params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string; sameIdentityAs?: string}) => request<CredentialChainState>('credentials.upsertAccount', params),
```

- [ ] **Step 3: Update the frontend API wrapper's type**

In `app/src/api.ts`, change (around line 358):

```ts
  upsertAccount: async (params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string}) => {
    const approval = await issueApproval('credential.change', `${params.provider}:${params.id}`, `credential ${params.mode}`);
    return daemonRequest<CredentialChainState>('credentials.upsertAccount', {...params, approvalId: approval.id});
  },
```

to:

```ts
  upsertAccount: async (params: {provider: ProviderId; id: string; mode: CredentialMode; label: string; apiKey?: string; baseUrl?: string; sameIdentityAs?: string}) => {
    const approval = await issueApproval('credential.change', `${params.provider}:${params.id}`, `credential ${params.mode}`);
    return daemonRequest<CredentialChainState>('credentials.upsertAccount', {...params, approvalId: approval.id});
  },
```

No caller passes `sameIdentityAs` yet (there's no UI for it — see the plan header's Scope note), so
this is purely additive: existing calls from `renderOnboarding`/`renderCredentials` in
`app/src/main.ts` keep compiling and behaving exactly as before.

- [ ] **Step 4: Verify everything still type-checks**

Run: `pnpm check`
Expected: no errors.

Run: `pnpm check:frontend`
Expected: no errors.

Run: `pnpm test`
Expected: `# fail 0` (unchanged from Task 3).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts src/daemon-client.ts app/src/api.ts
git commit -m "feat(credentials): pass sameIdentityAs through the daemon RPC layer"
```

---

## Deliberately not in this plan

- **A "same account or different?" UI prompt.** There is no existing flow that creates a
  `subscription`- or `platform-credits`-mode credential in the app today (only "add API key
  account" exists), so there's nothing to attach it to. When that UI is eventually built, it has
  `sameIdentityAs` (Task 4) ready to call.
- **Race mode (R8)'s guardrail enforcement.** R8 itself isn't built yet (research doc, v3) — the
  guardrail is recorded in the design doc and the research doc's R8 entry so it's honored whenever
  R8 is built, not implemented against nonexistent code now.
- **Editing the main design spec's prose** (§2/§7.5/§9/§11/§13) — per the established convention in
  this repo (the research doc argues with spec sections without editing them in place), the account-
  identity-safety design doc is the source of truth for this; `CLAUDE.md` and the research doc
  already point to it (commit `0b6da01`).
