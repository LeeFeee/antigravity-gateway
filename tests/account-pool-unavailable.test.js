'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');

const MODEL = 'gemini-3.8-flash-high';
const OTHER = 'claude-sonnet-4-6';

function fixture(t, count, providerFactory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-unavailable-test-'));
  const store = new AccountStore({ configDir: directory });
  const accounts = Array.from({ length: count }, (_, index) => store.save({
    email: `account-${index}@example.com`, accessToken: `access-${index}`,
    refreshToken: `refresh-${index}`, projectId: `project-${index}`
  }));
  let now = 1_800_000_000_000;
  const diagnostics = [];
  const pool = new AccountPool({ store, now: () => now,
    providerFactory: providerFactory || (() => ({ listModels: async () => [MODEL, OTHER] })),
    diagnosticReporter: (event, fields) => diagnostics.push({ event, ...fields })
  });
  t.after(() => { pool.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { pool, accounts, diagnostics, now: () => now, advance: milliseconds => { now += milliseconds; },
    lastUnavailable: () => diagnostics.filter(event => event.event === 'account_pool_unavailable').at(-1) };
}

test('actual upstream 429 cooldowns report the earliest retry without clearing or shortening deadlines', async t => {
  let fail = true;
  let calls = 0;
  const f = fixture(t, 2, account => ({
    listModels: async () => [MODEL, OTHER],
    send: async () => {
      calls++;
      if (fail) throw Object.assign(new Error('Resource has been exhausted (e.g. check quota).'), {
        status: 429, code: 'direct_upstream_error',
        details: JSON.stringify({ error: { details: [{
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: account.email === 'account-0@example.com' ? '2.1s' : '8s'
        }] } })
      });
      return { text: 'ok', toolCalls: [], usage: {} };
    }
  }));
  await assert.rejects(f.pool.send({}, MODEL), { status: 429, code: 'direct_upstream_error' });
  assert.equal(calls, 2);
  const deadlines = [...f.pool.entries.values()].map(entry => entry.modelCooldowns.get(MODEL)).sort();
  assert.deepEqual(deadlines, [f.now() + 2100, f.now() + 8000]);

  await assert.rejects(f.pool.send({}, MODEL), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'account_pool_unavailable');
    assert.equal(error.retryAfterSeconds, 3);
    assert.match(error.message, /上游限流暂时冷却，最早 3 秒后可重试/);
    assert.doesNotMatch(error.message, /额度耗尽|认证失败/);
    return true;
  });
  assert.equal(calls, 2, 'a cooling account must not receive another upstream request');
  assert.deepEqual([...f.pool.entries.values()].map(entry => entry.modelCooldowns.get(MODEL)).sort(), deadlines);
  assert.deepEqual(f.lastUnavailable().states, { model_cooldown: 2 });
  assert.equal(f.lastUnavailable().retryAfterSeconds, 3);
  assert.equal(f.pool.eligible(OTHER).length, 2, 'this model cooldown must not block another model');

  f.advance(2100);
  fail = false;
  assert.equal((await f.pool.send({}, MODEL)).text, 'ok');
  assert.equal(calls, 3, 'normal routing resumes at the original earliest deadline');
});

test('mixed exclusions distinguish unsupported models and cooldowns without promising a retry time', async t => {
  const f = fixture(t, 5);
  await f.pool.ensureModelCatalogs();
  const entries = f.accounts.map(account => f.pool.entries.get(account.id));
  entries[0].account.enabled = false;
  entries[1].healthState = 'authentication_error';
  f.pool.recordModelCatalog(entries[2], [OTHER]);
  entries[3].cooldownUntil = f.now() + 15_000;
  entries[4].modelCooldowns.set(MODEL, f.now() + 60_000);

  const error = f.pool.noAccountError(MODEL);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'account_pool_unavailable');
  assert.equal(error.retryAfterSeconds, undefined);
  assert.doesNotMatch(error.message, /最早|额度耗尽|账号因上游限流/);
  assert.deepEqual(f.lastUnavailable().states, {
    disabled: 1, authentication_error: 1, model_unsupported: 1, cooldown: 1, model_cooldown: 1
  });
  assert.equal(f.lastUnavailable().retryAfterSeconds, undefined);
  assert.equal(f.pool.eligible(MODEL).length, 0);
});

test('an account-wide cooldown cannot be hidden by an earlier model cooldown', async t => {
  const f = fixture(t, 2);
  await f.pool.ensureModelCatalogs();
  const entries = [...f.pool.entries.values()];
  entries[0].cooldownUntil = f.now() + 15_000;
  for (const entry of entries) entry.modelCooldowns.set(MODEL, f.now() + 1000);
  const error = f.pool.noAccountError(MODEL);
  assert.doesNotMatch(error.message, /最早/);
  assert.deepEqual(f.lastUnavailable().states, { cooldown: 1, model_cooldown: 1 });
  assert.equal(entries[0].cooldownUntil, f.now() + 15_000);
  assert.equal(f.pool.eligible(MODEL).length, 0);
});

test('catalog exclusion is reported without sending a model request', async t => {
  let calls = 0;
  const f = fixture(t, 2, () => ({
    listModels: async () => [OTHER],
    send: async () => { calls++; throw new Error('unexpected upstream request'); }
  }));
  await assert.rejects(f.pool.send({}, MODEL), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'account_pool_unavailable');
    assert.match(error.message, /模型目录不支持该模型/);
    assert.doesNotMatch(error.message, /最早|限流/);
    return true;
  });
  assert.equal(calls, 0);
  assert.deepEqual(f.lastUnavailable().states, { model_unsupported: 2 });
});

test('quota protection keeps its original error and is specific to the requested model', async t => {
  const f = fixture(t, 1);
  await f.pool.ensureModelCatalogs();
  f.pool.quotaManager = {
    isQuotaProtected: (_id, model) => model === MODEL,
    protection: () => ({ protected: true })
  };
  const error = f.pool.noAccountError(MODEL);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'account_quota_protected');
  assert.match(error.message, /5 小时额度低于 10% 或周额度低于 5%/);
  assert.deepEqual(f.lastUnavailable().states, { quota_protected: 1 });
  assert.equal(f.pool.eligible(MODEL).length, 0);
  assert.equal(f.pool.eligible(OTHER).length, 1);
  f.advance(10_000);
  assert.equal(f.pool.noAccountError(OTHER).code, 'account_pool_unavailable');
  assert.deepEqual(f.lastUnavailable().states, { available: 1 });
});

test('search-helper cooldown diagnostics use the separate helper catalog', async t => {
  const helper = 'gemini-3.5-flash-lite';
  const f = fixture(t, 1, () => ({
    listModels: async () => [MODEL],
    webSearchModelCatalog: () => [helper]
  }));
  await f.pool.ensureModelCatalogs();
  const entry = [...f.pool.entries.values()][0];
  entry.modelCooldowns.set(helper, f.now() + 1500);
  await assert.rejects(f.pool.searchWeb({ query: 'test' }), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'account_pool_unavailable');
    assert.match(error.message, /最早 2 秒后可重试/);
    return true;
  });
  assert.deepEqual(f.lastUnavailable().states, { model_cooldown: 1 });
  assert.equal(entry.modelCooldowns.get(helper), f.now() + 1500);
});
