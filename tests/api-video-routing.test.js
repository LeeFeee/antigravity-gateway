'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { AccountPool } = require('../src/account-pool');
const { DirectProviderError } = require('../src/direct-provider');
const { createServer } = require('../antigravity-gateway');
const video = Buffer.from('synthetic-video'), encoded = video.toString('base64');

async function server(t) {
  const instance = createServer(); await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('both inference protocols deliver original video bytes to the explicitly selected API model', async t => {
  const calls = [];
  t.mock.method(AccountPool.prototype, 'send', async (normalized, model) => {
    calls.push({ normalized, model }); return { text: 'video analysis', toolCalls: [], usage: {} };
  });
  const base = await server(t), model = 'gemini-3.8-flash-high';
  for (const [endpoint, payload] of [
    ['messages', { messages: [{ role: 'user', content: [
      { type: 'text', text: '分析视频。' }, { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: encoded } }
    ] }] }],
    ['responses', { input: [{ role: 'user', content: [
      { type: 'input_text', text: '分析视频。' }, { type: 'input_video', video_url: 'data:video/mp4;base64,' + encoded }
    ] }] }]
  ]) {
    const response = await fetch(base + '/v1/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, ...payload }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-antigravity-model'), model);
    const call = calls.at(-1), media = call.normalized.messages[0].parts.find(part => part.type === 'media');
    assert.equal(call.model, model); assert.equal(media.mediaType, 'video/mp4');
    assert.deepEqual(Buffer.from(media.data, 'base64'), video);
  }
  assert.equal(calls.length, 2);
});

test('an unavailable legacy video model returns its API failure instead of silently changing models', async t => {
  const calls = [];
  t.mock.method(AccountPool.prototype, 'send', async (_input, model) => {
    calls.push(model); throw new DirectProviderError('model unavailable', { code: 'model_not_supported', status: 400 });
  });
  const base = await server(t);
  const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-4-argon', input: [{ role: 'user', content: [{ type: 'input_video', video_url: 'data:video/mp4;base64,' + encoded }] }] }) });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.type, 'model_not_supported');
  assert.deepEqual(calls, ['gemini-4-argon']);
});
