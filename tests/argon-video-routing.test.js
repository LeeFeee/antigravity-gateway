'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
const { AccountPool } = require('../src/account-pool');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { ARGON_MODEL } = require('../src/robin-provider');
const { normalizeChat } = require('../src/protocol');
const { createServer, runTurn } = require('../antigravity-gateway');

test('Argon video understanding uses the original Cloud Code multimodal route only for video turns', async t => {
  const cloud = [], robin = [];
  t.mock.method(AccountPool.prototype, 'send', async (normalized, model) => {
    cloud.push({ normalized, model });
    return { text: 'cloud-video-analysis', toolCalls: [], usage: {} };
  });
  t.mock.method(RobinAccountPool.prototype, 'send', async (normalized, model) => {
    robin.push({ normalized, model });
    return { text: 'argon-text-answer', toolCalls: [], usageKnown: false };
  });
  const video = normalizeChat({
    model: ARGON_MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '分析这段视频。' },
      { type: 'input_video', video_url: `data:video/mp4;base64,${Buffer.from('synthetic-video').toString('base64')}` }
    ] }]
  });
  const videoResult = await runTurn(video, ARGON_MODEL, new AbortController().signal, { sessionId: 'video' });
  assert.equal(videoResult.text, 'cloud-video-analysis');
  assert.equal(cloud.length, 1); assert.equal(robin.length, 0);
  assert.equal(cloud[0].model, 'gemini-3.8-flash-high');
  assert.match(cloud[0].normalized.system, /Attached images.*are context/is);
  assert.equal(cloud[0].normalized.messages[0].parts[1].mediaType, 'video/mp4');

  const text = normalizeChat({ model: ARGON_MODEL, messages: [{ role: 'user', content: '只处理文本。' }] });
  const textResult = await runTurn(text, ARGON_MODEL, new AbortController().signal, { sessionId: 'text' });
  assert.equal(textResult.text, 'argon-text-answer');
  assert.equal(cloud.length, 1); assert.equal(robin.length, 1);
  assert.equal(robin[0].model, ARGON_MODEL);
});

test('all three public protocols route Argon video turns through Cloud Code', async t => {
  delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
  const cloud = [], robin = [];
  t.mock.method(AccountPool.prototype, 'send', async (normalized, model) => {
    cloud.push({ normalized, model });
    return { text: 'cloud-video-analysis', toolCalls: [], usage: {} };
  });
  t.mock.method(RobinAccountPool.prototype, 'send', async (normalized, model) => {
    robin.push({ normalized, model });
    return { text: 'unexpected-robin-answer', toolCalls: [], usageKnown: false };
  });

  const dataUrl = `data:video/mp4;base64,${Buffer.from('synthetic-video').toString('base64')}`;
  const cases = [
    ['/v1/messages', {
      model: ARGON_MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '分析这段视频。' },
        { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: dataUrl } }
      ] }]
    }],
    ['/v1/chat/completions', {
      model: ARGON_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '分析这段视频。' },
        { type: 'input_video', video_url: dataUrl }
      ] }]
    }],
    ['/v1/responses', {
      model: ARGON_MODEL,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: '分析这段视频。' },
        { type: 'input_video', video_url: dataUrl }
      ] }]
    }]
  ];

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [endpoint, payload] of cases) {
    const response = await fetch(base + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${endpoint}: ${JSON.stringify(body)}`);
    assert.equal(response.headers.get('x-antigravity-model'), ARGON_MODEL, endpoint);
  }

  assert.equal(robin.length, 0);
  assert.equal(cloud.length, cases.length);
  for (const call of cloud) {
    assert.equal(call.model, 'gemini-3.8-flash-high');
    assert.equal(call.normalized.messages[0].parts.find(part => part.type === 'media').mediaType, 'video/mp4');
  }
});

test('Argon video routing rejects a fallback model alias that loops back to Robin', async t => {
  const previous = process.env.ANTIGRAVITY_MODEL_ALIASES;
  t.after(() => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_MODEL_ALIASES;
    else process.env.ANTIGRAVITY_MODEL_ALIASES = previous;
  });
  process.env.ANTIGRAVITY_MODEL_ALIASES = JSON.stringify({
    'gemini-3.8-flash-high': ARGON_MODEL
  });
  const video = normalizeChat({
    model: ARGON_MODEL,
    messages: [{ role: 'user', content: [{
      type: 'input_video',
      video_url: `data:video/mp4;base64,${Buffer.from('synthetic-video').toString('base64')}`
    }] }]
  });
  await assert.rejects(
    runTurn(video, ARGON_MODEL, new AbortController().signal, { sessionId: 'loop' }),
    { code: 'argon_video_fallback_unavailable', status: 503 }
  );
});
