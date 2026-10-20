'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { CLAUDE_COMPACTION_PROFILE } = require('../src/agy-client-compaction');
const model = 'gemini-3.8-flash-high', step = r => Number(r.requestId.split('/').at(-1));
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { headers: { 'content-type': 'application/json' } });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-checkpoint-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], messages = [{ role: 'user', text: 'Remember quartz.' }];
  const provider = (fetchImpl, options = {}) => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }),
    accessToken: 'local', projectId: 'p', maxRetries: 1, retryBaseMs: 1,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:checkpoint' }) }, ...options,
    fetchImpl: (url, options) => { requests.push(JSON.parse(options.body)); return fetchImpl(url, options); } });
  const send = (p, input = messages, options = {}) => p.send({ messages: input }, model, { sessionId: 's', ...options });
  const seed = async () => { await send(provider(async () => reply('READY'))); messages.push({ role: 'assistant', text: 'READY' }, { role: 'user', text: '/compact Recall quartz.' }); };
  const compact = () => [...messages, { role: 'user', text: 'Write a continuation summary.' }];
  const resume = async () => { messages.push({ role: 'user', text: 'Recall.' }); await send(provider(async () => reply('quartz'))); return requests.at(-1); };
  return { requests, messages, provider, send, seed, compact, resume };
}

for (const status of [400, 429, 500, 502, 503, 504]) {
  test(`terminal checkpoint ${status} records one error step, no partial summary and a new execution`, async t => {
    const f = fixture(t); await f.seed();
    await assert.rejects(f.send(f.provider(async () => new Response('controlled checkpoint failure', { status })), f.compact(), { auxiliaryScope: 'compaction' }), { status });
    const failed = f.requests.slice(1); assert.equal(failed.length, status === 400 ? 1 : 4);
    assert.ok(failed.every(r => step(r) === 3 && r.request.labels.request_id === failed[0].request.labels.request_id));
    const resumed = await f.resume(); assert.equal(step(resumed), 5);
    assert.notEqual(resumed.request.labels.last_execution_id, failed[0].request.labels.last_execution_id);
    assert.equal(resumed.request.labels.request_id, failed[0].request.labels.request_id);
    assert.equal(resumed.request.contents.length, 4);
    assert.doesNotMatch(JSON.stringify(resumed.request.contents), /controlled checkpoint failure|Write a continuation summary|CONTEXT_SUMMARY/);
    assert.deepEqual(resumed.request.contents.slice(0, 3), failed[0].request.contents.slice(0, 3));
  });
}

for (const status of [429, 500, 502, 503, 504]) {
  test(`checkpoint ${status} retry changes only timestamp and successful summary advances once`, async t => {
    const f = fixture(t); await f.seed(); let count = 0;
    await f.send(f.provider(async () => { await new Promise(resolve => setTimeout(resolve, 3)); return ++count === 1 ? new Response('retry', { status }) : reply('Keep quartz.'); }), f.compact(), { auxiliaryScope: 'compaction' });
    const a = f.requests[1], b = f.requests[2], adjusted = structuredClone(b); adjusted.requestId = a.requestId;
    assert.deepEqual(adjusted, a); assert.notEqual(a.requestId, b.requestId); assert.equal(step(b), 3);
    await f.send(f.provider(async () => reply('quartz')), [{ role: 'user', text: '<CONTEXT_SUMMARY>\nKeep quartz.\n</CONTEXT_SUMMARY>' }]);
    assert.equal(step(f.requests.at(-1)), 4); assert.equal(f.requests.at(-1).request.labels.request_id, a.request.labels.request_id);
    assert.equal(f.requests.at(-1).request.labels.last_execution_id, a.request.labels.last_execution_id);
  });
}

for (const phase of ['early', 'thought', 'partial', 'backoff']) {
  test(`checkpoint cancellation during ${phase} discards partial summary without consuming a step`, async t => {
    const f = fixture(t); await f.seed(); const controller = new AbortController(); let count = 0;
    const fetchImpl = async () => {
      if (phase === 'early') { controller.abort(); throw controller.signal.reason; }
      if (phase === 'backoff') { if (++count === 2) controller.abort(); return new Response('retry', { status: 503, headers: { 'retry-after': '9' } }); }
      return new Response(new ReadableStream({ start(stream) {
        controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason), { once: true });
        stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'UNFINISHED_CHECKPOINT', ...(phase === 'thought' ? { thought: true } : {}) }] } }] } }) + '\n\n'));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
    await assert.rejects(f.send(f.provider(fetchImpl), f.compact(), { auxiliaryScope: 'compaction', signal: controller.signal,
      onDelta: () => controller.abort(), onThinkingDelta: () => controller.abort() }), { name: 'AbortError' });
    const cp = f.requests[1], resumed = await f.resume();
    assert.equal(step(resumed), 4); assert.notEqual(resumed.request.labels.last_execution_id, cp.request.labels.last_execution_id);
    assert.equal(resumed.request.labels.request_id, cp.request.labels.request_id);
    assert.doesNotMatch(JSON.stringify(resumed.request.contents), /UNFINISHED_CHECKPOINT|Write a continuation summary|CONTEXT_SUMMARY/);
    assert.equal(f.requests.length, phase === 'backoff' ? 4 : 3);
  });
}

for (const cancel of [false, true]) {
  test(`Claude omitted answer metadata survives ${cancel ? 'cancelled' : 'failed'} checkpoint without duplicate steps`, async t => {
    const f = fixture(t); await f.seed(); const controller = new AbortController();
    const prefix = [f.messages[0], { role: 'user', text: 'Known client instruction' }];
    await assert.rejects(f.send(f.provider(async () => { if (cancel) { controller.abort(); throw controller.signal.reason; } return new Response('failed', { status: 400 }); }), prefix,
      { nativeCompaction: CLAUDE_COMPACTION_PROFILE, signal: controller.signal }), cancel ? { name: 'AbortError' } : { status: 400 });
    // The later client includes the already completed answer, not a summary.
    await f.send(f.provider(async () => reply('quartz')), [f.messages[0], f.messages[1], { role: 'user', text: 'Recall.' }]);
    assert.equal(step(f.requests[1]), 2); assert.equal(step(f.requests.at(-1)), cancel ? 3 : 4);
    assert.notEqual(f.requests.at(-1).request.labels.last_execution_id, f.requests[1].request.labels.last_execution_id);
    assert.equal(f.requests.at(-1).request.contents.length, 3);
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /Known client instruction/);
  });
}

test('uncaptured checkpoint HTTP 501 keeps its previous metadata behavior', async t => {
  const f = fixture(t); await f.seed();
  await assert.rejects(f.send(f.provider(async () => new Response('unobserved HTTP status', { status: 501 }), { maxRetries: 0 }), f.compact(), { auxiliaryScope: 'compaction' }), { status: 501 });
  assert.deepEqual(f.requests[1], f.requests[2]); const resumed = await f.resume();
  assert.equal(step(resumed), 4); assert.equal(resumed.request.labels.last_execution_id, f.requests[1].request.labels.last_execution_id);
});
