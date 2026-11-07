'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
process.env.ANTIGRAVITY_GATEWAY_API_KEY = '';
const { normalizeAnthropic, normalizeResponses, normalizeChat } = require('../src/protocol');
const { buildDirectRequest } = require('../src/direct-provider');
const { AccountPool } = require('../src/account-pool');
const { createServer } = require('../antigravity-gateway');
const MODEL = 'gemini-3.8-flash-high';

const rejected = {
  messages: [
    { messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: 'server-call', name: 'web_search', input: { query: 'REQUIRED_QUERY' } }] }], code: 'invalid_server_search_history' },
    { messages: [{ role: 'user', content: [{ type: 'future_semantic_block', text: 'Must not be mistaken for ordinary text.' }] }], code: 'unsupported_content_block' },
    { system: [{ type: 'future_instruction', instruction: 'Retain this task constraint.' }], messages: [], code: 'unsupported_content_block' },
    { messages: [], tools: [{ type: 'computer_20250124', name: 'computer', display_width: 1024, display_height: 768 }], code: 'unsupported_tool_type' }
  ],
  responses: [
    { input: [{ role: 'user', content: 'Use this context.' }, { type: 'item_reference', id: 'msg_required' }], code: 'unsupported_input_item' },
    { input: [{ type: 'future_semantic_item', role: 'user', content: 'Role must not bypass the type check.' }], code: 'unsupported_input_item' },
    { input: [{ role: 'user', content: [{ type: 'future_attachment', data: 'Required attachment.' }] }], code: 'unsupported_content_block' },
    { input: 'Call my extension.', tools: [{ type: 'future_executor', name: 'executor', parameters: { type: 'object' }, execution_mode: 'remote' }], code: 'unsupported_tool_type' }
  ]
};

for (const endpoint of ['messages', 'responses']) {
  test(`${endpoint}: unsupported semantic content and typed tools fail at HTTP ingress with zero account dispatch`, async t => {
    let calls = 0;
    t.mock.method(AccountPool.prototype, 'send', async () => { calls++; throw new Error('Unexpected upstream dispatch'); });
    t.mock.method(AccountPool.prototype, 'searchWeb', async () => { calls++; throw new Error('Unexpected search dispatch'); });
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    for (const { code, ...payload } of rejected[endpoint]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, max_tokens: 64, ...payload })
      });
      const body = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body)); assert.equal(body.error.type, code);
    }
    assert.equal(calls, 0);
  });
}

test('Responses refusal history preserves exact visible text, order and assistant role through upstream construction', () => {
  const input = [{ role: 'user', content: 'Original question.' }, { type: 'message', role: 'assistant', content: [
    { type: 'output_text', text: 'Before.' }, { type: 'refusal', refusal: 'Exact original refusal.' }, { type: 'output_text', text: 'After.' }
  ] }, { role: 'user', content: 'Explain that answer.' }];
  const before = structuredClone(input), normalized = normalizeResponses({ model: MODEL, input });
  assert.deepEqual(input, before);
  assert.equal(normalized.messages[1].role, 'assistant');
  assert.equal(normalized.messages[1].text, 'Before.\nExact original refusal.\nAfter.');
  const wire = buildDirectRequest(normalized, MODEL, 'synthetic-project', 'synthetic-session');
  assert.deepEqual(wire.request.contents[1], { role: 'model', parts: [
    { text: 'Before.' }, { text: 'Exact original refusal.' }, { text: 'After.' }
  ] });
  assert.throws(() => normalizeResponses({ input: [{ role: 'assistant', content: [{ type: 'refusal' }] }] }),
    { code: 'invalid_content_block', status: 400 });
});

test('tool result business type fields remain opaque receipts instead of being mistaken for new protocol extensions', () => {
  const receipt = { type: 'business_receipt', payload: { type: 'invoice', amount: 0, success: false } };
  const cases = [normalizeAnthropic({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [receipt] }] }] }),
    normalizeResponses({ input: [{ type: 'function_call_output', call_id: 'call', output: [receipt] }] })];
  for (const normalized of cases) {
    const result = normalized.messages[0].parts[0];
    assert.equal(result.type, 'tool_result'); assert.deepEqual(JSON.parse(result.content), receipt);
  }
});

test('supported untyped/custom Messages declarations and Responses function/custom declarations retain their contract', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false };
  for (const type of [undefined, 'custom', 'function']) {
    const tool = { ...(type ? { type } : {}), name: 'fixture', input_schema: schema };
    assert.deepEqual(normalizeAnthropic({ tools: [tool] }).tools[0].schema, schema);
  }
  assert.deepEqual(normalizeResponses({ tools: [{ type: 'function', name: 'fixture', parameters: schema }] }).tools[0].schema, schema);
  const custom = normalizeResponses({ tools: [{ type: 'custom', name: 'raw', format: { type: 'text' } }] }).tools[0];
  assert.equal(custom.kind, 'custom'); assert.deepEqual(custom.format, { type: 'text' });
});

test('Messages stop_sequences and OpenAI stop reach generationConfig without changing output limits or business fields', () => {
  const stops = ['END_REQUIRED', '\nUser:'];
  for (const [normalize, body] of [[normalizeAnthropic, { messages: [{ role: 'user', content: 'Stop precisely.' }], stop_sequences: stops }],
    [normalizeResponses, { input: 'Stop precisely.', stop: stops }], [normalizeChat, { messages: [{ role: 'user', content: 'Stop precisely.' }], stop: stops }]]) {
    const payload = { model: MODEL, max_tokens: 99, ...body }, before = structuredClone(payload);
    const normalized = normalize(payload), wire = buildDirectRequest(normalized, MODEL, 'synthetic-project', 'synthetic-session');
    assert.deepEqual(payload, before); assert.notEqual(normalized.generationConfig.stopSequences, stops);
    assert.deepEqual(wire.request.generationConfig.stopSequences, stops); assert.equal(wire.request.generationConfig.maxOutputTokens, 99);
    assert.deepEqual(wire.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'HIGH' });
  }
  assert.deepEqual(normalizeResponses({ stop: 'ONE' }).generationConfig.stopSequences, ['ONE']);
  assert.deepEqual(normalizeChat({ stop: 'ONE' }).generationConfig.stopSequences, ['ONE']);
  for (const invalid of ['not-an-array', [1], { type: 'ignored' }]) {
    assert.throws(() => normalizeAnthropic({ stop_sequences: invalid }), { code: 'invalid_generation_config', status: 400 });
  }
  const business = { stop_sequences: ['BUSINESS'], stop: false };
  assert.deepEqual(normalizeAnthropic({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'fixture', input: business }] }] })
    .messages[0].parts[0].arguments, business);
});

test('known opaque thinking/cache hints do not become task content or trigger unsupported extension errors', () => {
  const anthropic = normalizeAnthropic({ system: [{ type: 'text', text: 'Keep this rule.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT', signature: 'opaque-client-signature' },
      { type: 'redacted_thinking', data: 'OPAQUE_DATA' }, { type: 'text', text: 'VISIBLE' }] }] });
  assert.equal(anthropic.system, 'Keep this rule.'); assert.deepEqual(anthropic.messages[0].parts, [{ type: 'text', text: 'VISIBLE' }]);
  const responses = normalizeResponses({ input: [{ type: 'reasoning', encrypted_content: 'OPAQUE_DATA', summary: [{ type: 'summary_text', text: 'PRIVATE_SUMMARY' }] },
    { role: 'user', content: 'VISIBLE' }], prompt_cache_key: 'fixture', store: false });
  assert.deepEqual(responses.messages, [{ role: 'user', text: 'VISIBLE', parts: [{ type: 'text', text: 'VISIBLE' }] }]);
});

for (const agent of ['claude', 'hermes', 'pi', 'dsh']) {
  test(`${agent}: all original request captures and verified compaction requests still normalize`, () => {
    const files = fs.readdirSync(path.join(__dirname, 'fixtures/agent-requests-20261107'))
      .filter(file => file.startsWith(`${agent}-`) && file.endsWith('.json'))
      .map(file => path.join(__dirname, 'fixtures/agent-requests-20261107', file));
    files.push(path.join(__dirname, 'fixtures/agent-compaction-20261107/verified', `${agent}-compact.json`));
    let count = 0;
    for (const file of files) for (const capture of JSON.parse(fs.readFileSync(file, 'utf8')).captures || []) {
      if (capture.method !== 'POST' || !/^\/v1\/(messages|responses)(?:\?|$)/.test(capture.path)) continue;
      const normalize = capture.path.startsWith('/v1/messages') ? normalizeAnthropic : normalizeResponses;
      assert.doesNotThrow(() => normalize(capture.body), path.basename(file)); count++;
    }
    assert(count >= 10, `Missing ${agent} recorded request coverage`);
  });
}
