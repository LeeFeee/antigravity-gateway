'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { AgySessionStore } = require('../src/agy-session-state');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const model = 'gemini-3.8-flash-high';
const reply = parts => new Response(JSON.stringify({ candidates: [{ content: { parts } }] }),
  { headers: { 'content-type': 'application/json' } });
const step = body => Number(body.requestId.split('/').at(-1));
const counter = body => Number(body.request.labels.request_id.split('-').at(-1));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-retry-tests-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  return { requests, provider: (fetchImpl, options = {}) => new DirectAntigravityProvider({
    sessionStore: new AgySessionStore({ directory }), accessToken: 'local-test', projectId: 'project',
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:retry-test' }) },
    maxRetries: 1, retryBaseMs: 1, ...options,
    fetchImpl: (url, request) => { requests.push(JSON.parse(request.body)); return fetchImpl(url, request); }
  }) };
}

function onlyRetryMetadataChanges(first, next) {
  const adjusted = structuredClone(next);
  adjusted.requestId = first.requestId;
  adjusted.request.labels.last_step_index = first.request.labels.last_step_index;
  assert.deepEqual(adjusted, first);
  assert.equal(counter(next), counter(first));
  assert.equal(step(next), step(first) + 1);
  assert.equal(next.request.labels.last_step_index, String(step(next) - 1));
}

test('captured 429 tool-result retry preserves signed history and its error step across restart', async t => {
  const { requests, provider } = fixture(t);
  const call = { id: 'native-call', name: 'read_file', args: { path: 'owned.txt' } };
  const messages = [{ role: 'user', text: 'Read the file.' }];
  await provider(async () => reply([{ functionCall: call, thoughtSignature: 'signed-call' }]))
    .send({ messages }, model, { sessionId: 'conversation' });
  messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: call.id, name: call.name, arguments: call.args }] },
    { role: 'user', parts: [{ type: 'tool_result', id: call.id, content: 'cedar' }] });
  let attempt = 0;
  await provider(async () => ++attempt === 1 ? new Response('controlled capacity failure', { status: 429 })
    : reply([{ text: 'cedar', thoughtSignature: 'signed-answer' }]))
    .send({ messages }, model, { sessionId: 'conversation' });
  onlyRetryMetadataChanges(requests[1], requests[2]);
  assert.equal(requests[2].request.contents[1].parts[0].thoughtSignature, 'signed-call');
  assert.equal(requests[2].request.contents.length, 3);
  messages.push({ role: 'assistant', text: 'cedar' }, { role: 'user', text: 'Recall.' });
  await provider(async () => reply([{ text: 'cedar' }])).send({ messages }, model, { sessionId: 'conversation' });
  assert.deepEqual(requests.map(step), [1, 3, 4, 6]);
  assert.deepEqual(requests.map(counter), [0, 1, 1, 2]);
  assert.equal(requests[3].request.contents[3].parts[0].thoughtSignature, 'signed-answer');
  assert.deepEqual(requests[3].request.contents.slice(0, 3), requests[2].request.contents);
});

test('successive captured HTTP failures each add one step but no duplicate message or request counter', async t => {
  const { requests, provider } = fixture(t);
  const statuses = [503, 429];
  await provider(async () => statuses.length ? new Response('retry', { status: statuses.shift() }) : reply([{ text: 'OK' }]))
    .send({ messages: [{ role: 'user', text: 'Hello.' }] }, model, { sessionId: 'conversation' });
  assert.deepEqual(requests.map(step), [1, 2, 3]);
  assert.deepEqual(requests.map(counter), [0, 0, 0]);
  onlyRetryMetadataChanges(requests[0], requests[1]);
  onlyRetryMetadataChanges(requests[1], requests[2]);
  assert.equal(new Set(requests.map(r => JSON.stringify(r.request.contents))).size, 1);
});

for (const failure of ['transport', 'uncaptured-http-status']) {
  test(`unobserved ${failure} retains its pre-existing retry behavior`, async t => {
    const { requests, provider } = fixture(t); let count = 0;
    await provider(async () => {
      if (++count === 1) { if (failure === 'transport') throw new Error('controlled network failure'); return new Response('unobserved HTTP status', { status: 501 }); }
      return reply([{ text: 'OK' }]);
    }).send({ messages: [{ role: 'user', text: 'Hello.' }] }, model, { sessionId: 'conversation' });
    assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  });
}

test('captured checkpoint retry refreshes only the timestamp, not the agent error step', async t => {
  const { requests, provider } = fixture(t); let count = 0;
  await provider(async () => { await new Promise(resolve => setTimeout(resolve, 3)); return ++count === 1 ? new Response('retry', { status: 503 }) : reply([{ text: 'Summary.' }]); })
    .send({ messages: [{ role: 'user', text: 'Summarize.' }] }, model, { sessionId: 'conversation', auxiliaryScope: 'compaction' });
  assert.equal(requests.length, 2); assert.equal(requests[0].requestType, 'checkpoint');
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  const adjusted = structuredClone(requests[1]); adjusted.requestId = requests[0].requestId;
  assert.deepEqual(adjusted, requests[0]);
  assert.equal(step(requests[0]), step(requests[1]));
});

test('abort before retry dispatch does not issue a phantom retry', async t => {
  const { requests, provider } = fixture(t), controller = new AbortController();
  await assert.rejects(provider(async () => { controller.abort(); return new Response('retry', { status: 503 }); })
    .send({ messages: [{ role: 'user', text: 'Hello.' }] }, model, { sessionId: 'conversation', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 1); assert.equal(step(requests[0]), 1);
});

for (const status of [400, 429, 500, 502, 503, 504]) {
  test(`captured terminal HTTP ${status} retains its final error step and execution boundary across restart`, async t => {
    const { requests, provider } = fixture(t);
    const messages = [{ role: 'user', text: 'Remember ash-6527.' }];
    await assert.rejects(provider(async () => new Response('controlled terminal error', { status }), { maxRetries: 0 })
      .send({ messages }, model, { sessionId: 'conversation' }), { status });
    const failures = requests.length;
    assert.equal(failures, status === 400 ? 1 : 2);
    messages.push({ role: 'user', text: 'Recall the code.' });
    await provider(async () => reply([{ text: 'ash-6527' }])).send({ messages }, model, { sessionId: 'conversation' });
    const resumed = requests.at(-1);
    assert.equal(step(resumed), failures + 2);
    assert.equal(counter(resumed), 1);
    assert.match(resumed.request.labels.last_execution_id, /^[\da-f-]{36}$/);
    assert.equal(resumed.request.contents.length, 2);
    assert.deepEqual(resumed.request.contents[0], requests[0].request.contents[0]);
    assert.equal(resumed.requestId.split('/')[1], requests[0].requestId.split('/')[1]);
    assert.equal(resumed.requestId.split('/')[3], requests[0].requestId.split('/')[3]);
    assert.ok(!JSON.stringify(resumed.request.contents).includes('controlled terminal error'));
  });
}

test('cancellation during observed HTTP error backoff saves that error but does not create an unsent retry', async t => {
  const { requests, provider } = fixture(t), controller = new AbortController();
  const messages = [{ role: 'user', text: 'Remember ash-6527.' }];
  let count = 0;
  const started = Date.now();
  await assert.rejects(provider(async () => {
    if (++count === 2) controller.abort();
    return new Response('controlled failure', { status: 503, headers: { 'retry-after': '9' } });
  }).send({ messages }, model, { sessionId: 'conversation', signal: controller.signal }), { name: 'AbortError' });
  assert.ok(Date.now() - started < 8000, 'an already-aborted signal must not wait through Retry-After: 9');
  assert.equal(requests.length, 2);
  messages.push({ role: 'user', text: 'Recall the code.' });
  await provider(async () => reply([{ text: 'ash-6527' }])).send({ messages }, model, { sessionId: 'conversation' });
  assert.deepEqual(requests.map(step), [1, 2, 4]);
  assert.deepEqual(requests.map(counter), [0, 0, 1]);
  assert.match(requests[2].request.labels.last_execution_id, /^[\da-f-]{36}$/);
  assert.equal(requests[2].request.contents.length, 2);
});

test('an uncaptured terminal HTTP status does not acquire guessed native error metadata', async t => {
  const { requests, provider } = fixture(t);
  const messages = [{ role: 'user', text: 'Hello.' }];
  await assert.rejects(provider(async () => new Response('unobserved HTTP status', { status: 501 }), { maxRetries: 0 })
    .send({ messages }, model, { sessionId: 'conversation' }), { status: 501 });
  messages.push({ role: 'user', text: 'Continue.' });
  await provider(async () => reply([{ text: 'OK' }])).send({ messages }, model, { sessionId: 'conversation' });
  assert.deepEqual(requests.map(step), [1, 1, 2]);
  assert.equal(requests[2].request.labels.last_execution_id, undefined);
});
