'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore, accountGrantGeneration } = require('../src/account-store');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');
const { AccountPool } = require('../src/account-pool');

const model = 'gemini-3.8-flash-high';
const initial = { id: 'a', subjectId: 'subject-a', email: 'a@example.invalid', accessToken: 'old-access',
  refreshToken: 'old-refresh', clientId: 'client', clientSecret: 'secret', projectId: 'project',
  expiresAt: '2000-01-01T00:00:00.000Z' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-account-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: root });
  const account = store.save(initial);
  return { root, store, account };
}
function pendingRefresh(store, account) {
  const response = deferred();
  const provider = new ManagedAccountAuthProvider({ account, store, fetchImpl: () => response.promise });
  const pending = provider.get();
  const finish = () => response.resolve(new Response(JSON.stringify({ access_token: 'refreshed-access',
    refresh_token: 'rotated-refresh', expires_in: 3600 }), { status: 200 }));
  return { provider, pending, finish };
}

test('late refresh cannot overwrite a new authorization, even before pool reload', async t => {
  const { store, account } = fixture(t);
  const refresh = pendingRefresh(store, account);
  const rejected = assert.rejects(refresh.pending, { code: 'account_credentials_changed' });
  const replacement = store.save({ ...account, accessToken: 'new-grant-access', refreshToken: 'new-grant-refresh',
    enabled: false, weight: 7 }, { newGrant: true });
  refresh.finish(); await rejected;
  assert.deepEqual(store.list()[0], replacement);
  assert.notEqual(replacement.grantGeneration, account.grantGeneration);
});

test('late refresh merges tokens only, preserving concurrent enabled and weight changes', async t => {
  const { store, account } = fixture(t);
  const refresh = pendingRefresh(store, account);
  store.update(account.id, { enabled: false, weight: 9, planName: 'changed-plan' });
  refresh.finish(); await refresh.pending;
  const latest = store.list()[0];
  assert.equal(latest.enabled, false); assert.equal(latest.weight, 9); assert.equal(latest.planName, 'changed-plan');
  assert.equal(latest.accessToken, 'refreshed-access'); assert.equal(latest.refreshToken, 'rotated-refresh');
  assert.equal(latest.grantGeneration, account.grantGeneration);
  assert.equal(latest.clientId, account.clientId); assert.equal(latest.clientSecret, account.clientSecret);
});

test('deletion and identical-token reauthorization both reject old refresh results', async t => {
  for (const replace of [false, true]) {
    const { store, account } = fixture(t);
    const refresh = pendingRefresh(store, account);
    const rejected = assert.rejects(refresh.pending, { code: 'account_credentials_changed' });
    if (replace) store.save(account, { newGrant: true }); else store.delete(account.id);
    refresh.finish(); await rejected;
    if (replace) {
      assert.equal(store.list()[0].refreshToken, 'old-refresh');
      assert.notEqual(store.list()[0].grantGeneration, account.grantGeneration);
    } else assert.deepEqual(store.list(), []);
  }
});

test('legacy records retain a stable generation through rotation, ordinary saves and restart', async t => {
  const { root, store } = fixture(t);
  const legacy = { ...initial }; delete legacy.grantGeneration;
  const file = path.join(store.directory, 'a-example.invalid.json');
  fs.writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 });
  const loaded = store.list()[0], generation = accountGrantGeneration(loaded);
  assert.match(generation, /^legacy:/);
  const refresh = pendingRefresh(store, loaded); refresh.finish(); await refresh.pending;
  assert.equal(store.list()[0].grantGeneration, generation);
  store.update('a', { weight: 4 });
  const restarted = new AccountStore({ configDir: root });
  assert.equal(restarted.list()[0].grantGeneration, generation);
  restarted.save(restarted.list()[0]);
  assert.equal(restarted.list()[0].grantGeneration, generation);
});

function waitingPool(t, { store, account }) {
  const started = deferred(), result = deferred();
  let disabled = 0;
  const pool = new AccountPool({ store, providerFactory: record => ({
    localAuth: { account: record, disable() { disabled++; } },
    listModels: async () => [model],
    send: async () => {
      if (record.id !== account.id) return { text: 'other-account', usage: {} };
      started.resolve(); return result.promise;
    }
  }) });
  t.after(() => pool.stop());
  return { pool, started, result, disabled: () => disabled };
}

test('adding another account during send preserves the current entry and quarantines its later 403', async t => {
  const f = fixture(t), p = waitingPool(t, f);
  const oldEntry = p.pool.entries.get('a');
  const pending = p.pool.send({}, model);
  await p.started.promise;
  f.store.save({ ...initial, id: 'b', subjectId: 'subject-b', email: 'b@example.invalid' });
  p.pool.reload();
  assert.equal(p.pool.entries.get('a'), oldEntry);
  await p.pool.listModels();
  p.result.reject(Object.assign(new Error('account verification required'), { status: 403 }));
  assert.equal((await pending).accountId, 'b');
  assert.equal(p.pool.health.get('a').state, 'verification_required');
  assert.equal(p.pool.status().find(a => a.id === 'a').state, 'verification_required');
  assert.ok(!p.pool.eligible(model).some(entry => entry.account.id === 'a'));
});

for (const kind of ['account', 'quota', 'transient', 'success']) {
  test(`old ${kind} completion cannot mutate a replacement authorization`, async t => {
    const f = fixture(t), p = waitingPool(t, f);
    const pending = p.pool.send({}, model, { sessionId: 'old-session' });
    const handled = pending.then(value => value, error => error);
    await p.started.promise;
    f.store.save({ ...f.account, accessToken: 'new-access', refreshToken: 'new-refresh' }, { newGrant: true });
    p.pool.reload();
    const current = p.pool.entries.get('a');
    assert.equal(p.disabled(), 1);
    p.pool.bindSession('old-session', 'a');
    const binding = p.pool.sessions.get('old-session');
    if (kind === 'success') p.result.resolve({ text: 'completed-old-request', usage: {} });
    else p.result.reject(Object.assign(new Error(kind === 'account' ? 'account verification required'
      : kind === 'quota' ? 'rate limit retry after 30s' : 'network timeout'),
    { status: kind === 'account' ? 403 : kind === 'quota' ? 429 : 503 }));
    await handled;
    assert.equal(current.healthState, 'available'); assert.equal(p.pool.health.size, 0);
    assert.equal(current.cooldownUntil, 0); assert.equal(current.modelCooldowns.size, 0);
    assert.equal(current.lastSuccessAt, ''); assert.equal(current.lastFailureAt, '');
    assert.equal(p.pool.sessions.get('old-session'), binding);
  });
}

test('normal token rotation and settings edits preserve same-grant in-flight state', async t => {
  const f = fixture(t), p = waitingPool(t, f);
  const original = p.pool.entries.get('a');
  const pending = p.pool.send({}, model).catch(error => error);
  await p.started.promise;
  f.store.updateCredentials(f.account, { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' });
  f.store.update('a', { weight: 8 });
  p.pool.reload();
  assert.equal(p.pool.entries.get('a'), original);
  assert.equal(p.disabled(), 0);
  p.result.reject(Object.assign(new Error('network timeout'), { status: 503 }));
  await pending;
  assert.ok(original.cooldownUntil > Date.now());
  assert.equal(original.account.weight, 8);
});

test('legacy token rotation followed by quarantine retains the same authoritative entry generation', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.store.directory, 'a-example.invalid.json'), JSON.stringify(initial));
  const pool = new AccountPool({ store: f.store, providerFactory: account => {
    const localAuth = new ManagedAccountAuthProvider({ account, store: f.store,
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 })) });
    return { localAuth, listModels: async () => [model], send: async () => {
      await localAuth.get();
      throw Object.assign(new Error('account verification required'), { status: 403 });
    } };
  } });
  t.after(() => pool.stop());
  const entry = pool.entries.get('a'), generation = entry.grantGeneration;
  await assert.rejects(pool.send({}, model), /verification required/);
  assert.equal(pool.isCurrentEntry(entry), true);
  assert.equal(entry.account.grantGeneration, generation);
  assert.equal(entry.account.refreshToken, 'rotated-refresh');
  pool.reload();
  assert.equal(pool.entries.get('a'), entry);
  assert.equal(entry.healthState, 'verification_required');
});

test('late model catalog from an old grant cannot replace the new provider catalog', async t => {
  const f = fixture(t), models = deferred();
  let count = 0;
  const pool = new AccountPool({ store: f.store, providerFactory: () => ({ listModels: () => ++count === 1 ? models.promise : [model] }) });
  t.after(() => pool.stop());
  const pending = pool.listModels();
  f.store.save({ ...f.account, refreshToken: 'replacement' }, { newGrant: true }); pool.reload();
  await pool.listModels();
  models.resolve(['retired-model']);
  await assert.rejects(pending, /没有返回模型目录/);
  assert.deepEqual([...pool.entries.get('a').supportedModels], [model]);
  assert.equal(pool.modelSupporters.has('retired-model'), false);
});
