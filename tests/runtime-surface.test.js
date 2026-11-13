'use strict';
const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const test = require('node:test');
const { DirectAntigravityProvider } = require('../src/direct-provider');

// Synthetic old credentials and all retired configuration switches must remain inert.
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'agy';
process.env.ANTIGRAVITY_ACCESS_TOKEN = 'unused-synthetic-access';
process.env.ANTIGRAVITY_REFRESH_TOKEN = 'unused-synthetic-refresh';
process.env.ANTIGRAVITY_AUTH_FILE = path.join(directory, 'ignored-local-auth.json');
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const files = new Map();
for (const folder of ['robin-accounts', 'gemini-win-accounts']) {
  fs.mkdirSync(path.join(directory, folder));
  for (const [name, content] of [['valid.json', '{"id":"old","accessToken":"legacy-private-fixture"}'], ['broken.json', '{']]) {
    const file = path.join(directory, folder, name); files.set(file, content); fs.writeFileSync(file, content);
  }
}
files.set(process.env.ANTIGRAVITY_AUTH_FILE, '{"access_token":"unused-local-file"}');
fs.writeFileSync(process.env.ANTIGRAVITY_AUTH_FILE, files.get(process.env.ANTIGRAVITY_AUTH_FILE));
const originalLoad = Module._load, originalRead = fs.readFileSync, originalReadDir = fs.readdirSync, originalSpawn = childProcess.spawn;
let gateway;
try {
  Module._load = function (name, ...args) {
    assert.doesNotMatch(name, /(?:^|\/)(?:provider-router|robin-account-pool|robin-oauth-flow|gemini-windows-login|gemini-account-store|local-account-importer)$/);
    return originalLoad.call(this, name, ...args);
  };
  fs.readFileSync = function (name, ...args) {
    assert.ok(!files.has(String(name)), `retired credentials read: ${name}`);
    return originalRead.call(this, name, ...args);
  };
  fs.readdirSync = function (name, ...args) {
    assert.ok(!['robin-accounts', 'gemini-win-accounts'].includes(path.basename(String(name))), 'retired directory scanned');
    return originalReadDir.call(this, name, ...args);
  };
  childProcess.spawn = () => { throw new Error('gateway initialization cannot launch agy or another provider'); };
  gateway = require('../antigravity-gateway');
} finally {
  Module._load = originalLoad; fs.readFileSync = originalRead; fs.readdirSync = originalReadDir; childProcess.spawn = originalSpawn;
}

async function server(t) {
  t.mock.method(DirectAntigravityProvider.prototype, 'send', async () => assert.fail('empty pool must never invoke an upstream'));
  t.mock.method(DirectAntigravityProvider.prototype, 'listModels', async () => assert.fail('empty pool must never discover from a local identity'));
  t.mock.method(DirectAntigravityProvider.prototype, 'generateImage', async () => assert.fail('empty pool must never generate from a local identity'));
  const instance = gateway.createServer();
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('empty account pool remains empty despite local credentials and retired transport settings', async t => {
  const base = await server(t);
  const health = await fetch(base).then(r => r.json());
  assert.equal(health.transport, 'direct');
  assert.equal(health.upstream_protocol, 'Google Antigravity API');
  assert.equal(health.agy.version, '1.5.8');
  assert.equal(health.capabilities.chat_completions, false);
  assert.equal(health.capabilities.local_agy_session_bridge, false);
  assert.deepEqual(health.account_pool.accounts, []);
  assert.equal(health.account_pool.managed_accounts, 0);
  assert.deepEqual((await fetch(base + '/v1/models').then(r => r.json())).data, []);
  for (const [route, body] of [
    ['messages', { messages: [{ role: 'user', content: 'test' }] }],
    ['responses', { input: 'test' }],
    ['images/generations', { prompt: 'test' }]
  ]) {
    const response = await fetch(base + '/v1/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 429, route);
    assert.equal((await response.json()).error.type, 'account_pool_unavailable');
  }
  for (const [file, content] of files) assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'accounts')), []);
});

test('retired inference endpoint is rejected before body normalization or upstream calls', async t => {
  const base = await server(t);
  for (const body of ['{not valid json', JSON.stringify({ model: 'legacy', messages: [] })]) {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 410);
    const error = (await response.json()).error;
    assert.equal(error.type, 'unsupported_api'); assert.match(error.message, /Messages.*Responses/);
  }
});

test('runtime tree and npm scripts contain no executable retired channel implementation', () => {
  const root = path.join(__dirname, '..'), source = path.join(root, 'src');
  const retired = /^(?:robin-|gemini-windows-|gemini-account-store\.js$|provider-router\.js$|local-account-importer\.js$|agy-worker\.js$)/;
  assert.deepEqual(fs.readdirSync(source).filter(name => retired.test(name)), []);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(manifest.scripts), /(?:robin-|gemini-windows-|provider-router|local-account-importer|agy-worker)/);
  // OAuth client discovery may inspect installation metadata, but cannot run an agent.
  const installation = fs.readFileSync(path.join(source, 'agy-installation.js'), 'utf8');
  assert.doesNotMatch(installation, /child_process|\b(?:spawn|execFile|exec)\s*\(/);
  for (const name of ['local-agy-auth.js', 'managed-account-auth.js', 'oauth-flow.js', 'agy-file-lease.js']) {
    assert.ok(fs.statSync(path.join(source, name)).isFile(), `required shared capability retained: ${name}`);
  }
});
