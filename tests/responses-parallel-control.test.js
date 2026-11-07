'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeResponses, finalizeModelResult } = require('../src/protocol');
const { buildDirectRequest } = require('../src/direct-provider');
const tools = [{ type: 'function', name: 'client_read', parameters: {
  type: 'object', properties: { parallel_tool_calls: { type: 'boolean' } }, required: ['parallel_tool_calls'], additionalProperties: false
} }];
const call = id => ({ id, name: 'client_read', arguments: { parallel_tool_calls: true } });

test('Responses serial-tool control reaches the upstream instruction without modifying tool arguments or thinking', () => {
  const normalized = normalizeResponses({ model: 'gemini-3.8-flash-low', input: 'Read.', tools,
    parallel_tool_calls: false, reasoning: { effort: 'high' } });
  assert.equal(normalized.parallelToolCalls, false);
  const wire = buildDirectRequest(normalized, normalized.model, 'synthetic-project', 'synthetic-session');
  assert.match(wire.request.systemInstruction.parts[0].text, /at most one client tool call/);
  assert.equal(wire.request.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.deepEqual(normalized.tools[0].schema, tools[0].parameters);
  const result = finalizeModelResult(normalized, { text: '', finishReason: 'STOP', toolCalls: [call('one')] });
  assert.deepEqual(result.toolCalls[0].arguments, { parallel_tool_calls: true });
  assert.throws(() => finalizeModelResult(normalized, { text: '', finishReason: 'STOP', toolCalls: [call('one'), call('two')] }),
    { code: 'invalid_tool_choice', status: 502 });
});

test('explicit parallel permission and the existing default still allow multiple independent calls', () => {
  for (const value of [true, undefined]) {
    const normalized = normalizeResponses({ input: 'Read.', tools, ...(value === undefined ? {} : { parallel_tool_calls: value }) });
    assert.equal(finalizeModelResult(normalized, { text: '', finishReason: 'STOP', toolCalls: [call('one'), call('two')] }).toolCalls.length, 2);
  }
  assert.throws(() => normalizeResponses({ input: 'Read.', parallel_tool_calls: 'false' }), { status: 400 });
});
