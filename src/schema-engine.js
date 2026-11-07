'use strict';

const Ajv = require('ajv');
const Ajv2019 = require('ajv/dist/2019');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const CACHE_CAPACITY = 256;
const CACHE_BYTES = 8 * 1024 * 1024;
let cacheBytes = 0;
const cache = new Map();

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

const validators = new Map();

function compileSchema(schema) {
  const source = schema === undefined ? true : schema;
  if (typeof source !== 'boolean' && (!source || typeof source !== 'object' || Array.isArray(source))) {
    throw new SchemaContractError('工具 Schema 必须是 JSON Schema 对象或布尔值。');
  }
  let serialized;
  try { serialized = JSON.stringify(source); }
  catch (cause) { throw new SchemaContractError('工具 Schema 不是可序列化的 JSON。', cause); }
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) throw new SchemaContractError('工具 Schema 超过 1 MiB。');
  if (cache.has(serialized)) {
    const result = cache.get(serialized);
    cache.delete(serialized);
    cache.set(serialized, result);
    return result;
  }
  const copy = JSON.parse(serialized);
  assertSchemaDepth(copy);
  const dialect = dialectFor(copy);
  if (!validators.has(dialect)) validators.set(dialect, createValidator(dialect));
  const validator = validators.get(dialect);
  let result;
  try {
    result = validator.compile(copy);
  } catch (cause) {
    throw new SchemaContractError('工具 Schema 无效，或包含无法解析的引用。', cause);
  } finally {
    // Ajv's internal object cache must not grow outside our bounded LRU.
    if (copy && typeof copy === 'object') validator.removeSchema(copy);
  }
  cache.set(serialized, result);
  cacheBytes += Buffer.byteLength(serialized);
  while (cache.size > CACHE_CAPACITY || cacheBytes > CACHE_BYTES) {
    const first = cache.keys().next().value;
    cacheBytes -= Buffer.byteLength(first); cache.delete(first);
  }
  return result;
}

function validateSchema(value, schema) {
  try { return compileSchema(schema)(value) === true; }
  catch { return false; }
}

module.exports = { compileSchema, validateSchema, SchemaContractError,
  MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH };
