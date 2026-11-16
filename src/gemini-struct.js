'use strict';

const { varint, messageField: m, stringField: s, intField: i, boolField: b,
  concatFields: c, decodeFields, field } = require('./gemini-wire');

// google.protobuf.Struct/Value/ListValue used by the captured MCP arguments
// and results. Preserve JSON keys verbatim, including __proto__, without
// allowing keys to mutate JS prototypes. Reject lossy non-JSON values.
function context(options = {}) {
  const maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 100000;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new RangeError('Invalid Gemini Struct limits');
  return { maxDepth, maxNodes, nodes: 0, active: new Set() };
}
function enter(state, depth) {
  if (depth > state.maxDepth || ++state.nodes > state.maxNodes) throw new RangeError('Gemini Struct exceeds nesting or value limit');
}

function encodeValue(value, state, depth) {
  enter(state, depth);
  if (value === null) return i(1, 0);
  if (typeof value === 'boolean') return b(4, value);
  if (typeof value === 'string') return s(3, value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Gemini Struct numbers must be finite');
    const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value);
    return c([varint(17), bytes]);
  }
  if (typeof value !== 'object') throw new TypeError('Gemini Struct requires JSON values');
  if (state.active.has(value)) throw new TypeError('Cyclic Gemini Struct value');
  state.active.add(value);
  try {
    if (Array.isArray(value)) return m(6, c(Array.from(value, item => m(1, encodeValue(item, state, depth + 1)))));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Gemini Struct requires plain JSON objects');
    return m(5, c(Object.entries(value).map(([key, item]) => m(1, c([s(1, key), m(2, encodeValue(item, state, depth + 1))])))));
  } finally { state.active.delete(value); }
}

function decodeValue(bytes, state, depth) {
  enter(state, depth);
  const fields = decodeFields(bytes);
  const wire = { 1: 0, 2: 1, 3: 2, 4: 0, 5: 2, 6: 2 };
  const selected = fields.findLast(item => wire[item.number] === item.wireType);
  if (!selected) throw new Error('Gemini protobuf Value has no kind');
  if (selected.number === 1) return null;
  if (selected.number === 2) {
    const value = selected.value.readDoubleLE();
    if (!Number.isFinite(value)) throw new TypeError('Non-finite Gemini Struct number');
    return value;
  }
  if (selected.number === 3) return selected.value.toString('utf8');
  if (selected.number === 4) return selected.value !== 0n;
  if (selected.number === 6) return decodeFields(selected.value).filter(item => item.number === 1 && item.wireType === 2)
    .map(item => decodeValue(item.value, state, depth + 1));
  const output = {};
  for (const item of decodeFields(selected.value)) {
    if (item.number !== 1 || item.wireType !== 2) continue;
    const entry = decodeFields(item.value), key = field(entry, 1, 2)?.toString('utf8') || '', value = field(entry, 2, 2);
    if (!value) throw new Error('Gemini Struct entry has no value');
    Object.defineProperty(output, key, { value: decodeValue(value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return output;
}

function encodeGeminiStruct(value, options) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Gemini Struct root must be an object');
  return field(encodeValue(value, context(options), 0), 5, 2);
}
function decodeGeminiStruct(bytes, options) { return decodeValue(m(5, bytes), context(options), 0); }

module.exports = { encodeGeminiStruct, decodeGeminiStruct };
