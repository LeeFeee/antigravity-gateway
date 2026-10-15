'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { anthropicResponse, chatResponse, responsesResponse, normalizeChat } = require('../src/protocol');
const {
  createServer, createAnthropicTextEmitter, createChatTextEmitter, createResponsesTextEmitter,
  emitAnthropicStream, emitChatStream, emitResponsesStream
} = require('../antigravity-gateway');
const { AccountStore } = require('../src/account-store');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { ARGON_MODEL } = require('../src/robin-provider');

const unknown = { text: 'done', toolCalls: [], usage: null, usageKnown: false };
const known = { text: 'done', toolCalls: [], usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } };
function events(text) {
  return text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)));
}
function harness() {
  const frames = [];
  return { res: { write: text => frames.push(text), end() {}, writeHead() {} }, read: () => events(frames.join('')) };
}

test('unknown usage is explicit without fictitious measured zeros in either OpenAI protocol', () => {
  const a = anthropicResponse(ARGON_MODEL, unknown);
  assert.equal(a.usage_known, false);
  assert.equal(a.usage.input_tokens, 0); assert.equal(a.usage.output_tokens, 0);
  const c = chatResponse(ARGON_MODEL, unknown);
  assert.equal(c.usage_known, false); assert.equal(Object.hasOwn(c, 'usage'), false);
  const r = responsesResponse(ARGON_MODEL, unknown, 'resp_1');
  assert.equal(r.usage_known, false); assert.equal(r.usage, null);
});

test('a verified zero usage value and all legacy known-usage responses keep their existing semantics', () => {
  for (const raw of [known, { ...known, usageKnown: true, usage: {} }]) {
    for (const response of [anthropicResponse('model', raw), chatResponse('model', raw), responsesResponse('model', raw, 'resp_1')]) {
      assert.equal(Object.hasOwn(response, 'usage_known'), false);
      assert.ok(response.usage && typeof response.usage === 'object');
    }
  }
});

test('Chat include_usage is opt-in, keeps prior chunks null and ends with one empty-choice usage chunk', () => {
  assert.equal(normalizeChat({ messages: [], stream_options: { include_usage: true } }).includeUsage, true);
  assert.equal(Object.hasOwn(normalizeChat({ messages: [] }), 'includeUsage'), false);
  for (const raw of [known, unknown]) for (const live of [false, true]) {
    const { res, read } = harness(), body = chatResponse('model', raw);
    if (live) { const emitter = createChatTextEmitter(res, 'model', { includeUsage: true }); emitter.onDelta('do'); emitter.finish(body); }
    else emitChatStream(res, body, { includeUsage: true });
    const all = read();
    assert.ok(all.slice(0, -1).every(chunk => chunk.usage === null));
    assert.deepEqual(all.at(-1).choices, []);
    assert.deepEqual(all.at(-1).usage, body.usage ?? null);
    assert.equal(all.filter(chunk => !chunk.choices.length).length, 1);
    assert.equal(all.at(-1).usage_known, raw.usageKnown === false ? false : undefined);
    assert.equal(all.flatMap(chunk => chunk.choices).map(choice => choice.delta?.content || '').join(''), 'done');
    const ordinary = harness(); emitChatStream(ordinary.res, body);
    assert.ok(ordinary.read().every(chunk => !Object.hasOwn(chunk, 'usage')));
  }
});

test('buffered and live Anthropic/Responses streaming preserve the unavailable-usage marker', () => {
  for (const live of [false, true]) {
    const a = harness(), body = anthropicResponse('model', unknown);
    if (live) { const emitter = createAnthropicTextEmitter(a.res, 'model'); emitter.onDelta('do'); emitter.finish(body); }
    else emitAnthropicStream(a.res, body);
    assert.equal(a.read().find(e => e.type === 'message_delta').usage_known, false);
    const r = harness(), response = responsesResponse('model', unknown, 'resp_1');
    if (live) { const emitter = createResponsesTextEmitter(r.res, 'model', 'resp_1'); emitter.onDelta('do'); emitter.finish(response); }
    else emitResponsesStream(r.res, response);
    assert.equal(r.read().at(-1).response.usage_known, false);
    assert.equal(r.read().at(-1).response.usage, null);
  }
});

test('actual gateway handlers propagate unknown usage for JSON, live SSE and buffered tool SSE', async t => {
  t.mock.method(RobinAccountPool.prototype, 'listModels', async () => [ARGON_MODEL]);
  t.mock.method(RobinAccountPool.prototype, 'send', async (_normalized, _model, options) => {
    options.onDelta?.('do'); return unknown;
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const protocol of ['messages', 'chat/completions', 'responses']) for (const variant of ['json', 'live', 'buffered']) {
    const stream = variant !== 'json';
    const payload = { model: ARGON_MODEL, stream,
      ...(protocol === 'responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] }),
      ...(protocol === 'chat/completions' ? { stream_options: { include_usage: true } } : {}) };
    if (variant === 'buffered') payload.tools = protocol === 'messages'
      ? [{ name: 'read_note', input_schema: { type: 'object' } }]
      : protocol === 'responses' ? [{ type: 'function', name: 'read_note', parameters: { type: 'object' } }]
        : [{ type: 'function', function: { name: 'read_note', parameters: { type: 'object' } } }];
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${protocol}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': 'usage-client', 'x-session-id': `${protocol}-${variant}` },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    if (!stream) {
      const body = await response.json(); assert.equal(body.usage_known, false);
      if (protocol === 'responses') assert.equal(body.usage, null);
      if (protocol === 'chat/completions') assert.equal(Object.hasOwn(body, 'usage'), false);
    } else {
      const all = events(await response.text());
      if (protocol === 'messages') assert.equal(all.find(e => e.type === 'message_delta').usage_known, false);
      if (protocol === 'responses') { assert.equal(all.at(-1).response.usage, null); assert.equal(all.at(-1).response.usage_known, false); }
      if (protocol === 'chat/completions') { assert.equal(all.at(-1).usage, null); assert.equal(all.at(-1).usage_known, false); assert.deepEqual(all.at(-1).choices, []); }
    }
  }
});

test('unknown native usage still counts successful upstream calls without recording a token measurement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-unknown-usage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  store.save({ id: 'r', accessToken: 'test', providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  const measurements = [];
  const pool = new RobinAccountPool({ store, providerFactory: () => ({ send: async () => unknown }),
    usageStore: { recordUpstream: record => measurements.push(record) } });
  t.after(() => pool.stop());
  await pool.send({ messages: [], tools: [] }, ARGON_MODEL, { sessionId: 'unknown' });
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].count, true);
  assert.equal(measurements[0].success, true);
  assert.equal(Object.hasOwn(measurements[0], 'usage'), false);
});
