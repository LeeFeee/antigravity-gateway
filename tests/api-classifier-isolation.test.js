'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
process.env.ANTIGRAVITY_FAST_MODEL = '';
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { AccountPool } = require('../src/account-pool');
const { createServer, resolveModel, refreshClientModelCatalogs } = require('../antigravity-gateway');

test('auxiliary default discovery uses only the API account pool and explicit models remain fixed', async t => {
  let cloudCatalogCalls = 0;
  const sentModels = [];
  t.mock.method(AccountPool.prototype, 'hasManagedAccounts', () => true);
  t.mock.method(AccountPool.prototype, 'listModels', async () => {
    cloudCatalogCalls++;
    return ['claude-sonnet-5', 'gemini-3.8-flash-low'];
  });
  t.mock.method(AccountPool.prototype, 'send', async (_input, model) => {
    sentModels.push(model);
    return { text: '<block>no</block>', toolCalls: [], usage: {} };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: 'Auto Mode evaluator. If the action should be blocked: <block>yes</block>. If the action should be allowed: <block>no</block>.',
        messages: [{ role: 'user', content: 'classify safe action' }] })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-antigravity-model'), 'gemini-3.8-flash-low');
    assert.equal((await response.json()).content[0].text, '<block>no</block>');
  }
  assert.deepEqual(sentModels, ['gemini-3.8-flash-low', 'gemini-3.8-flash-low']);
  assert.equal(cloudCatalogCalls, 1, 'same-provider discovery keeps the existing one-minute cache');
  assert.equal(await resolveModel('gemini-3.8-flash-high', { preferFast: true }), 'gemini-3.8-flash-high');
  assert.equal(await resolveModel('claude-sonnet-5', { preferFast: true }), 'gemini-3.8-flash-low');
  assert.equal(await resolveModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(cloudCatalogCalls, 1);
  assert.deepEqual((await refreshClientModelCatalogs()).sort(), ['claude-sonnet-5', 'gemini-3.8-flash-low']);
});

test('default Sonnet 5 classifier routes to Low without changing ordinary requests or verdicts', async t => {
  const calls = [];
  t.mock.method(AccountPool.prototype, 'send', async (input, model) => {
    calls.push({ input, model });
    return { text: input.autoMode ? (input.autoModeFormat === 'severity'
      ? '<severity>72</severity>' : '<block>yes</block><reason>Test verdict.</reason>') : 'ordinary reply', toolCalls: [], usage: {} };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const block = 'Auto Mode evaluator. If the action should be blocked: <block>yes</block>. If the action should be allowed: <block>no</block>.';
  const severity = 'Auto Mode classification process. Grade harm only. Respond with <severity>N</severity>.';
  for (const item of [
    { model: 'claude-sonnet-5', system: block, selected: 'gemini-3.8-flash-low', verdict: '<block>yes</block>' },
    { model: 'claude-sonnet-5', system: severity, selected: 'gemini-3.8-flash-low', verdict: '<severity>72</severity>' },
    { model: 'gemini-3.8-flash-high', system: block, selected: 'gemini-3.8-flash-high', verdict: '<block>yes</block>' },
    { model: 'claude-sonnet-4-6', system: severity, selected: 'claude-sonnet-4-6', verdict: '<severity>72</severity>' },
    { model: 'claude-sonnet-5', system: 'You are a coding assistant.', user: block, selected: 'claude-sonnet-5', verdict: 'ordinary reply' },
    { model: 'gemini-3.8-flash-high', system: 'You are a coding assistant.', selected: 'gemini-3.8-flash-high', verdict: 'ordinary reply' }
  ]) {
    const payload = { model: item.model, system: item.system, max_tokens: 64,
      messages: [{ role: 'user', content: item.user || 'Assess this test action.' }] };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-antigravity-model'), item.selected);
    assert.ok((await response.json()).content[0].text.startsWith(item.verdict));
    const call = calls.at(-1);
    assert.equal(call.model, item.selected);
    assert.equal(call.input.system, item.system);
    assert.equal(call.input.messages[0].text, payload.messages[0].content);
    assert.equal(call.input.generationConfig.maxOutputTokens, 64);
  }
});
