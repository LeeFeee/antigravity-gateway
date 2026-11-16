'use strict';

// Local lifecycle checks supplement real dashboard/Google acceptance. No
// generated reply, OAuth token exchange, or client compatibility is simulated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DashboardGeminiAuth } = require('../src/dashboard-gemini-auth');
const { GeminiAccountStore } = require('../src/gemini-account-store');
const { GeminiAccountAuth } = require('../src/gemini-auth');

const identity = { subjectId: 'lifecycle-subject', email: 'lifecycle@example.invalid',
  accessToken: 'private-access-fixture', refreshToken: 'private-refresh-fixture',
  providerType: 'gemini', authMethod: 'gemini-oauth' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-dashboard-lifecycle-'));
  const store = new GeminiAccountStore({ configDir: root });
  const exchange = deferred(), entered = deferred(), work = deferred();
  const auth = new DashboardGeminiAuth({ store, flow: { timeoutMs: 30000, start: () => exchange.promise },
    pool: { reload() {} }, onAdded() {} });
  auth.initialize = async job => { entered.resolve(job); await work.promise; job.controller.signal.throwIfAborted(); };
  t.after(async () => { exchange.resolve(identity); work.resolve(); await auth.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { auth, store, exchange, entered, work };
}

test('wrong selected Google identity cannot replace a reauthorization target', async t => {
  const { auth, store, exchange } = setup(t);
  const before = store.save(identity, { newGrant: true });
  await auth.start(undefined, { accountId: before.id });
  exchange.resolve({ ...identity, subjectId: 'other-subject', email: 'other@example.invalid' });
  await auth.job.promise;
  assert.equal(auth.job.errorCode, 'gemini_oauth_wrong_account');
  assert.deepEqual(store.list(), [before]);
  assert.doesNotMatch(JSON.stringify(auth.snapshot(auth.job)), /private-access|private-refresh/);
});

test('account deleted or reauthorized during Google login rejects the late exchange', async t => {
  for (const mutation of ['delete', 'reauthorize']) {
    const { auth, store, exchange } = setup(t);
    const before = store.save(identity, { newGrant: true });
    await auth.start(undefined, { accountId: before.id });
    if (mutation === 'delete') store.delete(before.id);
    else store.save({ ...before, refreshToken: 'replacement-refresh' }, { newGrant: true });
    const expected = store.list();
    exchange.resolve(identity); await auth.job.promise;
    assert.equal(auth.job.errorCode, 'gemini_initialization_changed');
    assert.deepEqual(store.list(), expected);
  }
});

test('cancelled initialization remains disabled and can resume with the same grant', async t => {
  const { auth, store, exchange, entered, work } = setup(t);
  const before = store.save({ ...identity, enabled: false, weight: 3,
    providerMetadata: { initialization: { complete: true } } }, { newGrant: true });
  await auth.start(undefined, { accountId: before.id }); exchange.resolve(identity);
  const job = await entered.promise, pending = store.list()[0];
  assert.equal(pending.enabled, false);
  assert.equal(pending.weight, 3);
  assert.equal(pending.providerMetadata.initialization.desiredEnabled, false);
  assert.notEqual(pending.grantGeneration, before.grantGeneration);
  const cancelled = auth.cancel(job.id); work.resolve(); await cancelled;
  const stopped = store.list()[0];
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.providerMetadata.initialization.running, false);
  assert.equal(stopped.providerMetadata.initialization.complete, false);
  let resumed;
  auth.initialize = async next => { resumed = store.list()[0]; next.controller.abort(new Error('stop local check')); next.controller.signal.throwIfAborted(); };
  await auth.start(undefined, { accountId: stopped.id, action: 'resume' }); await auth.job.promise;
  assert.equal(resumed.grantGeneration, stopped.grantGeneration);
  assert.equal(resumed.providerMetadata.initialization.desiredEnabled, false);
  assert.equal(store.list()[0].enabled, false);
});

test('late initialization updates and cancellation cannot overwrite a replacement grant', async t => {
  const { auth, store, exchange, entered, work } = setup(t);
  await auth.start(); exchange.resolve(identity); const job = await entered.promise;
  const replacement = store.save({ ...store.list()[0], refreshToken: 'replacement-refresh',
    providerMetadata: { initialization: { jobId: 'new-job', running: true, complete: false } } }, { newGrant: true });
  assert.throws(() => auth.update(job, { complete: true }, { enabled: true }), /账号已删除或授权已更新/);
  const cancelled = auth.cancel(job.id); work.resolve(); await cancelled;
  assert.deepEqual(store.list(), [replacement]);
});

test('only the active initialization may use disabled credentials; pending accounts never enter inference', t => {
  const { store } = setup(t);
  const account = store.save({ ...identity, enabled: false,
    providerMetadata: { initialization: { jobId: 'active-job', running: true, complete: false } } }, { newGrant: true });
  const normal = new GeminiAccountAuth({ account, store });
  const scoped = new GeminiAccountAuth({ account, store, initializationId: 'active-job' });
  const old = new GeminiAccountAuth({ account, store, initializationId: 'old-job' });
  assert.throws(() => normal.current(), error => ['gemini_initialization_required', 'gemini_account_unavailable'].includes(error.code));
  assert.equal(scoped.current().id, account.id);
  assert.throws(() => old.current(), { code: 'gemini_initialization_changed' });
  const enabled = store.save({ ...account, enabled: true }, { expectedGrant: account.grantGeneration });
  assert.equal(enabled.enabled, true);
  assert.throws(() => normal.current(), { code: 'gemini_initialization_required' });
  store.save({ ...enabled, providerMetadata: { initialization: { jobId: 'active-job', running: false, complete: false } } },
    { expectedGrant: account.grantGeneration });
  assert.throws(() => scoped.current(), { code: 'gemini_initialization_changed' });
});
