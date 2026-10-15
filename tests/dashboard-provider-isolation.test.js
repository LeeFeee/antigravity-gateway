'use strict';
const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { RobinAccountAuthProvider } = require('../src/robin-auth');
const { RobinProvider } = require('../src/robin-provider');
const { createServer } = require('../antigravity-gateway');

async function fixture(t, { cloudcode = ['same-id'], robin = ['same-id'] } = {}) {
  const operations = [];
  for (const [Pool, provider, ids] of [[AccountPool, 'cloudcode', cloudcode], [RobinAccountPool, 'robin', robin]]) {
    t.mock.method(Pool.prototype, 'status', () => ids.map(id => ({ id })));
    for (const [method, action] of [['removeAccount', 'delete'], ['recheckAccount', 'recheck']]) {
      t.mock.method(Pool.prototype, method, id => {
        operations.push({ provider, action, id });
        return { id, providerType: provider, action };
      });
    }
  }
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (action, query = '', id = 'same-id') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard/accounts/${id}${action === 'recheck' ? '/recheck' : ''}${query}`, {
      method: action === 'recheck' ? 'POST' : 'DELETE'
    });
    return { status: response.status, body: await response.json() };
  };
  return { operations, request };
}

test('dashboard account mutations reject invalid, empty and repeated provider parameters before touching either pool', async t => {
  const { operations, request } = await fixture(t);
  for (const action of ['recheck', 'delete']) {
    for (const query of ['?provider=robni', '?provider=', '?provider=robin&provider=cloudcode', '?provider=cloudcode&provider=cloudcode']) {
      const response = await request(action, query);
      assert.equal(response.status, 400, `${action} ${query}`);
      assert.equal(response.body.error.type, 'invalid_account_provider');
    }
  }
  assert.deepEqual(operations, []);
});

test('an unqualified account ID present in both providers is rejected instead of guessing a destructive target', async t => {
  const { operations, request } = await fixture(t);
  for (const action of ['recheck', 'delete']) {
    const response = await request(action);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.type, 'ambiguous_account_provider');
  }
  assert.deepEqual(operations, []);
});

test('an explicit provider targets only its own account even when both stores contain the same ID', async t => {
  const { operations, request } = await fixture(t);
  for (const provider of ['robin', 'cloudcode']) for (const action of ['recheck', 'delete']) {
    const response = await request(action, `?provider=${provider}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.providerType, provider);
  }
  assert.deepEqual(operations, ['robin', 'cloudcode'].flatMap(provider => ['recheck', 'delete'].map(action => ({ provider, action, id: 'same-id' }))));
});

test('legacy dashboard callers without a provider retain unique-account routing for both providers', async t => {
  const { operations, request } = await fixture(t, { cloudcode: ['cloud-only'], robin: ['robin-only'] });
  for (const [provider, id] of [['cloudcode', 'cloud-only'], ['robin', 'robin-only']]) {
    for (const action of ['recheck', 'delete']) {
      const response = await request(action, '', id);
      assert.equal(response.status, 200);
      assert.equal(response.body.providerType, provider);
    }
  }
  assert.equal(operations.length, 4);
});

test('actual Robin pool status and manual recheck never expose stored OAuth or server credentials through dashboard HTTP', async t => {
  const secrets = ['synthetic-access-do-not-return', 'synthetic-refresh-do-not-return',
    'synthetic-oauth-secret-do-not-return', 'synthetic-server-token-do-not-return'];
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  const account = store.save({ id: 'credential-boundary', providerType: 'robin', accountType: 'gemini-app',
    email: 'boundary@example.com', accessToken: secrets[0], refreshToken: secrets[1], clientSecret: secrets[2],
    capabilities: ['gemini-4-argon'], providerMetadata: { robinServerToken: secrets[3] } });
  t.after(() => store.delete(account.id));
  t.mock.method(AccountPool.prototype, 'status', () => []);
  t.mock.method(RobinAccountAuthProvider.prototype, 'get', async () => ({ accessToken: secrets[0], serverToken: secrets[3] }));
  t.mock.method(RobinProvider.prototype, 'listModels', async () => ['gemini-4-argon']);
  t.mock.method(RobinAccountPool.prototype, 'refreshQuota', async () => undefined);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [method, route] of [['GET', '/dashboard/data'], ['POST', '/dashboard/accounts/credential-boundary/recheck?provider=robin']]) {
    const response = await fetch(base + route, { method });
    assert.equal(response.status, 200);
    const body = await response.json(), text = JSON.stringify(body);
    for (const secret of secrets) assert.equal(text.includes(secret), false);
    assert.doesNotMatch(text, /accessToken|refreshToken|clientSecret|robinServerToken|providerMetadata/);
    const visible = method === 'GET' ? body.accounts[0] : body;
    assert.equal(visible.id, account.id);
    assert.equal(visible.providerType, 'robin');
    assert.deepEqual(visible.models, ['gemini-4-argon']);
    assert.equal(visible.state, 'available');
  }
});
