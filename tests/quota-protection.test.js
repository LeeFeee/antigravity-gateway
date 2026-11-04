'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { GeminiAccountStore } = require('../src/gemini-account-store');
const { AccountPool } = require('../src/account-pool');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { QuotaManager } = require('../src/quota-manager');
const { geminiQuotaProtection, LOW_QUOTA_REFRESH_MS, QUOTA_RETRY_MS } = require('../src/account-scheduling');

const NOW = Date.parse('2026-11-04T00:00:00Z'), MINUTE = 60_000;
const GEMINI = 'gemini-4-argon', CLAUDE = 'claude-sonnet-5-5-high';
const CHANNELS = ['cloudcode', 'oauth', 'windows'];
const input = { messages: [], tools: [] };
function quota(five = 0.5, weekly = 0.5) {
  return { groups: [{ id: 'gemini', groupId: 'gemini', buckets: [
    { id: 'gemini-5h', window: '5h', remainingFraction: five, resetTime: new Date(NOW + 2 * MINUTE).toISOString() },
    { id: 'gemini-weekly', window: 'weekly', remainingFraction: weekly, resetTime: new Date(NOW + 86400000).toISOString() }
  ] }] };
}

function fixture(t, channel, balances = [0.5, 0.5]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-quota-protection-'));
  const cloud = channel === 'cloudcode';
  const store = cloud ? new AccountStore({ configDir: dir }) : new GeminiAccountStore({ configDir: dir });
  const responses = new Map(), calls = [], quotaCalls = [];
  let time = NOW;
  const factory = account => ({
    listModels: async () => [GEMINI, CLAUDE, 'gemini-3.1-flash-image'],
    access: async () => 'test-token', baseUrls: () => ['https://example.invalid'],
    getQuota: async () => {
      quotaCalls.push(account.id);
      const result = responses.get(account.id);
      if (result instanceof Error) throw result;
      return result;
    },
    fetchImpl: async url => {
      if (!url.endsWith(':retrieveUserQuotaSummary')) return new Response('{}');
      quotaCalls.push(account.id);
      const result = responses.get(account.id);
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify(result));
    },
    send: async (_input, model) => { calls.push({ id: account.id, model }); return { text: account.id, toolCalls: [], usage: {} }; },
    generateImage: async () => { calls.push({ id: account.id, model: 'image' }); return { data: 'aW1hZ2U=', usage: {} }; }
  });
  balances.forEach((balance, index) => {
    const id = `a${index}`;
    responses.set(id, quota(balance));
    store.save({ id, email: `${id}@example.com`, subjectId: id, accessToken: 'test-token', projectId: 'test',
      providerType: cloud ? 'cloudcode' : 'robin', accountType: cloud ? 'antigravity' : 'gemini-app',
      capabilities: [GEMINI, CLAUDE, 'gemini-3.1-flash-image'],
      authMethod: channel === 'windows' ? 'gemini-windows-session' : 'oauth',
      providerMetadata: channel === 'windows' ? { geminiWindows: { cookies: [{ name: 'SID', value: 'test', domain: '.google.com' }] } } : {}
    });
  });
  let pool, manager;
  const create = () => {
    if (cloud) {
      pool = new AccountPool({ store, now: () => time, providerFactory: factory });
      manager = new QuotaManager({ configDir: dir, accountPool: pool, now: () => time });
      pool.quotaManager = manager;
    } else pool = new RobinAccountPool({ store, now: () => time, providerFactory: factory });
  };
  create();
  t.after(() => { manager?.stop(); pool.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    get pool() { return pool; }, get manager() { return manager; }, store, responses, calls, quotaCalls,
    advance: ms => { time += ms; },
    refresh: id => cloud ? manager.refreshAccount(id) : pool.refreshQuota(id, { refreshFresh: true }),
    fastRefresh: () => cloud ? manager.refreshLowQuotas() : pool.refreshLowQuotas(),
    bind: (key, id) => cloud ? pool.bindSession(key, id) : pool.bind(key, id),
    restart: () => { manager?.stop(); pool.stop(); create(); },
    status: id => pool.status().find(account => account.id === id)
  };
}

test('strict 10/15% boundaries, decimal rounding, Gemini-only 5h and unknown values', () => {
  for (const [remaining, protectedState, fastRefresh] of [
    [0, true, true], [0.099, true, true], [0.1, false, true], [1 - 0.9, false, true],
    [0.1499, false, true], [0.15, false, false], [1 - 0.85, false, false], [1, false, false]
  ]) {
    const value = geminiQuotaProtection(quota(remaining));
    assert.equal(value.protected, protectedState); assert.equal(value.fastRefresh, fastRefresh);
  }
  const previous = geminiQuotaProtection(quota(0.05));
  for (const value of [null, undefined, '', true, false, -1, 1.1, 'bad', Infinity]) {
    const invalid = quota(); invalid.groups[0].buckets[0].remainingFraction = value;
    assert.equal(geminiQuotaProtection(invalid, previous), previous);
  }
  assert.equal(geminiQuotaProtection(quota(0.6, 0)).protected, false, 'weekly depletion does not trigger protection');
  assert.equal(geminiQuotaProtection({ groups: [{ id: 'claude-gpt', buckets: quota(0).groups[0].buckets }] }), null);
  assert.equal(geminiQuotaProtection({ groups: [] }, previous), previous);
});

for (const channel of CHANNELS) {
  test(`${channel}: protection beats sticky/preferred selection, all-protected never falls back`, async t => {
    const f = fixture(t, channel, [0.09, 0.09]);
    await f.refresh('a0'); await f.refresh('a1');
    f.bind('family', 'a0');
    assert.equal(f.pool.selectAccount(GEMINI, 'family', new Set(), { preferredAccountId: 'a0' }), null);
    assert.equal(f.pool.sessions.has('family'), false);
    await assert.rejects(f.pool.send(input, GEMINI, { sessionId: 's' }), { code: 'account_quota_protected' });
    assert.equal(f.calls.length, 0);
    assert.equal(f.status('a0').state, 'quota_protected');
    assert.equal(f.status('a0').lastError, '');
    assert.equal(f.pool.selectAccount(CLAUDE, 'claude').account.id.startsWith('a'), true);
    f.advance(MINUTE); f.responses.set('a1', quota(0.1));
    await f.refresh('a1'); f.bind('family', 'a0');
    assert.equal(f.pool.selectAccount(GEMINI, 'family', new Set(), { preferredAccountId: 'a0' }).account.id, 'a1');
    assert.equal(f.status('a1').state, 'available');
    assert.equal((await f.pool.send(input, GEMINI, { sessionId: 's', routingKey: 'family' })).text, 'a1');
  });

  test(`${channel}: protection survives expiry/reset/restart, missing data and failed queries`, async t => {
    const f = fixture(t, channel, [0.08]);
    await f.refresh('a0'); f.advance(36 * MINUTE); f.restart();
    assert.equal(f.status('a0').state, 'quota_protected');
    assert.equal(f.pool.selectAccount(GEMINI, '', new Set()), null);
    f.responses.set('a0', { groups: [] }); await f.refresh('a0');
    assert.equal(f.status('a0').state, 'quota_protected');
    f.advance(MINUTE); f.responses.set('a0', new Error('network timeout'));
    await f.fastRefresh();
    assert.equal(f.status('a0').state, 'quota_protected');
    f.restart(); assert.equal(f.status('a0').state, 'quota_protected');
    f.responses.set('a0', quota(0.5)); await f.refresh('a0');
    assert.equal(f.status('a0').state, 'available');
    assert.ok(f.pool.selectAccount(GEMINI, '', new Set()));
  });

  test(`${channel}: low quota refreshes once per minute, normal accounts retain five-minute throttle`, async t => {
    const f = fixture(t, channel, [0.14, 0.15]);
    await f.refresh('a0'); await f.refresh('a1');
    await f.fastRefresh(); assert.equal(f.quotaCalls.length, 2);
    f.advance(LOW_QUOTA_REFRESH_MS - 1); await f.fastRefresh(); assert.equal(f.quotaCalls.length, 2);
    f.advance(1); await f.fastRefresh(); assert.deepEqual(f.quotaCalls, ['a0', 'a1', 'a0']);
    await f.refresh('a1'); assert.equal(f.quotaCalls.length, 3);
    f.responses.set('a0', new Error('quota query unavailable'));
    f.advance(MINUTE); await f.fastRefresh(); await f.fastRefresh(); assert.equal(f.quotaCalls.length, 4);
    f.advance(MINUTE); f.responses.set('a0', quota(0.15)); await f.fastRefresh(); assert.equal(f.quotaCalls.length, 5);
    f.advance(MINUTE); await f.fastRefresh(); assert.equal(f.quotaCalls.length, 5);
    f.advance(MINUTE); await f.refresh('a1'); assert.equal(f.quotaCalls.length, 6);
    assert.equal(QUOTA_RETRY_MS, 5 * MINUTE);
  });

  test(`${channel}: disabled and authentication-failed accounts are not polled by fast refresh`, async t => {
    const f = fixture(t, channel, [0.08, 0.08]);
    await f.refresh('a0'); await f.refresh('a1');
    f.store.update('a0', { enabled: false }); f.pool.reload();
    const entry = f.pool.entries.get('a1');
    if (channel === 'cloudcode') f.pool.markAccountIssue(entry, { status: 401, message: 'invalid_grant' });
    else f.pool.saveHealth(entry, 'account', 'authentication_error', 'reauthorize', Infinity);
    f.advance(MINUTE); await f.fastRefresh();
    assert.equal(f.quotaCalls.length, 2);
    assert.equal(f.status('a0').state, 'disabled');
    assert.equal(f.status('a1').state, 'authentication_error');
  });
}

test('Cloud Code sticky hot path reads only the protection flag, never snapshots, network or ranking', async t => {
  const f = fixture(t, 'cloudcode', [0.5]);
  await f.refresh('a0'); f.bind('family', 'a0');
  f.manager.get = f.manager.getSchedulingSnapshot = () => { throw new Error('unexpected quota read'); };
  f.pool.quotaRanks = () => { throw new Error('unexpected sorting'); };
  assert.equal(f.pool.selectAccount(GEMINI, 'family', new Set()).account.id, 'a0');
  assert.equal(f.quotaCalls.length, 1);
});

test('Cloud Code preferred image and local-session fallback cannot bypass the reserve', async t => {
  const f = fixture(t, 'cloudcode', [0.08]); await f.refresh('a0');
  // Image generation has a distinct preferred-account route but shares the gate.
  await assert.rejects(f.pool.generateImage({}, { accountId: 'a0' }), { code: 'account_quota_protected' });
  assert.equal(f.calls.length, 0);
  f.pool.entries.clear();
  f.manager.protections.set('local-agy-session', geminiQuotaProtection(quota(0.08)));
  await assert.rejects(f.pool.send(input, GEMINI), { code: 'account_quota_protected' });
  await assert.rejects(f.pool.generateImage({}), { code: 'account_quota_protected' });
});

test('Cloud Code preferred image account switches to a healthy alternate without rebinding its parent', async t => {
  const f = fixture(t, 'cloudcode', [0.08, 0.5]);
  await f.refresh('a0'); await f.refresh('a1'); f.bind('parent', 'a0');
  const result = await f.pool.generateImage({}, { accountId: 'a0', routingKey: 'parent', bindRouting: false });
  assert.equal(result.accountId, 'a1'); assert.deepEqual(f.calls, [{ id: 'a1', model: 'image' }]);
  // Next text request reselects as usual; auxiliary images never own the parent's binding.
  assert.notEqual(f.pool.selectAccount(GEMINI, 'parent', new Set()).account.id, 'a0');
});

for (const channel of ['oauth', 'windows']) test(`${channel}: invalidating telemetry during reauthorization cannot clear the reserve`, async t => {
  const f = fixture(t, channel, [0.08]); await f.refresh('a0');
  const account = f.store.list()[0], metadata = { ...account.providerMetadata };
  delete metadata.robinQuota; delete metadata.geminiWindowsQuota;
  f.store.update('a0', { providerMetadata: metadata }); f.restart();
  assert.equal(f.status('a0').state, 'quota_protected');
  assert.equal(f.pool.selectAccount(GEMINI, '', new Set()), null);
});

for (const channel of ['oauth', 'windows']) test(`${channel}: a protected pending tool task is held, never replayed on another account`, async t => {
  const f = fixture(t, channel, [0.08, 0.5]);
  await f.refresh('a0'); await f.refresh('a1');
  const key = JSON.stringify(['client', 'task']);
  f.pool.activeTasks.set(key, 'a0'); f.bind('family', 'a0');
  const options = { clientId: 'client', sessionId: 'task', routingKey: 'family' };
  await assert.rejects(f.pool.send(input, GEMINI, options), { code: 'account_quota_protected' });
  assert.equal(f.calls.length, 0); assert.equal(f.pool.activeTasks.get(key), 'a0');
  f.advance(MINUTE); f.responses.set('a0', quota(0.5)); await f.refresh('a0');
  assert.equal((await f.pool.send(input, GEMINI, options)).text, 'a0');
});

test('fast-refresh timers are registered and removed on stop in both quota managers', async t => {
  const timers = [], cleared = [];
  t.mock.method(global, 'setInterval', (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; });
  t.mock.method(global, 'clearInterval', timer => cleared.push(timer));
  for (const channel of ['cloudcode', 'oauth']) {
    const f = fixture(t, channel, [0.08]); await f.refresh('a0');
    const scheduler = f.manager || f.pool;
    scheduler.start();
    assert.equal(scheduler.lowQuotaTimer.ms, MINUTE);
    scheduler.stop(); assert.equal(scheduler.lowQuotaTimer, null);
  }
  assert.equal(timers.filter(timer => timer.ms === MINUTE).length, 2);
  assert.equal(cleared.length, 4);
});
