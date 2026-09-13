import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {CredentialBroker} from './credential-broker.js';
import type {FallbackGuidance, FallbackPolicy} from './daemon-protocol.js';

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
