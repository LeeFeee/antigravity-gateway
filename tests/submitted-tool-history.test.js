'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDirectRequest } = require('../src/direct-provider');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { newState, recordClientProjection } = require('../src/agy-session-state');

const model = 'gemini-3.8-flash-high';
const objectTool = { name: 'Read', description: 'Read a client file.', schema: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false
} };
function request(tools = [objectTool], args = { path: 'example.txt' }, result = 'file contents') {
  return { tools, messages: [{ role: 'user', parts: [{ type: 'text', text: 'Read the file.' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'read-1', name: 'Read', arguments: args }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'read-1', name: 'Read', content: result }] }] };
}
function convert(normalized, state = newState('new-account', 'existing-client-session')) {
  const native = { state, restoreStreamRecovery: false };
  const envelope = buildDirectRequest(normalized, model, 'project', 'existing-client-session', '', null, native);
  const parts = envelope.request.contents.flatMap(content => content.parts);
  return { native, state, envelope, call: parts.find(part => part.functionCall), receipt: parts.find(part => part.functionResponse) };
}

test('a new account translates submitted tool history without a local projection or changing the input', () => {
  const source = request(), before = JSON.stringify(source);
  const first = convert(source, newState('account-B', 'same-session'));
  const second = convert(source, newState('account-C', 'same-session'));
  for (const item of [first, second]) {
    const declarationNames = item.envelope.request.tools.flatMap(tool => tool.functionDeclarations.map(value => value.name));
    assert.ok(declarationNames.includes(item.call.functionCall.name));
    assert.equal(item.call.functionCall.name, item.receipt.functionResponse.name);
    assert.equal(item.call.functionCall.id, item.receipt.functionResponse.id);
    assert.equal(item.call.functionCall.args.path, 'example.txt');
    assert.deepEqual(item.receipt.functionResponse.response, { output: 'file contents' });
    assert.equal(item.call.thoughtSignature, undefined, 'No signature is invented');
    for (const group of ['responses', 'projections', 'streamProjections', 'streamRecoveries', 'toolStreamErrors', 'receiptTransforms']) {
      assert.equal(Object.keys(item.state[group] || {}).length, 0, `${group} is not a synthetic recovery record`);
    }
    assert.equal(item.native.context.sourceContents[1].parts[0].functionCall.name, 'Read');
  }
  assert.deepEqual(first.call, second.call);
  assert.deepEqual(first.receipt, second.receipt);
  assert.equal(JSON.stringify(source), before);
});

test('submitted signatures remain opaque caller data and are neither borrowed nor fabricated', () => {
  const source = request();
  source.messages[1].parts[0].thoughtSignature = 'signature-supplied-by-client';
  const { call } = convert(source);
  assert.equal(call.thoughtSignature, 'signature-supplied-by-client');
});

test('JSON root arguments and business fields survive compatibility history conversion', () => {
  const schema = {};
  for (const args of [null, false, 0, [1, 'x'], 'a literal', { toolSummary: 'business data', nested: { ok: true } }]) {
    const source = request([{ ...objectTool, schema }], args, { returned: args });
    const { call, receipt } = convert(source);
    assert.match(call.functionCall.name, /_json$/);
    assert.deepEqual(JSON.parse(call.functionCall.args.argumentsJson), args);
    assert.deepEqual(receipt.functionResponse.response, { output: { returned: args } });
  }
});

test('removed tools and changed schemas retain their actual submitted call/result', () => {
  for (const tools of [[], [{ ...objectTool, schema: { type: 'object', properties: { changed: { type: 'integer' } }, required: ['changed'], additionalProperties: false } }]]) {
    const source = request(tools), { call, receipt } = convert(source);
    assert.deepEqual(call.functionCall, { id: 'read-1', name: 'Read', args: { path: 'example.txt' } });
    assert.equal(receipt.functionResponse.name, 'Read');
    assert.deepEqual(receipt.functionResponse.response, { output: 'file contents' });
  }
});

test('an exact saved native projection keeps its issued view and signature', () => {
  const source = request(), state = newState('account-A', 'same-session');
  const prefix = [{ role: 'user', parts: [{ text: 'Read the file.' }] }];
  const visible = { role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'Read', args: { path: 'example.txt' } } }] };
  const issued = { role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'mcp_gateway_tool_1234567890abcdef',
    args: { path: 'example.txt', toolSummary: 'Actual issued metadata' } }, thoughtSignature: 'actual-issued-signature' }] };
  recordClientProjection(state, prefix, visible, model, [issued], Date.now(), { kind: 'client_tools' });
  const { call, receipt } = convert(source, state);
  assert.deepEqual(call, issued.parts[0]);
  assert.equal(receipt.functionResponse.name, issued.parts[0].functionCall.name);
});

for (const protocol of ['messages', 'responses']) for (const isError of [false, true]) {
  test(`${protocol}: error, image and structured tool references survive conversion without account history (${isError})`, () => {
    const definitions = [objectTool, { name: 'Target', description: 'Referenced tool.', schema: { type: 'object', properties: {} } }];
    const reference = { type: 'tool_reference', tool_name: 'Target' }, literal = JSON.stringify(reference);
    const encoded = Buffer.from('test-image').toString('base64');
    const blocks = [{ type: 'text', text: literal }, reference, protocol === 'messages'
      ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: encoded } }
      : { type: 'input_image', image_url: `data:image/png;base64,${encoded}` }];
    const normalized = protocol === 'messages' ? normalizeAnthropic({ model,
      tools: definitions.map(({ schema, ...tool }) => ({ ...tool, input_schema: schema })), messages: [
        { role: 'user', content: 'Read it.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'example.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: blocks, is_error: isError }] }
      ] }) : normalizeResponses({ model,
      tools: definitions.map(({ schema, ...tool }) => ({ type: 'function', ...tool, parameters: schema })), input: [
        { role: 'user', content: 'Read it.' },
        { type: 'function_call', call_id: 'read-1', name: 'Read', arguments: '{"path":"example.txt"}' },
        { type: 'function_call_output', call_id: 'read-1', output: blocks, is_error: isError }
      ] });
    const before = JSON.stringify(normalized), { native, call, receipt, state } = convert(normalized);
    const expected = [literal, ...native.toolAdapter.toProviderReferences([reference]).map(item => JSON.stringify(item))].join('\n');
    assert.equal(receipt.functionResponse.name, call.functionCall.name);
    assert.deepEqual(receipt.functionResponse.response, { [isError ? 'error' : 'output']: expected });
    assert.deepEqual(receipt.functionResponse.parts, [{ inlineData: { mimeType: 'image/png', data: encoded } }]);
    assert.equal(JSON.stringify(normalized), before);
    assert.equal(Object.keys(state.receiptTransforms || {}).length, 0);
  });
}

test('a removed referenced tool keeps the complete historical exchange unchanged', () => {
  const source = request();
  source.messages[2].parts[0] = { type: 'tool_result', id: 'read-1', name: 'Read',
    content: '{"type":"tool_reference","tool_name":"Removed"}', references: ['Removed'],
    resultSegments: [{ type: 'tool_reference', tool_name: 'Removed' }] };
  const { call, receipt } = convert(source);
  assert.equal(call.functionCall.name, 'Read');
  assert.equal(receipt.functionResponse.name, 'Read');
  assert.deepEqual(receipt.functionResponse.response.output, JSON.parse(source.messages[2].parts[0].content));
});
