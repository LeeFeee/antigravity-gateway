'use strict';
const assert = require('node:assert/strict'), test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { newState, contentFingerprint, AgySessionStore } = require('../src/agy-session-state');
const { prepareNativeContext, completeNativeContext } = require('../src/agy-context-state');
const { nativeSchema } = require('../src/agy-request-profile');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { normalizeAnthropic } = require('../src/protocol');
const model = 'gemini-3.8-flash-high';
const user = text => ({ role: 'user', parts: [{ text }] });
const answer = text => ({ role: 'model', parts: [{ text }] });
const reply = parts => new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { headers: { 'content-type': 'application/json' } });
const context = (state, contents, options) => prepareNativeContext(state, contents, model, options);

test('actual Claude system-role date layout does not advance the native user trajectory', () => {
  const request = buildDirectRequest(normalizeAnthropic({
    system: 'Keep permissions.',
    messages: [{ role: 'user', content: 'Read the fixture.' },
      { role: 'system', content: [{ type: 'text', text: "Today's date is 2026-10-19." }] }]
  }), model, 'p', 's');
  assert.equal(request.request.contents.length, 1);
  assert.match(request.requestId, /\/1$/);
  assert.equal(request.request.labels.last_step_index, '0');
  assert.equal(request.request.systemInstruction.parts[0].text, "Keep permissions.\n\nToday's date is 2026-10-19.");
  assert.doesNotMatch(JSON.stringify(request.request.contents), /Today's date/);
});

test('wire Schema uses observed enum spelling, field ordering, sorted property maps and one declaration per Tool', () => {
  const schema = nativeSchema({ required: ['z'], properties: { z: { description: 'Z', type: 'string' }, a: { items: { type: 'integer' }, type: 'array' } }, type: 'object' });
  assert.deepEqual(Object.keys(schema), ['type', 'properties', 'required']);
  assert.deepEqual(Object.keys(schema.properties), ['a', 'z']);
  assert.equal(schema.properties.a.items.type, 'INTEGER');
  assert.deepEqual(Object.keys(schema.properties.z), ['type', 'description']);
  const request = buildDirectRequest({ messages: [{ role: 'user', text: 'tools' }], tools: [{ name: 'one', schema: { type: 'object' } }, { name: 'two', schema: { type: 'object' } }] }, model, 'p', 's');
  assert.deepEqual(request.request.tools.map(t => t.functionDeclarations.length), [1, 1]);
});

test('user whitespace is significant while client-only assistant trailing newline does not lose signatures', () => {
  assert.notEqual(contentFingerprint(user(' a ')), contentFingerprint(user('a')));
  assert.equal(contentFingerprint(answer('a\n')), contentFingerprint(answer('a')));
});

test('timestamps and actual model selection stay stable across restart and previous-prefix rewrite', () => {
  let state = newState('a', 's');
  const first = context(state, [user('keep  spaces \n')], { now: 1792392109000 });
  const text = first.contents[0].parts[0].text;
  assert.match(text, /<USER_REQUEST>\nkeep  spaces \n\n<\/USER_REQUEST>/);
  assert.match(text, /from None to Gemini 3.8 Flash \(High\)/);
  assert.ok(text.endsWith('</USER_SETTINGS_CHANGE>'));
  completeNativeContext(state, first, model, answer('READY'));
  state = JSON.parse(JSON.stringify(state));
  const second = context(state, [user('keep  spaces \n'), answer('READY'), user('next')], { now: 1792392209000 });
  assert.equal(second.contents[0].parts[0].text, text);
  assert.doesNotMatch(second.contents[2].parts[0].text, /USER_SETTINGS_CHANGE/);
  assert.ok(second.contents[2].parts[0].text.endsWith('</ADDITIONAL_METADATA>'));
  completeNativeContext(state, second, model, answer('second'));
  const rewritten = context(state, [user('rewritten old prefix'), answer('READY'), user('next'), answer('second'), user('last')], { now: 1792392309000 });
  assert.equal(rewritten.contents[2].parts[0].text, second.contents[2].parts[0].text);
  assert.equal(rewritten.step, 5);
  assert.doesNotMatch(JSON.stringify(state), /keep  spaces|rewritten old prefix/);
});

test('already wrapped native messages and summary blocks are not nested or overwritten', () => {
  const state = newState('a', 's');
  const wrapped = '<USER_REQUEST>\nhello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\noriginal time\n</ADDITIONAL_METADATA>\n';
  const summary = '<CONTEXT_SUMMARY>\noriginal summary\n</CONTEXT_SUMMARY>';
  const request = context(state, [user(wrapped), answer('ok'), user(summary)]);
  assert.equal(request.contents[0].parts[0].text, wrapped);
  assert.equal(request.contents[2].parts[0].text, summary);
});

test('two OpenAI tool-result messages merge into one native content and count as two steps', () => {
  const request = buildDirectRequest({ messages: [
    { role: 'user', text: 'read both' },
    { role: 'assistant', parts: [
      { type: 'tool_call', id: 'a', name: 'read', arguments: { z: 1, a: { z: 2, a: 3 } } },
      { type: 'tool_call', id: 'b', name: 'read', arguments: {} }] },
    { role: 'tool', parts: [{ type: 'tool_result', id: 'b', content: 'B' }] },
    { role: 'tool', parts: [{ type: 'tool_result', id: 'a', content: 'A' }] }
  ] }, model, 'p', 's');
  assert.equal(request.request.contents.length, 3);
  assert.equal(request.request.contents[2].parts.length, 2);
  assert.deepEqual(request.request.contents[2].parts.map(p => p.functionResponse.id), ['a', 'b']);
  assert.equal(request.request.labels.last_step_index, '3');
  assert.match(request.requestId, /\/4$/);
  assert.deepEqual(Object.keys(request.request.contents[1].parts[0].functionCall.args), ['a', 'z']);
  assert.deepEqual(Object.keys(request.request.contents[1].parts[0].functionCall.args.a), ['a', 'z']);
});

test('captured six-request parallel/compaction sequence survives provider restart and keeps one trajectory', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-context-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const calls = [{ id: 'first', name: 'read', args: { path: 'first' } }, { id: 'second', name: 'read', args: { path: 'second' } }];
  const replies = [
    [{ text: 'READY', thoughtSignature: 'ready-signature' }],
    calls.map((functionCall,i) => ({ functionCall, ...(i ? {} : { thoughtSignature: 'parallel-signature' }) })),
    [{ text: 'A, B' }], [{ text: 'Remembered amber, A, B.' }], [{ text: 'amber, A, B' }], [{ text: 'amber, A, B' }]
  ];
  const send = async (messages, compact = false) => {
    // A fresh provider/store each request exercises disk persistence, not an
    // accidental process-global counter or client echo of the signatures.
    const provider = new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory: dir }), accessToken: 'token', projectId: 'p', maxRetries: 0,
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:account' }) },
      fetchImpl: async (_url, opts) => { requests.push(JSON.parse(opts.body)); return reply(replies.shift()); } });
    return provider.send({ messages, generationConfig: { maxOutputTokens: 65536 } }, model, { sessionId: 's', auxiliaryScope: compact ? 'compaction' : '' });
  };
  let messages = [{ role: 'user', text: 'Remember amber.' }];
  await send(messages);
  messages.push({ role: 'assistant', text: 'READY' }, { role: 'user', text: 'Read two files.' });
  await send(messages);
  messages.push({ role: 'assistant', parts: calls.map(c => ({ type: 'tool_call', id: c.id, name: c.name, arguments: c.args })) },
    { role: 'user', parts: calls.map(c => ({ type: 'tool_result', id: c.id, content: c.id === 'first' ? 'A' : 'B' })) });
  await send(messages);
  messages.push({ role: 'assistant', text: 'A, B' }, { role: 'user', text: '/compact Recall values.' });
  await send([...messages, { role: 'user', text: 'Write a continuation summary.' }], true);
  messages = [{ role: 'user', text: '<CONTEXT_SUMMARY>\nRemembered amber, A, B.\n</CONTEXT_SUMMARY>' }];
  await send(messages);
  messages.push({ role: 'assistant', text: 'amber, A, B' }, { role: 'user', text: 'Recall once more.' });
  await send(messages);
  assert.deepEqual(requests.map(r => r.requestId.split('/').at(-1)), ['1','3','6','8','9','11']);
  assert.deepEqual(requests.map(r => r.request.labels.last_step_index), ['0','2','5','7','8','10']);
  assert.deepEqual(requests.map(r => r.request.labels.request_id.split('-').at(-1)), ['0','1','2','3','3','4']);
  assert.deepEqual(requests.map(r => r.requestType), ['agent','agent','agent','checkpoint','agent','agent']);
  assert.equal(new Set(requests.map(r => r.request.labels.cascade_id)).size, 1);
  assert.equal(new Set(requests.map(r => r.request.labels.trajectory_id)).size, 1);
  assert.equal(requests[3].request.generationConfig.maxOutputTokens, 16384);
  assert.equal(requests[3].request.contents.at(-1).parts[0].text, 'Write a continuation summary.');
  assert.equal(requests[3].request.labels.last_execution_id, requests[4].request.labels.last_execution_id);
  assert.notEqual(requests[4].request.labels.last_execution_id, requests[5].request.labels.last_execution_id);
  assert.equal(requests[2].request.contents[3].parts[0].thoughtSignature, 'parallel-signature');
  assert.equal(requests[0].request.contents[0].parts[0].text, requests[3].request.contents[0].parts[0].text);
  assert.equal(requests[4].request.contents.length, 1);
  assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.json')).length, 1);
});
