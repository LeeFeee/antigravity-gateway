'use strict';

// Wire primitives for the protobuf API used by the Gemini application.
// Field numbers and their meanings belong to the individual RPC modules.
const MAX_FIELD_NUMBER = 0x1fffffff;
const MAX_UINT64 = (1n << 64n) - 1n;

function varint(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('Unsafe protobuf integer');
  let remaining = BigInt(value);
  if (remaining < -(1n << 63n) || remaining > MAX_UINT64) throw new RangeError('Protobuf integer out of range');
  if (remaining < 0n) remaining = BigInt.asUintN(64, remaining);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}

function key(number, wireType) {
  if (!Number.isInteger(number) || number < 1 || number > MAX_FIELD_NUMBER) throw new RangeError('Invalid protobuf field number');
  return varint(BigInt(number) * 8n + BigInt(wireType));
}

function bytesField(number, value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('Protobuf bytes must be a byte array');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.concat([key(number, 2), varint(bytes.length), bytes]);
}

function stringField(number, value) {
  if (typeof value !== 'string') throw new TypeError('Protobuf string must be a string');
  return bytesField(number, Buffer.from(value, 'utf8'));
}

function intField(number, value) { return Buffer.concat([key(number, 0), varint(value)]); }
function boolField(number, value) {
  if (typeof value !== 'boolean') throw new TypeError('Protobuf bool must be a boolean');
  return intField(number, value ? 1 : 0);
}
function concatFields(fields) { return Buffer.concat(fields); }

function readVarint(buffer, start = 0) {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    if (start + index >= buffer.length) throw new Error('Truncated protobuf varint');
    const byte = buffer[start + index];
    if (index === 9 && byte > 1) throw new Error('Overflowing protobuf varint');
    value |= BigInt(byte & 127) << BigInt(index * 7);
    if (!(byte & 128)) return { value, offset: start + index + 1 };
  }
  throw new Error('Invalid protobuf varint');
}

function decodeFields(input, { maxBytes = 64 * 1024 * 1024, maxFields = 100000 } = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Protobuf input must be a byte array');
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buffer.length > maxBytes) throw new RangeError('Protobuf message exceeds size limit');
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (fields.length >= maxFields) throw new RangeError('Protobuf field count exceeds limit');
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const number = Number(tag.value >> 3n), wireType = Number(tag.value & 7n);
    if (number < 1 || number > MAX_FIELD_NUMBER) throw new Error('Invalid protobuf field tag');
    let value;
    if (wireType === 0) {
      const decoded = readVarint(buffer, offset);
      value = decoded.value;
      offset = decoded.offset;
    } else if (wireType === 1 || wireType === 2 || wireType === 5) {
      let length = wireType === 1 ? 8 : 4;
      if (wireType === 2) {
        const decoded = readVarint(buffer, offset);
        offset = decoded.offset;
        if (decoded.value > BigInt(buffer.length - offset)) throw new Error('Truncated protobuf bytes');
        length = Number(decoded.value);
      }
      if (length > buffer.length - offset) throw new Error('Truncated protobuf fixed field');
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
    fields.push({ number, wireType, value });
  }
  return fields;
}

function field(input, number, wireType) {
  const fields = Array.isArray(input) ? input : decodeFields(input);
  // Protobuf singular scalar/message fields use the last occurrence here.
  // Callers requiring repeated fields or message merging inspect decodeFields.
  return fields.findLast(value => value.number === number && value.wireType === wireType)?.value;
}

module.exports = { varint, readVarint, bytesField, messageField: bytesField, stringField, intField, boolField, concatFields, decodeFields, field };
