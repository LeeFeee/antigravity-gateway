'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { RobinAccountPool, ROBIN_QUOTA_TTL_MS, ROBIN_QUOTA_RETRY_MS } = require('../src/robin-account-pool');
const { RobinProvider, GET_USAGE_INFO_PATH, ARGON_MODEL } = require('../src/robin-provider');
const { robinQuotaSnapshot } = require('../src/robin-quota');
const { concatFields, fieldKey, intField, messageField, stringField, decodeFields } = require('../src/robin-proto');

const now = Date.parse('2026-10-14T00:00:00Z');
function budget(type, used, seconds = now / 1000 + 3600) {
  const float = Buffer.alloc(4); float.writeFloatLE(used);
  return messageField(3, concatFields([
    intField(1, type), messageField(2, concatFields([
      messageField(1, intField(1, seconds)),
      Buffer.concat([fieldKey(2, 5), float]), stringField(3, 'Native title')
    ]))
  ]));
}
const response = () => concatFields([intField(2, 2), budget(1, 0.25), budget(2, 0.125)]);

test('Robin quota maps the empirically verified TIER1 account to Google AI Pro', () => {
  const q = robinQuotaSnapshot(response(), now);
  assert.equal(q.userTier, 2);
  assert.equal(q.planName, 'Google AI Pro');
  assert.equal(q.fetchedAt, new Date(now).toISOString());
  assert.deepEqual(q.groups[0].buckets.map(b => [b.window, b.remainingFraction, b.resetTime]), [
    ['5h', 0.75, '2026-10-14T01:00:00.000Z'], ['weekly', 0.875, '2026-10-14T01:00:00.000Z']
  ]);
});

test('Robin quota leaves every unverified subscription tier unnamed', () => {
  for (const value of [0, 1, 3, 4, 5, 99]) {
    assert.equal(robinQuotaSnapshot(intField(2, value), now).planName, undefined);
  }
});

test('Robin quota preserves zero/full and ignores unknown, missing or invalid fractions', () => {
  const q = robinQuotaSnapshot(concatFields([
    budget(1, 0), budget(2, 1), budget(3, 0), budget(100, 0),
    budget(1, NaN), budget(1, -1), budget(1, Infinity), budget(1, 1.5),
    messageField(3, concatFields([intField(1, 1), messageField(2, stringField(3, 'No fraction'))]))
  ]), now);
  assert.deepEqual(q.groups[0].buckets.map(b => b.remainingFraction), [1, 0]);
  assert.equal(q.groups[0].available, false);
  assert.deepEqual(robinQuotaSnapshot(Buffer.alloc(0), now).groups, []);
  assert.throws(() => robinQuotaSnapshot(Buffer.from([0x1a, 0xff])));
});

test('Robin provider uses its own auth and native usage RPC', async () => {
  const signal = new AbortController().signal;
  let rpcSignal;
  const provider = new RobinProvider({
    auth: { account: { providerMetadata: { robinDeviceId: 'device' } }, get: async s => {
      assert.ok(s instanceof AbortSignal); rpcSignal = s; return { accessToken: 'robin-token', serverToken: 'robin-server' };
    } },
    transport: { unary: async (rpc, token, bytes, options) => {
      assert.equal(rpc, GET_USAGE_INFO_PATH); assert.equal(token, 'robin-token');
      assert.equal(options.headers['x-server-token'], 'robin-server'); assert.equal(options.signal, rpcSignal);
      assert.equal(decodeFields(bytes)[0].number, 1);
      return response();
    } }
  });
  assert.equal((await provider.getQuota(signal)).groups[0].buckets.length, 2);
});

function harness(t, getQuota) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-quota-'));
  const store = new AccountStore({ configDir: dir, directoryName: 'robin-accounts' });
  store.save({ id: 'r', accessToken: 'token', providerType: 'robin', accountType: 'gemini-app' });
  let clock = now;
  const pool = new RobinAccountPool({ store, now: () => clock, providerFactory: () => ({ getQuota }) });
  t.after(() => { pool.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, pool, advance: ms => { clock += ms; } };
}

test('Robin quota coalesces calls, survives restart and does not rewrite concurrent credentials', async t => {
  let resolve, calls = 0;
  const { store, pool, advance } = harness(t, () => { calls++; return new Promise(r => { resolve = r; }); });
  const first = pool.refreshQuota('r'), second = pool.refreshQuota('r');
  assert.equal(calls, 1);
  store.update('r', { accessToken: 'new-token', providerMetadata: { robinDeviceId: 'new-device' } });
  resolve(robinQuotaSnapshot(response(), now));
  await Promise.all([first, second]);
  assert.equal(store.list()[0].accessToken, 'new-token');
  assert.equal(store.list()[0].providerMetadata.robinDeviceId, 'new-device');
  assert.equal(store.list()[0].planName, 'Google AI Pro');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
    const credential = fs.readdirSync(store.directory).find(name => name.endsWith('.json'));
    assert.equal(fs.statSync(path.join(store.directory, credential)).mode & 0o777, 0o600);
  }
  assert.equal(pool.status()[0].quota.stale, false);
  await pool.refreshQuota('r'); assert.equal(calls, 1);
  const restored = new RobinAccountPool({ store, now: pool.now, providerFactory: pool.providerFactory });
  t.after(() => restored.stop());
  assert.equal(restored.status()[0].quota.groups[0].buckets[0].remainingFraction, 0.75);
  advance(ROBIN_QUOTA_TTL_MS);
  assert.equal(pool.status()[0].quota.stale, true);
});

test('Robin quota failures are throttled and cannot mark the account unhealthy', async t => {
  let calls = 0;
  const { pool, advance } = harness(t, async () => { calls++; throw Object.assign(new Error('optional telemetry unavailable'), { status: 403 }); });
  await pool.refreshQuota('r'); await pool.refreshQuota('r');
  assert.equal(calls, 1); assert.equal(pool.status()[0].state, 'available');
  advance(ROBIN_QUOTA_RETRY_MS); await pool.refreshQuota('r'); assert.equal(calls, 2);
});

test('Robin quota cannot resurrect deleted accounts or write after shutdown', async t => {
  let resolve;
  const { pool, store } = harness(t, () => new Promise(r => { resolve = r; }));
  const pending = pool.refreshQuota('r');
  pool.removeAccount('r'); resolve(robinQuotaSnapshot(response(), now)); await pending;
  assert.equal(store.list().length, 0);
  store.save({ id: 'r', accessToken: 'again', providerType: 'robin', accountType: 'gemini-app' });
  pool.quotaAttempts.clear();
  const stopped = pool.refreshQuota('r'); pool.stop(); resolve(robinQuotaSnapshot(response(), now)); await stopped;
  assert.equal(store.list()[0].providerMetadata.robinQuota, undefined);
});

test('an old Robin quota result cannot overwrite a replacement grant or remove its new pending refresh', async t => {
  const pending = [];
  const { store, pool } = harness(t, () => new Promise(resolve => pending.push(resolve)));
  const old = pool.refreshQuota('r');
  store.update('r', { refreshToken: 'replacement-grant' });
  pool.reload();
  const fresh = pool.refreshQuota('r');
  assert.equal(pending.length, 2, 'a replacement grant must not join the old quota request');
  pending[0](robinQuotaSnapshot(response(), now));
  assert.equal(await old, null);
  assert.equal(pool.quotaRefreshes.size, 1, 'the old finally cannot delete the current request');
  assert.equal(store.list()[0].providerMetadata.robinQuota, undefined);
  pending[1](robinQuotaSnapshot(budget(1, 0.5), now));
  await fresh;
  assert.equal(pool.status()[0].quota.groups[0].buckets[0].remainingFraction, 0.5);
});

test('an old Robin quota result cannot attach to a deleted and recreated account with the same ID', async t => {
  let resolve;
  const { store, pool } = harness(t, () => new Promise(done => { resolve = done; }));
  const original = store.list()[0];
  const request = pool.refreshQuota('r');
  pool.removeAccount('r');
  store.save(original); // Even an exact restore has a different pool entry.
  pool.reload();
  resolve(robinQuotaSnapshot(response(), now));
  assert.equal(await request, null);
  assert.equal(store.list()[0].providerMetadata.robinQuota, undefined);
});

test('Robin background quota checks skip disabled and unhealthy accounts', async t => {
  let calls = 0;
  const { store, pool } = harness(t, async () => { calls++; return robinQuotaSnapshot(response(), now); });
  store.update('r', { enabled: false }); await pool.refreshQuotas(); assert.equal(calls, 0);
  store.update('r', { enabled: true }); pool.reload();
  pool.saveHealth(pool.entries.get('r'), 'account', 'authentication_error', 'reauthorize', Infinity);
  await pool.refreshQuotas(); assert.equal(calls, 0);
});

test('Robin selection skips fresh depleted quota but recovers at reset without changing health', async t => {
  const { pool, store, advance } = harness(t, async () => robinQuotaSnapshot(budget(1, 1), now));
  store.update('r', { capabilities: [ARGON_MODEL] });
  pool.entries.get('r').models.add(ARGON_MODEL);
  await pool.refreshQuota('r');
  assert.equal(pool.selectAccount(ARGON_MODEL, 'one'), null);
  assert.equal(pool.status()[0].state, 'quota_exhausted');
  await assert.rejects(pool.send({ messages: [], tools: [] }, ARGON_MODEL, { clientId: 'c', sessionId: 's' }), {
    code: 'robin_quota_error', status: 429
  });
  assert.equal(store.list()[0].providerMetadata.robinHealth, undefined);
  advance(3600000);
  assert.equal(pool.status()[0].state, 'available');
  assert.equal(pool.selectAccount(ARGON_MODEL, 'one').account.id, 'r');
});

test('Robin quota snapshot never breaks an already executing client tool task', async t => {
  const { pool, store } = harness(t, async () => robinQuotaSnapshot(budget(2, 1), now));
  store.update('r', { capabilities: [ARGON_MODEL] });
  pool.entries.get('r').models.add(ARGON_MODEL);
  const options = { clientId: 'c', sessionId: 's' };
  pool.entries.get('r').provider.send = async (_normalized, _model, options) => {
    assert.equal(options.requireExistingTurn, true);
    return { text: 'done', toolCalls: [], usage: {} };
  };
  pool.activeTasks.set(JSON.stringify(['c', 's']), 'r');
  await pool.refreshQuota('r');
  const result = await pool.send({ messages: [], tools: [] }, ARGON_MODEL, options);
  assert.equal(result.text, 'done');
  assert.equal(pool.activeTasks.size, 0);
});
