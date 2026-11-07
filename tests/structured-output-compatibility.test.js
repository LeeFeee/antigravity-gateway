'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDirectRequest, DirectAntigravityProvider } = require('../src/direct-provider');
const { normalizeAnthropic, normalizeResponses, finalizeModelResult, normalizeStructured } = require('../src/protocol');
const { AgySessionStore } = require('../src/agy-session-state');

const complex = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array',
  prefixItems: [{ type: 'integer', enum: [1, 2] }, { oneOf: [{ const: null }, { type: 'string', minLength: 2 }] }],
  minItems: 2, maxItems: 2, items: false };
const normalizers = {
  messages: schema => normalizeAnthropic({ model: 'gemini-3.8-flash-low', messages: [{ role: 'user', content: 'Give the result.' }],
    output_config: { format: { type: 'json_schema', schema } } }),
  responses: schema => normalizeResponses({ model: 'gemini-3.8-flash-low', input: 'Give the result.',
    text: { format: { type: 'json_schema', schema } } })
};

for (const [name, normalize] of Object.entries(normalizers)) {
  test(`${name}: a complex output schema reaches the first upstream request without lossy projection`, () => {
    const normalized = normalize(complex), before = structuredClone(normalized), native = {};
    const body = buildDirectRequest(normalized, normalized.model, 'project', 'session', '', null, native);
    assert.equal(body.request.tools, undefined);
    const instructions = body.request.systemInstruction.parts[0].text;
    assert.deepEqual(JSON.parse(instructions.slice(instructions.indexOf('\n') + 1)), complex);
    assert.equal(body.request.generationConfig.responseSchema, undefined);
    assert.equal(native.structuredSchema, null, 'complex formats do not pretend to be the native finish tool');
    assert.deepEqual(normalized, before);
    assert.equal(finalizeModelResult(normalized, { text: '[1,null]', toolCalls: [], usage: {} }).text, '[1,null]');
    assert.throws(() => finalizeModelResult(normalized, { text: '[3,null]', toolCalls: [], usage: {} }), { code: 'invalid_structured_output' });
  });

  test(`${name}: invalid or missing output contracts fail before dispatch`, () => {
    for (const schema of [undefined, null, false, [], { allOf: [] }, { $ref: '#/$defs/missing' }]) {
      assert.throws(() => normalize(schema), { code: 'invalid_structured_schema', status: 400 });
    }
    assert.equal(normalize(true).structuredSchema, true);
  });
}

test('JSON null, false, zero and empty values keep their distinct structured meaning', () => {
  for (const value of [null, false, 0, '', [], {}]) assert.equal(normalizeStructured(JSON.stringify(value), true), JSON.stringify(value));
  assert.equal(normalizeStructured('null', { type: 'null' }), 'null');
  assert.throws(() => normalizeStructured('not JSON', { type: 'null' }), { code: 'invalid_structured_output' });
});

test('complex structured answers remain buffered until validation, including provider-level streaming callbacks', async () => {
  const normalized = normalizers.responses(complex), chunks = [];
  const provider = new DirectAntigravityProvider({ accessToken: 'synthetic', projectId: 'project', maxRetries: 0,
    sessionStore: new AgySessionStore({ directory: '' }),
    fetchImpl: async () => new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '[1,null]' }] } }] }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }) });
  const result = await provider.send(normalized, normalized.model, { onDelta: text => chunks.push(text) });
  assert.equal(finalizeModelResult(normalized, result).text, '[1,null]');
  assert.deepEqual(chunks, []);
});
