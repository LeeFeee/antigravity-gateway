'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('../src/account-store');
const { AccountPool } = require('../src/account-pool');
const { GatewayError } = require('../src/protocol');

const HELPER = 'gemini-3.5-flash-lite';
const MAIN = 'claude-sonnet-4-6';
function fixture(t, catalogs = [[HELPER], [HELPER]]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-search-pool-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  const accounts = catalogs.map((_, index) => store.save({ email: `search-${index}@example.test`, accessToken: 'controlled-token',
    refreshToken: 'controlled-refresh', projectId: `controlled-project-${index}`, createdAt: new Date(1700000000000 + 1000 * index).toISOString() }));
  const calls = [], usage = [], failures = new Map();
  const pool = new AccountPool({ store, usageStore: { recordUpstream: event => usage.push(event) }, providerFactory: account => {
    const index = accounts.findIndex(item => item.id === account.id);
    return {
      listModels: async () => [MAIN], modelCatalog: () => [MAIN], webSearchModelCatalog: () => catalogs[index],
      searchWeb: async (request, options) => {
        calls.push({ index, request });
        options.onUpstreamAttempt({ phase: 'response', status: failures.has(index) ? 429 : 200, success: !failures.has(index) });
        if (failures.has(index)) throw failures.get(index);
        return { sourceCandidates: [], usage: { input_tokens: 2, output_tokens: 3 }, model: request.model };
      }
    };
  } });
  t.after(() => pool.stop());
  return { pool, accounts, calls, usage, failures };
}

test('a search auxiliary model is separately eligible and does not leak into ordinary model routing', async t => {
  const { pool, accounts, calls, usage } = fixture(t);
  await pool.ensureModelCatalogs();
  assert.equal(pool.eligible(HELPER).length, 0);
  assert.equal(pool.eligible(HELPER, new Set(), 'web-search').length, 2);
  const result = await pool.searchWeb({ query: 'controlled query' }, { accountId: accounts[1].id });
  assert.equal(result.accountId, accounts[1].id);
  assert.equal(result.model, HELPER);
  assert.deepEqual(calls.map(call => call.index), [1]);
  assert.ok(usage.length && usage.every(event => event.model === HELPER));
});

test('protected preferred search account cannot bypass quota, rebind or extend main-model affinity', async t => {
  const { pool, accounts, calls } = fixture(t);
  pool.quotaManager = { get: () => null, isQuotaProtected: (id, model) => id === accounts[0].id && model === HELPER };
  pool.bindSession('main-session', accounts[0].id);
  const before = structuredClone(pool.sessions.get('main-session'));
  const result = await pool.searchWeb({ query: 'controlled query' }, { accountId: accounts[0].id, routingKey: 'main-session' });
  assert.equal(result.accountId, accounts[1].id);
  assert.deepEqual(calls.map(call => call.index), [1]);
  assert.deepEqual(pool.sessions.get('main-session'), before);
  assert.ok(pool.isEntryEligible(pool.entries.get(accounts[0].id), MAIN));
});

test('all protected helper accounts cause zero search executions and preserve primary affinity', async t => {
  const { pool, accounts, calls } = fixture(t);
  pool.quotaManager = { isQuotaProtected: (_id, model) => model === HELPER };
  pool.bindSession('main-session', accounts[0].id);
  const before = structuredClone(pool.sessions.get('main-session'));
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }, { routingKey: 'main-session' }), { code: 'account_quota_protected' });
  assert.equal(calls.length, 0);
  assert.deepEqual(pool.sessions.get('main-session'), before);
});

test('one logical search failure does not retry another account and only cools its actual helper model', async t => {
  const { pool, accounts, calls, failures } = fixture(t);
  failures.set(0, Object.assign(new Error('controlled rate limit'), { status: 429, code: 'direct_search_upstream_error' }));
  pool.bindSession('main-session', accounts[0].id);
  const before = structuredClone(pool.sessions.get('main-session'));
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }, { accountId: accounts[0].id, routingKey: 'main-session' }), { status: 429 });
  assert.deepEqual(calls.map(call => call.index), [0]);
  assert.ok(pool.entries.get(accounts[0].id).modelCooldowns.get(HELPER) > Date.now());
  assert.equal(pool.entries.get(accounts[0].id).modelCooldowns.has(MAIN), false);
  assert.deepEqual(pool.sessions.get('main-session'), before);
});

test('invalid grounded response is a conversion error, not an account outage', async t => {
  const { pool, accounts, failures } = fixture(t);
  failures.set(0, new GatewayError('No grounded sources', { code: 'server_search_not_grounded', status: 502 }));
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }, { accountId: accounts[0].id }), { code: 'server_search_not_grounded' });
  const entry = pool.entries.get(accounts[0].id);
  assert.equal(entry.healthState, 'available');
  assert.equal(entry.cooldownUntil, 0);
  assert.equal(entry.modelCooldowns.size, 0);
});

test('search requires an actual helper catalog and respects disabled and unhealthy accounts', async t => {
  const { pool, accounts, calls } = fixture(t, [[], [HELPER]]);
  pool.entries.get(accounts[1].id).healthState = 'authentication_error';
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }), { code: 'server_search_model_unavailable' });
  assert.equal(calls.length, 0);
  pool.entries.get(accounts[1].id).healthState = 'available';
  pool.entries.get(accounts[1].id).account.enabled = false;
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }), { code: 'server_search_model_unavailable' });
  assert.equal(calls.length, 0);
});

test('cancelled search never spends shared scheduling weights, before or during catalog discovery', async t => {
  const { pool, calls, usage } = fixture(t);
  const before = new Map(pool.weights);
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }, { signal: AbortSignal.abort(new Error('cancel before start')) }), /cancel before start/);
  assert.deepEqual(pool.weights, before);
  const controller = new AbortController();
  const discover = pool.ensureModelCatalogs.bind(pool);
  pool.ensureModelCatalogs = async signal => { await discover(signal); controller.abort(new Error('cancel after catalog')); };
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }, { signal: controller.signal }), /cancel after catalog/);
  assert.deepEqual(pool.weights, before);
  assert.equal(calls.length, 0);
  assert.equal(usage.length, 0);
});

test('local search validation does not select an account or count an upstream attempt', async t => {
  const { pool, calls, usage } = fixture(t);
  const before = new Map(pool.weights);
  await assert.rejects(pool.searchWeb({ query: 'controlled query', maxOutputTokens: 0 }), { code: 'invalid_server_search_budget' });
  assert.deepEqual(pool.weights, before);
  assert.equal(calls.length, 0);
  assert.equal(usage.length, 0);
  await pool.ensureModelCatalogs();
  for (const entry of pool.entries.values()) entry.provider.searchWeb = async () => {
    throw new GatewayError('Controlled pre-transport failure', { code: 'controlled_preflight_failure', status: 400 });
  };
  await assert.rejects(pool.searchWeb({ query: 'controlled query' }), { code: 'controlled_preflight_failure' });
  assert.equal(usage.length, 0, 'a local provider failure without phase:start must not fabricate an upstream attempt');
});
