'use strict';
const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { AccountPool } = require('../src/account-pool');
const { createServer } = require('../antigravity-gateway');

async function fixture(t) {
  const operations = [];
  for (const [method, action] of [['removeAccount', 'delete'], ['recheckAccount', 'recheck']]) {
    t.mock.method(AccountPool.prototype, method, id => {
      operations.push({ action, id }); return { id, action };
    });
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
  return { operations, request, base: `http://127.0.0.1:${server.address().port}` };
}

test('dashboard mutations reject removed or ambiguous provider selectors without touching the active pool', async t => {
  const { operations, request } = await fixture(t);
  for (const action of ['recheck', 'delete']) {
    for (const query of ['?provider=robin', '?provider=robni', '?provider=', '?provider=robin&provider=cloudcode', '?provider=cloudcode&provider=cloudcode']) {
      const response = await request(action, query);
      assert.equal(response.status, 400, `${action} ${query}`);
      assert.equal(response.body.error.type, 'invalid_account_provider');
    }
  }
  assert.deepEqual(operations, []);
});

test('both current and legacy qualified links target the single active pool', async t => {
  const { operations, request } = await fixture(t);
  for (const query of ['', '?provider=cloudcode']) for (const action of ['recheck', 'delete']) {
    const response = await request(action, query);
    assert.equal(response.status, 200); assert.equal(response.body.id, 'same-id');
  }
  assert.deepEqual(operations, ['', '?provider=cloudcode'].flatMap(() => ['recheck', 'delete'].map(action => ({ action, id: 'same-id' }))));
});

test('dashboard leaves retired credentials untouched and never includes them in current accounts', async t => {
  const filenames = [];
  for (const folder of ['robin-accounts', 'gemini-win-accounts']) {
    const target = path.join(directory, folder); fs.mkdirSync(target, { recursive: true });
    for (const [name, text] of [['valid.json', '{"id":"old","accessToken":"private-fixture"}'], ['broken.json', '{']]) {
      const filename = path.join(target, name); fs.writeFileSync(filename, text); filenames.push([filename, text]);
    }
  }
  const { base } = await fixture(t);
  const nativeRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    assert.ok(!filenames.some(([filename]) => filename === String(file)), 'retired credentials must not be read');
    return nativeRead(file, ...args);
  });
  const response = await fetch(base + '/dashboard/data');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.accounts, []);
  assert.doesNotMatch(JSON.stringify(body), /private-fixture|accessToken|refreshToken|clientSecret/);
  for (const [filename, text] of filenames) assert.equal(nativeRead(filename, 'utf8'), text);
});
