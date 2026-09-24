'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TOOL_NARRATION_INSTRUCTION,
  toolNarrationEnabled,
  toolNarrationInstruction,
} = require('../src/protocol');
const { buildDirectRequest } = require('../src/direct-provider');

const ENV = 'ANTIGRAVITY_GATEWAY_TOOL_NARRATION';

/** Run one assertion body with the narration switch set to `value`. */
function withSwitch(value, run) {
  const previous = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

function normalized(overrides = {}) {
  return {
    protocol: 'chat',
    model: 'gemini-test-high',
    system: 'CLIENT_SYSTEM_SENTINEL',
    messages: [{ role: 'user', text: 'hi', parts: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'bash', description: 'run a command', schema: { type: 'object', properties: {} } }],
    toolChoice: 'auto',
    generationConfig: null,
    stream: true,
    structuredSchema: null,
    autoMode: false,
    ...overrides,
  };
}

/** The system instruction the gateway would send upstream. */
function systemTextOf(request) {
  const built = buildDirectRequest(request, request.model, 'project-1', 'session-1');
  return (built.request.systemInstruction?.parts ?? []).map((part) => part.text).join('\n\n');
}

// These guard prompt content, not probabilistic model compliance.
test('the contract requires stage transitions without narrating every tool', () => {
  assert.match(TOOL_NARRATION_INSTRUCTION, /SAME overall objective/);
  assert.match(TOOL_NARRATION_INSTRUCTION, /MUST write a brief transition BEFORE its tool calls/);
  assert.match(TOOL_NARRATION_INSTRUCTION, /dependent calls across multiple tool-result rounds/);
  assert.match(TOOL_NARRATION_INSTRUCTION, /not a substitute for a short user-facing text transition/);
  assert.match(TOOL_NARRATION_INSTRUCTION, /During a long stage/);
  assert.doesNotMatch(TOOL_NARRATION_INSTRUCTION, /Speak again only when the objective is complete|Never call a tool silently/);
});

test('the narration switch is off unless explicitly enabled', () => {
  const enabled = [];
  const disabled = [];
  for (const value of ['1', 'true', 'TRUE', 'On', 'yes', 'enabled', ' 1 ']) {
    withSwitch(value, () => { if (toolNarrationEnabled()) enabled.push(value); });
  }
  for (const value of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) {
    withSwitch(value, () => { if (!toolNarrationEnabled()) disabled.push(String(value)); });
  }
  assert.equal(enabled.length, 7, `expected every truthy spelling to enable: ${enabled}`);
  assert.equal(disabled.length, 7, `expected every other value to stay off: ${disabled}`);
});

test('the narration contract needs a tool-bearing, unshaped request', () => {
  withSwitch('1', () => {
    assert.equal(toolNarrationInstruction(normalized()), TOOL_NARRATION_INSTRUCTION);
    assert.equal(toolNarrationInstruction(normalized({ tools: [] })), '');
    assert.equal(toolNarrationInstruction(normalized({ autoMode: true })), '');
    assert.equal(toolNarrationInstruction(normalized({ structuredSchema: { type: 'object' } })), '');
  });
  withSwitch('0', () => {
    assert.equal(toolNarrationInstruction(normalized()), '');
  });
});

test('an opted-in direct request carries the contract after the client system prompt', () => {
  withSwitch('1', () => {
    const text = systemTextOf(normalized());
    assert.ok(text.includes('CLIENT_SYSTEM_SENTINEL'), 'the client system prompt must survive');
    assert.ok(text.includes(TOOL_NARRATION_INSTRUCTION), 'the contract must be appended');
    assert.ok(
      text.indexOf('CLIENT_SYSTEM_SENTINEL') < text.indexOf(TOOL_NARRATION_INSTRUCTION),
      'the contract goes last so it stays the freshest instruction',
    );
  });
});

test('a disabled or toolless direct request is unchanged', () => {
  withSwitch('0', () => {
    assert.equal(systemTextOf(normalized()), 'CLIENT_SYSTEM_SENTINEL');
  });
  withSwitch('1', () => {
    assert.equal(systemTextOf(normalized({ tools: [] })), 'CLIENT_SYSTEM_SENTINEL');
  });
});

test('the contract can create a system instruction the client never sent', () => {
  withSwitch('1', () => {
    assert.equal(systemTextOf(normalized({ system: '' })), TOOL_NARRATION_INSTRUCTION);
  });
  withSwitch('0', () => {
    const built = buildDirectRequest(normalized({ system: '' }), 'gemini-test-high', 'project-1', 'session-1');
    assert.equal(built.request.systemInstruction, undefined);
  });
});
