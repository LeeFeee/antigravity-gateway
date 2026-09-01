#!/usr/bin/env node
'use strict';

const readline = require('node:readline');

if (process.argv.includes('models')) {
  process.stdout.write('Fetching available models...\ngemini-test-high\tGemini Test High\ngemini-test-low\nclaude-opus-4-6-thinking\nclaude-sonnet-4-6\nnot a model\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9-test\n');
  process.exit(0);
}

let turn = 0;
const conversationId = 'conversation-test-1';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const event = JSON.parse(line);
  const content = event.message?.content || '';
  turn += 1;
  if (turn === 1) process.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: conversationId, init: { model: 'gemini-test-high' } })}\n`);
  if (content.includes('TIMEOUT')) return;
  if (content.includes('FAIL')) {
    process.stdout.write(`${JSON.stringify({ event: 'result', result: { conversation_id: conversationId, status: 'ERROR', error: 'simulated failure' } })}\n`);
    return;
  }
  const response = content.includes('RETURN_TOOL')
    ? '<ANTIGRAVITY_GATEWAY_TOOL_CALLS>{"tool_calls":[{"name":"shell","arguments":{"command":"pwd"}}]}</ANTIGRAVITY_GATEWAY_TOOL_CALLS>'
    : content.includes('CLAUDE_CODE_AUTO_MODE') || content.includes('AUTO_MODE_XML_REPAIR')
      ? 'Verdict: <block>no</block>'
      : `hello-${turn}`;
  const midpoint = Math.max(1, Math.floor(response.length / 2));
  process.stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'agent_response', state: 'ACTIVE', text_delta: response.slice(0, midpoint) } })}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'agent_response', state: 'DONE', text_delta: response.slice(midpoint) } })}\n`);
  if (content.includes('INTERNAL_TOOL')) {
    process.stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'tool', state: 'DONE', tool_info: { name: 'run_command' } } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'SUCCESS',
      response,
      usage: {
        input_tokens: turn * 100,
        output_tokens: turn * 10,
        thinking_tokens: turn * 2,
        cache_read_tokens: turn * 3,
        total_tokens: turn * 112
      }
    }
  })}\n`);
});
