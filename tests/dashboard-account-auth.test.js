'use strict';
const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OAuthFlow } = require('../src/oauth-flow');
const { DashboardAccountAuth, ROUTE } = require('../src/dashboard-account-auth');
const { AccountStore } = require('../src/account-store');
const { QuotaManager } = require('../src/quota-manager');
const { dashboardHtml, dashboardAsset } = require('../src/dashboard');
const { createServer } = require('../antigravity-gateway');
const credentials = [{ clientId: 'test.apps.googleusercontent.com', clientSecret: 'client-secret-never-expose' }];
const account = { id: 'dashboard-added', email: 'dashboard@example.com', accessToken: 'access-never-expose',
  refreshToken: 'refresh-never-expose', projectId: 'test-project', providerType: 'cloudcode', enabled: true };
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, overrides = {}) {
  const calls = { saved: [], reloads: 0, refreshes: [], added: 0, browser: 0 };
  const flow = new OAuthFlow({ clientCredentials: credentials, openBrowserImpl: async () => { calls.browser++; return true; },
    timeoutMs: 2000, ...overrides });
  flow._exchange = async () => ({ ...account });
  const auth = new DashboardAccountAuth({ flow, store: { save: a => { calls.saved.push(a); return a; } },
    pool: { reload: () => { calls.reloads++; } }, quotaManager: { refreshAccount: async (id, opts) => { calls.refreshes.push({ id, opts }); } },
    onAdded: () => { calls.added++; } });
  t.after(() => auth.stop());
  return { auth, flow, calls };
}
async function waitReady(auth) {
  for (let i = 0; i < 100 && auth.job.status === 'starting'; i++) await tick();
  assert.equal(auth.job.status, 'waiting');
  return auth.snapshot(auth.job);
}
function callback(job, code = 'test-code') {
  const login = new URL(job.url), url = new URL(login.searchParams.get('redirect_uri'));
  url.searchParams.set('state', login.searchParams.get('state'));
  url.searchParams.set('code', code);
  return url.href;
}

test('dashboard OAuth reuses the real flow, saves one Cloud Code account and never launches a server browser', async t => {
  const { auth, calls } = setup(t);
  const started = await auth.start();
  assert.match(started.id, /^[a-f0-9]{48}$/);
  const ready = await waitReady(auth);
  assert.equal(new URL(ready.url).hostname, 'accounts.google.com');
  const status = auth.submit(ready.id, callback(ready));
  assert.equal(status.status, 'processing');
  await auth.job.promise; await tick();
  const result = auth.snapshot(auth.get(ready.id));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.account, { id: account.id, email: account.email, providerType: 'cloudcode' });
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.reloads, 1); assert.equal(calls.added, 1); assert.equal(calls.browser, 0);
  assert.deepEqual(calls.refreshes, [{ id: account.id, opts: { force: true, summaryOnly: false } }]);
  assert.doesNotMatch(JSON.stringify(result), /access-never|refresh-never|client-secret|test-code|accessToken|refreshToken|clientSecret/);
});

test('dashboard accepts only its complete state-bound callback URL and permits retry after invalid input', async t => {
  const { auth } = setup(t);
  await auth.start(); const ready = await waitReady(auth), valid = callback(ready);
  const changedState = new URL(valid); changedState.searchParams.set('state', 'wrong');
  const missingState = new URL(valid); missingState.searchParams.delete('state');
  const twice = new URL(valid); twice.searchParams.append('code', 'second');
  const wrongPort = new URL(valid); wrongPort.port = '1';
  for (const value of ['only-code', valid.replace('localhost', 'attacker.example'), changedState.href, missingState.href,
    twice.href, wrongPort.href, valid.replace('http:', 'https:'), valid.replace('/oauth-callback', '/elsewhere'), {}]) {
    assert.throws(() => auth.submit(ready.id, value), e => e.status === 400);
    assert.equal(auth.get(ready.id).status, 'waiting');
  }
  auth.submit(ready.id, valid); await auth.job.promise;
  assert.equal(auth.get(ready.id).status, 'completed');
});

test('local automatic callback rejects missing state, wrong method, malformed URL and then completes', async t => {
  const { auth } = setup(t);
  await auth.start(); const ready = await waitReady(auth);
  const good = new URL(callback(ready)); good.hostname = '127.0.0.1';
  const missing = new URL(good); missing.searchParams.delete('state');
  assert.equal((await fetch(missing)).status, 400);
  assert.equal((await fetch(good, { method: 'POST' })).status, 405);
  assert.equal(auth.job.status, 'waiting');
  assert.equal((await fetch(good)).status, 200);
  await auth.job.promise;
  assert.equal(auth.job.status, 'completed');
});

test('double start is idempotent for the same browser but blocks competing authorization and preserves CLI', async t => {
  const { auth, flow, calls } = setup(t);
  const id = 'a'.repeat(48), first = await auth.start(id);
  assert.equal((await auth.start(id)).id, first.id);
  await assert.rejects(auth.start(), e => e.status === 409);
  await waitReady(auth);
  await assert.rejects(flow.start(), /已有账号授权/);
  await auth.cancel(id);
  assert.equal(flow.active, null); assert.equal(flow.starting, false); assert.equal(calls.saved.length, 0);
  const terminal = flow.start({ onReady: ({ url }) => {
    assert.equal(flow.submit(callback({ url })), true);
  } });
  await assert.rejects(auth.start(), e => e.status === 409);
  assert.equal((await terminal).email, account.email);
  assert.equal(calls.browser, 1);
});

test('cancel during exchange discards late credentials and shutdown prevents new flows', async t => {
  const { auth, flow, calls } = setup(t);
  let finish;
  flow._exchange = () => new Promise(resolve => { finish = resolve; });
  await auth.start(); const ready = await waitReady(auth);
  auth.submit(ready.id, callback(ready));
  await tick();
  const cancellation = auth.cancel(ready.id);
  finish({ ...account });
  assert.equal((await cancellation).status, 'cancelled');
  assert.equal(calls.saved.length, 0);
  await auth.stop();
  await assert.rejects(auth.start(), e => e.status === 503);
});

test('timeout and upstream failure are retryable and do not leak credential-shaped errors', async t => {
  const { auth, flow, calls } = setup(t, { timeoutMs: 25 });
  await auth.start(); await waitReady(auth);
  await new Promise(resolve => setTimeout(resolve, 50));
  await auth.job.promise;
  assert.equal(auth.job.status, 'failed'); assert.match(auth.job.message, /超时/);
  assert.equal(flow.active, null);
  flow.timeoutMs = 2000;
  flow._exchange = async () => { throw new Error('access-never-expose refresh-never-expose client-secret-never-expose'); };
  await auth.start(); const ready = await waitReady(auth);
  auth.submit(ready.id, callback(ready)); await auth.job.promise;
  assert.equal(auth.job.status, 'failed'); assert.equal(calls.saved.length, 0);
  assert.doesNotMatch(JSON.stringify(auth.snapshot(auth.job)), /never-expose/);
});

test('setup failure, cancellation during listener setup and readiness failure release OAuth reservation', async t => {
  const { auth, flow } = setup(t);
  const original = flow._callbackServer.bind(flow);
  flow._callbackServer = async () => { throw new Error('listener failed'); };
  await auth.start(); await auth.job.promise;
  assert.equal(flow.starting, false); assert.equal(flow.active, null);
  let release;
  flow._callbackServer = (...args) => new Promise(resolve => { release = async () => resolve(await original(...args)); });
  const job = await auth.start(); await tick();
  const cancelled = auth.cancel(job.id);
  await release(); await cancelled;
  assert.equal(flow.active, null); assert.equal(flow.starting, false);
  flow._callbackServer = original;
  await assert.rejects(flow.start({ openBrowser: false, onReady: () => { throw new Error('readiness failed'); } }), /readiness failed/);
  assert.equal(flow.active, null); assert.equal(flow.starting, false);
  const controller = new AbortController();
  await assert.rejects(flow.start({ openBrowser: false, signal: controller.signal,
    onReady: () => controller.abort(new Error('cancel on ready')) }), /cancel on ready/);
  assert.equal(flow.active, null); assert.equal(flow.starting, false);
});

test('dashboard HTTP protects authorization with source policy and CSRF and returns no credentials', async t => {
  const saved = [];
  const start = OAuthFlow.prototype.start;
  t.mock.method(OAuthFlow.prototype, 'start', function(options) {
    this.clientCredentials = credentials;
    return start.call(this, options);
  });
  t.mock.method(OAuthFlow.prototype, '_exchange', async () => ({ ...account }));
  const save = AccountStore.prototype.save;
  t.mock.method(AccountStore.prototype, 'save', function(a) { saved.push(this.directory); return save.call(this, a); });
  t.mock.method(QuotaManager.prototype, 'refreshAccount', async () => null);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => { const dir = path.join(directory, 'accounts'); if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const bootstrap = await fetch(base + ROUTE);
  assert.equal(bootstrap.status, 200); assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  const { csrfToken } = await bootstrap.json();
  assert.equal((await fetch(base + ROUTE, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(base + ROUTE, { method: 'POST', headers: { origin: 'https://attacker.example', 'x-dashboard-csrf': csrfToken } })).status, 403);
  const headers = { 'x-dashboard-csrf': csrfToken, 'content-type': 'application/json', origin: base };
  assert.equal((await fetch(base + ROUTE, { method: 'POST', headers, body: '[' })).status, 400);
  const created = await fetch(base + ROUTE, { method: 'POST', headers, body: '{}' });
  assert.equal(created.status, 202);
  let job = await created.json();
  assert.equal((await fetch(base + ROUTE + '/' + job.id)).status, 403);
  assert.equal((await fetch(base + ROUTE + '/' + job.id, { method: 'DELETE' })).status, 403);
  for (let i = 0; i < 30 && job.status === 'starting'; i++) { await tick(); job = await (await fetch(base + ROUTE + '/' + job.id, { headers })).json(); }
  assert.equal(job.status, 'waiting');
  const submitted = await fetch(base + ROUTE + '/' + job.id + '/callback', { method: 'POST', headers,
    body: JSON.stringify({ callbackUrl: callback(job) }) });
  assert.equal(submitted.status, 202);
  for (let i = 0; i < 30 && job.status !== 'completed'; i++) { await tick(); job = await (await fetch(base + ROUTE + '/' + job.id, { headers })).json(); }
  assert.equal(job.status, 'completed');
  assert.doesNotMatch(JSON.stringify(job), /never-expose|accessToken|refreshToken|clientSecret/);
  assert.deepEqual(saved, [path.join(directory, 'accounts')]);
  const data = await (await fetch(base + '/dashboard/data')).json();
  assert.ok(data.accounts.some(a => a.id === account.id && a.providerType === 'cloudcode'));
  const another = await (await fetch(base + ROUTE, { method: 'POST', headers, body: '{}' })).json();
  const cancelled = await fetch(base + ROUTE + '/' + another.id, { method: 'DELETE', headers });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
  assert.equal(saved.length, 1);
  const asset = await fetch(base + '/dashboard/assets/account-auth.js');
  assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
});

test('dashboard adds only the Antigravity entry and keeps the existing account controls and stat script intact', () => {
  const html = dashboardHtml(), js = dashboardAsset('account-auth.js').body.toString();
  assert.equal((html.match(/id="addAntigravityAccount"/g) || []).length, 1);
  assert.match(html, /id="quotaViewToggle"/);
  assert.match(html, /<dialog[^>]+id="antigravityAuthDialog"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /id="antigravityAuthError" role="alert"/);
  assert.match(js, /sessionStorage/); assert.match(js, /crypto.getRandomValues/);
  assert.doesNotMatch(js, /innerHTML|robin|add-gemini|gemini-win/);
  assert.match(js, /dialog\.addEventListener\('cancel'/);
});
