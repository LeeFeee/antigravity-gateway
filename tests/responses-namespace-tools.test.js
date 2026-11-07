'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { normalizeResponses, finalizeModelResult, responsesResponse } = require('../src/protocol');
const { prepareAntigravityTools, APPLY_PATCH_GRAMMAR } = require('../src/antigravity-tool-contract');
const { buildDirectRequest, DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const model = 'gemini-3.8-flash-high';
const fn = (name = 'read') => ({ type: 'function', name, description: 'Return a client-owned fixture.',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } });
const group = (name, tools = [fn()]) => ({ type: 'namespace', name, description: `Tools in ${name}.`, tools });
const input = [{ role: 'user', content: 'Use only the requested local fixture.' }];

test('actual Codex 0.164 declarations preserve all namespace leaves and the captured patch grammar', () => {
  for (const name of ['text-installation-metadata', 'text-gateway-catalog']) {
    const fixture = require(`./fixtures/codex-0.164.0-20261107/${name}.json`);
    const body = fixture.captures.find(item => item.method === 'POST').body;
    const normalized = normalizeResponses(body), adapter = prepareAntigravityTools(normalized);
    assert.equal(normalized.tools.length, name === 'text-gateway-catalog' ? 13 : 12);
    const namespace = body.tools.find(item => item.type === 'namespace');
    assert.deepEqual(normalized.tools.filter(tool => tool.namespace).map(tool => [tool.namespace, tool.clientName]),
      namespace.tools.map(tool => [namespace.name, tool.name]));
    assert.equal(adapter.records.length, normalized.tools.length);
    assert.match(adapter.instructions, /"namespace":"multi_agent_v1"/);
    if (name === 'text-gateway-catalog') assert.equal(body.tools.find(tool => tool.type === 'custom').format.definition, APPLY_PATCH_GRAMMAR);
  }
});

test('flat names, same-name namespace leaves and adversarial internal-prefix names remain distinct', () => {
  const first = normalizeResponses({ input, tools: [group('one')] }).tools[0].name;
  const raw = [fn(), fn('one.read'), fn(first), group('one'), group('two')];
  const normalized = normalizeResponses({ input, tools: raw, tool_choice: { type: 'function', namespace: 'two', name: 'read' } });
  assert.equal(new Set(normalized.tools.map(tool => tool.name)).size, 5);
  const reversed = normalizeResponses({ input, tools: [...raw].reverse() });
  assert.deepEqual([...normalized.tools.map(tool => tool.name)].sort(), reversed.tools.map(tool => tool.name).sort());
  const adapter = prepareAntigravityTools(normalized);
  const calls = normalized.tools.map((tool, index) => ({ id: `id-${index}`, name: tool.name, arguments: { value: `v-${index}` } }));
  const decoded = calls.map(call => adapter.toClient(adapter.toProvider(call)));
  assert.deepEqual(decoded, calls);
  const result = finalizeModelResult({ ...normalized, toolChoice: 'auto' }, { text: '', toolCalls: decoded });
  const output = responsesResponse(model, result, 'resp-ns').output;
  assert.deepEqual(output.map(call => [call.namespace ?? null, call.name]), [[null, 'read'], [null, 'one.read'], [null, first], ['one', 'read'], ['two', 'read']]);
  const replay = normalizeResponses({ input: output, tools: raw });
  assert.deepEqual(replay.messages.map(message => message.parts[0].name), calls.map(call => call.name));
  const wire = buildDirectRequest(normalized, model, 'project', 'session');
  assert.deepEqual(wire.request.toolConfig.functionCallingConfig.allowedFunctionNames,
    [adapter.toProviderName(normalized.tools.find(tool => tool.namespace === 'two').name)]);
});

test('namespaced custom patches return their original raw input and retain grammar validation', () => {
  const tools = [group('workspace', [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: APPLY_PATCH_GRAMMAR } }])];
  const normalized = normalizeResponses({ input, tools }), adapter = prepareAntigravityTools(normalized);
  const patch = '*** Begin Patch\n*** Add File: x.txt\n+界面🙂\n*** End Patch';
  const call = { id: 'patch', name: normalized.tools[0].name, kind: 'custom', input: patch, arguments: { input: patch } };
  const decoded = adapter.toClient(adapter.toProvider(call));
  const output = responsesResponse(model, finalizeModelResult(normalized, { text: '', toolCalls: [decoded] }), 'r').output[0];
  assert.equal(output.type, 'custom_tool_call'); assert.equal(output.name, 'apply_patch');
  assert.equal(output.namespace, 'workspace'); assert.equal(output.input, patch);
  assert.equal(normalizeResponses({ tools, input: [output] }).messages[0].parts[0].name, call.name);
  assert.throws(() => adapter.toProvider({ ...call, arguments: { input: 'invalid patch' }, input: 'invalid patch' }));
});

test('namespace validation rejects missing names, nested groups, conflicting ownership and duplicate leaves', () => {
  for (const tools of [
    [{ type: 'namespace', tools: [fn()] }], [{ type: 'namespace', name: 'one' }],
    [group('one', [group('two')])], [group('one', [{ ...fn(), namespace: 'two' }])],
    [group('one', [{ type: 'function', parameters: {} }])], [{ ...fn(), namespace: 1 }]
  ]) assert.throws(() => normalizeResponses({ tools, input }), { status: 400 });
  assert.throws(() => prepareAntigravityTools(normalizeResponses({ input, tools: [group('one'), group('one')] })), { status: 400 });
});

test('namespace calls and out-of-order receipts recover signed upstream history after provider restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-namespace-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tools = [group('one'), group('two')], normalized = normalizeResponses({ tools, input });
  const adapter = prepareAntigravityTools(normalized), requests = [];
  const firstParts = normalized.tools.map((tool, index) => {
    const call = adapter.toProvider({ id: `c${index}`, name: tool.name, arguments: { value: `fixture-${index}` } });
    return { functionCall: { id: call.id, name: call.name, args: call.arguments }, thoughtSignature: `signature-${index}` };
  });
  const replies = [firstParts, [{ text: 'done' }]];
  const send = messages => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'synthetic', projectId: 'p', maxRetries: 0,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:namespace-fixture' }) },
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ candidates: [{ content: { parts: replies.shift() } }] })); }
  }).send(normalizeResponses({ input: messages, tools }), model, { sessionId: 'namespace-fixture', nativeClientProfile: 'codex-exec-0.164.0' });
  const first = finalizeModelResult(normalized, await send(input));
  const output = responsesResponse(model, first, 'first').output;
  await send([...input, ...output, { type: 'function_call_output', call_id: 'c1', output: 'B' }, { type: 'function_call_output', call_id: 'c0', output: 'A' }]);
  assert.deepEqual(requests[1].request.contents[1].parts, firstParts);
  const receipts = requests[1].request.contents[2].parts.map(part => [part.functionResponse.id, part.functionResponse.name, part.functionResponse.response.output]);
  assert.deepEqual(receipts, [['c0', firstParts[0].functionCall.name, 'A'], ['c1', firstParts[1].functionCall.name, 'B']]);
});
