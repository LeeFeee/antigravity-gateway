'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { nativeRetryDecision, nativeRetryDelayMs, retryInfoMs } = require('../src/agy-retry-policy');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const model = 'gemini-3.8-flash-high';
const body = seconds => JSON.stringify({ error: { message: 'controlled', details: [
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${seconds}s` }
] } });

test('captured agent backoff uses downward .4 jitter, lower bound 4s and nominal cap 30s', () => {
  assert.deepEqual([0, 1, 2, 3, 8].map(i => nativeRetryDelayMs(i, { random: () => 0 })), [4000, 8000, 16000, 30000, 30000]);
  assert.deepEqual([0, 1, 2, 3, 8].map(i => nativeRetryDelayMs(i, { random: () => 1 })), [4000, 4800, 9600, 18000, 18000]);
  assert.equal(nativeRetryDelayMs(0, { minimumMs: 9000 }), 9000);
  assert.equal(nativeRetryDelayMs(3, { checkpoint: true }), 1000);
  assert.equal(nativeRetryDelayMs(3, { checkpoint: true, minimumMs: 9000 }), 9000);
});

test('only captured statuses and typed 429 RetryInfo select native retry behavior', () => {
  for (const status of [429, 500, 502, 503, 504]) assert.deepEqual(nativeRetryDecision(status, '{}'), { retryable: true, minimumMs: 0 });
  for (const status of [400, 401, 403, 408, 501]) assert.equal(nativeRetryDecision(status, '{}'), null);
  assert.deepEqual(nativeRetryDecision(429, body(9)), { retryable: true, minimumMs: 9000 });
  assert.equal(nativeRetryDecision(429, body(30)).retryable, true);
  assert.equal(nativeRetryDecision(429, body(31)).retryable, false);
  for (const value of ['bad JSON', '{"error":{"details":{}}}', body(-1), body('NaN'), body('Infinity')]) assert.equal(retryInfoMs(429, value), 0);
  assert.equal(retryInfoMs(502, body(9)), 0);
});

function fixture(t, options = {}) {
  const requests = [], delays = [];
  // Timer substitution is unit coverage only. Live timing is separately tested
  // with unmodified clocks, real official agy and the formally installed CLI.
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => { delays.push(ms); return setImmediate(fn, ...args); });
  t.mock.method(global, 'clearTimeout', timer => clearImmediate(timer));
  const provider = fetchImpl => new DirectAntigravityProvider({ localAuth: null,
    sessionStore: new AgySessionStore({ directory: '' }), accessToken: 'local-test', projectId: 'p',
    ...options, fetchImpl: (url, request) => { requests.push({ url, body: JSON.parse(request.body) }); return fetchImpl(url, request); }
  });
  const send = (p, checkpoint = false, selectedModel = model, signal) => p.send({ messages: [{ role: 'user', text: 'Hello.' }] }, selectedModel,
    { sessionId: 'retry-policy-unit', ...(checkpoint ? { auxiliaryScope: 'compaction' } : {}), signal });
  return { provider, send, requests, delays };
}

for (const checkpoint of [false, true]) {
  test(`explicit agy ${checkpoint ? 'checkpoint' : 'agent'} retries on one endpoint with native count and ignores HTTP Retry-After`, async t => {
    const f = fixture(t, { retryPolicy: 'agy' });
    await assert.rejects(f.send(f.provider(async () => new Response('failure', { status: 502, headers: { 'retry-after': '9' } })), checkpoint), { status: 502 });
    assert.equal(f.requests.length, checkpoint ? 5 : 9);
    assert.equal(new Set(f.requests.map(r => r.url)).size, 1);
    assert.match(f.requests[0].url, /daily-cloudcode/);
    assert.equal(f.delays.length, checkpoint ? 4 : 8);
    assert.equal(f.delays[0], checkpoint ? 1000 : 4000);
    assert.deepEqual(f.requests.map(r => +r.body.requestId.split('/').at(-1)), checkpoint ? [1, 1, 1, 1, 1] : [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(new Set(f.requests.map(r => r.body.request.labels.request_id)).size, 1);
  });
  test(`explicit agy 429 body retry delay above 30s terminates ${checkpoint ? 'checkpoint' : 'agent'} for pool failover without waiting`, async t => {
    const f = fixture(t, { retryPolicy: 'agy' });
    await assert.rejects(f.send(f.provider(async () => new Response(body(31), { status: 429 })), checkpoint), error => error.status === 429 && error.details.includes('31s'));
    assert.equal(f.requests.length, 1); assert.equal(f.delays.length, 0);
  });
}

test('explicit legacy configuration preserves daily/normal fallback', async t => {
  const f = fixture(t, { maxRetries: 0 });
  await assert.rejects(f.send(f.provider(async () => new Response('failure', { status: 502 }))), { status: 502 });
  assert.equal(f.requests.length, 2); assert.equal(f.delays.length, 0);
  assert.match(f.requests[1].url, /^https:\/\/cloudcode-pa/);
});

for (const failure of ['transport', '501', 'other-model']) {
  test(`uncaptured ${failure} retains bounded legacy failover`, async t => {
    const f = fixture(t);
    await assert.rejects(f.send(f.provider(async () => {
      if (failure === 'transport') throw new Error('local transport failure');
      return new Response('failure', { status: failure === '501' ? 501 : 502 });
    }), false, failure === 'other-model' ? 'gemini-test-high' : model));
    assert.equal(f.requests.length, 4);
    assert.match(f.requests[1].url, /^https:\/\/cloudcode-pa/);
  });
}

test('native retry observes cancellation before dispatch or sleep', async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(f.send(f.provider(async () => { controller.abort(); return new Response('failure', { status: 502 }); }), false, model, controller.signal), { name: 'AbortError' });
  assert.equal(f.requests.length, 1); assert.equal(f.delays.length, 0);
});
