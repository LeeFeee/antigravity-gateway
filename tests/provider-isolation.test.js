'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { AccountPool } = require('../src/account-pool');
const { DirectProviderError } = require('../src/direct-provider');
const { createServer } = require('../antigravity-gateway');

async function withServer(t) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('API error diagnostics never query retired providers through either client protocol', async t => {
  let cloudCatalogCalls = 0;
  t.mock.method(AccountPool.prototype, 'hasManagedAccounts', () => true);
  t.mock.method(AccountPool.prototype, 'listModels', async () => {
    cloudCatalogCalls++;
    return ['claude-opus-5-5-high'];
  });
  t.mock.method(AccountPool.prototype, 'send', async () => {
    throw new DirectProviderError('upstream rejected this request', { code: 'direct_upstream_error', status: 502 });
  });
  const base = await withServer(t);
  for (const protocol of ['messages', 'responses']) {
    const response = await fetch(`${base}/v1/${protocol}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'new-cloud-model', max_tokens: 32,
        ...(protocol === 'responses' ? { input: '你好。' } : { messages: [{ role: 'user', content: '你好。' }] }) })
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error.message, /upstream rejected this request/);
    assert.match(body.error.message, /new-cloud-model.*未出现在/);
    assert.doesNotMatch(body.error.message, /Gemini authorization/);
  }
  assert.equal(cloudCatalogCalls, 1, 'same-provider diagnostics retain bounded catalog caching');
});

test('explicit model discovery remains restricted to the API account pool', async t => {
  t.mock.method(AccountPool.prototype, 'hasManagedAccounts', () => true);
  t.mock.method(AccountPool.prototype, 'listModels', async () => ['claude-opus-5-5-high']);
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map(item => item.id).sort(), ['claude-opus-5-5-high']);
});
