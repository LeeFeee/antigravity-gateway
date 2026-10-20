'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { AgySessionStore } = require('../src/agy-session-state');
const { DirectAntigravityProvider } = require('../src/direct-provider');

const model = 'gemini-3.8-flash-high';
const reply = parts => new Response(JSON.stringify({ candidates: [{ content: { parts } }] }),
  { headers: { 'content-type': 'application/json' } });

for (const phase of ['early', 'thought-only', 'partial-omitted', 'partial-echo']) {
  test(`captured cancellation boundary persists across provider restart: ${phase}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cancel-tests-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const observed = [], controller = new AbortController();
    const provider = fetchImpl => new DirectAntigravityProvider({
      sessionStore: new AgySessionStore({ directory }), accessToken: 'test-token', projectId: 'test-project', maxRetries: 0,
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:test-account' }) },
      fetchImpl: (url, options) => { observed.push(JSON.parse(options.body)); return fetchImpl(url, options); }
    });
    const messages = [{ role: 'user', text: 'Remember the code.' }];
    await provider(async () => reply([{ text: 'READY', thoughtSignature: 'real-test-signature' }]))
      .send({ messages }, model, { sessionId: 'conversation' });
    messages.push({ role: 'assistant', text: 'READY' }, { role: 'user', text: 'Write a long answer.' });
    const incomplete = provider(async (_url, options) => {
      if (phase === 'early') {
        controller.abort(); throw controller.signal.reason;
      }
      const part = phase === 'thought-only' ? { thought: true, text: 'UNFINISHED_THOUGHT' } : { text: 'PARTIAL' };
      const body = new ReadableStream({ start(stream) {
        stream.enqueue(Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`));
        options.signal.addEventListener('abort', () => stream.error(options.signal.reason), { once: true });
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    await assert.rejects(incomplete.send({ messages }, model, { sessionId: 'conversation', signal: controller.signal,
      onDelta: () => controller.abort(), onThinkingDelta: () => controller.abort() }), { name: 'AbortError' });
    const file = fs.readdirSync(directory).find(name => name.endsWith('.json'));
    const state = JSON.parse(fs.readFileSync(path.join(directory, file)));
    assert.equal(state.nextStep, phase === 'early' ? 3 : 4);
    assert.notEqual(state.lastExecutionId, observed[1].request.labels.last_execution_id);
    assert.doesNotMatch(JSON.stringify(state), /UNFINISHED_THOUGHT/);
    if (phase === 'partial-echo') messages.push({ role: 'assistant', text: 'PARTIAL\n' });
    messages.push({ role: 'user', text: 'Recall the code.' });
    await provider(async () => reply([{ text: 'code' }])).send({ messages }, model, { sessionId: 'conversation' });
    assert.deepEqual(observed.map(r => Number(r.requestId.split('/').at(-1))), phase === 'early' ? [1, 3, 4] : [1, 3, 5]);
    assert.equal(observed[2].request.labels.last_execution_id, state.lastExecutionId);
    assert.equal(observed[2].request.labels.request_id.split('-').at(-1), '2');
    assert.doesNotMatch(JSON.stringify(observed[2]), /UNFINISHED_THOUGHT|SYSTEM_MESSAGE|server restart/);
    if (phase === 'partial-echo') {
      assert.deepEqual(observed[2].request.contents[3], { role: 'model', parts: [{ text: 'PARTIAL' }] });
    } else assert.doesNotMatch(JSON.stringify(observed[2]), /PARTIAL/);
    assert.equal(observed[2].request.contents[1].parts[0].thoughtSignature, 'real-test-signature');
    assert.deepEqual(observed[2].request.contents[0], observed[0].request.contents[0]);
    assert.equal(fs.readdirSync(directory).some(name => name.includes('.lock')), false);
  });
}

test('a signal cancelled before dispatch creates no execution or response step', async () => {
  const store = new AgySessionStore({ directory: '' }), controller = new AbortController(); controller.abort();
  const provider = new DirectAntigravityProvider({ sessionStore: store, accessToken: 'token', projectId: 'project',
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:test-account' }) },
    fetchImpl: () => assert.fail('cancelled request reached transport') });
  await assert.rejects(provider.send({ messages: [{ role: 'user', text: 'hello' }] }, model,
    { sessionId: 's', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(store.memory.size, 0);
});
