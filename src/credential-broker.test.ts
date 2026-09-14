import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {after, describe, it} from 'node:test';
import {CredentialBroker} from './credential-broker.js';
import {join} from 'node:path';
import type {FallbackGuidance, FallbackPolicy} from './daemon-protocol.js';
import {writePrivateJson} from './security/secure-state.js';

// The OS keyring is not available in every environment a test runs in (headless CI, containers).
// The store already has an in-memory mode for exactly this; the key material below is fake.
process.env.FLUENT_SECRET_STORE = 'memory';

const directories: string[] = [];

/** A broker with two connected Claude accounts, subscription first — the ordinary chain the
 * fallback question is asked about. */
async function broker(policy: FallbackPolicy = 'always-ask') {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-broker-'));
  directories.push(directory);
  const instance = new CredentialBroker(directory);
  await instance.upsertAccount('claude', 'work-sub', 'subscription', 'work · subscription');
  await instance.upsertAccount('claude', 'work-credits', 'platform-credits', 'work · credits');
  await instance.setFallbackPolicy('claude', policy);
  return instance;
}

function notices(instance: CredentialBroker) {
  const captured: Array<{message: string; guidance?: FallbackGuidance}> = [];
  instance.on('notice', (_provider, message, _resetAt, guidance) => captured.push({message, guidance}));
  return captured;
}

after(async () => {
  for (const directory of directories) await rm(directory, {recursive: true, force: true});
});

describe('putting a session on one account', () => {
  /**
   * Verified against Claude Code 2.1.270: `claude auth login --claudeai` is the subscription and
   * `--console` is Anthropic Console API-usage billing. Both are OAuth logins, so neither can be
   * selected with an env var — only with its own config directory.
   */
  it('gives a subscription its own CLI config directory', async () => {
    const instance = await broker();

    const environment = await instance.resolveEnv('claude', 'work-sub');

    assert.equal(environment.set.CLAUDE_CONFIG_DIR, instance.configDirectory('claude', 'work-sub'));
    assert.equal(environment.set.ANTHROPIC_API_KEY, undefined);
  });

  it('gives platform credits a different one, so both can run at once', async () => {
    const instance = await broker();

    const subscription = await instance.resolveEnv('claude', 'work-sub');
    const credits = await instance.resolveEnv('claude', 'work-credits');

    assert.notEqual(subscription.set.CLAUDE_CONFIG_DIR, credits.set.CLAUDE_CONFIG_DIR, 'sharing a directory would make the two accounts the same login');
  });

  it('removes a key the user happened to export, on every non-key account', async () => {
    const instance = await broker();

    for (const accountId of ['work-sub', 'work-credits']) {
      const environment = await instance.resolveEnv('claude', accountId);
      assert.ok(environment.unset.includes('ANTHROPIC_API_KEY'), `${accountId} must not inherit a key Fluent did not choose`);
      assert.ok(environment.unset.includes('ANTHROPIC_AUTH_TOKEN'));
    }
  });

  it('uses the key for an api-key account, and keeps it out of an account config dir', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-key', 'api-key', 'personal · key', 'sk-ant-test');

    const environment = await instance.resolveEnv('claude', 'personal-key');

    assert.equal(environment.set.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.ok(environment.unset.includes('CLAUDE_CONFIG_DIR'), 'a key is meant to win over any OAuth login');
  });

  it('sends OpenRouter its bearer token with the key variable removed, not blanked', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'router', 'api-key', 'openrouter', 'or-key', 'https://openrouter.ai/api');

    const environment = await instance.resolveEnv('claude', 'router');

    assert.equal(environment.set.ANTHROPIC_AUTH_TOKEN, 'or-key');
    assert.equal(environment.set.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
    assert.ok(environment.unset.includes('ANTHROPIC_API_KEY'), 'an empty value is still a value the CLI can prefer');
    assert.equal(environment.set.ANTHROPIC_API_KEY, undefined);
  });

  it('says how to connect each account in the CLI\'s own words', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-key', 'api-key', 'personal · key', 'sk-ant-test');
    const statuses = await instance.authStatus('claude');
    const byId = Object.fromEntries(statuses.map(status => [status.accountId, status]));

    assert.match(byId['work-sub']!.loginCommand!, /claude auth login --claudeai$/);
    assert.match(byId['work-credits']!.loginCommand!, /claude auth login --console$/);
    assert.match(byId['work-credits']!.loginCommand!, /^CLAUDE_CONFIG_DIR=/);
    assert.equal(byId['personal-key']!.loginCommand, undefined, 'a key is pasted, not logged into');
  });

  it('reports a stored key as connected without shelling out', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-key', 'api-key', 'personal · key', 'sk-ant-test');

    const status = (await instance.authStatus('claude')).find(entry => entry.accountId === 'personal-key');

    assert.equal(status?.loggedIn, true);
    assert.equal(status?.authMethod, 'api_key');
  });

  it('returns nothing to change for an account it does not know', async () => {
    const instance = await broker();

    assert.deepEqual(await instance.resolveEnv('claude', 'not-an-account'), {set: {}, unset: []});
  });

  it('uses Gemini CLI\'s documented API-key environment without inheriting a different Google key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-broker-'));
    directories.push(directory);
    const instance = new CredentialBroker(directory);
    await instance.upsertAccount('gemini', 'studio', 'api-key', 'Gemini API', 'AIza-test');

    const environment = await instance.resolveEnv('gemini', 'studio');

    assert.equal(environment.set.GEMINI_API_KEY, 'AIza-test');
    assert.ok(environment.unset.includes('GOOGLE_API_KEY'));
    assert.ok(environment.unset.includes('GOOGLE_APPLICATION_CREDENTIALS'));
  });
});

describe('fallback guidance', () => {
  it('recommends waiting when the window is about to reset anyway', async () => {
    const instance = await broker();
    // Deliberately off the rounding boundary: 90s lands on 1.5 minutes and would round either way
    // depending on how long the test itself took.
    const resetAt = new Date(Date.now() + 100_000).toISOString();

    const guidance = instance.guidance('claude', {accountId: 'work-sub', resetAt});

    assert.equal(guidance.recommendation, 'wait');
    assert.match(guidance.detail, /resets in about 2 minutes/);
  });

  it('recommends switching when the window is long', async () => {
    const instance = await broker();
    const resetAt = new Date(Date.now() + 47 * 60_000).toISOString();

    assert.equal(instance.guidance('claude', {accountId: 'work-sub', resetAt}).recommendation, 'switch');
  });

  it('recommends waiting when there is nothing to switch to', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-broker-'));
    directories.push(directory);
    const instance = new CredentialBroker(directory);
    await instance.upsertAccount('claude', 'only', 'subscription', 'only');

    const guidance = instance.guidance('claude', {accountId: 'only', resetAt: new Date(Date.now() + 47 * 60_000).toISOString()});

    assert.equal(guidance.recommendation, 'wait');
    assert.match(guidance.detail, /nothing to switch to/);
  });

  it('reports the prompt-cache reuse a switch would discard', async () => {
    const instance = await broker();
    instance.observeCache('claude', {sessionId: 'lane-a', accountId: 'work-sub', hitRatio: 0.82});
    instance.observeCache('claude', {sessionId: 'lane-b', accountId: 'work-sub', hitRatio: 0.78});

    const guidance = instance.guidance('claude', {accountId: 'work-sub', resetAt: new Date(Date.now() + 47 * 60_000).toISOString()});

    assert.equal(guidance.cacheHitRatio, 0.8);
    assert.match(guidance.detail, /reusing 80% of its prompt cache/);
    assert.match(guidance.detail, /starts cold/);
  });

  it('ignores cache observed on a different account', async () => {
    const instance = await broker();
    instance.observeCache('claude', {sessionId: 'lane-a', accountId: 'work-credits', hitRatio: 0.9});

    assert.equal(instance.guidance('claude', {accountId: 'work-sub'}).cacheHitRatio, undefined);
  });

  it('forgets a session that ended', async () => {
    const instance = await broker();
    instance.observeCache('claude', {sessionId: 'lane-a', accountId: 'work-sub', hitRatio: 0.9});
    instance.forgetSession('claude', 'lane-a');

    assert.equal(instance.guidance('claude', {accountId: 'work-sub'}).cacheHitRatio, undefined);
  });

  it('says a switch does not move sessions that are already running', async () => {
    const instance = await broker();

    const guidance = instance.guidance('claude', {accountId: 'work-sub', activeSessions: 3});

    assert.equal(guidance.activeSessions, 3);
    assert.match(guidance.detail, /3 running sessions will keep the current credential/);
  });
});

describe('usage limits', () => {
  it('asks before switching, with the cost in the question', async () => {
    const instance = await broker('always-ask');
    const captured = notices(instance);
    instance.observeCache('claude', {sessionId: 'lane-a', accountId: 'work-sub', hitRatio: 0.7});

    const state = await instance.reportUsageLimit('claude', {accountId: 'work-sub', resetAt: new Date(Date.now() + 47 * 60_000).toISOString()});

    assert.equal(state.activeAccountId, 'work-sub', 'always-ask must not move the credential on its own');
    assert.equal(captured.length, 1);
    assert.match(captured[0]!.message, /reusing 70% of its prompt cache/);
    assert.match(captured[0]!.message, /Switch to the next credential\?/);
    assert.equal(captured[0]!.guidance?.recommendation, 'switch');
  });

  it('asks differently when waiting is the better trade', async () => {
    const instance = await broker('always-ask');
    const captured = notices(instance);

    await instance.reportUsageLimit('claude', {accountId: 'work-sub', resetAt: new Date(Date.now() + 60_000).toISOString()});

    assert.match(captured[0]!.message, /Switch anyway\?/);
    assert.equal(captured[0]!.guidance?.recommendation, 'wait');
  });

  it('honours always-switch even when waiting would cost less, and says what it cost', async () => {
    const instance = await broker('always-switch');
    const captured = notices(instance);

    const state = await instance.reportUsageLimit('claude', {accountId: 'work-sub', resetAt: new Date(Date.now() + 60_000).toISOString()});

    assert.equal(state.activeAccountId, 'work-credits', 'an explicit policy is an instruction, not a suggestion');
    assert.equal(captured.length, 1);
    assert.match(captured[0]!.message, /Switched away from work-sub as configured/);
  });

  it('switches silently when switching was the right call anyway', async () => {
    const instance = await broker('always-switch');
    const captured = notices(instance);

    await instance.reportUsageLimit('claude', {accountId: 'work-sub', resetAt: new Date(Date.now() + 47 * 60_000).toISOString()});

    assert.deepEqual(captured, [], 'no notice is needed when the configured behaviour and the advice agree');
  });

  it('attaches guidance to a never-switch notice too', async () => {
    const instance = await broker('never-switch');
    const captured = notices(instance);

    const state = await instance.reportUsageLimit('claude', {accountId: 'work-sub'});

    assert.equal(state.activeAccountId, 'work-sub');
    assert.match(captured[0]!.message, /fallback is disabled/);
    assert.ok(captured[0]!.guidance, 'the advice is still worth showing even when nothing will act on it');
  });
});

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

  it('does not rejoin a chain-excluded account on re-upsert if it has a different identity', async () => {
    const instance = await broker();
    await instance.upsertAccount('claude', 'personal-sub', 'subscription', 'personal · subscription');

    // personal-sub was correctly excluded from the chain on first upsert
    let [state] = instance.list().filter(entry => entry.provider === 'claude');
    assert.deepEqual(state!.chain, ['work-sub', 'work-credits'], 'first upsert of different identity excludes from chain');

    // Re-upsert personal-sub (e.g., relabel or reconnect) must not rejoin it
    await instance.upsertAccount('claude', 'personal-sub', 'subscription', 'personal · subscription (relabeled)');

    [state] = instance.list().filter(entry => entry.provider === 'claude');
    assert.deepEqual(state!.chain, ['work-sub', 'work-credits'], 're-upsert of different-identity account must not rejoin chain');
  });
});

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
