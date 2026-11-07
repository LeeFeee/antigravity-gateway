'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { AccountPool } = require('../src/account-pool');
const { QuotaManager } = require('../src/quota-manager');
const { geminiQuotaProtection, LOW_QUOTA_REFRESH_MS, QUOTA_RETRY_MS } = require('../src/account-scheduling');

const NOW = Date.parse('2026-11-04T00:00:00Z'), MINUTE = 60_000;
const GEMINI = 'gemini-3.8-flash-high', CLAUDE = 'claude-sonnet-5-5-high';
const CHANNELS = ['api'];
const input = { messages: [], tools: [] };
function quota(five = 0.5, weekly = 0.5) {
  return { groups: [{ id: 'gemini', groupId: 'gemini', buckets: [
    { id: 'gemini-5h', window: '5h', remainingFraction: five, resetTime: new Date(NOW + 2 * MINUTE).toISOString() },
    { id: 'gemini-weekly', window: 'weekly', remainingFraction: weekly, resetTime: new Date(NOW + 86400000).toISOString() }
  ] }] };
}

function fixture(t, channel, balances = [0.5, 0.5]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-quota-protection-'));
  const store = new AccountStore({ configDir: dir });
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
      providerType: 'cloudcode', accountType: 'antigravity',
      capabilities: [GEMINI, CLAUDE, 'gemini-3.1-flash-image'],
      authMethod: 'oauth'
    });
  });
  let pool, manager;
  const create = () => {
    pool = new AccountPool({ store, now: () => time, providerFactory: factory });
    manager = new QuotaManager({ configDir: dir, accountPool: pool, now: () => time });
    pool.quotaManager = manager;
  };
  create();
  t.after(() => { manager?.stop(); pool.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    get pool() { return pool; }, get manager() { return manager; }, store, responses, calls, quotaCalls,
    advance: ms => { time += ms; },
    refresh: id => manager.refreshAccount(id),
    fastRefresh: () => manager.refreshLowQuotas(),
    bind: (key, id) => pool.bindSession(key, id),
    restart: () => { manager?.stop(); pool.stop(); create(); },
    status: id => pool.status().find(account => account.id === id)
  };
}

test('strict 10/15% boundaries, decimal rounding, Gemini-only quota and unknown values', () => {
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
    assert.deepEqual(geminiQuotaProtection(invalid, previous), previous);
  }
  assert.equal(geminiQuotaProtection(quota(0.6, 0)).protected, true, 'weekly depletion triggers independent protection');
  assert.equal(geminiQuotaProtection({ groups: [{ id: 'claude-gpt', buckets: quota(0).groups[0].buckets }] }), null);
  assert.deepEqual(geminiQuotaProtection({ groups: [] }, previous), previous);
});

test('weekly 5% boundary and independent window recovery reject missing or malformed readings', () => {
  for (const [weekly, blocked] of [[0, true], [0.04999, true], [0.05, false], [1 - 0.95, false], [1, false]]) {
    const state = geminiQuotaProtection(quota(0.5, weekly));
    assert.equal(state.protected, blocked); assert.equal(state.weekly.protected, blocked);
    assert.equal(state.fastRefresh, false, 'weekly reserve does not change the five-hour fast-refresh threshold');
  }
  const previous = geminiQuotaProtection(quota(0.09, 0.04));
  for (const raw of [null, undefined, '', true, false, -1, 1.1, 'bad', Infinity]) {
    const invalid = quota(0.5); invalid.groups[0].buckets[1].remainingFraction = raw;
    const next = geminiQuotaProtection(invalid, previous);
    assert.equal(next.fiveHour.protected, false); assert.equal(next.weekly.protected, true);
    assert.equal(next.protected, true);
  }
  const onlyWeekly = quota(0.5, 0.05); onlyWeekly.groups[0].buckets.shift();
  const halfRecovered = geminiQuotaProtection(onlyWeekly, previous);
  assert.equal(halfRecovered.weekly.protected, false); assert.equal(halfRecovered.protected, true);
  const onlyFive = quota(0.1); onlyFive.groups[0].buckets.pop();
  assert.equal(geminiQuotaProtection(onlyFive, halfRecovered).protected, false);
  const duplicate = quota(0.5, 0.5); duplicate.groups[0].buckets.push({ ...duplicate.groups[0].buckets[1] });
  assert.equal(geminiQuotaProtection(duplicate, previous).weekly.protected, true);
});

for (const channel of CHANNELS) {
  test(`${channel}: weekly reserve beats affinity and cannot be cleared by five-hour recovery or expiry`, async t => {
    const f = fixture(t, channel);
    f.responses.set('a0', quota(0.5, 0.04)); f.responses.set('a1', quota(0.5, 0.03));
    await f.refresh('a0'); await f.refresh('a1'); f.bind('family', 'a0');
    assert.equal(f.pool.selectAccount(GEMINI, 'family', new Set(), { preferredAccountId: 'a0' }), null);
    await assert.rejects(f.pool.send(input, GEMINI), { code: 'account_quota_protected' });
    assert.equal(f.calls.length, 0);
    assert.ok(f.pool.selectAccount(CLAUDE, 'other'));
    f.advance(8 * 86400000); f.restart();
    assert.equal(f.status('a0').state, 'quota_protected');
    const incomplete = quota(1); incomplete.groups[0].buckets.pop();
    f.responses.set('a0', incomplete); await f.refresh('a0');
    assert.equal(f.status('a0').state, 'quota_protected');
    f.restart(); assert.equal(f.status('a0').state, 'quota_protected');
    f.responses.set('a1', quota(0.5, 0.05)); await f.refresh('a1');
    assert.equal(f.pool.selectAccount(GEMINI, 'family', new Set(), { preferredAccountId: 'a0' }).account.id, 'a1');
    assert.equal(f.status('a1').state, 'available');
  });

  test(`${channel}: startup migrates v1.7.3 five-hour state and retains newer per-window protection`, async t => {
    const f = fixture(t, channel, [0.5]);
    f.responses.set('a0', quota(0.5, 0.04)); await f.refresh('a0');
    const legacy = { remainingFraction: 0.5, protected: false, fastRefresh: false, resetTime: '', observedAt: '' };
    f.manager.snapshots.a0.geminiQuotaProtection = legacy; f.manager.save();
    f.restart(); assert.equal(f.status('a0').state, 'quota_protected');
    // New persisted protection wins over stale legacy summary data on restart.
    const state = f.status('a0').quotaProtection;
    f.manager.snapshots.a0.groups = quota(0.5, 0.8).groups;
    f.manager.snapshots.a0.geminiQuotaProtection = state; f.manager.save();
    f.restart(); assert.equal(f.status('a0').state, 'quota_protected');
  });
}

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
    f.pool.markAccountIssue(entry, { status: 401, message: 'invalid_grant' });
    f.advance(MINUTE); await f.fastRefresh();
    assert.equal(f.quotaCalls.length, 2);
    assert.equal(f.status('a0').state, 'disabled');
    assert.equal(f.status('a1').state, 'authentication_error');
  });
}

test('Google Antigravity API sticky hot path reads only the protection flag, never snapshots, network or ranking', async t => {
  const f = fixture(t, 'api', [0.5]);
  await f.refresh('a0'); f.bind('family', 'a0');
  f.manager.get = f.manager.getSchedulingSnapshot = () => { throw new Error('unexpected quota read'); };
  f.pool.quotaRanks = () => { throw new Error('unexpected sorting'); };
  assert.equal(f.pool.selectAccount(GEMINI, 'family', new Set()).account.id, 'a0');
  assert.equal(f.quotaCalls.length, 1);
});

test('preferred image cannot bypass the reserve and an empty pool does not become a local session', async t => {
  const f = fixture(t, 'api', [0.08]); await f.refresh('a0');
  // Image generation has a distinct preferred-account route but shares the gate.
  await assert.rejects(f.pool.generateImage({}, { accountId: 'a0' }), { code: 'account_quota_protected' });
  assert.equal(f.calls.length, 0);
  f.pool.entries.clear();
  f.manager.protections.set('local-agy-session', geminiQuotaProtection(quota(0.08)));
  assert.deepEqual(f.manager.activeEntries(), []);
  await assert.rejects(f.pool.send(input, GEMINI), { code: 'account_pool_unavailable' });
  await assert.rejects(f.pool.generateImage({}), { code: 'account_pool_unavailable' });
});

test('Google Antigravity API preferred image account switches to a healthy alternate without rebinding its parent', async t => {
  const f = fixture(t, 'api', [0.08, 0.5]);
  await f.refresh('a0'); await f.refresh('a1'); f.bind('parent', 'a0');
  const result = await f.pool.generateImage({}, { accountId: 'a0', routingKey: 'parent', bindRouting: false });
  assert.equal(result.accountId, 'a1'); assert.deepEqual(f.calls, [{ id: 'a1', model: 'image' }]);
  // Next text request reselects as usual; auxiliary images never own the parent's binding.
  assert.notEqual(f.pool.selectAccount(GEMINI, 'parent', new Set()).account.id, 'a0');
});

test('fast-refresh timers are registered and removed on stop in the API quota manager', async t => {
  const timers = [], cleared = [];
  t.mock.method(global, 'setInterval', (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; });
  t.mock.method(global, 'clearInterval', timer => cleared.push(timer));
  for (const channel of CHANNELS) {
    const f = fixture(t, channel, [0.08]); await f.refresh('a0');
    const scheduler = f.manager || f.pool;
    scheduler.start();
    assert.equal(scheduler.lowQuotaTimer.ms, MINUTE);
    scheduler.stop(); assert.equal(scheduler.lowQuotaTimer, null);
  }
  assert.equal(timers.filter(timer => timer.ms === MINUTE).length, 1);
  assert.equal(cleared.length, 2);
});
