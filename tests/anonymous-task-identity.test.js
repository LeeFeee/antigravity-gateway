'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionManager } = require('../src/session-manager');
const { normalizeAnthropic } = require('../src/protocol');
const payload = { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: '读取当前目录的笔记。' }] };
const req = (extra = {}) => ({ headers: { authorization: 'Bearer synthetic-key',
  'user-agent': 'pi/1.5.0', ...extra }, socket: { remoteAddress: '127.0.0.1' } });

test('anonymous full-history API requests keep deterministic affinity without claiming saved conversation ownership', () => {
  const manager = new SessionManager(), input = normalizeAnthropic(payload);
  const first = manager.resolveIdentity(req(), payload, input);
  const second = manager.resolveIdentity(req(), payload, input);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.routingKey, second.routingKey);
  assert.equal(first.reuseConversation, false);
  const other = manager.resolveIdentity(req({ authorization: 'Bearer other-key' }), payload, input);
  assert.notEqual(other.clientId, first.clientId);
  assert.notEqual(other.sessionId, first.sessionId);
  const continued = manager.resolveIdentity(req(), {}, { messages: [] }, first);
  assert.equal(continued.sessionId, first.sessionId);
  assert.equal(continued.routingKey, first.routingKey);
  assert.equal(continued.reuseConversation, true);
});

test('Pi-compatible session_id is a conversation, while x-session-affinity alone only shares affinity', () => {
  const manager = new SessionManager(), input = normalizeAnthropic(payload);
  const headers = { session_id: 'pi-session', 'x-session-affinity': 'parent-affinity' };
  const a = manager.resolveIdentity(req(headers), payload, input);
  const again = manager.resolveIdentity(req(headers), payload, input);
  const b = manager.resolveIdentity(req({ ...headers, session_id: 'other-session' }), payload, input);
  assert.equal(a.sessionId, again.sessionId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.routingKey, b.routingKey);
  assert.equal(a.reuseConversation, true);
  const weak = manager.resolveIdentity(req({ 'x-session-affinity': 'parent-affinity' }), payload, input);
  assert.notEqual(weak.sessionId, a.sessionId);
  assert.equal(weak.routingKey, a.routingKey);
  assert.equal(weak.reuseConversation, false);
});

test('both HTTP protocols isolate concurrent client sessions and retain each tool owner', async t => {
  require('./helpers/gateway-environment');
  const { AccountPool } = require('../src/account-pool');
  const { createServer } = require('../antigravity-gateway');
  const calls = [];
  t.mock.method(AccountPool.prototype, 'send', async (input, model, options) => {
    const toolCallId = 'call-' + (calls.length + 1);
    calls.push({ input, model, options, toolCallId });
    const result = input.messages.flatMap(message => message.parts).find(part => part.type === 'tool_result');
    return result ? { text: result.content, toolCalls: [], usage: {} }
      : { text: '', toolCalls: [{ id: toolCallId, name: 'read_note', arguments: {} }], usage: {} };
  });
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port, model = 'gemini-3.8-flash-high';
  const schema = { type: 'object', properties: {} }, initial = [{ role: 'user', content: '读取笔记。' }];
  for (const protocol of ['messages', 'responses']) {
    const tools = protocol === 'messages' ? [{ name: 'read_note', input_schema: schema }]
      : [{ type: 'function', name: 'read_note', parameters: schema }];
    const post = async (index, payload) => {
      const response = await fetch(base + '/v1/' + protocol, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer synthetic-client',
        'x-client-id': 'pi', 'x-session-id': protocol + '-' + index
      }, body: JSON.stringify({ model, tools, ...payload }) });
      assert.equal(response.status, 200); return response.json();
    };
    const first = await Promise.all([0, 1].map(index => post(index, protocol === 'messages' ? { messages: initial } : { input: initial })));
    const owners = calls.slice(-2).map(call => call.options.sessionId);
    const ownerByToolCall = new Map(calls.slice(-2).map(call => [call.toolCallId, call.options.sessionId]));
    assert.notEqual(owners[0], owners[1]);
    const replies = await Promise.all(first.map((reply, index) => post(index, protocol === 'messages'
      ? { messages: [...initial, { role: 'assistant', content: reply.content }, { role: 'user', content: [{ type: 'tool_result',
          tool_use_id: reply.content.find(block => block.type === 'tool_use').id, content: 'result-' + index }] }] }
      : { previous_response_id: reply.id, input: [{ type: 'function_call_output',
          call_id: reply.output.find(item => item.type === 'function_call').call_id, output: 'result-' + index }] })));
    // Concurrent requests may finish schema validation in either order.
    // Verify the actual tool call's owner, not incidental arrival order.
    for (const call of calls.slice(-2)) {
      const receipt = call.input.messages.flatMap(message => message.parts).find(part => part.type === 'tool_result');
      assert.ok(ownerByToolCall.has(receipt.id));
      assert.equal(call.options.sessionId, ownerByToolCall.get(receipt.id));
    }
    assert.deepEqual(calls.slice(-2).map(call => call.options.sessionId).sort(), owners.slice().sort());
    assert.deepEqual(replies.map(reply => protocol === 'messages'
      ? reply.content.find(block => block.type === 'text').text
      : reply.output.find(item => item.type === 'message').content[0].text), ['result-0', 'result-1']);
  }
});
