'use strict';
require('./helpers/gateway-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { normalizeResponses, normalizeAnthropic, finalizeModelResult, anthropicResponse, responsesResponse } = require('../src/protocol');
const { createResponsesTextEmitter, emitResponsesStream, emitAnthropicStream } = require('../antigravity-gateway');
const { createServer } = require('../antigravity-gateway');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { GatewayError } = require('../src/protocol');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function provider(body, type = 'application/json') {
  return new DirectAntigravityProvider({ accessToken: 'synthetic', projectId: 'synthetic', maxRetries: 0,
    baseUrl: 'https://synthetic.invalid', sessionStore: new AgySessionStore({ directory: '' }),
    fetchImpl: async (_url, options) => new Response(typeof body === 'function' ? body(JSON.parse(options.body))
      : typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': type } }) });
}
function upstream(reason, parts = [{ text: 'partial answer' }]) {
  return { candidates: [{ content: { parts }, ...(reason ? { finishReason: reason } : {}) }] };
}
function sink() {
  const chunks = [];
  return { headersSent: false, writeHead() { this.headersSent = true; }, write(s) { chunks.push(s); }, end() {},
    events: () => chunks.join('').split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))) };
}

for (const format of ['json', 'sse']) for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-low']) {
  test(`${model} ${format}: MAX_TOKENS survives provider, both serializers and both Responses SSE paths`, async () => {
    const value = upstream('MAX_TOKENS');
    const p = provider(format === 'json' ? value : `data: ${JSON.stringify(value)}\n\n`, format === 'json' ? 'application/json' : 'text/event-stream');
    const n = normalizeResponses({ input: 'x' }), raw = await p.send(n, model);
    assert.equal(raw.finishReason, 'MAX_TOKENS');
    const result = finalizeModelResult(n, raw);
    const a = anthropicResponse(model, result), r = responsesResponse(model, result, 'resp_synthetic');
    assert.equal(a.stop_reason, 'max_tokens');
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(r.output[0].status, 'incomplete');
    const aSink = sink(); emitAnthropicStream(aSink, a);
    assert.equal(aSink.events().find(e => e.type === 'message_delta').delta.stop_reason, 'max_tokens');
    for (const live of [false, true]) {
      const s = sink(), copy = structuredClone(r);
      if (live) { const emitter = createResponsesTextEmitter(s, model, copy.id); emitter.onDelta('partial '); emitter.finish(copy); }
      else emitResponsesStream(s, copy);
      assert.equal(s.events().at(-1).type, 'response.incomplete');
      assert.equal(s.events().at(-1).response.output[0].status, 'incomplete');
      assert.ok(!s.events().some(e => e.type === 'response.completed'));
    }
  });
}

test('truncated structured text and required tool requests retain truncation, not a misleading contract failure', async () => {
  const n = normalizeResponses({ input: 'x', text: { format: { type: 'json_schema', schema: { type: 'array' } } },
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], tool_choice: 'required' });
  const result = finalizeModelResult(n, { text: '[1,', toolCalls: [], finishReason: 'MAX_TOKENS' });
  assert.equal(result.text, '[1,');
  assert.equal(responsesResponse('model', result, 'r').status, 'incomplete');
});

test('complete tools take precedence over STOP, but not explicit truncation or filtering', () => {
  const n = normalizeAnthropic({ messages: [], tools: [{ name: 'read', input_schema: { type: 'object' } }] });
  for (const [finishReason, stop] of [['STOP', 'tool_use'], ['MAX_TOKENS', 'max_tokens']]) {
    const result = finalizeModelResult(n, { text: '', toolCalls: [{ id: 'c', name: 'read', arguments: {} }], finishReason });
    assert.equal(anthropicResponse('model', result).stop_reason, stop);
    if (finishReason === 'MAX_TOKENS') assert.equal(responsesResponse('model', result, 'r').output[0].status, 'incomplete');
  }
});

test('content filtering maps to refusal/content_filter; unknown explicit reasons are conversion errors', async () => {
  for (const value of [upstream('SAFETY', []), { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]) {
    const n = normalizeResponses({ input: 'x' }), raw = await provider(value).send(n, 'gemini-3.8-flash-low');
    const result = finalizeModelResult(n, raw);
    assert.equal(anthropicResponse('model', result).stop_reason, 'refusal');
    assert.deepEqual(responsesResponse('model', result, 'r').incomplete_details, { reason: 'content_filter' });
    assert.equal(result.text, '', 'do not invent refusal prose');
  }
  for (const reason of ['OTHER', 'FUTURE_REASON', 'MALFORMED_FUNCTION_CALL']) {
    await assert.rejects(provider(upstream(reason)).send(normalizeResponses({ input: 'x' }), 'gemini-3.8-flash-low'),
      error => error.code === 'unsupported_upstream_finish_reason' && error.status === 502);
  }
});

for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-sonnet-4-6']) {
  test(`${model}: valid multiline SSE data is parsed as one event`, async () => {
    const body = 'event: message\r\ndata: {"candidates": [\r\ndata: {"content":{"parts":[{"text":"not empty"}]},"finishReason":"STOP"}]}\r\n\r\n';
    const result = await provider(body, 'text/event-stream').send(normalizeResponses({ input: 'x' }), model);
    assert.equal(result.text, 'not empty');
    assert.equal(result.finishReason, 'STOP');
  });
}

test('conflicting tool names for one upstream call ID cannot execute a mixed call', async () => {
  const n = normalizeResponses({ input: 'x', tools: ['alpha', 'beta'].map(name => ({ type: 'function', name,
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } })) });
  const p = provider(request => {
    const declarations = request.request.tools.flatMap(t => t.functionDeclarations);
    return JSON.stringify(upstream('STOP', declarations.map((d, i) => ({ functionCall: {
      id: 'same-id', name: d.name, args: { value: String(i), toolSummary: 'Synthetic call' }
    } }))));
  });
  await assert.rejects(p.send(n, 'gemini-3.8-flash-low'), error => error.code === 'invalid_tool_call' && error.status === 502);
});

test('truncated internal finish cannot fabricate a task-complete receipt', async () => {
  const n = normalizeResponses({ input: 'x', text: { format: { type: 'json_schema', schema: {
    type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false
  } } } });
  await assert.rejects(provider(upstream('MAX_TOKENS', [{ functionCall: { id: 'f', name: 'finish', args: { done: true } } }]))
    .send(n, 'gemini-3.8-flash-low'), error => error.code === 'incomplete_structured_tool_call' && error.status === 502);
});

test('ordinary complete tool event without finishReason remains valid', async () => {
  const n = normalizeResponses({ input: 'x', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] });
  const p = provider(request => {
    const name = request.request.tools.flatMap(t => t.functionDeclarations).find(t => t.name.endsWith('_json')).name;
    return `data: ${JSON.stringify(upstream(null, [{ functionCall: { id: 'r', name, args: {
      argumentsJson: '{}', toolSummary: 'Read' } }, thoughtSignature: 'sig' }]))}\n\n`;
  }, 'text/event-stream');
  const result = await p.send(n, 'gemini-3.8-flash-high');
  assert.equal(result.toolCalls[0].name, 'read');
  assert.equal(anthropicResponse('model', finalizeModelResult(n, result)).stop_reason, 'tool_use');
});

test('broken committed SSE fails explicitly for low and high profiles', async () => {
  for (const model of ['gemini-3.8-flash-low', 'gemini-3.8-flash-high']) {
    await assert.rejects(provider('data: {broken}\n\n', 'text/event-stream').send(normalizeResponses({ input: 'x' }), model),
      error => error.code === 'invalid_upstream_response' && error.status === 502);
  }
});

for (const protocol of ['messages', 'responses']) test(`${protocol}: incomplete internal image call never executes, including after live text`, async t => {
  let reason, sends = 0, images = 0;
  t.mock.method(AccountPool.prototype, 'send', async (_n, _m, options) => {
    sends++; options.onDelta?.('Thinking about an image.');
    return { text: 'Thinking about an image.', finishReason: reason, toolCalls: [
      { id: 'image', name: 'generate_image', arguments: { Prompt: 'controlled circle', ImageName: 'circle' } }
    ] };
  });
  t.mock.method(AccountPool.prototype, 'generateImage', async () => { images++; throw new Error('must not execute'); });
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const stream of [false, true]) for (reason of ['MAX_TOKENS', 'SAFETY', 'FUTURE_REASON']) {
    const payload = { model: 'gemini-3.8-flash-low', stream,
      ...(protocol === 'messages' ? { messages: [{ role: 'user', content: 'Draw' }], max_tokens: 100 } : { input: 'Draw' }) };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/${protocol}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const code = reason === 'FUTURE_REASON' ? 'unsupported_upstream_finish_reason' : 'incomplete_native_image_call';
    if (!stream) { assert.equal(res.status, 502); assert.equal((await res.json()).error.type, code); }
    else {
      const events = (await res.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      assert.ok(events.some(e => e.type === (protocol === 'messages' ? 'content_block_delta' : 'response.output_text.delta')));
      assert.equal(events.at(-1).type, 'error');
      if (protocol === 'messages') assert.equal(events.at(-1).error.type, code);
      else {
        assert.equal(events.at(-1).code, code); assert.equal(events.at(-1).param, null);
        assert.equal(typeof events.at(-1).message, 'string');
        assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
      }
      assert.ok(!events.some(e => ['response.completed', 'message_stop'].includes(e.type)));
    }
  }
  assert.equal(sends, 6); assert.equal(images, 0);
});

for (const protocol of ['messages', 'responses']) test(`${protocol}: filtering after an emitted delta preserves partial text and terminal meaning`, async t => {
  t.mock.method(AccountPool.prototype, 'send', async (_n, _m, options) => {
    options.onDelta?.('Actual partial ');
    return { text: 'Actual partial answer.', finishReason: 'SAFETY', toolCalls: [], usage: {} };
  });
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const payload = { model: 'gemini-3.8-flash-low', stream: true,
    ...(protocol === 'messages' ? { messages: [{ role: 'user', content: 'x' }], max_tokens: 100 } : { input: 'x' }) };
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/${protocol}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const events = (await res.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  if (protocol === 'messages') {
    assert.equal(events.filter(e => e.type === 'content_block_delta').map(e => e.delta.text || '').join(''), 'Actual partial answer.');
    assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'refusal');
    assert.equal(events.at(-1).type, 'message_stop');
  } else {
    assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), 'Actual partial answer.');
    assert.equal(events.at(-1).type, 'response.incomplete');
    assert.deepEqual(events.at(-1).response.incomplete_details, { reason: 'content_filter' });
    assert.equal(events.at(-1).response.output[0].content[0].text, 'Actual partial answer.');
    assert.equal(events.at(-1).response.output[0].status, 'incomplete');
    assert.ok(!events.some(e => e.type === 'response.completed'));
  }
});

test('termination conversion errors do not cool accounts or retry another account', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-termination-pool-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  for (const email of ['one@example.test', 'two@example.test']) store.save({ email, accessToken: 'synthetic', refreshToken: 'synthetic' });
  let failure, calls = 0;
  const pool = new AccountPool({ store, providerFactory: () => ({
    listModels: async () => ['synthetic-model'], modelInfo: () => null,
    send: async () => { calls++; throw failure; }
  }) });
  t.after(() => pool.stop());
  for (const code of ['incomplete_native_image_call', 'incomplete_structured_tool_call', 'unsupported_upstream_finish_reason', 'invalid_tool_call']) {
    failure = new GatewayError('Controlled conversion failure', { code, status: 502 });
    await assert.rejects(pool.send({}, 'synthetic-model'), error => error === failure);
    assert.ok(pool.status().every(item => item.state === 'available' && !item.cooldownUntil));
    assert.ok([...pool.entries.values()].every(entry => entry.modelCooldowns.size === 0));
  }
  assert.equal(calls, 4);
});
