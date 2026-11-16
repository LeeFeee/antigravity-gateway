'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareGeminiClientRequest, geminiClientToolResults, CLIENT_UPDATE_PREFIX } = require('../src/gemini-client-request');
const { encodeGeminiStruct, decodeGeminiStruct } = require('../src/gemini-struct');

test('tool continuation retains the complete latest client context separately from literal tool output', () => {
  const request = { system: 'User SOUL.\nThe following MCP servers failed to connect; their tools are unavailable.',
    messages: [{ role: 'user', text: 'Read the file.' },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'a', name: 'read', arguments: { path: '/fixture' } }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'a', content: 'literal\nfile\n' },
        { type: 'text', text: 'New user instruction, preserve me.' }] }],
    generationConfig: { maxOutputTokens: 2048 }, toolChoice: 'none',
    tools: [{ name: 'read', description: 'Read file', schema: { type: 'object' } }] };
  const before = JSON.stringify(request);
  const prepared = prepareGeminiClientRequest(request);
  const [receipt] = geminiClientToolResults([request.messages[2].parts[0]], prepared);
  const native = decodeGeminiStruct(encodeGeminiStruct(receipt.result));
  assert.deepEqual(native.content[0], { type: 'text', text: 'literal\nfile\n' });
  assert.equal(native.content[1].text, CLIENT_UPDATE_PREFIX + prepared.prompt);
  const context = JSON.parse(native.content[1].text.split('\n\nCLIENT_REQUEST_JSON\n')[1]);
  assert.equal(context.system, request.system);
  assert.deepEqual(context.messages[2].parts, request.messages[2].parts);
  assert.deepEqual(context.outputPreferences, request.generationConfig);
  assert.equal(context.tools[0].name, 'read');
  assert.equal(prepared.toolExecutionEnabled, false);
  assert.equal(JSON.stringify(request), before);
});

test('parallel receipt conversion preserves order and failure status without duplicating the full context', () => {
  const prepared = prepareGeminiClientRequest({ system: 'rules', messages: [] });
  const results = [{ id: 'a', content: 'first' }, { id: 'b', content: 'permission denied', isError: true }];
  const converted = geminiClientToolResults(results, prepared);
  assert.deepEqual(converted.map(value => value.id), ['a', 'b']);
  assert.equal(converted[0].result.content.length, 1);
  assert.equal(converted[1].result.content.length, 2);
  assert.equal(converted[1].result.content[0].text, 'permission denied');
  assert.equal(converted[1].result.isError, true);
});
