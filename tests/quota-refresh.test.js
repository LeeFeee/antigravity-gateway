'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { QuotaManager, TARGETED_REFRESH_MIN_INTERVAL_MS, usageQuotaSnapshot } = require('../src/quota-manager');

const NOW = Date.parse('2026-09-30T00:00:00Z');
const HOUR = 3_600_000;
const usageBody = { groups: [{ groupId: 'gemini', buckets: [
  { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: new Date(NOW + 24 * HOUR).toISOString() },
  { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: new Date(NOW + 2 * HOUR).toISOString() }
] }] };
function fixture(t, { count = 1, fetch, concurrency = 2 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-quota-refresh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = NOW;
  const requests = [];
  const entries = new Map(Array.from({ length: count }, (_, index) => {
    const id = String(index);
    return [id, {
      account: { id, email: `${id}@example.com` }, healthState: 'available',
      provider: {
        access: async () => 'test-token', baseUrls: () => ['https://example.invalid'], userAgent: 'test',
        fetchImpl: async (url) => {
          requests.push({ id, url });
          if (fetch) return fetch(url, id);
          return new Response(JSON.stringify(url.endsWith(':retrieveUserQuotaSummary') ? usageBody : {}), { status: 200 });
        }
      }
    }];
  }));
  const accountPool = { hasManagedAccounts: () => true, entries, isAccountHealthy: (entry) => entry.healthState === 'available' };
  const manager = new QuotaManager({ configDir: directory, accountPool, now: () => now, refreshConcurrency: concurrency });
  return { manager, entries, requests, accountPool, directory, advance: (ms) => { now += ms; } };
}

test('targeted quota refresh fetches only the summary, shares concurrent jobs, and throttles for five minutes', async (t) => {
  const { manager, requests, advance } = fixture(t);
  const first = manager.refreshAccount('0');
  assert.equal(manager.refreshAccount('0'), first);
  await first;
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith(':retrieveUserQuotaSummary'));
  assert.equal(manager.getSchedulingSnapshot('0').groups[0].id, 'gemini');
  await manager.refreshAccount('0');
  advance(TARGETED_REFRESH_MIN_INTERVAL_MS - 1);
  await manager.refreshAccount('0');
  assert.equal(requests.length, 1);
  advance(1);
  await manager.refreshAccount('0');
  assert.equal(requests.length, 2);
});

test('background full refresh fetches plan, catalog and summary and preserves legacy scheduling snapshots', async (t) => {
  const { manager, requests } = fixture(t);
  await manager.refresh();
  assert.equal(requests.length, 3);
  const snapshot = manager.peek('0');
  assert.equal(snapshot.groupsObservedAt, new Date(NOW).toISOString());
  assert.equal(snapshot.groupsExpiresAt, snapshot.expiresAt);
  assert.ok(manager.getSchedulingSnapshot('0'));
  delete manager.snapshots['0'].groupsObservedAt;
  delete manager.snapshots['0'].groupsExpiresAt;
  assert.ok(manager.getSchedulingSnapshot('0'));
});

test('successful catalog/plan refresh does not renew stale Gemini summary data', async (t) => {
  let failSummary = false;
  const { manager, advance } = fixture(t, { fetch: async (url) => {
    if (url.endsWith(':retrieveUserQuotaSummary')) return new Response(JSON.stringify(failSummary ? { error: 'temporary failure' } : usageBody), { status: failSummary ? 503 : 200 });
    return new Response(JSON.stringify({ models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.8 } } } }), { status: 200 });
  } });
  await manager.refresh();
  const originalTime = manager.peek('0').groupsObservedAt;
  const originalExpiry = manager.peek('0').groupsExpiresAt;
  advance(31 * 60_000);
  failSummary = true;
  await manager.refresh();
  assert.equal(manager.peek('0').groupsObservedAt, originalTime);
  assert.equal(manager.peek('0').groupsExpiresAt, originalExpiry);
  assert.equal(manager.peek('0').stale, true);
  assert.equal(manager.getSchedulingSnapshot('0'), null);
  assert.equal(manager.get('0', 'gemini-test').remainingFraction, 0.8);
});

test('summary refresh does not renew old model availability and a scheduling expiry uses unknown data', async (t) => {
  const { manager, advance } = fixture(t);
  await manager.refresh();
  const modelsExpiry = manager.peek('0').modelsExpiresAt;
  advance(31 * 60_000);
  assert.equal(manager.getSchedulingSnapshot('0'), null);
  await manager.refreshAccount('0');
  assert.ok(manager.getSchedulingSnapshot('0'));
  assert.equal(manager.peek('0').modelsExpiresAt, modelsExpiry);
  assert.equal(manager.get('0', 'gemini-test'), null);
});

test('quota refresh limits account concurrency and avoids bursts for many missing snapshots', async (t) => {
  let active = 0;
  let maximum = 0;
  const { manager } = fixture(t, { count: 8, fetch: async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return new Response(JSON.stringify(usageBody), { status: 200 });
  } });
  await Promise.all(Array.from({ length: 8 }, (_, index) => manager.refreshAccount(String(index))));
  assert.equal(maximum, 2);
  assert.equal(Object.keys(manager.snapshots).length, 8);
});

test('a deleted account cannot be restored by an in-flight quota refresh', async (t) => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { manager, entries } = fixture(t, { fetch: async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify(usageBody), { status: 200 });
  } });
  const pending = manager.refreshAccount('0');
  await ready;
  entries.delete('0');
  manager.remove('0');
  release();
  assert.equal(await pending, null);
  assert.equal(manager.peek('0'), null);
});

test('a full refresh following a summary-only job still retrieves the catalog and plan', async (t) => {
  const { manager, requests } = fixture(t);
  const summary = manager.refreshAccount('0');
  const full = manager.refresh();
  await Promise.all([summary, full]);
  assert.equal(requests.filter(({ url }) => url.endsWith(':fetchAvailableModels')).length, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith(':loadCodeAssist')).length, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith(':retrieveUserQuotaSummary')).length, 2);
});

test('failed summary refreshes are throttled and never mark old snapshots fresh', async (t) => {
  const { manager, requests, advance } = fixture(t, { fetch: async () => {
    throw new Error('network timeout');
  } });
  await assert.rejects(manager.refreshAccount('0'), /network timeout/);
  await manager.refreshAccount('0');
  assert.equal(requests.length, 1);
  assert.equal(manager.getSchedulingSnapshot('0'), null);
  advance(TARGETED_REFRESH_MIN_INTERVAL_MS);
  await assert.rejects(manager.refreshAccount('0'), /network timeout/);
  assert.equal(requests.length, 2);
});

test('credential replacement refreshes the new provider after an obsolete in-flight job', async (t) => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { manager, entries } = fixture(t, { fetch: async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify(usageBody), { status: 200 });
  } });
  const pending = manager.refreshAccount('0');
  await ready;
  let newRequests = 0;
  entries.get('0').provider = {
    access: async () => 'new-test-token', baseUrls: () => ['https://example.invalid'], userAgent: 'test',
    fetchImpl: async () => { newRequests++; return new Response(JSON.stringify(usageBody), { status: 200 }); }
  };
  const replacement = manager.refreshAccount('0', { force: true });
  release();
  assert.equal(await pending, null);
  await replacement;
  assert.equal(newRequests, 1);
  assert.ok(manager.getSchedulingSnapshot('0'));
});

test('account scheduling does not await quota refresh and fresh sticky continuations do not query it', async (t) => {
  const { manager, directory } = fixture(t);
  const store = new AccountStore({ configDir: directory });
  const saved = store.save({ email: 'user@example.com', accessToken: 'test', refreshToken: 'test' });
  const pool = new AccountPool({ store, fallbackProvider: {}, now: () => NOW, providerFactory: () => ({
    send: async () => ({ text: 'ok', toolCalls: [], usage: {} })
  }) });
  let refreshes = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  pool.quotaManager = {
    get: (id) => manager.get(id), getSchedulingSnapshot: (id) => manager.getSchedulingSnapshot(id),
    refreshAccount: () => { refreshes++; return blocked; }
  };
  const result = await pool.send({}, 'gemini-test', { routingKey: 'sticky' });
  assert.equal(result.accountId, saved.id);
  assert.equal(refreshes, 1);
  await pool.send({}, 'gemini-test', { routingKey: 'sticky' });
  assert.equal(refreshes, 1);
  release();
});

test('null, empty or boolean summary fractions do not become exhausted quota buckets', () => {
  const groups = usageQuotaSnapshot({ groups: [{ groupId: 'gemini', buckets: [
    ...[null, '', ' ', false].map((remainingFraction) => ({ window: 'weekly', remainingFraction })),
    { window: 'weekly', remainingFraction: 0 }
  ] }] });
  assert.equal(groups[0].buckets.length, 1);
  assert.equal(groups[0].buckets[0].available, false);
});

test('a quota challenge after a pool reload marks the current account entry unhealthy', async (t) => {
  const { manager, directory } = fixture(t);
  const store = new AccountStore({ configDir: directory });
  const saved = store.save({ email: 'user@example.com', accessToken: 'test', refreshToken: 'test' });
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pool = new AccountPool({ store, fallbackProvider: {}, now: () => NOW, providerFactory: () => ({
    access: async () => 'test', baseUrls: () => ['https://example.invalid'], userAgent: 'test',
    fetchImpl: async () => {
      started();
      await new Promise((resolve) => { release = resolve; });
      return new Response('{"error":{"message":"Verify your account to continue"}}', { status: 403 });
    }
  }) });
  manager.accountPool = pool;
  pool.quotaManager = manager;
  const pending = manager.refreshAccount(saved.id);
  await ready;
  const original = pool.entries.get(saved.id);
  pool.reload();
  assert.notEqual(pool.entries.get(saved.id), original);
  release();
  await assert.rejects(pending, /Verify your account/);
  assert.equal(pool.entries.get(saved.id).healthState, 'verification_required');
  assert.equal(manager.peek(saved.id), null);
});

test('an optional summary permission denial does not quarantine an otherwise working account', async (t) => {
  const { manager, accountPool, requests } = fixture(t, { fetch: async (url) => {
    if (url.endsWith(':retrieveUserQuotaSummary')) return new Response('{"error":"permission denied"}', { status: 403 });
    return new Response('{"models":{}}', { status: 200 });
  } });
  let healthFailures = 0;
  accountPool.observeAccountFailure = () => { healthFailures++; return true; };
  await assert.rejects(manager.refreshAccount('0'), /permission denied/);
  await manager.refresh();
  assert.equal(healthFailures, 0);
  assert.equal(requests.filter(({ url }) => url.endsWith(':fetchAvailableModels')).length, 1);
  assert.equal(manager.getSchedulingSnapshot('0')?.groups.length || 0, 0);
});
