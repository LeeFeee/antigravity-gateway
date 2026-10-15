'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionManager } = require('../src/session-manager');
const input = { model: 'gemini-4-argon', messages: [{ role: 'user', text: '读取笔记。' }] };
function request(session, user = 'anonymous-a', version = '0.1.0-rc.5', extra = {}) {
  return { headers: { authorization: 'Bearer synthetic-local-key',
    'user-agent': 'deepseek-harness/' + version + ' (+https://github.com/deepseek-ai/deepseek-harness)',
    'x-deepseek-harness-user-id': user, 'x-deepseek-harness-session-id': session, ...extra },
    socket: { remoteAddress: '127.0.0.1' } };
}

test('two DSH sessions with the same initial prompt get separate native conversation and affinity identities', () => {
  const manager = new SessionManager();
  const first = manager.resolveIdentity(request('session-a'), {}, input);
  const second = manager.resolveIdentity(request('session-b'), {}, input);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.routingKey, second.routingKey);
  assert.equal(first.clientId, second.clientId);
  assert.equal(first.sessionSource, 'explicit');
  assert.equal(first.reuseConversation, true);
});

test('DSH tool continuations keep their stable caller identity across product version changes', () => {
  const manager = new SessionManager();
  const first = manager.resolveIdentity(request('session-a'), {}, input);
  const upgraded = manager.resolveIdentity(request('session-a', 'anonymous-a', '0.1.0-rc.6'), {}, { messages: [] });
  assert.equal(first.clientId, upgraded.clientId);
  assert.equal(first.sessionId, upgraded.sessionId);
  assert.equal(first.routingKey, upgraded.routingKey);
});

test('distinct DSH homes do not share a caller or conversation even if their session IDs are equal', () => {
  const manager = new SessionManager();
  const first = manager.resolveIdentity(request('session-a', 'anonymous-a'), {}, input);
  const second = manager.resolveIdentity(request('session-a', 'anonymous-b'), {}, input);
  assert.notEqual(first.clientId, second.clientId);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.routingKey, second.routingKey);
});

test('DSH response reuse still enforces the credential and caller scope', () => {
  const manager = new SessionManager();
  const req = request('session-a');
  manager.bindResponse('resp-synthetic', req, manager.resolveIdentity(req, {}, input));
  assert.ok(manager.getResponse('resp-synthetic', request('session-a', 'anonymous-a', '0.1.0-rc.6')));
  assert.equal(manager.getResponse('resp-synthetic', request('session-a', 'anonymous-b')), null);
  assert.equal(manager.getResponse('resp-synthetic', request('session-b')), null);
  assert.equal(manager.getResponse('resp-synthetic', request('session-a', 'anonymous-a', undefined, { authorization: 'Bearer different-key' })), null);
});

test('explicit common client and session metadata retain precedence over DSH aliases', () => {
  const manager = new SessionManager();
  const extra = { 'x-client-id': 'explicit-agent', 'x-session-id': 'explicit-session' };
  const withDsh = manager.resolveIdentity(request('ignored-session', 'ignored-user', undefined, extra), {}, input);
  const common = manager.resolveIdentity({ headers: { authorization: 'Bearer synthetic-local-key', ...extra },
    socket: { remoteAddress: '127.0.0.1' } }, {}, input);
  assert.equal(withDsh.clientId, common.clientId);
  assert.equal(withDsh.sessionId, common.sessionId);
});

test('DSH auxiliary scopes follow explicit compaction headers or tool declarations, never prompt keywords', () => {
  const manager = new SessionManager(), req = request('session-a');
  const mainInput = { ...input, tools: [{ name: 'read_note' }] };
  const main = manager.resolveIdentity(req, {}, mainInput);
  const title = manager.resolveIdentity(req, {}, { ...input, tools: [] });
  const compact = manager.resolveIdentity(request('session-a', undefined, undefined,
    { 'x-deepseek-harness-compact': '1' }), {}, mainInput);
  assert.equal(title.auxiliaryScope, 'no-client-tools');
  assert.equal(compact.auxiliaryScope, 'compaction');
  assert.equal(main.auxiliaryScope, undefined);
  assert.equal(main.sessionId, title.sessionId); assert.equal(main.routingKey, title.routingKey);
  assert.equal(main.routingKey, compact.routingKey);
  const result = manager.resolveIdentity(req, {}, { tools: [], messages: [{ parts: [{ type: 'tool_result', id: 'call-a' }] }] });
  assert.equal(result.auxiliaryScope, undefined, 'omitted declarations must not detach a pending tool result');
  assert.equal(manager.resolveIdentity(req, {}, { ...mainInput, messages: [{ role: 'user', text: 'compaction title 标题压缩' }] }).auxiliaryScope, undefined);
});

test('Chat handlers retain DSH tool ownership across turns without injecting routing headers into model content', async t => {
  const { RobinAccountPool } = require('../src/robin-account-pool');
  const { createServer } = require('../antigravity-gateway');
  const seen = [];
  t.mock.method(RobinAccountPool.prototype, 'listModels', async () => ['gemini-4-argon']);
  t.mock.method(RobinAccountPool.prototype, 'send', async (normalized, _model, options) => {
    seen.push({ normalized, options });
    const done = normalized.messages.some(message => message.parts.some(part => part.type === 'tool_result'));
    return { text: done ? '读回完成。' : '', usage: null, usageKnown: false,
      toolCalls: done ? [] : [{ id: 'same-call-id', name: 'read_note', arguments: {} }] };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const preflight = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS', headers: { origin: base,
    'access-control-request-headers': 'x-deepseek-harness-session-id, x-deepseek-harness-user-id, x-deepseek-harness-compact' } });
  assert.equal(preflight.status, 204);
  for (const header of ['x-deepseek-harness-session-id', 'x-deepseek-harness-user-id', 'x-deepseek-harness-compact']) {
    assert.ok(preflight.headers.get('access-control-allow-headers').split(', ').includes(header));
  }
  const body = { model: 'gemini-4-argon', messages: [{ role: 'user', content: '读取笔记。' }],
    tools: [{ type: 'function', function: { name: 'read_note', parameters: { type: 'object', properties: {} } } }] };
  async function send(session, payload, version) {
    const headers = { ...request(session, 'opaque-dsh-user-unique', version).headers, 'content-type': 'application/json' };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(response.status, 200); return response.json();
  }
  const first = await send('opaque-dsh-session-a-unique', body);
  await send('opaque-dsh-session-b-unique', body);
  await send('opaque-dsh-session-a-unique', { ...body, messages: [...body.messages,
    first.choices[0].message, { role: 'tool', tool_call_id: 'same-call-id', content: 'note content' }] }, '0.1.0-rc.6');
  assert.equal(seen[0].options.sessionId, seen[2].options.sessionId);
  assert.equal(seen[0].options.clientId, seen[2].options.clientId);
  assert.equal(seen[0].options.routingKey, seen[2].options.routingKey);
  assert.notEqual(seen[0].options.sessionId, seen[1].options.sessionId);
  assert.ok(seen.every(call => call.options.reuseConversation));
  for (const call of seen) {
    const modelContent = JSON.stringify(call.normalized);
    assert.doesNotMatch(modelContent, /opaque-dsh-user-unique|opaque-dsh-session-[ab]-unique|x-deepseek-harness/);
  }
});
