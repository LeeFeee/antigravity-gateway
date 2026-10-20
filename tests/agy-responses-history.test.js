'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { normalizeResponses, normalizeAnthropic } = require('../src/protocol');
const { buildDirectRequest, DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const model = 'gemini-3.8-flash-high';
const message = (role, text) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const call = (id, name = 'read') => ({ type: 'function_call', call_id: id, name, arguments: '{"path":"fixture"}' });
const output = (id, text) => ({ type: 'function_call_output', call_id: id, output: text });

test('actual Codex Responses split text/parallel calls rejoin one native model step', () => {
  const normalized = normalizeResponses({ input: [message('user', 'read both'),
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'client summary' }] },
    message('assistant', 'Reading both.'), call('a'), call('b'), output('b', 'B'), output('a', 'A')] });
  const sourceBefore = JSON.stringify(normalized);
  const body = buildDirectRequest(normalized, model, 'p', 's');
  assert.equal(JSON.stringify(normalized), sourceBefore, 'Other providers retain their original normalized input');
  assert.equal(body.request.contents.length, 3);
  assert.deepEqual(body.request.contents[1].parts.map(p => p.functionCall?.id || p.text), ['Reading both.', 'a', 'b']);
  assert.equal(body.request.contents[1].parts[1].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(body.request.contents[1].parts[2].thoughtSignature, undefined);
  assert.deepEqual(body.request.contents[2].parts.map(p => p.functionResponse.id), ['a', 'b']);
  assert.match(body.requestId, /\/4$/);
  assert.doesNotMatch(JSON.stringify(body), /ASSISTANT_TOOL_CALL|CLIENT_TOOL_RESULT|client summary/);
});

test('Responses regrouping respects user/result boundaries and does not merge plain answers', () => {
  const n = normalizeResponses({ input: [message('assistant', 'A'), message('assistant', 'B'),
    message('user', 'read'), call('a'), output('a', 'one'), call('b'), output('b', 'two'), message('user', 'done')] });
  const contents = buildDirectRequest(n, model, 'p', 's').request.contents;
  assert.equal(contents.length, 8);
  assert.equal(contents[0].parts[0].text, 'A'); assert.equal(contents[1].parts[0].text, 'B');
  assert.equal(contents[3].parts[0].functionCall.id, 'a');
  assert.equal(contents[5].parts[0].functionCall.id, 'b');
  const anthropic = normalizeAnthropic({ messages: [{ role: 'assistant', content: 'A' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'read', input: {} }] }] });
  assert.equal(buildDirectRequest(anthropic, model, 'p', 's').request.contents.length, 2);
});

test('Responses regrouping restores real saved parts and signatures across parallel/custom tools and restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-responses-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const firstParts = [{ text: 'Reading both.' },
    { functionCall: { id: 'a', name: 'read', args: { path: 'fixture' } }, thoughtSignature: 'native-parallel-signature' },
    { functionCall: { id: 'b', name: 'read', args: { path: 'fixture' } } }];
  const patch = '*** Begin Patch\n*** Add File: out.txt\n+verified\n*** End Patch';
  const secondParts = [{ text: 'Writing.' }, { functionCall: { id: 'c', name: 'apply_patch', args: { input: patch } }, thoughtSignature: 'native-custom-signature' }];
  const replies = [firstParts, secondParts, [{ text: 'OK' }]];
  async function send(input) {
    const provider = new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'synthetic', projectId: 'p', maxRetries: 0,
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:responses-test' }) },
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: replies.shift() } }] }), { headers: { 'content-type': 'application/json' } });
      } });
    return provider.send(normalizeResponses({ input }), model, { sessionId: 'responses-real-layout' });
  }
  const initial = [message('user', 'client context'), message('user', 'workspace context'), message('user', 'read both')];
  await send(initial);
  const second = [...initial, message('assistant', 'Reading both.'), call('a'), call('b'), output('b', 'B'), output('a', 'A')];
  await send(second);
  await send([...second, message('assistant', 'Writing.'), { type: 'custom_tool_call', call_id: 'c', name: 'apply_patch', input: patch },
    { type: 'custom_tool_call_output', call_id: 'c', output: 'file created' }]);
  assert.deepEqual(requests.map(r => Number(r.requestId.split('/').at(-1))), [3, 6, 8]);
  assert.deepEqual(requests[1].request.contents[3].parts, firstParts);
  assert.deepEqual(requests[2].request.contents[3].parts, firstParts);
  assert.deepEqual(requests[2].request.contents[5].parts, secondParts);
  assert.equal(new Set(requests.map(r => r.request.labels.cascade_id)).size, 1);
  assert.doesNotMatch(JSON.stringify(requests.slice(1)), /skip_thought_signature_validator/);
});
