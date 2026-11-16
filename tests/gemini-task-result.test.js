'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { messageField: m, stringField: s, intField: i, concatFields: c, field } = require('../src/gemini-wire');
const { geminiTaskResult } = require('../src/gemini-task-result');

function savedTurn({ conversation = 'task-a', request = 'request-a', prompt = 'current prompt', final = false, failed = false } = {}) {
  return m(1, c([m(1, c([s(1, conversation), s(2, request)])), m(3, m(1, s(1, prompt))),
    m(4, c([m(1, c([s(1, 'response-a'), m(2, s(1, 'actual stored output'))])),
      i(10, final ? 1 : 0), i(16, failed ? 1 : 0), i(22, 8), i(23, 1), s(24, 'argon')]))]));
}
const selection = { conversationId: 'task-a', prompt: 'current prompt' };

test('Task readback rejects another conversation, turn, changed prompt and already consumed turns', () => {
  assert.equal(geminiTaskResult(savedTurn({ conversation: 'task-b' }), selection), null);
  assert.equal(geminiTaskResult(savedTurn(), { ...selection, requestId: 'request-b' }), null);
  assert.equal(geminiTaskResult(savedTurn({ prompt: 'earlier prompt' }), selection), null);
  assert.equal(geminiTaskResult(savedTurn(), { ...selection, excludedRequestIds: new Set(['request-a']) }), null);
});

test('Task readback preserves actual completion and model fields instead of inventing a final answer', () => {
  for (const final of [false, true]) {
    const selected = geminiTaskResult(savedTurn({ final }), selection);
    assert.equal(selected.requestId, 'request-a');
    const response = field(field(selected.message, 1003, 2), 1, 2);
    assert.equal(field(response, 9, 0), final ? 1n : 0n);
    assert.equal(field(response, 41, 0), 8n);
    assert.equal(field(response, 42, 0), 1n);
    assert.equal(field(response, 39, 2).toString(), 'argon');
    assert.equal(field(field(field(response, 1, 2), 2, 2), 1, 2).toString(), 'actual stored output');
  }
});

test('failed Task readback remains an error even when stored output exists', () => {
  assert.throws(() => geminiTaskResult(savedTurn({ final: true, failed: true }), selection),
    error => error.code === 'gemini_task_failed');
});
