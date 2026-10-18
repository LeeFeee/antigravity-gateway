'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { GeminiAccountStore } = require('../src/gemini-account-store');
const { GeminiWindowsProvider } = require('../src/gemini-windows-provider');
const { TerminalConsole } = require('../src/terminal-console');
const { dashboardData } = require('../src/dashboard');
const { RobinAccountPool, ROBIN_QUOTA_TTL_MS } = require('../src/robin-account-pool');
const { windowsQuotaSnapshot, parseWindowsQuota, fetchWindowsQuota, WINDOWS_USAGE_QUERY } = require('../src/gemini-windows-quota');

const now = Date.parse('2026-10-18T09:45:00Z');
const cookies = [{ name: 'SAPISID', value: 'test-only', domain: '.google.com', expires: -1 },
  { name: 'SID', value: 'test-session', domain: '.google.com', expires: -1 }];
// Shape and fractional units verified with two real Windows accounts via the
// official UsagePageQuery. This fixture contains no credentials or identifiers.
function usage(five = 1, weekly = 0.05026779) {
  return { subscriptionTier: 'TIER1', pools: [
    { poolType: 'GXU_FIVE_HOURLY', percentageUsed: five, gxu: { windowRefreshesAt: '2026-10-18T10:11:21.023168Z' } },
    { poolType: 'GXU_WEEKLY', percentageUsed: weekly, gxu: { windowRefreshesAt: '2026-10-25T05:11:21.023256Z' } }
  ], advancedSettings: null, useOverageAiCredits: false };
}
const envelope = (value, extra = {}) => `)]}'\n${JSON.stringify([{ data: { viewer: { rpcs: { getUsageInfo: value } } }, ...extra }])}`;
const account = id => ({ id, providerType: 'robin', accountType: 'gemini-app', authMethod: 'gemini-windows-session',
  subjectId: id, email: `${id}@example.com`, capabilities: ['gemini-4-argon'],
  providerMetadata: { geminiWindows: { cookies } } });

test('Windows usage maps verified 0..1 fractions, plans and independent reset windows', () => {
  const result = parseWindowsQuota(envelope(usage()), now);
  assert.equal(result.planName, 'Google AI Pro');
  assert.equal(result.source, 'gemini-windows-usage');
  assert.equal(result.fetchedAt, new Date(now).toISOString());
  const [five, weekly] = result.groups[0].buckets;
  assert.equal(five.remainingFraction, 0); assert.equal(weekly.remainingFraction, 0.94973221);
  assert.equal(five.resetTime, '2026-10-18T10:11:21.023Z'); assert.equal(weekly.resetTime, '2026-10-25T05:11:21.023Z');
  assert.equal(result.groups[0].available, false);
  assert.equal(windowsQuotaSnapshot(usage(0, 0), now).groups[0].buckets[0].remainingFraction, 1);
  for (const [tier, plan] of [['TIER2', 'Google AI Ultra'], ['TIER_NEON', 'Google AI Ultra'], ['TIER_HELIUM', 'Google AI Plus'], ['FUTURE', undefined]]) {
    assert.equal(windowsQuotaSnapshot({ ...usage(), subscriptionTier: tier }, now).planName, plan);
  }
});

test('Windows quota never treats unknown/duplicate pools, credits or missing percentages as a balance', () => {
  for (const fraction of [undefined, null, '0', NaN, Infinity, -1, 100, 1.1]) {
    const value = usage(fraction); value.pools[0].percentageUsed = fraction;
    assert.deepEqual(windowsQuotaSnapshot(value, now).groups[0].buckets.map(b => b.window), ['weekly']);
  }
  const value = usage(); value.pools.push(value.pools[0], { poolType: 'AI_CREDITS', percentageUsed: 1 });
  assert.deepEqual(windowsQuotaSnapshot(value, now).groups[0].buckets.map(b => b.window), ['weekly']);
  assert.throws(() => windowsQuotaSnapshot({ pools: [] }), /没有可识别/);
  assert.throws(() => windowsQuotaSnapshot({}), /缺少额度池/);
  value.pools = [{ ...usage().pools[0], gxu: { windowRefreshesAt: 'invalid' } }];
  assert.equal(windowsQuotaSnapshot(value, now).groups[0].buckets[0].resetTime, '');
});

test('GraphQL errors and truncated/ambiguous data cannot overwrite a saved quota snapshot', () => {
  for (const source of ['<html>login</html>', '[]', '{}', envelope(null), envelope(usage()).slice(0, -1)]) {
    assert.throws(() => parseWindowsQuota(source));
  }
  assert.throws(() => parseWindowsQuota(envelope(usage(), { errors: [{ message: 'failed' }] })), /未能完整/);
  assert.throws(() => parseWindowsQuota(envelope(usage(), { errors: {} })), /错误格式/);
  assert.throws(() => parseWindowsQuota(envelope(usage(), { errors: [null] })), /未能完整/);
  assert.throws(() => parseWindowsQuota(envelope(usage(), { hasNext: true })), /截断/);
  assert.throws(() => parseWindowsQuota(envelope(usage(), { errors: [{ path: ['viewer', 'rpcs', 'getUsageInfo'] }] })), /未能完整/);
  assert.equal(parseWindowsQuota(envelope(usage(), { errors: [{ path: ['viewer', 'rpcs', 'getG1Interventions'] }] }), now).groups.length, 1);
  const frame = JSON.parse(envelope(usage()).slice(5))[0];
  assert.throws(() => parseWindowsQuota(JSON.stringify([frame, frame])), /唯一/);
});

function transport(responses, inspect = () => {}) {
  let calls = 0;
  const requestImpl = (url, options, callback) => {
    inspect(url, options, calls);
    const item = responses[calls++] || responses.at(-1), req = new EventEmitter(), res = new EventEmitter();
    res.statusCode = item.status ?? 200; res.headers = item.headers || {}; res.resume = () => {};
    req.destroy = error => req.emit('error', error);
    queueMicrotask(() => {
      callback(res);
      if (res.statusCode === 200) {
        res.emit('data', Buffer.from(item.body ?? envelope(usage())));
        if (item.aborted) res.emit('aborted'); else res.emit('end');
      }
    });
    return req;
  };
  return { requestImpl, calls: () => calls };
}

test('quota transport is a bounded read-only request with the selected Google cookie session', async () => {
  const fake = transport([{}], (url, options) => {
    assert.equal(url.origin, 'https://gemini.google.com');
    assert.match(url.pathname, /graphql\/schemas\/GEMINI_WEB_GRAPHQL\/executeQuery$/);
    assert.equal(url.searchParams.get('query_signature'), WINDOWS_USAGE_QUERY);
    assert.equal(url.searchParams.get('authuser'), '2');
    assert.equal(options.method, undefined); assert.equal(options.body, undefined);
    assert.equal(options.maxHeaderSize, 256 * 1024);
    assert.match(options.headers.Cookie, /SID=test-session/); assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!url.href.includes('processSession')); assert.ok(!options.headers.Authorization);
  });
  const result = await fetchWindowsQuota({ cookies, authUser: '2', endpoint: 'https://evil.invalid/' }, fake);
  assert.equal(result.groups[0].buckets[0].remainingFraction, 0); assert.equal(fake.calls(), 1);
  await assert.rejects(fetchWindowsQuota({ cookies, authUser: '../1' }, fake), /账号索引/);
  await assert.rejects(fetchWindowsQuota({ cookies }, { ...fake, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fake.calls(), 1);
});

test('quota redirects cannot forward credentials to another host, account or endpoint', async () => {
  const base = '/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery';
  for (const target of ['https://evil.invalid/', 'https://accounts.google.com/', '/app', base, '/u/1'+base+'?query_signature='+encodeURIComponent(WINDOWS_USAGE_QUERY)]) {
    const fake = transport([{ status: 302, headers: { location: target } }]);
    await assert.rejects(fetchWindowsQuota({ cookies, authUser: '2' }, fake), /跳转/); assert.equal(fake.calls(), 1);
  }
  const target = '/u/2'+base+'?query_signature='+encodeURIComponent(WINDOWS_USAGE_QUERY);
  const good = transport([{ status: 302, headers: { location: target } }, {}]);
  assert.equal((await fetchWindowsQuota({ cookies, authUser: '2' }, good)).groups.length, 1);
  const loop = transport([{ status: 302, headers: { location: target } }]);
  await assert.rejects(fetchWindowsQuota({ cookies, authUser: '2' }, loop), /跳转/); assert.equal(loop.calls(), 4);
});

test('quota transport reports HTTP, oversized and interrupted bodies without starting inference', async () => {
  await assert.rejects(fetchWindowsQuota({ cookies }, transport([{ status: 429 }])), { status: 429 });
  await assert.rejects(fetchWindowsQuota({ cookies }, transport([{ body: ' '.repeat(4 * 1024 * 1024 + 1) }])), /超过限制/);
  await assert.rejects(fetchWindowsQuota({ cookies }, transport([{ aborted: true }])), /截断/);
});

test('Windows provider quota uses its verified account bootstrap and does not invoke model transport', async () => {
  const signal = new AbortController().signal;
  const provider = new GeminiWindowsProvider({
    auth: { get: async received => { assert.equal(received, signal); return { cookies, subjectId: 'expected' }; } },
    fetchImpl: async () => assert.fail('Inference must not be called'),
    quotaFetch: async (record, options) => { assert.equal(record.subjectId, 'expected'); assert.equal(options.signal, signal); return windowsQuotaSnapshot(usage(), now); }
  });
  assert.equal((await provider.getQuota(signal)).groups[0].available, false);
});

function harness(t, fetchQuota = () => windowsQuotaSnapshot(usage(), now)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-quota-'));
  const store = new GeminiAccountStore({ configDir: dir }); store.save(account('one')); store.save(account('two'));
  let time = now, calls = 0;
  const factory = account => ({ getQuota: async () => { calls++; return fetchQuota(account); } });
  const pool = new RobinAccountPool({ store, now: () => time, providerFactory: factory });
  t.after(() => { pool.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { pool, store, calls: () => calls, advance: ms => { time += ms; }, factory };
}

test('Windows snapshots persist on their own accounts, appear in status and guide existing failover', async t => {
  const { pool, store, calls, advance, factory } = harness(t, account => windowsQuotaSnapshot(usage(account.id === 'one' ? 1 : 0, 0.05), now));
  const oauth = store.save({ ...account('oauth'), authMethod: 'oauth', accessToken: 'oauth-only', providerMetadata: { robinQuota: windowsQuotaSnapshot(usage(0), now) } });
  const oauthFile = path.join(store.oauth.directory, fs.readdirSync(store.oauth.directory)[0]);
  const original = fs.readFileSync(oauthFile);
  await pool.refreshQuota('one'); await pool.refreshQuota('two');
  assert.equal(calls(), 2); assert.deepEqual(fs.readFileSync(oauthFile), original);
  assert.equal(store.windows.list()[0].providerMetadata.robinQuota, undefined);
  assert.equal(store.windows.list()[0].planName, 'Google AI Pro');
  assert.ok(store.windows.list()[0].providerMetadata.geminiWindowsQuota);
  const status = pool.status();
  assert.equal(status.find(a => a.id === 'one').quotaDepleted, true);
  assert.equal(status.find(a => a.id === 'one').state, 'available');
  assert.equal(status.find(a => a.id === 'two').quota.groups[0].buckets[0].remainingFraction, 1);
  assert.equal(pool.selectAccount('gemini-4-argon', 'client', new Set([oauth.id])).account.id, 'two');
  assert.equal(pool.entries.get('one').unhealthyUntil, 0);
  const dashboard = dashboardData({ usageStore: { summary: () => ({}) }, accountPool: { status: () => [] }, robinAccountPool: pool });
  assert.equal(dashboard.accounts.find(a => a.id === 'one').quota.groups[0].buckets[0].remainingFraction, 0);
  assert.equal(dashboard.accounts.find(a => a.id === 'one').tokenUsageKnown, false);
  const restored = new RobinAccountPool({ store, now: pool.now, providerFactory: factory }); t.after(() => restored.stop());
  assert.equal(restored.status().find(a => a.id === 'one').quotaDepleted, true);
  await pool.refreshQuota('one'); assert.equal(calls(), 2);
  advance(ROBIN_QUOTA_TTL_MS); assert.equal(pool.status().find(a => a.id === 'one').quota.stale, true);
  await pool.refreshQuota('one'); assert.equal(calls(), 3);
});

test('a stale OAuth snapshot is never interpreted as Windows quota', t => {
  const { pool, store } = harness(t);
  store.update('one', { providerMetadata: { ...account('one').providerMetadata, robinQuota: windowsQuotaSnapshot(usage(), now) } });
  assert.equal(pool.status()[0].quota, null); assert.equal(pool.status()[0].available, true);
});

test('Windows quota failure preserves its last snapshot and cannot poison account health', async t => {
  let fail = false;
  const { pool, store, calls, advance } = harness(t, () => { if (fail) throw Error('query unavailable'); return windowsQuotaSnapshot(usage(0.25), now); });
  await pool.refreshQuota('one'); const saved = store.list()[0].providerMetadata.geminiWindowsQuota;
  fail = true; advance(ROBIN_QUOTA_TTL_MS);
  await pool.refreshQuota('one'); await pool.refreshQuota('one');
  assert.equal(calls(), 2); assert.deepEqual(store.list()[0].providerMetadata.geminiWindowsQuota, saved);
  assert.equal(pool.status()[0].state, 'available'); assert.equal(pool.status()[0].quota.stale, true);
});

test('an expired five-hour window does not release an exhausted weekly window', async t => {
  const value = usage(1, 1); value.pools[0].gxu.windowRefreshesAt = new Date(now + 60000).toISOString();
  const { pool, advance } = harness(t, () => windowsQuotaSnapshot(value, now));
  await pool.refreshQuota('one'); advance(61000);
  assert.equal(pool.status()[0].quota.stale, true);
  assert.equal(pool.status()[0].quotaDepleted, true);
});

test('Windows five-hour reset permits retry and does not manufacture a full balance', async t => {
  const value = usage(1, 0.1); value.pools[0].gxu.windowRefreshesAt = new Date(now + 60000).toISOString();
  const { pool, advance } = harness(t, () => windowsQuotaSnapshot(value, now));
  await pool.refreshQuota('one'); advance(61000);
  assert.equal(pool.status()[0].state, 'available'); assert.equal(pool.status()[0].quota.stale, true);
  assert.equal(pool.status()[0].quotaDepleted, false);
  assert.equal(pool.status()[0].quota.groups[0].buckets[0].remainingFraction, 0);
});

test('Windows async quota rejects deleted/replaced grants and coalesces refresh requests', async t => {
  const pending = [];
  const { pool, store, calls } = harness(t, () => new Promise(resolve => pending.push(resolve)));
  const old = pool.refreshQuota('one'), joined = pool.refreshQuota('one'); assert.equal(calls(), 1);
  store.update('one', { providerMetadata: { geminiWindows: { cookies: cookies.map(c => ({ ...c, value: c.value + '-new' })) } } });
  pool.reload(); const fresh = pool.refreshQuota('one'); assert.equal(calls(), 2);
  pending[0](windowsQuotaSnapshot(usage(), now)); await Promise.all([old, joined]);
  assert.equal(store.list()[0].providerMetadata.geminiWindowsQuota, undefined); assert.equal(pool.quotaRefreshes.size, 1);
  pending[1](windowsQuotaSnapshot(usage(0), now)); await fresh;
  const removed = pool.refreshQuota('two'); pool.removeAccount('two');
  pending[2](windowsQuotaSnapshot(usage(), now)); await removed;
  assert.equal(store.list().length, 1);
});

test('depleted Windows quota does not migrate a tool task already owned by that account', async t => {
  const { pool } = harness(t);
  await pool.refreshQuotas(); const options = { clientId: 'client', sessionId: 'tool-task' };
  pool.activeTasks.set(JSON.stringify(['client', 'tool-task']), 'one');
  pool.entries.get('one').provider.send = async (_normalized, _model, opts) => {
    assert.equal(opts.requireExistingTurn, true); return { text: 'done', toolCalls: [], usageKnown: false };
  };
  pool.entries.get('two').provider.send = async () => assert.fail('No tool replay');
  assert.equal((await pool.send({ messages: [], tools: [] }, 'gemini-4-argon', options)).accountId, 'one');
});

test('Windows account reauthorization clears old quota and starts a nonblocking refresh after saving', async t => {
  const { store } = harness(t);
  store.update('one', { providerMetadata: { ...account('one').providerMetadata,
    geminiWindowsQuota: windowsQuotaSnapshot(usage(), now), robinQuota: { unrelated: true }, robinHealth: { state: 'failed' } } });
  let refreshed;
  const terminal = new TerminalConsole({
    windowsLogin: { start: async () => account('one') }, windowsAccountStore: store.windows,
    robinAccountPool: { reload() {}, refreshQuota: async id => {
      refreshed = id;
      assert.equal(store.list().find(a => a.id === id).providerMetadata.geminiWindowsQuota, undefined);
      throw Error('Optional quota query failure');
    } }, output: { write() {} }, commands: {}
  });
  await terminal.addWindowsAccount(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshed, 'one'); assert.equal(terminal.adding, '');
  assert.equal(store.list()[0].providerMetadata.robinQuota, undefined);
  assert.equal(store.list()[0].providerMetadata.robinHealth, undefined);
  assert.equal(store.list().length, 2);
});

test('Windows quota refresh honors disabled accounts and rejects a late result after pool shutdown', async t => {
  let resolve;
  const { pool, store, calls } = harness(t, () => new Promise(done => { resolve = done; }));
  store.update('two', { enabled: false });
  const pending = pool.refreshQuotas(); assert.equal(calls(), 1);
  pool.stop(); resolve(windowsQuotaSnapshot(usage(), now)); await pending;
  assert.equal(store.list()[0].providerMetadata.geminiWindowsQuota, undefined);
  assert.equal(calls(), 1);
});
