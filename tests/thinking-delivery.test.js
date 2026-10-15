'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');

test('shared protocols preserve thinking-disabled output semantics without controlling Argon internals', () => {
  const { normalizeChat, normalizeAnthropic } = require('../src/protocol');
  const { clientGenerateRequest } = require('../src/robin-provider');
  const { decodeFields } = require('../src/robin-proto');
  for (const normalize of [normalizeChat, normalizeAnthropic]) {
    const normalized = normalize({ model: 'gemini-4-argon', thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: '回复橙色笔记。' }] });
    assert.equal(normalized.reasoningEffort, 'none');
    assert.equal(normalized.includeThinking, false);
    const request = decodeFields(clientGenerateRequest(normalized));
    assert.equal(request.some(field => field.number === 38 || field.number === 48), false);
  }
});
const {
  normalizeAnthropic, normalizeChat, normalizeResponses, finalizeModelResult,
  anthropicResponse, chatResponse, responsesResponse
} = require('../src/protocol');
const {
  createAnthropicTextEmitter, createChatTextEmitter, createResponsesTextEmitter,
  emitAnthropicStream, emitChatStream, emitResponsesStream
} = require('../antigravity-gateway');

function harness() {
  const frames = [];
  return { res: { write: text => frames.push(text), end() {}, writeHead() {} },
    events: () => frames.join('').split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice(6))) };
}
const result = { text: '结果为 26。', thinking: '已核对两箱数量。', toolCalls: [], usage: {} };

test('thinking output follows explicit protocol settings and reasoning none always disables it', () => {
  const cases = [
    [normalizeAnthropic, { thinking: { type: 'enabled', budget_tokens: 1024 } }],
    [normalizeChat, { reasoning_effort: 'low' }],
    [normalizeResponses, { reasoning: { summary: 'auto' } }]
  ];
  for (const [normalize, settings] of cases) {
    const disabled = normalize({ messages: [], input: [] });
    assert.equal(disabled.includeThinking, false);
    assert.equal(finalizeModelResult(disabled, result).thinking, '');
    const enabled = normalize({ messages: [], input: [], ...settings });
    assert.equal(enabled.includeThinking, true);
    assert.equal(finalizeModelResult(enabled, result).thinking, result.thinking);
    const none = normalize({ messages: [], input: [], ...settings, reasoning_effort: 'none' });
    assert.equal(none.includeThinking, false);
  }
  assert.equal(normalizeResponses({ input: '', reasoning: { effort: 'high' } }).includeThinking, false,
    'Responses effort alone does not opt into a summary');
});

test('shared response formats keep public thoughts distinct from answer text and opaque tool signatures', () => {
  const raw = { ...result, toolCalls: [{ id: 'call_1', name: 'read_note', arguments: {}, thoughtSignature: 'opaque-native-signature' }] };
  const a = anthropicResponse('gemini-test', raw);
  assert.deepEqual(a.content.slice(0, 3), [
    { type: 'thinking', thinking: '', signature: 'opaque-native-signature' },
    { type: 'thinking', thinking: result.thinking }, { type: 'text', text: result.text }
  ]);
  assert.equal(a.content[3].type, 'tool_use');
  assert.equal(normalizeAnthropic({ messages: [{ role: 'assistant', content: a.content }] }).messages[0].parts
    .find(part => part.type === 'tool_call').thoughtSignature, 'opaque-native-signature');
  const c = chatResponse('gemini-test', raw).choices[0].message;
  assert.equal(c.reasoning_content, result.thinking); assert.equal(c.content, result.text);
  assert.equal(c.tool_calls[0].id, 'call_1');
  const r = responsesResponse('gemini-test', raw, 'resp_1');
  assert.deepEqual(r.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
  assert.equal(r.output[0].summary[0].text, result.thinking);
});

test('Anthropic and Chat streaming preserve summary and answer exactly once, including late final suffixes', () => {
  for (const protocol of ['anthropic', 'chat']) {
    const { res, events } = harness();
    const emitter = protocol === 'anthropic' ? createAnthropicTextEmitter(res, 'gemini-test') : createChatTextEmitter(res, 'gemini-test');
    emitter.onThinkingDelta('已核对'); emitter.onDelta('结果');
    emitter.finish(protocol === 'anthropic' ? anthropicResponse('gemini-test', result) : chatResponse('gemini-test', result));
    const all = events();
    const thoughts = protocol === 'anthropic'
      ? all.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join('')
      : all.map(e => e.choices?.[0]?.delta?.reasoning_content || '').join('');
    const text = protocol === 'anthropic'
      ? all.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('')
      : all.map(e => e.choices?.[0]?.delta?.content || '').join('');
    assert.equal(thoughts, result.thinking); assert.equal(text, result.text);
    if (protocol === 'anthropic') {
      const starts = all.filter(e => e.type === 'content_block_start');
      assert.deepEqual(starts.map(e => e.index), starts.map((_, i) => i));
      assert.deepEqual(all.filter(e => e.type === 'content_block_stop').map(e => e.index), starts.map(e => e.index));
    }
  }
});

test('Responses summary SSE uses stable item identities, indices and monotonic sequence in either arrival order', () => {
  for (const thoughtFirst of [true, false]) {
    const { res, events } = harness();
    const emitter = createResponsesTextEmitter(res, 'gemini-test', 'resp_1');
    if (thoughtFirst) { emitter.onThinkingDelta('已核对'); emitter.onDelta('结果'); }
    else { emitter.onDelta('结果'); emitter.onThinkingDelta('已核对'); }
    emitter.finish(responsesResponse('gemini-test', result, 'resp_1'));
    const all = events(), body = all.at(-1).response;
    assert.equal(all.at(-1).type, 'response.completed');
    assert.deepEqual(all.map(e => e.sequence_number), all.map((_, i) => i));
    const reasoning = body.output.find(item => item.type === 'reasoning');
    const message = body.output.find(item => item.type === 'message');
    const summary = all.filter(e => e.type === 'response.reasoning_summary_text.delta');
    assert.equal(summary.map(e => e.delta).join(''), result.thinking);
    assert.ok(summary.every(e => e.item_id === reasoning.id && body.output[e.output_index] === reasoning && e.summary_index === 0));
    const texts = all.filter(e => e.type === 'response.output_text.delta');
    assert.equal(texts.map(e => e.delta).join(''), result.text);
    assert.ok(texts.every(e => e.item_id === message.id && body.output[e.output_index] === message));
    for (const suffix of ['part.added', 'text.done', 'part.done']) {
      assert.equal(all.filter(e => e.type === 'response.reasoning_summary_' + suffix).length, 1);
    }
    assert.deepEqual(all.filter(e => e.type === 'response.output_item.done').map(e => e.item.id), body.output.map(e => e.id));
  }
});

test('buffered streaming with tools does not discard reasoning on any protocol', () => {
  const tool = { id: 'call_1', name: 'read_note', arguments: {} }, raw = { ...result, toolCalls: [tool] };
  for (const [response, emit, protocol] of [
    [anthropicResponse, emitAnthropicStream, 'anthropic'], [chatResponse, emitChatStream, 'chat'],
    [responsesResponse, emitResponsesStream, 'responses']
  ]) {
    const { res, events } = harness(); emit(res, response('gemini-test', raw, 'resp_1')); const all = events();
    if (protocol === 'anthropic') assert.equal(all.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join(''), result.thinking);
    if (protocol === 'chat') assert.equal(all[0].choices[0].delta.reasoning_content, result.thinking);
    if (protocol === 'responses') assert.equal(all.filter(e => e.type === 'response.reasoning_summary_text.delta').map(e => e.delta).join(''), result.thinking);
  }
});
