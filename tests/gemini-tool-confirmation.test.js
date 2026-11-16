'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geminiToolConfirmation } = require('../src/gemini-tool-confirmation');
const { trailingGeminiToolResults } = require('../src/gemini-client-request');
const { geminiGenerationMessages } = require('../src/gemini-request-profile');
const { GatewayError } = require('../src/protocol');
const { isConversionError } = require('../src/conversion-errors');
const { messageField: m, stringField: s, intField: i, concatFields: c, field } = require('../src/gemini-wire');

// Sanitized structural fixture from Pi's actual 1.144.4.1467 upstream card.
// This tests decoding boundaries; it is not a live acceptance substitute.
function card({ name = 'write', args = { path: '/fixture/out.txt', content: 'sample' }, type = 4, allowAction, extra = [] } = {}) {
  const button = (label, action) => c([s(1, label), m(2, action || s(4, label))]);
  const confirmation = c([s(2, `Run ${name}?`), s(3, `Allow Gemini to run ${name} on your machine?`),
    m(7, button('允许', allowAction)), m(9, button('取消')), i(10, 1),
    m(12, c([s(1, 'terminal'), s(2, 'Details'), s(3, JSON.stringify(args))])), ...extra]);
  return c([s(1, 'rc_fixture'), m(5, m(1, m(24, m(1, c([
    m(2, s(1, 'http://googleusercontent.com/action_card_content/fixture')),
    m(154, confirmation), m(166, i(1, type))
  ]))))) ]);
}
const tools = new Map([['write', { name: 'write', inputSchema: { type: 'object' } }]]);

test('a typed native confirmation preserves exact declared tool arguments and both control choices', () => {
  const result = geminiToolConfirmation(card(), tools);
  assert.equal(result.name, 'write');
  assert.deepEqual(result.arguments, { path: '/fixture/out.txt', content: 'sample' });
  assert.equal(result.allowQuery, '允许');
  assert.equal(result.cancelQuery, '取消');
  assert.equal(result.responseId, 'rc_fixture');
});

test('unknown tools, non-client cards and side-effecting button actions cannot become executable calls', () => {
  for (const fixture of [card({ name: 'undeclared' }), card({ type: 2 }), card({ args: [] }),
    card({ allowAction: s(2, 'https://example.com/action') }), card({ extra: [s(17, 'remember permission')] })]) {
    assert.throws(() => geminiToolConfirmation(fixture, tools), error => error instanceof GatewayError
      && isConversionError(error) && error.code === 'gemini_tool_confirmation_unsupported');
  }
});

test('native confirmation control retains its exact parent and ACTION_BLOCKS source', () => {
  const model = { provider: 'gemini', upstreamId: 'argon', modeVariantId: 'argon', modeCategory: 8, thinkingLevel: 1, taskThinkingLevels: [1] };
  const [initial] = geminiGenerationMessages({ prompt: '允许', model, tools: true,
    confirmation: { conversationId: 'c_fixture', requestId: 'r_fixture', responseId: 'rc_fixture' } });
  const generate = field(field(field(initial, 1000, 2), 1001, 2), 1, 2);
  const ids = field(generate, 4, 2);
  assert.deepEqual([1, 2, 3].map(tag => field(ids, tag, 2).toString()), ['c_fixture', 'r_fixture', 'rc_fixture']);
  assert.equal(field(field(generate, 30, 2), 1, 0), 5n);
  assert.equal(field(generate, 45, 0), 1n);
});

test('parallel tool receipts preserve order across messages and flag accompanying context', () => {
  const normalized = { messages: [
    { parts: [{ type: 'text', text: 'original' }] },
    { parts: [{ type: 'tool_result', id: 'a' }, { type: 'tool_result', id: 'b' }] },
    { parts: [{ type: 'tool_result', id: 'c' }, { type: 'text', text: 'new instruction' }] }
  ] };
  const result = trailingGeminiToolResults(normalized);
  assert.deepEqual(result.results.map(value => value.id), ['a', 'b', 'c']);
  assert.deepEqual(result.additional, [{ type: 'text', text: 'new instruction' }]);
});
