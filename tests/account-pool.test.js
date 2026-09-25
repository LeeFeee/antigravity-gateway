'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccountPool, durationMs, retryDelay } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');

function tempStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-account-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new AccountStore({ configDir: directory });
}

function account(email) {
  return { email, accessToken: `access-${email}`, refreshToken: `refresh-${email}`, projectId: `project-${email}` };
}

test('account store persists ordinary JSON and replaces refreshed credentials', (t) => {
  const store = tempStore(t);
  const first = store.save(account('one@example.com'));
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].refreshToken, 'refresh-one@example.com');
  store.save({ ...first, accessToken: 'new-access', refreshToken: 'new-refresh' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].accessToken, 'new-access');
  assert.equal(store.list()[0].refreshToken, 'new-refresh');
});

test('managed account refresh writes the new tokens back to its JSON record', async (t) => {
  const store = tempStore(t);
  const saved = store.save({
    ...account('refresh@example.com'),
    expiresAt: '2020-01-01T00:00:00.000Z',
    clientId: 'client',
    clientSecret: 'secret'
  });
  const auth = new ManagedAccountAuthProvider({
    account: saved,
    store,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }), { status: 200 })
  });
  assert.deepEqual(auth.provider.clientCredentials, [{ clientId: 'client', clientSecret: 'secret' }]);
  const record = await auth.get();
  assert.equal(record.accessToken, 'access-new');
  assert.equal(store.list()[0].accessToken, 'access-new');
  assert.equal(store.list()[0].refreshToken, 'refresh-new');
  assert.equal(store.list()[0].clientId, 'client');
  assert.equal(store.list()[0].clientSecret, 'secret');
});

test('account pool rotates new sessions but keeps one session on one account', async (t) => {
  const store = tempStore(t);
  const first = store.save(account('one@example.com'));
  const second = store.save(account('two@example.com'));
  const calls = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async (_normalized, model) => {
        calls.push([record.id, model]);
        return { text: record.email, toolCalls: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
      },
      listModels: async () => ['gemini-3.8-flash-high'],
      modelInfo: () => null
    })
  });
  await pool.send({}, 'claude-sonnet-4-6', { sessionId: 'session-a' });
  await pool.send({}, 'claude-sonnet-4-6', { sessionId: 'session-a' });
  await pool.send({}, 'claude-sonnet-4-6', { sessionId: 'session-b' });
  assert.equal(calls[0][0], calls[1][0]);
  assert.notEqual(calls[0][0], calls[2][0]);
  assert.deepEqual(calls.map((item) => item[1]), ['claude-sonnet-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-6']);
  assert.deepEqual(new Set(calls.map((item) => item[0])), new Set([first.id, second.id]));
});

test('account pool reports the actual account selected for each upstream attempt', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  const selected = [];
  let attempts = 0;
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('quota exhausted');
          error.status = 429;
          throw error;
        }
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  const result = await pool.send({}, 'gemini-3.8-flash-high', {
    onAccountSelected: (value) => selected.push(value)
  });
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((value) => value.attempt), [1, 2]);
  assert.notEqual(selected[0].email, selected[1].email);
  assert.deepEqual(new Set(selected.map((value) => value.email)), new Set(['one@example.com', 'two@example.com']));
  assert.equal(result.text, selected[1].email);
});

test('account pool reports the official local agy session when no managed account exists', async (t) => {
  const store = tempStore(t);
  const selected = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {
      send: async () => ({ text: 'ok', toolCalls: [], usage: {} })
    }
  });
  await pool.send({}, 'gemini-3.8-flash-high', { onAccountSelected: (value) => selected.push(value) });
  assert.deepEqual(selected, [{ accountId: 'local-agy-session', email: '', source: 'local-agy-session', attempt: 1 }]);
});

test('account pool fails over quota errors without changing the requested model', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  const models = [];
  let failed = false;
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async (_normalized, model) => {
        models.push(model);
        if (!failed) {
          failed = true;
          const error = new Error('Resource has been exhausted (quota)');
          error.status = 429;
          throw error;
        }
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [model],
      modelInfo: () => null
    })
  });
  const result = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'session' });
  assert.match(result.text, /@example\.com$/);
  assert.deepEqual(models, ['gemini-3.8-flash-high', 'gemini-3.8-flash-high']);
});

test('account pool does not hide request/schema errors by switching accounts', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  let attempts = 0;
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: () => ({
      send: async () => {
        attempts += 1;
        const error = new Error('invalid JSON schema');
        error.status = 400;
        throw error;
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  await assert.rejects(pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'session' }), /invalid JSON schema/);
  assert.equal(attempts, 1);
});

test('quota snapshots prioritize healthy accounts but never hard-block the last fallback', async (t) => {
  const store = tempStore(t);
  const first = store.save(account('empty@example.com'));
  const second = store.save(account('healthy@example.com'));
  const attempts = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        attempts.push(record.id);
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  pool.quotaManager = {
    get: (id) => ({ available: id === first.id ? false : true })
  };

  const preferred = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'new-session' });
  assert.equal(preferred.text, second.email);
  assert.deepEqual(attempts, [second.id]);

  const fallbackPool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => ({ text: record.email, toolCalls: [], usage: {} }),
      listModels: async () => [], modelInfo: () => null
    })
  });
  fallbackPool.quotaManager = { get: () => ({ available: false }) };
  const fallback = await fallbackPool.send({}, 'gemini-3.8-flash-high', { sessionId: 'all-empty' });
  assert.match(fallback.text, /@example\.com$/);
});

test('quota cooldown parser understands compound Google reset durations', () => {
  assert.equal(durationMs('114h17m51.141587561s'), 114 * 3_600_000 + 17 * 60_000 + 51.141587561 * 1000);
  assert.equal(retryDelay('{"quotaResetDelay":"5h1m2s"}'), 5 * 3_600_000 + 60_000 + 2000);
  assert.equal(retryDelay('retryDelay: 708.717057ms'), 1000);
});
