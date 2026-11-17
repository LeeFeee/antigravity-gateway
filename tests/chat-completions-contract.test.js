'use strict';
require('./helpers/gateway-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChat, normalizeChatAsync } = require('../src/protocol');
const { generationProfile } = require('../src/antigravity-model-config');
const { LegacyChatCalls } = require('../src/chat-legacy-calls');
const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
const tools = [{ type: 'function', function: { name: 'read', description: 'Read the complete file.', parameters: schema } }];

test('Chat async schema boundary preserves instructions, full tool contract and tool history', async () => {
  const payload = { model: 'gemini-3.8-flash-high', tools, parallel_tool_calls: false,
    messages: [
      { role: 'system', content: 'USER_SOUL_EXACT' }, { role: 'developer', content: 'USER_RULES_EXACT' },
      { role: 'user', content: 'Read /tmp/input.' },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'call_real_client', type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/input"}' } }] },
      { role: 'tool', tool_call_id: 'call_real_client', content: '{"type":"business_record","value":"EXACT"}' }
    ] };
  const before = structuredClone(payload), result = await normalizeChatAsync(payload);
  assert.deepEqual(result, normalizeChat(payload)); assert.deepEqual(payload, before);
  assert.equal(result.system, 'USER_SOUL_EXACT\nUSER_RULES_EXACT');
  assert.deepEqual(result.tools[0].schema, schema); assert.equal(result.parallelToolCalls, false);
  assert.deepEqual(result.messages[1].parts[1], { type: 'tool_call', id: 'call_real_client', name: 'read', arguments: { path: '/tmp/input' } });
  assert.equal(result.messages[2].parts[0].content, payload.messages[4].content);
});

test('Chat max_completion_tokens takes precedence; model name still owns thinking strength', () => {
  const result = normalizeChat({ model: 'gemini-3.8-flash-high', max_completion_tokens: 8192, max_tokens: 100,
    reasoning_effort: 'none', temperature: 0.2, top_p: 0.8, stop: 'END' });
  const wire = generationProfile(result, result.model);
  assert.equal(wire.maxOutputTokens, 8192); assert.equal(wire.temperature, 0.2); assert.equal(wire.topP, 0.8);
  assert.deepEqual(wire.stopSequences, ['END']); assert.equal(wire.thinkingConfig.thinkingLevel, 'HIGH');
});

test('Chat supports both JSON formats without dropping the output schema', async () => {
  assert.deepEqual((await normalizeChatAsync({ response_format: { type: 'json_object' } })).structuredSchema, { type: 'object' });
  const result = await normalizeChatAsync({ response_format: { type: 'json_schema', json_schema: { name: 'file', strict: true, schema } } });
  assert.deepEqual(result.structuredSchema, schema);
  assert.throws(() => normalizeChat({ response_format: { type: 'json_schema', json_schema: { name: 'missing' } } }), { code: 'invalid_structured_schema' });
});

test('deprecated functions retain matching call/result identity and single-call semantics', () => {
  const payload = { functions: [tools[0].function], function_call: { name: 'read' }, messages: [
    { role: 'assistant', content: null, function_call: { name: 'read', arguments: '{"path":"/tmp/input"}' } },
    { role: 'function', name: 'read', content: 'EXACT' }
  ] };
  const result = normalizeChat(payload);
  assert.equal(result.legacyFunctions, true); assert.equal(result.parallelToolCalls, false);
  assert.equal(result.messages[0].parts[0].id, result.messages[1].parts[0].id);
  assert.equal(result.messages[1].parts[0].content, 'EXACT');
  assert.deepEqual(result.toolChoice, { type: 'function', function: { name: 'read' } });
});

test('custom tools preserve raw text input and declared grammar', () => {
  const format = { type: 'grammar', syntax: 'regex', definition: '.*' };
  const result = normalizeChat({ tools: [{ type: 'custom', custom: { name: 'raw', description: 'Raw data', format } }],
    tool_choice: { type: 'custom', custom: { name: 'raw' } }, messages: [
      { role: 'assistant', content: null, tool_calls: [{ type: 'custom', id: 'call_raw', custom: { name: 'raw', input: '001\n{"data":1}' } }] },
      { role: 'tool', tool_call_id: 'call_raw', content: 'accepted' }
    ] });
  assert.equal(result.tools[0].kind, 'custom'); assert.deepEqual(result.tools[0].format, format);
  assert.deepEqual(result.messages[0].parts[0].arguments, { input: '001\n{"data":1}' });
});

test('Chat image and audio inputs use the shared media representation', () => {
  const result = normalizeChat({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe the inputs.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } }
  ] }] });
  assert.equal(result.messages[0].parts.filter(p => p.type === 'media').length, 2);
});

test('Chat does not silently accept unsupported semantics or malformed tool history', () => {
  for (const payload of [{ n: 2 }, { logprobs: true }, { store: true }, { modalities: ['audio'] },
    { web_search_options: {} }, { frequency_penalty: 1 }, { response_format: { type: 'future' } }]) {
    assert.throws(() => normalizeChat(payload), { code: 'unsupported_parameter', status: 400 });
  }
  for (const payload of [{ messages: 'hello' }, { messages: [null] }, { stream: 'false' },
    { max_completion_tokens: -1 }, { parallel_tool_calls: 'false' },
    { messages: [{ role: 'tool', content: 'missing-id' }] },
    { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{bad' } }] }] }]) {
    assert.throws(() => normalizeChat(payload), { code: 'invalid_request_error', status: 400 });
  }
});

test('legacy ID translation is scoped to caller, model and full supplied history, without storing context', async () => {
  let now = 100;
  const cache = new LegacyChatCalls({ now: () => now, ttlMs: 1000, capacity: 2 });
  const initial = { messages: [{ role: 'user', content: 'Read /tmp/input.' }] };
  const call = { role: 'assistant', content: null, function_call: { name: 'read', arguments: '{"path":"/tmp/input"}' } };
  cache.record('caller', initial, 'model', call, 'issued_upstream_id');
  const payload = { functions: [tools[0].function], messages: [...initial.messages, call,
    { role: 'function', name: 'read', content: 'EXACT' }] };
  const ids = cache.resolve('caller', payload, 'model');
  const result = await normalizeChatAsync(payload, { legacyCallIds: ids });
  assert.equal(result.messages[1].parts[0].id, 'issued_upstream_id');
  assert.equal(result.messages[2].parts[0].id, 'issued_upstream_id');
  assert.deepEqual([...cache.entries.values()], [{ id: 'issued_upstream_id', expiresAt: 1100 }]);
  for (const [caller, model, body] of [['other', 'model', payload], ['caller', 'other', payload],
    ['caller', 'model', { ...payload, messages: [{ role: 'user', content: 'Different task' }, call] }]]) {
    assert.throws(() => cache.resolve(caller, body, model), { code: 'legacy_function_call_not_found', status: 400 });
  }
  now = 1100;
  assert.throws(() => cache.resolve('caller', payload, 'model'), { code: 'legacy_function_call_not_found' });
  assert.equal(cache.entries.size, 0);
});
