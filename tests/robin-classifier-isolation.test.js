'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
process.env.ANTIGRAVITY_FAST_MODEL = '';
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { createServer, resolveModel, refreshClientModelCatalogs } = require('../antigravity-gateway');

test('Cloud Code Auto Mode discovery and its short cache are isolated from Robin; explicit union discovery remains available', async t => {
  let cloudCatalogCalls = 0, robinCatalogCalls = 0;
  const sentModels = [];
  t.mock.method(DirectAntigravityProvider.prototype, 'isConfigured', () => true);
  t.mock.method(DirectAntigravityProvider.prototype, 'listModels', async () => {
    cloudCatalogCalls++;
    return ['claude-sonnet-5', 'gemini-3.8-flash-low'];
  });
  t.mock.method(DirectAntigravityProvider.prototype, 'send', async (_input, model) => {
    sentModels.push(model);
    return { text: '<block>no</block>', toolCalls: [], usage: {} };
  });
  t.mock.method(RobinAccountPool.prototype, 'listModels', async () => {
    robinCatalogCalls++;
    throw new Error('unrelated Robin directory unavailable');
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5',
        system: 'Auto Mode evaluator. If the action should be blocked: <block>yes</block>. If the action should be allowed: <block>no</block>.',
        messages: [{ role: 'user', content: 'classify safe action' }] })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-antigravity-model'), 'gemini-3.8-flash-low');
    assert.equal((await response.json()).content[0].text, '<block>no</block>');
  }
  assert.deepEqual(sentModels, ['gemini-3.8-flash-low', 'gemini-3.8-flash-low']);
  assert.equal(robinCatalogCalls, 0, 'a Cloud Code auxiliary request cannot initiate unrelated Robin metadata');
  assert.equal(cloudCatalogCalls, 1, 'same-provider discovery keeps the existing one-minute cache');
  assert.equal(await resolveModel('gemini-4-argon', { preferFast: true }), 'gemini-4-argon');
  assert.equal(await resolveModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(cloudCatalogCalls, 1);
  assert.equal(robinCatalogCalls, 0);
  assert.deepEqual((await refreshClientModelCatalogs()).sort(), ['claude-sonnet-5', 'gemini-3.8-flash-low']);
  assert.equal(robinCatalogCalls, 1, 'an explicit directory refresh still queries both providers');
});
