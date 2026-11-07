'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { performance } = require('node:perf_hooks');
const { compileSchema, withAsyncSchemaBoundary, SchemaContractError, SchemaWorkerPool, compileSchemaAsync, validateSchemaAsync, closeSchemaWorkers, MAX_VALUE_BYTES } = require('../src/schema-contract');
const { normalizeResponsesAsync, finalizeModelResultAsync } = require('../src/protocol');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { newState } = require('../src/agy-session-state');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { createServer } = require('../antigravity-gateway');

test.after(closeSchemaWorkers);
const patternSchema = { type: 'object', properties: { value: { type: 'string', pattern: '^(a+)+$' } }, required: ['value'], additionalProperties: false };
const bomb = { value: 'a'.repeat(32) + '!' };

test('worker validation keeps full dialect, patternProperties, format and immutable value semantics', async t => {
  const pool = new SchemaWorkerPool(); t.after(() => pool.close());
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { when: { type: 'string', format: 'date-time' }, tuple: { type: 'array', prefixItems: [{ const: 'x' }, { type: 'integer' }], items: false } },
    patternProperties: { '^flag_': { type: 'boolean' } }, required: ['when', 'tuple'], additionalProperties: false };
  const validate = await compileSchemaAsync(schema, { pool });
  const value = { when: '2026-11-07T12:00:00Z', tuple: ['x', 4], flag_a: false }, before = structuredClone(value);
  assert.equal(await validate(value), true);
  assert.deepEqual(value, before);
  for (const changed of [{ ...value, when: 'invalid' }, { ...value, tuple: ['x', '4'] }, { ...value, flag_a: 'false' }, { ...value, extra: true }]) assert.equal(await validate(changed), false);
  assert.ok(validate.errors.length);
  assert.equal(await validateSchemaAsync({}, false, { pool }), false);
  await assert.rejects(compileSchemaAsync({ $ref: 'https://invalid.test/remote' }, { pool }), { code: 'invalid_tool_schema' });
});

test('runaway worker is terminated while a different schema request completes, then capacity recovers', async t => {
  const pool = new SchemaWorkerPool({ validateMs: 500 }); t.after(() => pool.close());
  const [bad, good] = await Promise.all([compileSchemaAsync(patternSchema, { pool }), compileSchemaAsync({ type: 'integer' }, { pool })]);
  let badFinished = false;
  const running = bad(bomb).then(() => assert.fail('backtracking input accepted'), error => { badFinished = true; assert.equal(error.code, 'schema_execution_timeout'); });
  assert.equal(await good(7), true);
  assert.equal(badFinished, false, 'ordinary request must complete while the runaway worker is still running');
  await running;
  assert.equal(await good(8), true);
  assert.ok(pool.slots.length <= 2);
});

test('cancellation, bounded queue, argument size and close release work without leaving runaway threads', async t => {
  const pool = new SchemaWorkerPool({ workers: 1, queue: 1, validateMs: 1000, queueMs: 80 }); t.after(() => pool.close());
  const controller = new AbortController();
  const bad = await compileSchemaAsync(patternSchema, { pool, signal: controller.signal });
  const running = assert.rejects(bad(bomb), { name: 'AbortError' });
  const queued = pool.execute('compile', '{}');
  const waiting = assert.rejects(queued, { code: 'schema_capacity_exceeded' });
  await assert.rejects(pool.execute('compile', '{}'), { code: 'schema_capacity_exceeded', status: 503 });
  await waiting;
  controller.abort(); await running;
  assert.equal(pool.queue.length, 0);
  assert.equal(pool.queuedBytes, 0);
  const good = await compileSchemaAsync({ type: 'string' }, { pool });
  await assert.rejects(good('x'.repeat(MAX_VALUE_BYTES)), { code: 'invalid_tool_schema' });
  assert.equal(await good('still works'), true);
  await pool.close();
  assert.equal(pool.slots.length, 0);
});

test('HTTP normalize, history, output tools, structured finish and search projection never run main-thread Ajv', async t => {
  // An accidental synchronous fallback anywhere in the actual production
  // converter/provider call chain fails the request instead of doing work.
  const engine = require('../src/schema-engine');
  let mainCompiles = 0;
  t.mock.method(engine, 'compileSchema', () => { mainCompiles++; throw new Error('main-thread compiler forbidden'); });
  const upstreamCalls = [];
  const mockedSend = t.mock.method(AccountPool.prototype, 'send', async (normalized, model, options) => {
    const provider = new DirectAntigravityProvider({ accessToken: 'synthetic', projectId: 'synthetic', maxRetries: 0,
      localAuth: { isConfigured: () => false, load: () => ({}) },
      fetchImpl: async (_url, request) => {
        const body = JSON.parse(request.body); upstreamCalls.push(body);
        const text = normalized.messages.map(message => message.text).join('\n');
        const declarations = body.request.tools?.flatMap(tool => tool.functionDeclarations) || [];
        let parts = [{ text: 'ordinary result' }];
        if (text.includes('tool-output')) {
          const declaration = declarations.find(tool => tool.name.endsWith('_json'));
          parts = [{ functionCall: { id: 'result-call', name: declaration.name,
            args: { argumentsJson: JSON.stringify({ when: '2026-11-07T12:00:00Z', flag_ok: true }), toolSummary: 'Fixture result' } } }];
        }
        if (text.includes('structured-output')) parts = [{ functionCall: { id: 'finish-call', name: 'finish', args: { value: 'aaa' } } }];
        return new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] }));
      } });
    return provider.sendInSession(normalized, model, options, newState('synthetic', 'test'), () => {});
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, payload) => {
    const response = await fetch(url + '/v1/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gemini-3.8-flash-high', ...payload }) });
    return { status: response.status, body: await response.json() };
  };
  const schema = { type: 'object', properties: { when: { type: 'string', format: 'date-time' } }, patternProperties: { '^flag_': { type: 'boolean' } }, required: ['when'], additionalProperties: false };
  const tool = { type: 'function', name: 'echo', parameters: schema };
  const output = await post('responses', { input: 'tool-output', tools: [tool] });
  assert.equal(output.status, 200); assert.equal(output.body.output.find(item => item.type === 'function_call').name, 'echo');
  const structured = await post('responses', { input: 'structured-output', text: { format: { type: 'json_schema', schema: patternSchema } } });
  assert.equal(structured.status, 200); assert.match(JSON.stringify(structured.body.output), /aaa/);
  const search = await post('messages', { messages: [{ role: 'user', content: 'ordinary request' }], max_tokens: 1024,
    tool_choice: { type: 'none' }, tools: [{ type: 'web_search_20250305', name: 'web_search' }, { name: 'echo', input_schema: schema }] });
  assert.equal(search.status, 200);
  // Warm normal input before measuring independent HTTP liveness. Its request
  // still declares a tool, so it must obtain the other worker, not skip schema.
  const normal = { input: 'ordinary request', tools: [tool], tool_choice: 'none' };
  assert.equal((await post('responses', normal)).status, 200);
  let started;
  const runningValidation = new Promise(resolve => { started = resolve; });
  const originalExecute = SchemaWorkerPool.prototype.execute;
  t.mock.method(SchemaWorkerPool.prototype, 'execute', function(operation, serializedSchema, value, options) {
    const result = originalExecute.call(this, operation, serializedSchema, value, options);
    if (operation === 'validate' && value?.includes('a'.repeat(32))) started();
    return result;
  });
  let finished = false;
  const bad = post('responses', { tools: [{ type: 'function', name: 'echo', parameters: patternSchema }], input: [
    { role: 'user', content: 'history' }, { type: 'function_call', call_id: 'old', name: 'echo', arguments: JSON.stringify(bomb) },
    { type: 'function_call_output', call_id: 'old', output: 'old receipt' }, { role: 'user', content: 'continue' }
  ] }).then(result => { finished = true; return result; });
  await runningValidation;
  const start = performance.now();
  const good = await post('responses', normal);
  assert.equal(good.status, 200);
  assert.equal(finished, false, 'the unrelated real HTTP request completes before the hostile one times out');
  assert.ok(performance.now() - start < 1000);
  const rejected = await bad;
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error.type, 'schema_execution_timeout');
  assert.equal(mainCompiles, 0);
  assert.equal(upstreamCalls.length, 5, 'hostile historical arguments never reach the mock upstream');
  mockedSend.mock.mockImplementation(async () => { compileSchema({ type: 'object' }); return { text: 'unsafe' }; });
  const forbidden = await post('responses', normal);
  assert.equal(forbidden.status, 500); assert.equal(forbidden.body.error.type, 'schema_sync_forbidden');
  assert.equal(mainCompiles, 0, 'HTTP boundary rejects a future accidental sync import before Ajv');
});


test('worker resource errors are conversion failures, never account cooldown or cross-account retry', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-schema-routing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  for (const email of ['one@example.test', 'two@example.test']) store.save({ email, accessToken: 'synthetic', refreshToken: 'synthetic' });
  let calls = 0, failure;
  const accountPool = new AccountPool({ store, providerFactory: () => ({
    listModels: async () => ['synthetic-model'], modelInfo: () => null,
    send: async () => { calls++; throw failure; }
  }) });
  t.after(() => accountPool.stop());
  for (const [code, status] of [['schema_execution_timeout', 400], ['schema_capacity_exceeded', 503], ['schema_worker_unavailable', 503]]) {
    failure = new SchemaContractError('Schema worker cannot finish.', undefined, { code, status });
    const before = calls;
    await assert.rejects(accountPool.send({}, 'synthetic-model'), error => error === failure);
    assert.equal(calls, before + 1);
    assert.ok(accountPool.status().every(item => item.state === 'available' && !item.cooldownUntil));
    assert.ok([...accountPool.entries.values()].every(entry => entry.modelCooldowns.size === 0));
  }
});

test('idle workers do not prevent a standalone client process from exiting', async () => {
  const script = "require('./src/schema-contract').compileSchemaAsync({type:'integer'}).then(async validate=>{if(!await validate(4)) process.exitCode=1;})";
  await promisify(execFile)(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), timeout: 5000 });
});


test('async-only request scope also prevents invoking an offline-compiled validator later', async () => {
  const validate = compileSchema({ type: 'object' });
  assert.equal(validate({}), true);
  await withAsyncSchemaBoundary(async () => {
    await Promise.resolve();
    assert.throws(() => compileSchema({ type: 'object' }), { code: 'schema_sync_forbidden' });
    assert.throws(() => validate({}), { code: 'schema_sync_forbidden' });
  });
  assert.equal(validate({}), true, 'offline callers outside the request remain isolated');
});
