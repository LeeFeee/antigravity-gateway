'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');
const { OAuthFlow } = require('../src/oauth-flow');
const { DashboardAccountAuth, ROUTE } = require('../src/dashboard-account-auth');
const { dashboardHtml, dashboardAsset } = require('../src/dashboard');

class Element {
  constructor() { this.listeners = new Map(); this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { if (!this.disabled) return this.listeners.get('click')?.({ preventDefault() {} }); }
  removeAttribute(name) { delete this[name]; }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  select() {}
}

function setup(t, changeUrl = value => value) {
  const flow = new OAuthFlow({ clientCredentials: [{ clientId: 'ui-test.apps.googleusercontent.com', clientSecret: 'fake-secret' }],
    timeoutMs: 10000, fetchImpl: async () => { throw new Error('UI URL regression must not exchange credentials'); } });
  const auth = new DashboardAccountAuth({ flow, store: { save() { throw new Error('Must not save an account'); } }, pool: {} });
  t.after(() => auth.stop());
  const elements = new Map(), storage = new Map(), timers = new Map(), clipboard = [];
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let timerId = 0;
  vm.runInNewContext(dashboardAsset('account-auth.js').body.toString(), {
    document: { getElementById: element }, URL, AbortSignal, Uint8Array, crypto: crypto.webcrypto,
    navigator: { clipboard: { writeText: async value => { clipboard.push(value); } } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      assert.equal(options.credentials, 'same-origin');
      let result;
      if (url === ROUTE && options.method === 'GET') result = { csrfToken: auth.csrfToken };
      else {
        auth.checkCsrf(options.headers['x-dashboard-csrf']);
        if (url === ROUTE && options.method === 'POST') result = await auth.start(JSON.parse(options.body).id);
        else if (options.method === 'DELETE') result = await auth.cancel(url.split('/').at(-1));
        else result = auth.snapshot(auth.get(url.split('/').at(-1)));
      }
      if (result.url) result = { ...result, url: changeUrl(result.url) };
      return { ok: true, json: async () => result };
    }
  });
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setImmediate(resolve));
      const first = timers.entries().next().value;
      if (first) { timers.delete(first[0]); await first[1](); }
      if (auth.job?.status === 'waiting' && element('antigravityAuthStatus').textContent !== '正在创建授权链接…') return;
    }
    throw new Error('Dashboard did not finish rendering the actual OAuth ready state');
  };
  return { auth, element, clipboard, settle };
}

test('dashboard renders and copies the URL produced by the current real OAuthFlow', async t => {
  const ui = setup(t);
  ui.element('addAntigravityAccount').click();
  await ui.settle();
  const expected = ui.auth.job.url;
  assert.equal(new URL(expected).pathname, '/o/oauth2/auth');
  assert.equal(ui.element('antigravityAuthLogin').hidden, false);
  assert.equal(ui.element('antigravityAuthForm').hidden, false);
  assert.equal(ui.element('antigravityAuthUrl').value, expected);
  assert.equal(ui.element('antigravityAuthOpen').href, expected);
  assert.equal(ui.element('antigravityAuthCopy').disabled, false);
  await ui.element('antigravityAuthCopy').click();
  assert.deepEqual(ui.clipboard, [expected]);
  await ui.element('antigravityAuthClose').click();
  assert.equal(ui.auth.job.status, 'cancelled');
  assert.equal(ui.element('antigravityAuthUrl').value, '');
  assert.equal(ui.element('antigravityAuthOpen').href, undefined);
});

test('invalid OAuth navigation targets never expose an empty copy field or stale clickable link', async t => {
  const ui = setup(t, value => value.replace('accounts.google.com', 'untrusted.example'));
  ui.element('addAntigravityAccount').click();
  await ui.settle();
  assert.match(ui.element('antigravityAuthStatus').textContent, /授权链接无效/);
  assert.equal(ui.element('antigravityAuthLogin').hidden, true);
  assert.equal(ui.element('antigravityAuthForm').hidden, true);
  assert.equal(ui.element('antigravityAuthUrl').value, '');
  assert.equal(ui.element('antigravityAuthOpen').href, undefined);
  assert.equal(ui.element('antigravityAuthCopy').disabled, true);
  await ui.element('antigravityAuthCopy').click();
  assert.deepEqual(ui.clipboard, []);
  await ui.element('antigravityAuthClose').click();
  assert.equal(ui.auth.job.status, 'cancelled');
});

test('dashboard references a content-versioned authorization script after an in-place upgrade', () => {
  const scriptUrl = dashboardHtml().match(/<script src="([^" ]*account-auth\.js[^" ]*)"/)[1];
  const url = new URL(scriptUrl, 'http://127.0.0.1:9897');
  assert.equal(url.pathname, '/dashboard/assets/account-auth.js');
  assert.equal(url.searchParams.get('v'), crypto.createHash('sha256').update(dashboardAsset('account-auth.js').body).digest('hex').slice(0, 16));
  assert.notEqual(scriptUrl, '/dashboard/assets/account-auth.js');
});
