'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAnthropic, normalizeResponses, finalizeModelResult, anthropicResponse, responsesResponse } = require('../src/protocol');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');
const { buildDirectRequest } = require('../src/direct-provider');
const model = 'gemini-3.8-flash-high';
const fields = ['explanation', 'toolSummary', 'toolAction', 'waitForPreviousTools'];
const values = ['', false, 0, { explanation: 'nested business value', toolSummary: '', toolAction: 0, waitForPreviousTools: false }];
const initial = { role: 'user', content: 'Preserve every declared business field.' };
const description = 'Accepts client-owned business fields without treating their names as metadata.';
function valueSchema(value) {
  if (value && typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, valueSchema(child)])), required: Object.keys(value), additionalProperties: false };
  return { type: Number.isInteger(value) ? 'integer' : typeof value };
}
const protocols = [
  {
    name: 'Messages', normalize: (name, schema, history = [initial]) => normalizeAnthropic({ tools: [{ name, description, input_schema: schema }], messages: history }),
    serialize: result => anthropicResponse(model, result),
    call(response) { const c = response.content.find(item => item.type === 'tool_use'); return { id: c.id, name: c.name, arguments: c.input }; },
    history: (response, id, output) => [initial, { role: 'assistant', content: response.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] }]
  },
  {
    name: 'Responses', normalize: (name, schema, history = [initial]) => normalizeResponses({ tools: [{ type: 'function', name, description, parameters: schema }], input: history }),
    serialize: result => responsesResponse(model, result, 'controlled-response'),
    call(response) { const c = response.output.find(item => item.type === 'function_call'); return { id: c.call_id, name: c.name, arguments: JSON.parse(c.arguments) }; },
    history: (response, id, output) => [initial, ...response.output, { type: 'function_call_output', call_id: id, output }]
  }
];

for (const protocol of protocols) for (const name of ['custom_business_tool', 'mcp__fixture__business_tool']) {
  test(`${protocol.name}: ${name} 业务元数据经过声明、调用、响应与历史往返不变`, () => {
    for (let rotation = 0; rotation < values.length; rotation++) {
      const args = Object.fromEntries(fields.map((field, index) => [field, structuredClone(values[(index + rotation) % values.length])]));
      const schema = valueSchema(args), normalized = protocol.normalize(name, schema), before = structuredClone(normalized);
      const adapter = prepareAntigravityTools(normalized), native = {}, wire = buildDirectRequest(normalized, model, 'controlled-project', 'controlled-session', '', null, native);
      assert.deepEqual(adapter.records[0].clientSchema, schema);
      assert.equal(adapter.records[0].views[0].mode, 'mcp-json', '业务 toolSummary 必须与外层元数据隔离');
      const declaration = wire.request.tools.flatMap(item => item.functionDeclarations)[0];
      assert.equal(declaration.name, adapter.toProviderName(name));
      assert.deepEqual(Object.keys(declaration.parameters.properties).sort(), ['argumentsJson', 'toolSummary']);
      const call = { id: `business-${rotation}`, name, arguments: args };
      const upstream = adapter.toProvider(call);
      for (const argumentsValue of [upstream.arguments, JSON.stringify(upstream.arguments)]) {
        const restored = adapter.toClient({ ...upstream, arguments: argumentsValue });
        const result = finalizeModelResult(normalized, { text: '', toolCalls: [restored], usage: {} });
        const response = protocol.serialize(result);
        assert.deepEqual(protocol.call(response), call);
        const history = protocol.normalize(name, schema, protocol.history(response, call.id, JSON.stringify(args)));
        const historyBefore = structuredClone(history), next = prepareAntigravityTools(history);
        const parts = history.messages.flatMap(message => message.parts || []);
        const historicalCall = parts.find(part => part.type === 'tool_call');
        assert.deepEqual(historicalCall.arguments, args);
        assert.deepEqual(next.toClient(next.toProvider(historicalCall)), historicalCall);
        const receipt = parts.find(part => part.type === 'tool_result');
        const nativeReceipt = next.toProviderResult(receipt, upstream);
        assert.equal(nativeReceipt.content, JSON.stringify(args));
        assert.deepEqual(JSON.parse(nativeReceipt.content), args);
        assert.deepEqual(history, historyBefore);
      }
      assert.deepEqual(normalized, before);
    }
  });
}

for (const name of ['Read', 'Bash', 'read_file']) {
  test(`${name}: 熟悉名字不授予旧原生语义，业务扩展字段及 false/0/空字符串保留`, () => {
    for (let index = 0; index < fields.length; index++) {
      const args = { value: 'controlled', [fields[index]]: values[index] }, schema = valueSchema(args);
      const normalized = protocols[0].normalize(name, schema), adapter = prepareAntigravityTools(normalized, { clientProfile: 'claude-code-2.1.285' });
      assert.ok(adapter.declarations.every(item => item.name.startsWith('mcp_')));
      const call = { name, arguments: args, thoughtSignature: 'unchanged' };
      assert.deepEqual(adapter.toClient(adapter.toProvider(call)), call);
      assert.deepEqual(adapter.records[0].clientSchema, schema);
    }
  });
}

test('只有声明所属 toolSummary 元数据被移除；其他历史保留字段不会被当成 transport 字段吞掉', () => {
  const schema = { type: 'object', properties: { explanation: { type: 'string' }, toolAction: { type: 'boolean' }, waitForPreviousTools: { type: 'integer' } }, required: ['explanation', 'toolAction', 'waitForPreviousTools'], additionalProperties: false };
  const adapter = prepareAntigravityTools(protocols[0].normalize('fixture', schema));
  const name = adapter.toProviderName('fixture');
  const args = { explanation: '', toolAction: false, waitForPreviousTools: 0 };
  assert.deepEqual(adapter.toClient({ name, arguments: { ...args, toolSummary: 'Controlled task' } }).arguments, args);
  assert.throws(() => adapter.toClient({ name, arguments: { ...args, toolSummary: 'Controlled task', unexpected: false } }));
  assert.throws(() => adapter.toClient({ name, arguments: { ...args, toolSummary: 'Controlled task', toolAction: 'false' } }));
});
