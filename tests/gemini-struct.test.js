'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeGeminiStruct, decodeGeminiStruct } = require('../src/gemini-struct');
const { intField, stringField, messageField, concatFields } = require('../src/gemini-wire');

test('tool schemas and results preserve empty strings, null, booleans, nested arrays and JSON keys', () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"":{"type":"string","enum":["",null,false,0]},"constructor":[1.5,{"required":[]}]}');
  const decoded = decodeGeminiStruct(encodeGeminiStruct(value));
  assert.deepEqual(decoded, value);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.ok(Object.hasOwn(decoded, '__proto__'));
});

test('invalid JSON and excessive nesting cannot be silently converted into tool arguments', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [{ field: undefined }, { field: Infinity }, { field: NaN }, { field: 1n }, { field: new Date() }, cyclic]) {
    assert.throws(() => encodeGeminiStruct(value));
  }
  const bytes = encodeGeminiStruct({ a: { b: { c: 1 } } });
  assert.throws(() => decodeGeminiStruct(bytes, { maxDepth: 2 }), /limit/);
  assert.throws(() => encodeGeminiStruct({ a: [1, 2, 3] }, { maxNodes: 3 }), /limit/);
});

test('protobuf Value oneof follows its final recognized kind, including explicit empty string', () => {
  const value = concatFields([intField(4, 1), stringField(3, '')]);
  const struct = messageField(1, concatFields([stringField(1, 'value'), messageField(2, value)]));
  assert.deepEqual(decodeGeminiStruct(struct), { value: '' });
});
