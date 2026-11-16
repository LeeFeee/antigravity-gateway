'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { varint, decodeFields, field, intField, boolField, stringField, messageField, concatFields } = require('../src/gemini-wire');

test('Gemini protobuf preserves explicit false, empty messages and 64-bit values', () => {
  const large = (1n << 63n) + 23n;
  const bytes = concatFields([boolField(5, false), messageField(1003, Buffer.alloc(0)), intField(70, large), stringField(2, '中文🙂')]);
  const fields = decodeFields(bytes);
  assert.equal(field(fields, 5, 0), 0n);
  assert.equal(field(fields, 1003, 2).length, 0);
  assert.equal(field(fields, 70, 0), large);
  assert.equal(field(fields, 2, 2).toString(), '中文🙂');
  assert.equal(field(fields, 7, 0), undefined);
});

test('Gemini protobuf does not round unsafe input integers or oversized tags', () => {
  assert.throws(() => varint(Number.MAX_SAFE_INTEGER + 1), /Unsafe/);
  assert.throws(() => varint(1n << 64n), /out of range/);
  assert.throws(() => intField(0x20000000, 1), /field number/);
  assert.throws(() => decodeFields(Buffer.from([0])), /field tag/);
  assert.throws(() => decodeFields(varint(0x20000000n << 3n)), /field tag/);
});

test('Gemini protobuf rejects malformed and oversized messages without partial decoding', () => {
  for (const bytes of [Buffer.from([8, 128]), Buffer.from([18, 10, 1]), Buffer.from([13, 1]), Buffer.from([9, 1]), Buffer.concat([Buffer.from([8]), Buffer.alloc(10, 255)])]) {
    assert.throws(() => decodeFields(bytes), /Truncated|Overflowing|Invalid/);
  }
  assert.throws(() => decodeFields(intField(1, 1), { maxBytes: 1 }), /size limit/);
  assert.throws(() => decodeFields(concatFields([intField(1, 1), intField(2, 1)]), { maxFields: 1 }), /field count/);
  assert.throws(() => boolField(1, 'false'), /boolean/);
});

test('Gemini protobuf keeps repeated fields and resolves the final singular value', () => {
  const fields = decodeFields(concatFields([intField(1, 1), intField(1, 2), stringField(3, 'a'), stringField(3, 'b')]));
  assert.equal(fields.length, 4);
  assert.equal(field(fields, 1, 0), 2n);
  assert.deepEqual(fields.filter(f => f.number === 3).map(f => f.value.toString()), ['a', 'b']);
});
