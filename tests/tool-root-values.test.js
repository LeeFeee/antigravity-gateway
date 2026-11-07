'use strict';
require('./helpers/gateway-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeResponses, normalizeAnthropic, finalizeModelResult, responsesResponse } = require('../src/protocol');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { createServer } = require('../antigravity-gateway');
const { AccountPool } = require('../src/account-pool');

test('Responses JSON roots survive adapter, serialization, history echo and restart with declarations removed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-json-roots-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [i, value] of [null, false, 0, [1, 2], 'literal', '[1,2]', '{"business":true}', 'null', ''].entries()) {
    let sent, phase = 0;
    const create = () => new DirectAntigravityProvider({ accessToken: 'synthetic', projectId: 'synthetic', maxRetries: 0,
      baseUrl: 'https://synthetic.invalid', sessionStore: new AgySessionStore({ directory }),
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body);
        const declaration = sent.request.tools?.flatMap(t => t.functionDeclarations).find(d => d.name.endsWith('_json'));
        return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: phase++ === 0
          ? [{ thoughtSignature: 'synthetic-signature', functionCall: { id: `call-${i}`, name: declaration.name,
            args: { argumentsJson: JSON.stringify(value), toolSummary: 'Synthetic request' } } }]
          : [{ text: 'done' }] } }] }), { headers: { 'content-type': 'application/json' } });
      } });
    const first = normalizeResponses({ input: 'x', tools: [{ type: 'function', name: 'any_json', parameters: true }] });
    const raw = await create().send(first, 'gemini-3.8-flash-low', { sessionId: `root-${i}` });
    const result = finalizeModelResult(first, raw), body = responsesResponse('model', result, `resp-${i}`);
    assert.equal(body.output[0].arguments, JSON.stringify(value));
    const next = normalizeResponses({ input: [{ role: 'user', content: 'x' }, body.output[0],
      { type: 'function_call_output', call_id: `call-${i}`, output: 'ok' }] });
    assert.deepEqual(next.messages[1].parts[0].arguments, value);
    await create().send(next, 'gemini-3.8-flash-low', { sessionId: `root-${i}` });
    const call = sent.request.contents.flatMap(c => c.parts).find(p => p.functionCall);
    assert.equal(call.functionCall.args.argumentsJson, JSON.stringify(value));
    assert.equal(call.thoughtSignature, 'synthetic-signature');
  }
});

test('Messages rejects non-object root tool schemas before generation without changing Responses schemas', () => {
  for (const schema of [{ type: 'array' }, { type: 'null' }, { type: ['object', 'string'] }, true, false]) {
    assert.throws(() => normalizeAnthropic({ messages: [], tools: [{ name: 'fixture', input_schema: schema }] }),
      error => error.code === 'invalid_tool_schema' && error.status === 400);
    assert.deepEqual(normalizeResponses({ input: 'x', tools: [{ type: 'function', name: 'fixture', parameters: schema }] }).tools[0].schema, schema);
  }
});

for (const protocol of ['messages', 'responses']) test(`${protocol}: impossible tool choices fail at HTTP ingress before account dispatch`, async t => {
  let calls = 0;
  t.mock.method(AccountPool.prototype, 'send', async () => { calls++; throw new Error('unexpected account dispatch'); });
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const choice of protocol === 'messages' ? [{ type: 'any' }, { type: 'tool', name: 'missing' }, { type: 'tool' }]
    : ['required', { type: 'function', name: 'missing' }, { type: 'function' }]) {
    const payload = { model: 'gemini-3.8-flash-low', tools: [], tool_choice: choice,
      ...(protocol === 'messages' ? { messages: [{ role: 'user', content: 'x' }], max_tokens: 100 } : { input: 'x' }) };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${protocol}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.type, 'invalid_tool_choice');
  }
  assert.equal(calls, 0);
});
