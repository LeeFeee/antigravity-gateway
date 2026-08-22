'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  anthropicResponse,
  buildPrompt,
  finalizeModelResult,
  normalizeAnthropic,
  normalizeAutoMode,
  normalizeResponses,
  normalizeStructured,
  parseToolCalls,
  validateSchema
} = require('../src/protocol');

const shellTool = {
  name: 'shell',
  description: 'run a command',
  schema: {
    type: 'object',
    required: ['command'],
    properties: { command: { type: 'string' } },
    additionalProperties: false
  }
};

test('Anthropic content and tools become an isolated inference prompt', () => {
  const normalized = normalizeAnthropic({
    model: 'gemini-test-high',
    system: 'Be concise.',
    messages: [
      { role: 'user', content: 'Run pwd' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'shell', input: { command: 'pwd' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: '/tmp' }] }
    ],
    tools: [{ name: 'shell', description: 'run', input_schema: shellTool.schema }]
  });
  const prompt = buildPrompt(normalized);
  assert.match(prompt, /CLIENT_SYSTEM_BEGIN/);
  assert.match(prompt, /CLIENT_TOOL_RESULT id=old/);
  assert.match(prompt, /Do not use Antigravity built-in tools/);
  assert.match(prompt, /ANTIGRAVITY_GATEWAY_TOOL_CALLS/);
});

test('tool envelope is parsed only against the client whitelist and schema', () => {
  const calls = parseToolCalls(
    '<ANTIGRAVITY_GATEWAY_TOOL_CALLS>{"tool_calls":[{"name":"shell","arguments":{"command":"pwd"}}]}</ANTIGRAVITY_GATEWAY_TOOL_CALLS>',
    [shellTool]
  );
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].arguments.command, 'pwd');
  assert.match(calls[0].id, /^call_/);
  assert.throws(() => parseToolCalls('{"name":"unknown","arguments":{}}', [shellTool]), /未提供/);
  assert.throws(() => parseToolCalls('{"name":"shell","arguments":{}}', [shellTool]), /Schema/);
});

test('fenced single-call JSON is a controlled fallback for agy structured wrapping', () => {
  const calls = parseToolCalls('```json\n{"name":"shell","arguments":{"command":"pwd"}}\n```', [shellTool]);
  assert.equal(calls.length, 1);
});

test('Auto mode extracts XML and fails closed', () => {
  assert.equal(normalizeAutoMode('safe\n<block>no</block>'), '<block>no</block>');
  assert.equal(
    normalizeAutoMode('<block>yes</block><category>Risk</category><reason>why</reason>'),
    '<block>yes</block><category>Risk</category><reason>why</reason>'
  );
  assert.throws(() => normalizeAutoMode('probably safe'), /XML/);
});

test('structured JSON is extracted and validated', () => {
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false };
  assert.equal(normalizeStructured('```json\n{"ok":true}\n```', schema), '{"ok":true}');
  assert.throws(() => normalizeStructured('{"ok":"yes"}', schema), /JSON Schema/);
  assert.equal(validateSchema({ ok: false }, schema), true);
});

test('internal agy tools are never exposed as client tool calls', () => {
  const normalized = normalizeAnthropic({ messages: [{ role: 'user', content: 'hello' }] });
  assert.throws(() => finalizeModelResult(normalized, {
    text: 'done', usage: {}, internalToolUsed: true
  }), /自身工具/);
});

test('tool_choice none and required are enforced', () => {
  const toolText = '<ANTIGRAVITY_GATEWAY_TOOL_CALLS>{"tool_calls":[{"name":"shell","arguments":{"command":"pwd"}}]}</ANTIGRAVITY_GATEWAY_TOOL_CALLS>';
  assert.throws(() => finalizeModelResult({ tools: [shellTool], toolChoice: { type: 'none' } }, {
    text: toolText, usage: {}, internalToolUsed: false
  }), /tool_choice=none/);
  assert.throws(() => finalizeModelResult({ tools: [shellTool], toolChoice: { type: 'any' } }, {
    text: 'direct answer', usage: {}, internalToolUsed: false
  }), /tool_choice=required/);
});

test('Responses previous transcript is prepended without mutating it', () => {
  const previous = { system: 'S', messages: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'answer' }] };
  const normalized = normalizeResponses({ model: 'm', input: 'second' }, previous);
  assert.deepEqual(normalized.messages.map((item) => item.text), ['first', 'answer', 'second']);
  assert.equal(previous.messages.length, 2);
});

test('Anthropic response exposes external tools in native format', () => {
  const body = anthropicResponse('gemini-test-high', {
    text: '',
    toolCalls: [{ id: 'call_1', name: 'shell', arguments: { command: 'pwd' } }],
    usage: { input_tokens: 10, output_tokens: 2 }
  });
  assert.equal(body.stop_reason, 'tool_use');
  assert.deepEqual(body.content[0], { type: 'tool_use', id: 'call_1', name: 'shell', input: { command: 'pwd' } });
});
