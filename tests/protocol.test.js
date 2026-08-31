'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  anthropicResponse,
  buildPrompt,
  detectAutoModeFormat,
  finalizeModelResult,
  normalizeAnthropic,
  normalizeAutoMode,
  normalizeResponses,
  normalizeStructured,
  normalizeToolCalls,
  parseToolCalls,
  responsesResponse,
  validateSchema
} = require('../src/protocol');

test('Claude Code provider identity marker is neutralized without dropping system instructions', () => {
  const normalized = normalizeAnthropic({
    system: [
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      { type: 'text', text: 'Keep all project and permission instructions.' }
    ],
    messages: [{ role: 'user', content: 'hello' }]
  });
  assert.doesNotMatch(normalized.system, /Anthropic's Claude Agent SDK/);
  assert.match(normalized.system, /AI coding agent operating behind a protocol-compatible client/);
  assert.match(normalized.system, /Keep all project and permission instructions/);
});

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

test('native tool calls are normalized without a text envelope', () => {
  const calls = normalizeToolCalls([
    { id: 'call_native', name: 'shell', args: { command: 'pwd' }, thoughtSignature: 'sig-1' }
  ], [shellTool]);
  assert.deepEqual(calls, [{
    id: 'call_native', name: 'shell', arguments: { command: 'pwd' }, thoughtSignature: 'sig-1'
  }]);
  assert.deepEqual(
    normalizeAnthropic({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_native', name: 'shell', input: { command: 'pwd' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_native', content: '/tmp' }] }
      ]
    }).messages.map((message) => message.parts),
    [
      [{ type: 'tool_call', id: 'call_native', name: 'shell', arguments: { command: 'pwd' } }],
      [{ type: 'tool_result', id: 'call_native', content: '/tmp' }]
    ]
  );
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

test('current Claude Code Auto mode block contract is detected by grammar', () => {
  const system = [
    'You evaluate actions in Auto Mode.',
    '## Output Format',
    'If the action should be blocked: <block>yes</block><category>Risk</category><reason>why</reason>',
    'If the action should be allowed: <block>no</block>'
  ].join('\n');
  assert.equal(detectAutoModeFormat(system), 'block');
  const normalized = normalizeAnthropic({ system, messages: [{ role: 'user', content: 'classify' }] });
  assert.equal(normalized.autoMode, true);
  assert.equal(normalized.autoModeFormat, 'block');
  assert.match(buildPrompt(normalized), /beginning with <block>/);
});

test('current Claude Code Auto mode severity contract is detected and normalized', () => {
  const system = [
    'Auto Mode classification process. Grade harm only.',
    'The allow/block boundary is 50.',
    'Your ENTIRE response MUST begin with <severity>N</severity>.'
  ].join('\n');
  assert.equal(detectAutoModeFormat(system), 'severity');
  const normalized = normalizeAnthropic({ system, messages: [{ role: 'user', content: 'classify' }] });
  assert.equal(normalized.autoMode, true);
  assert.equal(normalized.autoModeFormat, 'severity');
  assert.match(buildPrompt(normalized), /beginning with <severity>/);
  assert.equal(normalizeAutoMode('analysis\n<severity>24</severity>', 'severity'), '<severity>24</severity>');
  assert.equal(
    normalizeAutoMode('<severity>87.5</severity><category>destructive</category>', 'severity'),
    '<severity>87.5</severity><category>destructive</category>'
  );
  assert.throws(() => normalizeAutoMode('<severity>101</severity>', 'severity'), /XML/);
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

test('Responses custom tools round-trip as custom_tool_call instead of function_call', () => {
  const normalized = normalizeResponses({
    model: 'm',
    input: 'edit a file',
    tools: [{
      type: 'custom', name: 'apply_patch', description: 'Apply a patch',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch"' }
    }]
  });
  assert.equal(normalized.tools[0].kind, 'custom');
  assert.deepEqual(normalized.tools[0].schema.required, ['input']);
  assert.match(normalized.tools[0].description, /\*\*\* Begin Patch/);
  assert.match(normalized.tools[0].description, /lark grammar/);
  const result = finalizeModelResult(normalized, {
    text: '', usage: {}, internalToolUsed: false,
    toolCalls: [{ id: 'call_patch', name: 'apply_patch', args: { input: '*** Begin Patch\n*** End Patch' } }]
  });
  assert.equal(result.toolCalls[0].kind, 'custom');
  const body = responsesResponse('m', result, 'resp_patch');
  assert.deepEqual(body.output[0], {
    id: body.output[0].id,
    type: 'custom_tool_call', status: 'completed', call_id: 'call_patch',
    name: 'apply_patch', input: '*** Begin Patch\n*** End Patch'
  });

  const continued = normalizeResponses({ input: [
    { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Success' }
  ] });
  assert.equal(continued.messages[0].parts[0].kind, 'custom');
  assert.equal(continued.messages[0].parts[0].arguments.input, '*** Begin Patch\n*** End Patch');
  assert.equal(continued.messages[1].parts[0].type, 'tool_result');
});

test('Anthropic response exposes external tools in native format', () => {
  const body = anthropicResponse('gemini-test-high', {
    text: '',
    toolCalls: [{ id: 'call_1', name: 'shell', arguments: { command: 'pwd' }, thoughtSignature: 'sig-1' }],
    usage: { input_tokens: 10, output_tokens: 2 }
  });
  assert.equal(body.stop_reason, 'tool_use');
  assert.deepEqual(body.content[0], { type: 'thinking', thinking: '', signature: 'sig-1' });
  assert.deepEqual(body.content[1], { type: 'tool_use', id: 'call_1', name: 'shell', input: { command: 'pwd' } });
  assert.deepEqual(
    normalizeAnthropic({ messages: [{ role: 'assistant', content: body.content }] }).messages[0].parts,
    [{ type: 'tool_call', id: 'call_1', name: 'shell', arguments: { command: 'pwd' }, thoughtSignature: 'sig-1' }]
  );
});
