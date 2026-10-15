'use strict';

// Robin uses ordinary protobuf messages over gRPC. Keep the small wire codec
// local so the gateway does not need a generated-code runtime merely to frame
// the handful of envelopes used by ProcessQuery and ExecuteRemoteTools.

function varint(value) {
  let number = BigInt(value);
  if (number < 0n) number = BigInt.asUintN(64, number);
  const output = [];
  do {
    let byte = Number(number & 0x7fn);
    number >>= 7n;
    if (number) byte |= 0x80;
    output.push(byte);
  } while (number);
  return Buffer.from(output);
}

function fieldKey(number, wireType) {
  if (!Number.isInteger(number) || number <= 0) throw new TypeError('protobuf field number must be a positive integer');
  return varint((BigInt(number) << 3n) | BigInt(wireType));
}

function bytesField(number, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  return Buffer.concat([fieldKey(number, 2), varint(data.length), data]);
}

function stringField(number, value) {
  return value === undefined || value === null || value === '' ? Buffer.alloc(0) : bytesField(number, Buffer.from(String(value)));
}

function messageField(number, value) {
  return bytesField(number, value);
}

function intField(number, value) {
  return Buffer.concat([fieldKey(number, 0), varint(value)]);
}

function boolField(number, value) {
  return intField(number, value ? 1 : 0);
}

function doubleField(number, value) {
  const data = Buffer.allocUnsafe(8);
  data.writeDoubleLE(Number(value), 0);
  return Buffer.concat([fieldKey(number, 1), data]);
}

function concatFields(fields) {
  return Buffer.concat(fields.filter((field) => Buffer.isBuffer(field) && field.length));
}

function readVarint(buffer, offset = 0) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length && shift < 70n) {
    const byte = BigInt(buffer[cursor++]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value, offset: cursor };
    shift += 7n;
  }
  throw new Error('invalid protobuf varint');
}

function decodeFields(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const number = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (!number) throw new Error('invalid protobuf field number');
    if (wireType === 0) {
      const decoded = readVarint(buffer, offset);
      fields.push({ number, wireType, value: decoded.value });
      offset = decoded.offset;
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error('truncated protobuf fixed64');
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > buffer.length) throw new Error('truncated protobuf bytes');
      fields.push({ number, wireType, value: buffer.subarray(offset, end) });
      offset = end;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error('truncated protobuf fixed32');
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type: ${wireType}`);
    }
  }
  return fields;
}

function firstField(fields, number, wireType) {
  return fields.find((field) => field.number === number && (wireType === undefined || field.wireType === wireType));
}

function stringValue(field) {
  return field?.wireType === 2 ? field.value.toString('utf8') : '';
}

// google.protobuf.Value / Struct / ListValue. Robin uses these for client
// function arguments and results, so keep them transport-neutral JSON here.
function protoValue(value) {
  if (value === null || value === undefined) return intField(1, 0);
  if (typeof value === 'number') return doubleField(2, value);
  // Value is a oneof: an explicitly empty string is different from no kind.
  if (typeof value === 'string') return bytesField(3, Buffer.from(value));
  if (typeof value === 'boolean') return boolField(4, value);
  if (Array.isArray(value)) {
    return messageField(6, concatFields(value.map((item) => messageField(1, protoValue(item)))));
  }
  if (typeof value === 'object') return messageField(5, protoStruct(value));
  return stringField(3, String(value));
}

function protoStruct(value) {
  const fields = [];
  for (const [key, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    fields.push(messageField(1, concatFields([
      stringField(1, key),
      messageField(2, protoValue(item))
    ])));
  }
  return concatFields(fields);
}

function decodeProtoValue(input) {
  const fields = decodeFields(input);
  const selected = fields.find((field) => field.number >= 1 && field.number <= 6);
  if (!selected) return null;
  if (selected.number === 1) return null;
  if (selected.number === 2 && selected.wireType === 1) return selected.value.readDoubleLE(0);
  if (selected.number === 3 && selected.wireType === 2) return selected.value.toString('utf8');
  if (selected.number === 4 && selected.wireType === 0) return selected.value !== 0n;
  if (selected.number === 5 && selected.wireType === 2) return decodeProtoStruct(selected.value);
  if (selected.number === 6 && selected.wireType === 2) {
    return decodeFields(selected.value)
      .filter((field) => field.number === 1 && field.wireType === 2)
      .map((field) => decodeProtoValue(field.value));
  }
  return null;
}

function decodeProtoStruct(input) {
  const output = {};
  for (const field of decodeFields(input)) {
    if (field.number !== 1 || field.wireType !== 2) continue;
    const entry = decodeFields(field.value);
    const key = stringValue(firstField(entry, 1, 2));
    const value = firstField(entry, 2, 2);
    if (value) Object.defineProperty(output, key, {
      value: decodeProtoValue(value.value), enumerable: true, configurable: true, writable: true
    });
  }
  return output;
}

function grpcFrame(message, { compressed = false } = {}) {
  const data = Buffer.isBuffer(message) ? message : Buffer.from(message || '');
  const header = Buffer.alloc(5);
  header[0] = compressed ? 1 : 0;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

class GrpcFrameDecoder {
  constructor({ maxFrameBytes = 64 * 1024 * 1024 } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];
    while (this.buffer.length >= 5) {
      if (this.buffer[0] > 1) throw new Error('invalid gRPC compression flag');
      const compressed = this.buffer[0] === 1;
      const length = this.buffer.readUInt32BE(1);
      if (length > this.maxFrameBytes) throw new Error('gRPC frame exceeds size limit');
      if (this.buffer.length < length + 5) break;
      messages.push({ compressed, data: this.buffer.subarray(5, length + 5) });
      this.buffer = this.buffer.subarray(length + 5);
    }
    return messages;
  }

  finish() {
    if (this.buffer.length) throw new Error('truncated gRPC frame');
  }
}

module.exports = {
  GrpcFrameDecoder,
  boolField,
  bytesField,
  concatFields,
  decodeProtoStruct,
  decodeProtoValue,
  decodeFields,
  doubleField,
  fieldKey,
  firstField,
  grpcFrame,
  intField,
  messageField,
  protoStruct,
  protoValue,
  readVarint,
  stringField,
  stringValue,
  varint
};
