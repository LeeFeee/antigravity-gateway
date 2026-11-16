'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geminiValueMessageDepth, prepareGeminiToolSchema, decodeGeminiToolArguments } = require('../src/gemini-tool-schema');
const { encodeGeminiStruct, decodeGeminiStruct } = require('../src/gemini-struct');

test('deep schema remains complete through shallow protobuf catalog and JSON arguments', () => {
  let schema = { type: 'string', enum: ['中文', 'line\nquote"'] };
  let args = '中文';
  for (let n = 0; n < 12; n++) {
    schema = { type: 'object', properties: { nested: schema }, required: ['nested'], additionalProperties: false };
    args = { nested: args };
  }
  const original = { name: 'deep_client_tool', description: 'Original client contract.', inputSchema: schema };
  const prepared = prepareGeminiToolSchema(original);
  assert.equal(prepared.encoded, true);
  assert.ok(geminiValueMessageDepth(prepared.tool) < 32);
  const roundtrip = decodeGeminiStruct(encodeGeminiStruct(prepared.tool));
  const description = roundtrip.inputSchema.properties.arguments_json.description;
  assert.deepEqual(JSON.parse(description.slice(description.indexOf('\n') + 1)), schema);
  assert.deepEqual(decodeGeminiToolArguments({ arguments_json: JSON.stringify(args) }, true), args);
  assert.equal(original.inputSchema, schema);
  assert.ok(roundtrip.description.startsWith(original.description));
});

test('ordinary tools, including an original arguments_json property, retain their contract', () => {
  const original = { name: 'ordinary', inputSchema: { type: 'object', properties: { arguments_json: { type: 'string' } } } };
  const prepared = prepareGeminiToolSchema(original);
  assert.equal(prepared.encoded, false);
  assert.equal(prepared.tool, original);
  const args = { arguments_json: 'ordinary user data' };
  assert.equal(decodeGeminiToolArguments(args, false), args);
});

test('malformed transport arguments never become executable client arguments', () => {
  for (const args of [{}, { arguments_json: '{}' , extra: true }, { arguments_json: 1 },
    { arguments_json: '[' }, { arguments_json: '[]' }, { arguments_json: 'null' }, { arguments_json: '"text"' }]) {
    assert.throws(() => decodeGeminiToolArguments(args, true), { code: 'gemini_tool_arguments_encoding_invalid' });
  }
  const withPrototypeKey = JSON.parse('{"__proto__":{"literal":true}}');
  const decoded = decodeGeminiToolArguments({ arguments_json: JSON.stringify(withPrototypeKey) }, true);
  assert.deepEqual(decoded, withPrototypeKey);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
});
