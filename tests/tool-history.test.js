'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { trailingToolResultIds, hasToolResultHistory } = require('../src/tool-history');
const call = id => ({ role: 'assistant', parts: [{ type: 'tool_call', id, name: 'Read', arguments: { file: '/note' } }] });
const result = id => ({ role: 'user', parts: [{ type: 'tool_result', id, content: 'actual receipt' }] });
test('portable tool history validates order, roles, IDs and optional result names without changing data', () => {
  const history = { messages: [call('a'), call('b'), result('a'), result('b')] }, before = JSON.stringify(history);
  assert.deepEqual(trailingToolResultIds(history), ['b', 'a']);
  assert.equal(hasToolResultHistory(history), true);
  assert.equal(JSON.stringify(history), before);
  for (const messages of [
    [result('a')], [result('a'), call('a'), result('a')], [call('a'), call('a'), result('a')],
    [call('a'), result('a'), result('a')], [{ ...call('a'), role: 'user' }, result('a')],
    [call('a'), { ...result('a'), role: 'assistant' }],
    [call('a'), { role: 'user', parts: [{ ...result('a').parts[0], name: 'Write' }] }],
    [call('a'), result('a'), result('b')]
  ]) assert.equal(hasToolResultHistory({ messages }), false);
  assert.deepEqual(trailingToolResultIds({ messages: [...history.messages, { role: 'user', parts: [{ type: 'text', text: 'next task' }] }] }), []);
});
