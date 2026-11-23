'use strict';

const Ajv = require('ajv');
const Ajv2019 = require('ajv/dist/2019');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const CACHE_CAPACITY = 256;
const CACHE_BYTES = 8 * 1024 * 1024;
const CONTEXT_LIMIT = 4;
const CONTEXT_CAPACITY = CACHE_CAPACITY / CONTEXT_LIMIT;
const CONTEXT_BYTES = CACHE_BYTES / CONTEXT_LIMIT;
let cacheBytes = 0;
const cache = new Map();
const contexts = new Set();
const currentContexts = new Map();

class SchemaContractError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'SchemaContractError';
    this.code = 'invalid_tool_schema';
    this.status = 400;
  }
}

function assertSchemaDepth(value, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaContractError('JSON Schema 嵌套超过支持深度。');
  if (!value || typeof value !== 'object') return;
  // Limit the entire JSON structure, including const/enum/default data, even
  // when the root explicitly declares its dialect.
  for (const child of Object.values(value)) assertSchemaDepth(child, depth + 1);
}

function dialectFor(schema) {
  const declared = schema && typeof schema === 'object' ? schema.$schema : '';
  if (declared) {
    if (/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(declared)) return '07';
    if (/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/.test(declared)) return '2019';
    if (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(declared)) return '2020';
    throw new SchemaContractError('不支持此 JSON Schema 版本，请使用 draft-07、2019-09 或 2020-12。');
  }
  // Clients frequently omit $schema. Inspect only schema locations: names in
  // property/definition maps and arbitrary const/enum/annotation data are not
  // vocabulary. Keep tuple and unevaluated-property semantics unchanged.
  let dialect = '07';
  const singleSchemas = ['additionalProperties', 'additionalItems', 'unevaluatedProperties',
    'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema'];
  const schemaMaps = ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas', 'dependencies'];
  const schemaArrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
  function visit(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Object.hasOwn(value, 'prefixItems') || Object.hasOwn(value, '$dynamicRef')
        || Object.hasOwn(value, '$dynamicAnchor')) dialect = '2020';
    else if (dialect === '07' && ['$recursiveRef', '$recursiveAnchor', 'dependentRequired',
      'dependentSchemas', 'unevaluatedProperties', 'unevaluatedItems', 'minContains', 'maxContains']
      .some(key => Object.hasOwn(value, key))) dialect = '2019';
    for (const key of singleSchemas) visit(value[key]);
    for (const key of schemaMaps) {
      const map = value[key];
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        // Array-valued draft-07 dependencies contain property names, not schemas.
        for (const child of Object.values(map)) visit(child);
      }
    }
    for (const key of schemaArrays) {
      if (Array.isArray(value[key])) for (const child of value[key]) visit(child);
    }
    if (Array.isArray(value.items)) for (const child of value.items) visit(child);
    else visit(value.items);
  }
  visit(schema);
  return dialect;
}

function createValidator(dialect) {
  const Constructor = dialect === '2020' ? Ajv2020 : dialect === '2019' ? Ajv2019 : Ajv;
  const validator = new Constructor({
    strict: false,
    strictNumbers: true,
    allErrors: false,
    ownProperties: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    addUsedSchema: false,
    logger: false
  });
  // Unknown application-specific formats remain annotations. Standard formats
  // are checked; no format, default, or coercion mutates a client's arguments.
  addFormats(validator);
  return validator;
}

function touchContext(context) {
  contexts.delete(context);
  contexts.add(context);
}

function retireContext(context) {
  // Ajv's code-generation scope retains every compiled schema and validator,
  // even after removeSchema(). Evict all entries sharing that scope together;
  // a surviving cached validator would otherwise keep the entire scope alive.
  for (const key of context.keys) {
    const entry = cache.get(key);
    if (entry?.context !== context) continue;
    cache.delete(key);
    cacheBytes -= entry.bytes;
  }
  context.keys.clear();
  contexts.delete(context);
  if (currentContexts.get(context.dialect) === context) currentContexts.delete(context.dialect);
  context.validator = null;
}

function compilationContext(dialect, bytes) {
  let context = currentContexts.get(dialect);
  if (!context || context.attempts >= CONTEXT_CAPACITY || context.bytes + bytes > CONTEXT_BYTES) {
    while (contexts.size >= CONTEXT_LIMIT) retireContext(contexts.values().next().value);
    context = { dialect, validator: createValidator(dialect), attempts: 0, bytes: 0, keys: new Set() };
    currentContexts.set(dialect, context);
    contexts.add(context);
  }
  // Failed compilation can also retain code-generation scope values. Charge
  // its attempt and source bytes before compiling, not only after success.
  context.attempts++;
  context.bytes += bytes;
  touchContext(context);
  return context;
}

function compileSchema(schema) {
  const source = schema === undefined ? true : schema;
  if (typeof source !== 'boolean' && (!source || typeof source !== 'object' || Array.isArray(source))) {
    throw new SchemaContractError('工具 Schema 必须是 JSON Schema 对象或布尔值。');
  }
  let serialized;
  try { serialized = JSON.stringify(source); }
  catch (cause) { throw new SchemaContractError('工具 Schema 不是可序列化的 JSON。', cause); }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_SCHEMA_BYTES) throw new SchemaContractError('工具 Schema 超过 1 MiB。');
  if (cache.has(serialized)) {
    const entry = cache.get(serialized);
    cache.delete(serialized);
    cache.set(serialized, entry);
    touchContext(entry.context);
    return entry.validate;
  }
  const copy = JSON.parse(serialized);
  assertSchemaDepth(copy);
  const dialect = dialectFor(copy);
  const context = compilationContext(dialect, bytes);
  const validator = context.validator;
  let result;
  try {
    result = validator.compile(copy);
  } catch (cause) {
    throw new SchemaContractError('工具 Schema 无效，或包含无法解析的引用。', cause);
  } finally {
    // Avoid Ajv's object cache as well as bounding its code-generation scope.
    if (copy && typeof copy === 'object') validator.removeSchema(copy);
  }
  cache.set(serialized, { validate: result, context, bytes });
  context.keys.add(serialized);
  cacheBytes += bytes;
  while (cache.size > CACHE_CAPACITY || cacheBytes > CACHE_BYTES) {
    retireContext(cache.values().next().value.context);
  }
  return result;
}

function validateSchema(value, schema) {
  try { return compileSchema(schema)(value) === true; }
  catch { return false; }
}

module.exports = { compileSchema, validateSchema, SchemaContractError,
  MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH };
