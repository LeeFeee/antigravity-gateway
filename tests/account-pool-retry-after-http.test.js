'use strict';
require('./helpers/gateway-environment');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { createServer } = require('../antigravity-gateway');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { DirectProviderError } = require('../src/direct-provider');

const MODEL = 'gemini-3.8-flash-high';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-retry-http-'));
  const store = new AccountStore({ configDir: directory });
  for (let index = 0; index < 2; index++) store.save({
    email: `account-${index}@example.com`, accessToken: `synthetic-access-${index}`,
    refreshToken: `synthetic-refresh-${index}`, projectId: `synthetic-project-${index}`
  });
  let now = 1_800_000_000_000;
  let upstreamCalls = 0;
  const pool = new AccountPool({ store, now: () => now, providerFactory: () => ({
    listModels: async () => [MODEL],
    send: async () => { upstreamCalls++; throw new Error('unexpected upstream request'); }
  }) });
  await pool.ensureModelCatalogs();
  const entries = [...pool.entries.values()];
  entries[0].modelCooldowns.set(MODEL, now + 60_000);
  entries[1].modelCooldowns.set(MODEL, now + 120_000);
  const dispatch = AccountPool.prototype.send;
  t.mock.method(AccountPool.prototype, 'send', function (...args) { return dispatch.call(pool, ...args); });
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    pool.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { pool, entries, upstreamCalls: () => upstreamCalls, advance: value => { now += value; },
    post: (protocol, stream = false) => fetch(`http://127.0.0.1:${server.address().port}/v1/${protocol}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(protocol === 'messages'
        ? { model: MODEL, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 128, stream }
        : { model: MODEL, input: 'Reply OK.', max_output_tokens: 128, stream })
    }) };
}

function assertErrorBody(protocol, body, code) {
  assert.equal(body.error.type, code);
  if (protocol === 'messages') assert.equal(body.type, 'error');
  else assert.equal(body.error.code, code);
}

for (const protocol of ['messages', 'responses']) {
  test(`${protocol}: original upstream 429 exposes only a validated retry delay before headers are sent`, async t => {
    const f = await fixture(t);
    let error;
    for (const entry of f.entries) entry.provider.send = async () => { throw error; };
    for (const [status, code, delay, header] of [
      [429, 'direct_upstream_error', 30, '30'],
      [429, 'direct_upstream_error', 0, null],
      [429, 'direct_upstream_error', -1, null],
      [429, 'direct_upstream_error', 1.5, null],
      [429, 'direct_upstream_error', '30', null],
      [500, 'direct_upstream_error', 30, null],
      [429, 'unverified_error', 30, null]
    ]) {
      for (const entry of f.entries) { entry.modelCooldowns.clear(); entry.cooldownUntil = 0; }
      error = Object.assign(new DirectProviderError('Original upstream failure.', { status, code }), { retryAfterSeconds: delay });
      const response = await f.post(protocol);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('retry-after'), header);
      const body = await response.json();
      assertErrorBody(protocol, body, code);
      assert.equal(body.error.message, error.message);
    }
    for (const entry of f.entries) { entry.modelCooldowns.clear(); entry.cooldownUntil = 0; }
    error = Object.assign(new DirectProviderError('Original upstream failure.', {
      status: 429, code: 'direct_upstream_error'
    }), { retryAfterSeconds: 30 });
    const streamed = await f.post(protocol, true);
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get('retry-after'), null);
    const events = (await streamed.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(protocol === 'messages' ? events[0].error.type : events[0].code, 'direct_upstream_error');
    assert.equal(f.upstreamCalls(), 0);
  });

  test(`${protocol}: model cooldown exposes Retry-After while retaining its 429 error contract`, async t => {
    const f = await fixture(t);
    const deadlines = f.entries.map(entry => entry.modelCooldowns.get(MODEL));
    for (const expected of ['60', '59']) {
      const response = await f.post(protocol);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), expected);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      const body = await response.json();
      assertErrorBody(protocol, body, 'account_pool_unavailable');
      assert.match(body.error.message, new RegExp(`最早 ${expected} 秒后可重试`));
      assert.deepEqual(f.entries.map(entry => entry.modelCooldowns.get(MODEL)), deadlines);
      f.advance(1001);
    }
    assert.equal(f.upstreamCalls(), 0);
  });

  test(`${protocol}: mixed account failures and quota protection do not advertise Retry-After`, async t => {
    const f = await fixture(t);
    f.entries[0].healthState = 'authentication_error';
    const mixed = await f.post(protocol);
    assert.equal(mixed.status, 429);
    assert.equal(mixed.headers.get('retry-after'), null);
    assertErrorBody(protocol, await mixed.json(), 'account_pool_unavailable');

    f.entries[0].healthState = 'available';
    f.pool.quotaManager = { isQuotaProtected: () => true };
    const protectedResponse = await f.post(protocol);
    assert.equal(protectedResponse.status, 429);
    assert.equal(protectedResponse.headers.get('retry-after'), null);
    assertErrorBody(protocol, await protectedResponse.json(), 'account_quota_protected');
    assert.equal(f.upstreamCalls(), 0);
  });

  test(`${protocol}: an already-started SSE response retains its original error event without new headers`, async t => {
    const f = await fixture(t);
    const response = await f.post(protocol, true);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('retry-after'), null);
    const wire = await response.text();
    const events = wire.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    if (protocol === 'messages') assert.equal(events[0].error.type, 'account_pool_unavailable');
    else {
      assert.equal(events[0].code, 'account_pool_unavailable');
      assert.equal(events[0].sequence_number, 0);
    }
    assert.equal(f.upstreamCalls(), 0);
  });
}
