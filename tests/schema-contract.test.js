'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileSchema, validateSchema, MAX_SCHEMA_DEPTH } = require('../src/schema-contract');

test('preserves numeric and object enum/const values without string conversion', () => {
  assert.equal(validateSchema(2, { enum: [1, 2, 3] }), true);
  assert.equal(validateSchema('2', { enum: [1, 2, 3] }), false);
  assert.equal(validateSchema({ mode: 'exact', count: 0 }, { const: { mode: 'exact', count: 0 } }), true);
  assert.equal(validateSchema({ mode: 'exact', count: 1 }, { const: { mode: 'exact', count: 0 } }), false);
});

test('validates complete union branches, bounds, patterns and local references', () => {
  const schema = {
    $defs: { line: { type: 'integer', minimum: 1 } },
    oneOf: [
      { type: 'object', properties: { line: { $ref: '#/$defs/line' } }, required: ['line'], additionalProperties: false },
      { type: 'object', properties: { page: { type: 'string', pattern: '^p-[0-9]+$' } }, required: ['page'], additionalProperties: false }
    ]
  };
  assert.equal(validateSchema({ line: 5 }, schema), true);
  assert.equal(validateSchema({ page: 'p-2' }, schema), true);
  for (const value of [{ line: 0 }, { page: 'invalid' }, { line: 2, page: 'p-2' }, { line: '2' }]) {
    assert.equal(validateSchema(value, schema), false);
  }
});

test('enforces conditional, pattern and additional-property schemas', () => {
  const schema = { type: 'object', properties: { mode: { enum: ['read', 'write'] } },
    patternProperties: { '^flag_': { type: 'boolean' } },
    additionalProperties: { type: 'integer', minimum: 0 },
    if: { properties: { mode: { const: 'write' } }, required: ['mode'] },
    then: { required: ['count'] } };
  assert.equal(validateSchema({ mode: 'write', count: 1, flag_a: false }, schema), true);
  assert.equal(validateSchema({ mode: 'write' }, schema), false);
  assert.equal(validateSchema({ mode: 'read', count: -1 }, schema), false);
  assert.equal(validateSchema({ flag_a: 'false' }, schema), false);
});

test('keeps draft-07 tuple and 2020 prefixItems semantics', () => {
  const tuple07 = { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false };
  const tuple20 = { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false };
  for (const schema of [tuple07, tuple20]) {
    assert.equal(validateSchema(['value', 2], schema), true);
    assert.equal(validateSchema(['value', '2'], schema), false);
    assert.equal(validateSchema(['value', 2, 'extra'], schema), false);
  }
});

test('supports dependent and unevaluated constraints rather than silently dropping them', () => {
  const schema = { type: 'object', properties: { file: { type: 'string' }, offset: { type: 'integer' } },
    dependentRequired: { offset: ['file'] }, unevaluatedProperties: false };
  assert.equal(validateSchema({ file: 'a', offset: 0 }, schema), true);
  assert.equal(validateSchema({ offset: 0 }, schema), false);
  assert.equal(validateSchema({ file: 'a', surprise: true }, schema), false);
});

test('does not coerce, add defaults, remove fields or mutate schemas', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer', default: 1 } }, additionalProperties: false };
  const original = JSON.stringify(schema);
  const value = { count: '2', extra: 'keep' };
  assert.equal(validateSchema(value, schema), false);
  assert.deepEqual(value, { count: '2', extra: 'keep' });
  const empty = {};
  assert.equal(validateSchema(empty, schema), true);
  assert.deepEqual(empty, {});
  assert.equal(JSON.stringify(schema), original);
});

test('false, remote references and invalid schemas cannot pass validation', () => {
  assert.equal(validateSchema({}, false), false);
  assert.equal(validateSchema({}, true), true);
  assert.throws(() => compileSchema({ $ref: 'https://example.invalid/remote.json' }), { code: 'invalid_tool_schema' });
  assert.throws(() => compileSchema({ type: 'invented' }), { code: 'invalid_tool_schema' });
  assert.equal(validateSchema({}, { type: 'invented' }), false);
});

test('standard formats and numeric array constraints are enforced', () => {
  assert.equal(validateSchema('invalid', { type: 'string', format: 'date-time' }), false);
  assert.equal(validateSchema('2026-11-07T00:00:00Z', { type: 'string', format: 'date-time' }), true);
  const schema = { type: 'array', uniqueItems: true, contains: { type: 'number', multipleOf: 2 } };
  assert.equal(validateSchema([1, 4], schema), true);
  assert.equal(validateSchema([1, 1, 4], schema), false);
  assert.equal(validateSchema([1, 3], schema), false);
});

test('enforces the exact structural depth boundary with every supported explicit dialect', () => {
  for (const declared of [undefined, 'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
    function nestedSchema(depth) {
      let schema = true;
      for (let index = 0; index < depth; index++) schema = { not: schema };
      if (declared) schema.$schema = declared;
      return schema;
    }
    const allowed = nestedSchema(MAX_SCHEMA_DEPTH);
    const original = JSON.stringify(allowed);
    assert.equal(compileSchema(allowed)(null), true, declared || 'inferred draft-07');
    assert.equal(JSON.stringify(allowed), original);
    assert.throws(() => compileSchema(nestedSchema(MAX_SCHEMA_DEPTH + 1)),
      { code: 'invalid_tool_schema', status: 400, message: /嵌套超过支持深度/ });
  }
});

test('depth validation still covers literal data independently of dialect inference', () => {
  let value = null;
  for (let index = 0; index < MAX_SCHEMA_DEPTH - 1; index++) value = { next: value };
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', const: value };
  assert.equal(compileSchema(schema)(value), true);
  assert.throws(() => compileSchema({ ...schema, const: { next: value } }),
    { code: 'invalid_tool_schema', message: /嵌套超过支持深度/ });
});

test('business field and definition names do not upgrade draft-07 tuples', () => {
  const tuple = { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false };
  const schema = {
    type: 'object',
    properties: { prefixItems: tuple, $dynamicRef: { type: 'string' }, $dynamicAnchor: { type: 'string' },
      dependentSchemas: { type: 'string' }, unevaluatedProperties: { type: 'boolean' } },
    definitions: { prefixItems: { type: 'string' } },
    $defs: { $dynamicRef: { type: 'string' } },
    patternProperties: { '^prefixItems$': tuple },
    dependencies: { prefixItems: ['$dynamicRef'] },
    required: ['prefixItems'], additionalProperties: false
  };
  const original = JSON.stringify(schema);
  const validate = compileSchema(schema);
  assert.equal(validate({ prefixItems: ['value', 2], $dynamicRef: 'business data' }), true);
  assert.equal(validate({ prefixItems: ['value', '2'], $dynamicRef: 'business data' }), false);
  assert.equal(validate({ prefixItems: ['value', 2] }), false);
  assert.equal(JSON.stringify(schema), original);
});

test('literal and annotation objects never supply dialect keywords', () => {
  const literal = { prefixItems: [1], $dynamicRef: 'business data', $dynamicAnchor: 'label',
    dependentSchemas: {}, unevaluatedProperties: false };
  for (const keyword of ['const', 'enum', 'default', 'examples', 'x-client-metadata']) {
    const data = ['enum', 'examples'].includes(keyword) ? [literal] : literal;
    const schema = { type: 'array', items: [{ [keyword]: data }], additionalItems: false };
    const original = JSON.stringify(schema);
    const validate = compileSchema(schema);
    assert.equal(validate([structuredClone(literal)]), true, keyword);
    assert.equal(validate([literal, 'extra']), false, keyword);
    if (keyword === 'const' || keyword === 'enum') assert.equal(validate([{}]), false, keyword);
    assert.equal(JSON.stringify(schema), original);
  }
});

test('detects modern vocabulary inside real schema maps, arrays and single-schema positions', () => {
  const tuple = { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false };
  const valid = ['value', 2], invalid = ['value', '2'];
  const examples = [
    [{ type: 'object', properties: { slot: tuple } }, { slot: valid }, { slot: invalid }],
    [{ type: 'object', patternProperties: { '^slot$': tuple } }, { slot: valid }, { slot: invalid }],
    [{ definitions: { slot: tuple }, $ref: '#/definitions/slot' }, valid, invalid],
    [{ $defs: { slot: tuple }, $ref: '#/$defs/slot' }, valid, invalid],
    [{ allOf: [tuple] }, valid, invalid],
    [{ anyOf: [tuple, { type: 'null' }] }, valid, invalid],
    [{ oneOf: [tuple, { type: 'null' }] }, valid, invalid],
    [{ type: 'array', items: tuple }, [valid], [invalid]],
    [{ type: 'object', additionalProperties: tuple }, { slot: valid }, { slot: invalid }],
    [{ type: 'array', contains: tuple }, [valid], [invalid]],
    [{ not: { not: tuple } }, valid, invalid],
    [{ if: { type: 'array' }, then: tuple, else: false }, valid, invalid],
    [{ if: { type: 'null' }, then: false, else: tuple }, valid, invalid],
    [{ type: 'object', dependencies: { enabled: { properties: { slot: tuple } } } },
      { enabled: true, slot: valid }, { enabled: true, slot: invalid }],
    [{ type: 'object', dependentSchemas: { enabled: { properties: { slot: tuple } } } },
      { enabled: true, slot: valid }, { enabled: true, slot: invalid }],
    [{ type: 'object', properties: { slot: { type: 'object', dependentRequired: { offset: ['file'] } } } },
      { slot: { offset: 0, file: 'a' } }, { slot: { offset: 0 } }]
  ];
  for (const [schema, accepted, rejected] of examples) {
    const validate = compileSchema(schema);
    assert.equal(validate(accepted), true, JSON.stringify(schema));
    assert.equal(validate(rejected), false, JSON.stringify(schema));
  }
});

test('explicit draft-07 remains authoritative over newer optional vocabulary', () => {
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'array',
    prefixItems: [{ type: 'string' }], items: [{ type: 'integer' }], additionalItems: false };
  const validate = compileSchema(schema);
  assert.equal(validate([1]), true);
  assert.equal(validate(['one']), false);
  assert.equal(validate([1, 2]), false);
});
