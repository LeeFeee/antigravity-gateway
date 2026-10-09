'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { ProxyManager } = require('../src/proxy-manager');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');

function setup(t, options = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proxy-test-'));
  const manager = new ProxyManager({ configDir, ...options });
  t.after(async () => { await manager.close(); fs.rmSync(configDir, { recursive: true, force: true }); });
  return { manager, configDir };
}

test('proxy credentials stay on disk; bindings persist separately from refreshed accounts', async t => {
  const calls = [];
  const { manager, configDir } = setup(t, { agentFactory: url => ({ url, close() {} }) });
  const store = new AccountStore({ configDir });
  const account = store.save({ email: 'test@example.com', accessToken: 'old', refreshToken: 'refresh', clientId: 'client', clientSecret: 'secret', expiresAt: '2020-01-01' });
  manager.upsert({ id: 'us', url: 'http://user:password@127.0.0.1:9001', name: 'USA' });
  manager.bind(account.id, 'us');
  const pool = new AccountPool({ store, proxyManager: manager, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }));
  } });
  const provider = pool.entries.get(account.id).provider;
  await provider.localAuth.get(undefined, { forceRefresh: true });
  const response = await provider.fetchImpl('https://example.com/chat', { method: 'POST', body: 'hello' });
  await response.text();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.dispatcher, calls[1].init.dispatcher);
  assert.equal(calls[1].init.body, 'hello');
  assert.equal(store.list()[0].accessToken, 'fresh');
  assert.equal(new ProxyManager({ configDir }).snapshot().bindings[account.id], 'us');
  const snapshot = JSON.stringify(manager.snapshot());
  assert(!snapshot.includes('password')); assert(!snapshot.includes('user:'));
  assert.equal(fs.statSync(manager.file).mode & 0o777, 0o600);
  assert.throws(() => manager.remove('us'), /仍被账号绑定/);
});

test('bindings update live, missing proxies and failures never use the default fetch', async t => {
  const dispatched = [];
  const { manager } = setup(t, { agentFactory: url => ({ url, close() {} }), fetchImpl: async (_url, init) => {
    dispatched.push(init?.dispatcher?.url || 'default');
    if (init?.dispatcher?.url.includes('9002')) throw new Error('unreachable');
    return new Response('OK');
  } });
  manager.upsert({ id: 'a', url: 'http://127.0.0.1:9001' });
  manager.upsert({ id: 'b', url: 'http://127.0.0.1:9002' });
  const fetch = manager.accountFetch('account');
  await (await fetch('https://example.com')).text();
  manager.bind('account', 'a');
  await (await fetch('https://example.com', { dispatcher: 'must-be-overridden' })).text();
  manager.bind('account', 'b');
  await assert.rejects(fetch('https://example.com'), /unreachable/);
  manager.state.proxies = [];
  await assert.rejects(fetch('https://example.com'), /未回落/);
  assert.deepEqual(dispatched, ['default', 'http://127.0.0.1:9001/', 'http://127.0.0.1:9002/']);
  assert.throws(() => manager.upsert({ url: 'socks5://localhost:1080' }), /HTTP/);
  assert.throws(() => manager.upsert({ url: 'http://localhost/secret?token=hidden' }), /路径/);
});

test('active streaming responses block rebinding until body cancellation', async t => {
  const { manager } = setup(t, { agentFactory: () => ({ close() {} }), fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: hello\n\n')); } })) });
  manager.upsert({ id: 'a', url: 'http://localhost:9001' }); manager.bind('account', 'a');
  const response = await manager.accountFetch('account')('https://example.com');
  assert.equal(manager.snapshot().proxies[0].activeRequests, 1);
  assert.throws(() => manager.bind('account', null), /在途/);
  assert.throws(() => manager.upsert({ id: 'a', url: 'http://localhost:9002' }), /在途/);
  await response.body.cancel();
  assert.equal(manager.snapshot().proxies[0].activeRequests, 0);
  manager.bind('account', null);
});

test('corrupt proxy configuration refuses startup and probe errors are redacted', async t => {
  const { manager, configDir } = setup(t, { agentFactory: () => ({ close() {} }), fetchImpl: async () => { throw new Error('secret-password'); } });
  manager.upsert({ id: 'a', url: 'http://user:secret-password@localhost:9001' });
  const health = await manager.check('a'); assert.equal(health.ok, false);
  assert(!JSON.stringify(health).includes('secret-password'));
  fs.writeFileSync(manager.file, 'broken');
  assert.throws(() => new ProxyManager({ configDir }), /拒绝启动/);
});

test('real CONNECT transport reaches only the bound proxy and fails closed', async t => {
  const sockets = new Set();
  const connections = [];
  const servers = [];
  for (const name of ['one', 'two']) {
    const server = http.createServer();
    server.on('connect', (req, socket, head) => {
      connections.push(name); sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let raw = head.toString();
      socket.on('data', chunk => { raw += chunk; if (raw.includes('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\n'+(name === 'one' ? 'ONE' : 'TWO')); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  }
  t.after(async () => { for (const s of sockets) s.destroy(); await Promise.all(servers.map(s => new Promise(r => s.close(r)))); });
  const { manager } = setup(t);
  for (const [i, server] of servers.entries()) manager.upsert({ id: 'proxy'+i, url: 'http://127.0.0.1:'+server.address().port });
  manager.bind('account1', 'proxy0');manager.bind('account2', 'proxy1');
  assert.equal(await (await manager.accountFetch('account1')('http://unresolvable.invalid/')).text(), 'ONE');
  assert.equal(await (await manager.accountFetch('account2')('http://unresolvable.invalid/')).text(), 'TWO');
  assert.deepEqual(connections, ['one', 'two']);
  const reserved = net.createServer(); await new Promise(r => reserved.listen(0,'127.0.0.1',r)); const port=reserved.address().port; await new Promise(r=>reserved.close(r));
  manager.upsert({ id:'dead', url:'http://127.0.0.1:'+port });manager.bind('account1','dead');
  await assert.rejects(manager.accountFetch('account1')('http://unresolvable.invalid/', { signal: AbortSignal.timeout(1000) }));
  assert.deepEqual(connections, ['one','two']);
});
