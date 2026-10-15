'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionManager } = require('../src/session-manager');
const { normalizeChat } = require('../src/protocol');
const { ARGON_MODEL } = require('../src/robin-provider');
const opts = { taskProvider: 'robin' };
const payload = { model: ARGON_MODEL, messages: [{ role: 'user', content: '读取当前目录的笔记。' }] };
const req = (extra = {}) => ({ headers: { authorization: 'Bearer synthetic-key',
  'user-agent': 'pi (darwin 24.6.0; arm64)', ...extra }, socket: { remoteAddress: '127.0.0.1' } });
const resultInput = (...ids) => ({ messages: [{ role: 'user', parts: ids.map(id =>
  ({ type: 'tool_result', id, content: 'private-result-must-not-be-stored' })) }] });

test('stateful anonymous tasks do not share an initial prompt identity, while stateless affinity stays unchanged', () => {
  const manager = new SessionManager(), input = normalizeChat(payload);
  const first = manager.resolveIdentity(req(), payload, input, null, opts);
  const second = manager.resolveIdentity(req(), payload, input, null, opts);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(first.routingKey, second.routingKey);
  assert.equal(first.clientId, second.clientId);
  assert.equal(first.reuseConversation, false);
  const cloudA = manager.resolveIdentity(req(), payload, input);
  const cloudB = manager.resolveIdentity(req(), payload, input);
  assert.equal(cloudA.sessionId, cloudB.sessionId, 'legacy Cloud Code request identity is preserved');
  assert.equal(cloudA.routingKey, first.routingKey);
});

test('anonymous client results recover only their own issued tool task and are not persisted as context', () => {
  const manager = new SessionManager(), input = normalizeChat(payload);
  const a = manager.resolveIdentity(req(), payload, input, null, opts);
  const b = manager.resolveIdentity(req(), payload, input, null, opts);
  manager.bindToolCalls(a, [{ id: 'call-a' }]);
  manager.bindToolCalls(b, [{ id: 'call-b' }]);
  const replyA = manager.resolveIdentity(req(), {}, resultInput('call-a'), null, opts);
  const replyB = manager.resolveIdentity(req(), {}, resultInput('call-b'), null, opts);
  assert.equal(replyA.sessionId, a.sessionId); assert.equal(replyA.routingKey, a.routingKey);
  assert.equal(replyB.sessionId, b.sessionId); assert.equal(replyB.routingKey, b.routingKey);
  assert.equal(replyA.reuseConversation, false);
  assert.doesNotMatch(JSON.stringify([...manager.toolBindings.values()]), /private-result-must-not-be-stored|读取/);
  manager.bindToolCalls(replyA, []);
  assert.throws(() => manager.resolveIdentity(req(), {}, resultInput('call-a'), null, opts), { code: 'tool_session_not_found' });
  assert.equal(manager.resolveIdentity(req(), {}, resultInput('call-b'), null, opts).sessionId, b.sessionId);
});

test('a shared prompt-cache hint is affinity, not evidence of one stateful conversation', () => {
  const manager = new SessionManager(), input = normalizeChat(payload);
  const hinted = { ...payload, prompt_cache_key: 'shared-prefix-cache' };
  const a = manager.resolveIdentity(req(), hinted, input, null, opts);
  const b = manager.resolveIdentity(req(), hinted, input, null, opts);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.routingKey, b.routingKey);
  assert.equal(a.reuseConversation, false);
  const explicit = manager.resolveIdentity(req(), { ...hinted, conversation_id: 'real-conversation' }, input, null, opts);
  assert.equal(explicit.reuseConversation, true);
  const other = manager.resolveIdentity(req(), { ...hinted, conversation_id: 'other-real-conversation' }, input, null, opts);
  assert.notEqual(explicit.sessionId, other.sessionId, 'a shared cache key never overrides a dedicated conversation ID');
});

test('Pi-compatible session_id is a conversation, while x-session-affinity alone only shares affinity', () => {
  const manager = new SessionManager(), input = normalizeChat(payload);
  const headers = { session_id: 'pi-session', 'x-session-affinity': 'parent-affinity' };
  const a = manager.resolveIdentity(req(headers), payload, input, null, opts);
  const again = manager.resolveIdentity(req(headers), payload, input, null, opts);
  const b = manager.resolveIdentity(req({ ...headers, session_id: 'other-session' }), payload, input, null, opts);
  assert.equal(a.sessionId, again.sessionId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.routingKey, b.routingKey);
  assert.equal(a.reuseConversation, true);
  const weak = manager.resolveIdentity(req({ 'x-session-affinity': 'parent-affinity' }), payload, input, null, opts);
  assert.notEqual(weak.sessionId, a.sessionId);
  assert.equal(weak.routingKey, a.routingKey);
  assert.equal(weak.reuseConversation, false);
});

test('expired anonymous tool bindings are removed from both lookup indexes', () => {
  const manager = new SessionManager(), input = normalizeChat(payload);
  const a = manager.resolveIdentity(req(), payload, input, null, opts);
  manager.bindToolCalls(a, [{ id: 'expired' }]);
  for (const binding of manager.toolBindings.values()) binding.at = Date.now() - manager.ttlMs - 1;
  assert.throws(() => manager.resolveIdentity(req(), {}, resultInput('expired'), null, opts), { code: 'tool_session_not_found' });
  assert.equal(manager.toolBindings.size, 0);
  assert.equal(manager.toolOwners.size, 0);
});

test('anonymous tool lookup rejects another credential, caller, provider or ambiguous and mixed task IDs', () => {
  const manager = new SessionManager(), input = normalizeChat(payload);
  const a = manager.resolveIdentity(req(), payload, input, null, opts);
  const b = manager.resolveIdentity(req(), payload, input, null, opts);
  manager.bindToolCalls(a, [{ id: 'shared' }, { id: 'only-a' }]);
  manager.bindToolCalls(b, [{ id: 'shared' }, { id: 'only-b' }]);
  assert.throws(() => manager.resolveIdentity(req(), {}, resultInput('shared'), null, opts), { code: 'tool_session_ambiguous' });
  assert.throws(() => manager.resolveIdentity(req(), {}, resultInput('only-a', 'only-b'), null, opts), { code: 'tool_session_ambiguous' });
  for (const other of [req({ authorization: 'Bearer other-key' }), req({ 'user-agent': 'other-agent' })]) {
    assert.throws(() => manager.resolveIdentity(other, {}, resultInput('only-a'), null, opts), { code: 'tool_session_not_found' });
  }
  assert.throws(() => manager.resolveIdentity(req(), {}, resultInput('only-a'), null, { taskProvider: 'other' }), { code: 'tool_session_not_found' });
});

test('explicit conversations and previous response chains retain priority; historic tool results do not identify a new turn', () => {
  const manager = new SessionManager(), input = normalizeChat(payload);
  const anonymous = manager.resolveIdentity(req(), payload, input, null, opts);
  manager.bindToolCalls(anonymous, [{ id: 'read-1' }]);
  const explicit = manager.resolveIdentity(req({ 'x-session-id': 'explicit' }), {}, resultInput('read-1'), null, opts);
  assert.notEqual(explicit.sessionId, anonymous.sessionId);
  assert.equal(explicit.reuseConversation, true);
  const previous = manager.resolveIdentity(req(), {}, resultInput('read-1'), anonymous, opts);
  assert.equal(previous.sessionId, anonymous.sessionId);
  assert.equal(previous.reuseConversation, true);
  const next = manager.resolveIdentity(req(), {}, { messages: [...resultInput('read-1').messages,
    { role: 'user', parts: [{ type: 'text', text: '下一项工作。' }] }] }, null, opts);
  assert.notEqual(next.sessionId, anonymous.sessionId);
});

test('anonymous tool bindings are capacity bounded and consumed only after a successful response', () => {
  const manager = new SessionManager({ capacity: 100 }), input = normalizeChat(payload);
  const first = manager.resolveIdentity(req(), payload, input, null, opts);
  manager.bindToolCalls(first, [{ id: 'oldest' }]);
  for (let i = 0; i < 100; i++) {
    const identity = manager.resolveIdentity(req(), payload, input, null, opts);
    manager.bindToolCalls(identity, [{ id: 'call-' + i }]);
  }
  assert.equal(manager.toolBindings.size, 100);
  assert.throws(() => manager.resolveIdentity(req(), {}, resultInput('oldest'), null, opts), { code: 'tool_session_not_found' });
  const resolved = manager.resolveIdentity(req(), {}, resultInput('call-99'), null, opts);
  assert.equal(manager.resolveIdentity(req(), {}, resultInput('call-99'), null, opts).sessionId, resolved.sessionId);
  manager.bindToolCalls(resolved, [{ id: 'follow-up' }]);
  assert.throws(() => manager.resolveIdentity(req(), {}, resultInput('call-99'), null, opts), { code: 'tool_session_not_found' });
  assert.equal(manager.resolveIdentity(req(), {}, resultInput('follow-up'), null, opts).sessionId, resolved.sessionId);
});

test('all three HTTP protocols isolate identical anonymous tasks and recover each real pool tool owner', async t => {
  const { directory } = require('./helpers/gateway-environment');
  const { AccountStore } = require('../src/account-store');
  const { RobinProvider } = require('../src/robin-provider');
  const { AccountPool } = require('../src/account-pool');
  const { createServer } = require('../antigravity-gateway');
  const { setTimeout: pause } = require('node:timers/promises');
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  store.save({ id: 'anonymous-test', accessToken: 'synthetic', providerType: 'robin',
    accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  t.after(() => store.delete('anonymous-test'));
  t.mock.method(AccountPool.prototype, 'listModels', async () => []);
  t.mock.method(RobinProvider.prototype, 'listModels', async () => [ARGON_MODEL]);
  const tasks = new Map(), calls = [];
  t.mock.method(RobinProvider.prototype, 'send', async (_input, _model, options) => {
    calls.push(options);
    await pause(15);
    const current = tasks.get(options.sessionId);
    if (current) {
      assert.equal(options.requireExistingTurn, true);
      const result = _input.messages.flatMap(message => message.parts).find(part =>
        part.type === 'tool_result' && part.id === current.id);
      assert.ok(result, 'each result stays on the task which issued it');
      tasks.delete(options.sessionId);
      return { text: result.content, toolCalls: [], usageKnown: false };
    }
    assert.equal(options.requireExistingTurn, false);
    const id = 'call-' + calls.length + '-' + tasks.size;
    tasks.set(options.sessionId, { id });
    return { text: '', toolCalls: [{ id, name: 'read_note', arguments: {} }], usageKnown: false };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const initial = [{ role: 'user', content: '读取当前目录的笔记。' }];
  const schema = { type: 'object', properties: {} };
  const cases = [
    { path: '/v1/chat/completions', first: { model: ARGON_MODEL, messages: initial,
      tools: [{ type: 'function', function: { name: 'read_note', parameters: schema } }] },
      continuation: (body, text) => ({ model: ARGON_MODEL, messages: [...initial, body.choices[0].message,
        { role: 'tool', tool_call_id: body.choices[0].message.tool_calls[0].id, content: text }],
        tools: [{ type: 'function', function: { name: 'read_note', parameters: schema } }] }),
      text: body => body.choices[0].message.content },
    { path: '/v1/messages', first: { model: ARGON_MODEL, max_tokens: 128, messages: initial,
      tools: [{ name: 'read_note', input_schema: schema }] },
      continuation: (body, text) => ({ model: ARGON_MODEL, max_tokens: 128, messages: [...initial,
        { role: 'assistant', content: body.content }, { role: 'user', content: [{
          type: 'tool_result', tool_use_id: body.content.find(item => item.type === 'tool_use').id, content: text
        }] }], tools: [{ name: 'read_note', input_schema: schema }] }),
      text: body => body.content.filter(item => item.type === 'text').map(item => item.text).join('') },
    { path: '/v1/responses', first: { model: ARGON_MODEL, input: initial,
      tools: [{ type: 'function', name: 'read_note', parameters: schema }] },
      continuation: (body, text) => ({ model: ARGON_MODEL, input: [{
        type: 'function_call_output', call_id: body.output.find(item => item.type === 'function_call').call_id, output: text
      }], tools: [{ type: 'function', name: 'read_note', parameters: schema }] }),
      text: body => body.output.filter(item => item.type === 'message').flatMap(item => item.content).map(item => item.text || '').join('') }
  ];
  for (const example of cases) {
    const post = async payload => {
      const response = await fetch(base + example.path, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer synthetic-pi-key', 'user-agent': 'pi'
      }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() };
    };
    const first = await Promise.all([post(example.first), post(example.first)]);
    assert.deepEqual(first.map(reply => reply.status), [200, 200], example.path);
    const pair = calls.slice(-2);
    assert.notEqual(pair[0].sessionId, pair[1].sessionId);
    const beforeReplies = calls.length;
    const replies = await Promise.all(first.map((reply, index) => post(example.continuation(reply.body, 'result-' + index))));
    assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
    assert.deepEqual(replies.map(reply => example.text(reply.body)), ['result-0', 'result-1']);
    assert.equal(calls.length, beforeReplies + 2);
    assert.deepEqual(new Set(calls.slice(-2).map(call => call.sessionId)), new Set(pair.map(call => call.sessionId)));
    assert.equal(tasks.size, 0);
    const replay = await post(example.continuation(first[0].body, 'must-not-be-replayed'));
    assert.equal(replay.status, 409);
    assert.equal(calls.length, beforeReplies + 2, 'lost or completed tools never start another upstream request');
    if (example.path === '/v1/responses') {
      const start = await post(example.first);
      const resumed = await post({ ...example.continuation(start.body, 'previous-response-result'), previous_response_id: start.body.id });
      assert.equal(resumed.status, 200);
      assert.equal(example.text(resumed.body), 'previous-response-result');
      assert.equal(calls.at(-1).sessionId, calls.at(-2).sessionId);
      assert.equal(calls.at(-1).reuseConversation, true);
      assert.equal((await post(example.continuation(start.body, 'completed-result'))).status, 409);
    }
  }
});
