'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccountPool, SESSION_TTL_MS, durationMs, errorCategory, retryDelay } = require('../src/account-pool');
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

test('account store deletes credentials only by the stored account ID', (t) => {
  const store = tempStore(t);
  const first = store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  assert.equal(store.delete(first.id).email, first.email);
  assert.deepEqual(store.list().map((item) => item.email), ['two@example.com']);
  assert.equal(store.delete(first.id), null);
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
  auth.disable();
  await assert.rejects(auth.get(), /已从账号池删除/);
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

test('soft account affinity uses a fixed five-hour window across restarts', async (t) => {
  const store = tempStore(t);
  const first = store.save(account('one@example.com'));
  const second = store.save(account('two@example.com'));
  let now = Date.parse('2026-09-29T00:00:00Z');
  const calls = [];
  const createPool = () => new AccountPool({
    store,
    fallbackProvider: {},
    now: () => now,
    providerFactory: (record) => ({
      send: async () => {
        calls.push(record.id);
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });

  const original = createPool();
  const warmup = await original.send({}, 'gemini-3.8-flash-high', { routingKey: 'warmup' });
  const selected = await original.send({}, 'gemini-3.8-flash-high', { routingKey: 'persistent-session' });
  const otherId = [first.id, second.id].find((id) => id !== warmup.accountId);
  assert.equal(selected.accountId, otherId);
  const selectedAt = original.sessions.get('persistent-session').at;

  now += SESSION_TTL_MS / 2;
  const continued = await original.send({}, 'gemini-3.8-flash-high', { routingKey: 'persistent-session' });
  assert.equal(continued.accountId, otherId);
  assert.equal(original.sessions.get('persistent-session').at, selectedAt);
  original.stop();

  const restarted = createPool();
  const restored = await restarted.send({}, 'gemini-3.8-flash-high', { routingKey: 'persistent-session' });
  assert.equal(restored.accountId, otherId);
  restarted.stop();

  now = selectedAt + SESSION_TTL_MS + 1;
  const expired = createPool();
  const reassigned = await expired.send({}, 'gemini-3.8-flash-high', { routingKey: 'persistent-session' });
  assert.equal(reassigned.accountId, warmup.accountId);
  assert.ok(fs.existsSync(path.join(path.dirname(store.directory), 'state', 'account-pool.json')));
});

test('account affinity is shared by parent and child conversations without sharing upstream session IDs', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  const calls = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async (_normalized, _model, options) => {
        calls.push({ accountId: record.id, sessionId: options.sessionId });
        return { text: record.email, toolCalls: [], usage: {} };
      },
      generateImage: async () => ({ data: Buffer.from('image').toString('base64'), mimeType: 'image/jpeg', usage: {} }),
      listModels: async () => ['gemini-3.8-flash-high'],
      modelInfo: () => null
    })
  });
  const parent = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'parent-session', routingKey: 'family-affinity' });
  const child = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'child-session', routingKey: 'family-affinity' });
  const image = await pool.generateImage({ prompt: 'draw it' }, {
    sessionId: 'child-session', routingKey: 'family-affinity', accountId: parent.accountId
  });
  assert.equal(parent.accountId, child.accountId);
  assert.equal(parent.accountId, image.accountId);
  assert.deepEqual(calls.map((call) => call.sessionId), ['parent-session', 'child-session']);
});

test('an auxiliary image fallback does not migrate the parent text conversation', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  let primaryAccount = '';
  const textAccounts = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        textAccounts.push(record.id);
        return { text: record.email, toolCalls: [], usage: {} };
      },
      generateImage: async () => {
        if (record.id === primaryAccount) {
          const error = new Error('image quota exhausted');
          error.status = 429;
          throw error;
        }
        return { data: Buffer.from('image').toString('base64'), mimeType: 'image/jpeg', usage: {} };
      },
      listModels: async () => ['gemini-3.8-flash-high'],
      modelInfo: () => null
    })
  });
  const first = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'parent', routingKey: 'family' });
  primaryAccount = first.accountId;
  const image = await pool.generateImage({ prompt: 'draw it' }, {
    sessionId: 'parent', routingKey: 'family', accountId: primaryAccount, bindRouting: false
  });
  assert.notEqual(image.accountId, primaryAccount);
  await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'parent', routingKey: 'family' });
  assert.deepEqual(textAccounts, [primaryAccount, primaryAccount]);
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

test('Google verification challenges mark the account unhealthy, persist the warning, and fail over', async (t) => {
  const store = tempStore(t);
  const challenged = store.save(account('verify@example.com'));
  const healthy = store.save(account('healthy@example.com'));
  const attempts = [];
  const imageAttempts = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        attempts.push(record.id);
        if (record.id === challenged.id) {
          const error = new Error('403: Verify your account to continue');
          error.status = 403;
          throw error;
        }
        return { text: record.email, toolCalls: [], usage: {} };
      },
      generateImage: async () => {
        imageAttempts.push(record.id);
        return { data: Buffer.from('image').toString('base64'), mimeType: 'image/jpeg', usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });

  pool.sessions.set('verification-session', { accountId: challenged.id, at: Date.now() });
  const result = await pool.send({}, 'gemini-3.8-flash-high', { routingKey: 'verification-session' });
  assert.equal(result.accountId, healthy.id);
  assert.deepEqual(attempts, [challenged.id, healthy.id]);
  const status = pool.status().find((entry) => entry.id === challenged.id);
  assert.equal(status.state, 'verification_required');
  assert.equal(status.healthReason, 'google_account_verification');
  assert.match(status.healthMessage, /安全核验/);
  const image = await pool.generateImage({ prompt: 'draw it' }, {
    routingKey: 'image-after-verification', accountId: challenged.id
  });
  assert.equal(image.accountId, healthy.id);
  assert.deepEqual(imageAttempts, [healthy.id]);

  const stateFile = path.join(path.dirname(store.directory), 'state', 'account-pool.json');
  const persisted = fs.readFileSync(stateFile, 'utf8');
  assert.match(persisted, /verification_required/);
  assert.doesNotMatch(persisted, /access-verify@example\.com|refresh-verify@example\.com/);

  const afterRestartAttempts = [];
  const restarted = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        afterRestartAttempts.push(record.id);
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  await restarted.send({}, 'gemini-3.8-flash-high', { routingKey: 'new-session-after-restart' });
  assert.deepEqual(afterRestartAttempts, [healthy.id]);

  store.update(challenged.id, { accessToken: 'renewed-access-token' });
  restarted.reload();
  assert.equal(restarted.status().find((entry) => entry.id === challenged.id).state, 'available');
});

test('manual account recheck clears health only after a successful lightweight probe', async (t) => {
  const store = tempStore(t);
  const saved = store.save(account('verify@example.com'));
  let result = 'success';
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: () => ({
      probeAuthentication: async () => {
        if (result === 'network') {
          const error = new Error('network timeout');
          error.status = 502;
          throw error;
        }
        if (result === 'account') {
          const error = new Error('403: Verify your account to continue');
          error.status = 403;
          throw error;
        }
        return { ok: true };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  const entry = pool.entries.get(saved.id);
  const challenge = Object.assign(new Error('403: Verify your account to continue'), { status: 403 });
  pool.markAccountIssue(entry, challenge);

  result = 'network';
  await assert.rejects(pool.recheckAccount(saved.id), /network timeout/);
  assert.equal(pool.status()[0].state, 'verification_required');

  result = 'account';
  await assert.rejects(pool.recheckAccount(saved.id), /Verify your account/);
  assert.equal(pool.status()[0].state, 'verification_required');

  result = 'success';
  const recovered = await pool.recheckAccount(saved.id);
  assert.equal(recovered.recovered, true);
  assert.equal(pool.status()[0].state, 'available');
});

test('deleting an account removes credentials, quota, affinity, health, and blocks automatic local reimport', async (t) => {
  const store = tempStore(t);
  const saved = store.save({ ...account('removed@example.com'), subjectId: 'removed-subject', source: 'local-agy-import' });
  let quotaRemoved = '';
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: () => ({ listModels: async () => [], modelInfo: () => null })
  });
  pool.quotaManager = { remove: (id) => { quotaRemoved = id; } };
  pool.sessions.set('sticky', { accountId: saved.id, at: Date.now() });
  pool.markAccountIssue(pool.entries.get(saved.id), Object.assign(new Error('Verify your account'), { status: 403 }));

  const deleted = pool.removeAccount(saved.id);
  assert.equal(deleted.deleted, true);
  assert.equal(quotaRemoved, saved.id);
  assert.equal(store.list().length, 0);
  assert.equal(pool.entries.size, 0);
  assert.equal(pool.sessions.size, 0);
  assert.equal(pool.health.size, 0);
  assert.equal(pool.isRemovedIdentity({ subjectId: 'removed-subject', email: 'removed@example.com' }), true);
  assert.equal(pool.canUseFallback(), false);
  await assert.rejects(pool.send({}, 'gemini-3.8-flash-high'), /没有可用于模型/);

  const restarted = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: () => ({ listModels: async () => [], modelInfo: () => null })
  });
  assert.equal(restarted.isRemovedIdentity({ subjectId: 'removed-subject', email: 'removed@example.com' }), true);
  await assert.rejects(restarted.listModels(), /账号池没有可用/);
});

test('error classification separates account failures, quota, network failures, and bad requests', () => {
  assert.equal(errorCategory({ status: 403, message: 'Verifyyouraccount to continue' }), 'account');
  assert.equal(errorCategory({ status: 401, message: 'UNAUTHENTICATED' }), 'account');
  assert.equal(errorCategory({ status: 400, code: 'direct_refresh_failed', message: 'OAuth refresh failed' }), 'account');
  assert.equal(errorCategory({ status: 429, message: 'RESOURCE_EXHAUSTED' }), 'quota');
  assert.equal(errorCategory({ status: 503, message: 'temporarily unavailable' }), 'transient');
  assert.equal(errorCategory({ status: 502, message: 'OAuth refresh failed', cause: { code: 'ENOTFOUND' } }), 'transient');
  assert.equal(errorCategory({ status: 400, message: 'invalid JSON schema' }), 'request');
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

test('account selection always prioritizes the nearest Gemini five-hour reset', (t) => {
  const store = tempStore(t);
  const soon = store.save(account('soon@example.com'));
  const middle = store.save(account('middle@example.com'));
  const late = store.save(account('late@example.com'));
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: () => ({ listModels: async () => [], modelInfo: () => null })
  });
  const now = Date.now();
  const resets = {
    [soon.id]: now + 60 * 60_000,
    [middle.id]: now + 3 * 60 * 60_000,
    [late.id]: now + 4 * 60 * 60_000
  };
  pool.quotaManager = {
    get: (id) => ({
      available: true,
      groups: [{
        id: 'gemini', displayName: 'Gemini Models', buckets: [{ window: '5h', resetTime: new Date(resets[id]).toISOString() }]
      }, {
        id: '3p', displayName: 'Claude and GPT models', buckets: [{ window: '5h', resetTime: new Date(now + (id === middle.id ? 30 : 240) * 60_000).toISOString() }]
      }]
    })
  };

  assert.equal(pool.orderedCandidates('gemini-3.8-flash-high', '')[0].account.id, soon.id);
  pool.weights.clear();
  assert.equal(pool.orderedCandidates('claude-sonnet-4-6', '')[0].account.id, soon.id);

  pool.sessions.set('sticky-session', { accountId: late.id, at: Date.now() });
  pool.weights.clear();
  assert.equal(pool.orderedCandidates('gemini-3.8-flash-high', 'sticky-session')[0].account.id, late.id);
});

test('account failover chooses the remaining account whose five-hour quota resets first', async (t) => {
  const store = tempStore(t);
  const current = store.save(account('current@example.com'));
  const soon = store.save(account('soon@example.com'));
  const late = store.save(account('late@example.com'));
  const attempts = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        attempts.push(record.id);
        if (record.id === current.id) {
          const error = new Error('quota exhausted');
          error.status = 429;
          throw error;
        }
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  const now = Date.now();
  pool.quotaManager = {
    get: (id) => ({
      available: true,
      groups: [{
        id: 'gemini', displayName: 'Gemini Models', buckets: [{
          window: '5h',
          resetTime: new Date(now + (id === soon.id ? 60 : id === late.id ? 240 : 300) * 60_000).toISOString()
        }]
      }]
    }),
    refresh: async () => {}
  };
  pool.sessions.set('sticky-session', { accountId: current.id, at: Date.now() });

  const result = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'sticky-session' });
  assert.deepEqual(attempts, [current.id, soon.id]);
  assert.equal(result.accountId, soon.id);
});

test('quota cooldown parser understands compound Google reset durations', () => {
  assert.equal(durationMs('114h17m51.141587561s'), 114 * 3_600_000 + 17 * 60_000 + 51.141587561 * 1000);
  assert.equal(retryDelay('{"quotaResetDelay":"5h1m2s"}'), 5 * 3_600_000 + 60_000 + 2000);
  assert.equal(retryDelay('retryDelay: 708.717057ms'), 1000);
});
