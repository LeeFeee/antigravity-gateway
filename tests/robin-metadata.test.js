'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http2 = require('node:http2');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: pause } = require('node:timers/promises');
const { AccountStore } = require('../src/account-store');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { RobinGrpcTransport, RobinProvider, ARGON_MODEL, ARGON_MODE_VARIANT_ID, GET_USER_STATUS_PATH, GET_USAGE_INFO_PATH } = require('../src/robin-provider');
const { concatFields, messageField, stringField } = require('../src/robin-proto');

const tick = () => new Promise(resolve => setImmediate(resolve));
const record = { accessToken: 'test-access', serverToken: 'test-server', credentialFingerprint: 'test-fingerprint' };
const capability = () => concatFields([
  messageField(17, stringField(1, ARGON_MODE_VARIANT_ID)), messageField(18, stringField(1, ARGON_MODE_VARIANT_ID))
]);

test('Robin metadata calls have a bounded deadline even without a caller signal or an abort-aware adapter', async t => {
  let rpcSignal, authSignal;
  const provider = new RobinProvider({ metadataTimeoutMs: 10,
    auth: { account: {}, get: async signal => { authSignal = signal; return record; } },
    transport: { unary: async (rpc, token, _body, options) => {
      assert.equal(rpc, GET_USER_STATUS_PATH); assert.equal(token, record.accessToken);
      assert.equal(options.headers['x-server-token'], record.serverToken);
      rpcSignal = options.signal;
      return new Promise(() => {});
    } }
  });
  t.after(() => provider.stop());
  // Keep one ordinary timer referenced while the synthetic adapter has no IO.
  await Promise.all([pause(20), assert.rejects(provider.listModels(), error => {
    assert.equal(error.code, 'robin_deadline_exceeded'); assert.equal(error.status, 504);
    assert.equal(error.upstreamAuthFingerprint, record.credentialFingerprint);
    return true;
  })]);
  assert.equal(authSignal, rpcSignal);
  assert.equal(rpcSignal.aborted, true);
  assert.equal(provider.requestControllers.size, 0);
});

test('stopping Robin during metadata auth cancels the wait and cannot start a late status RPC', async () => {
  let finishAuth, authSignal, rpcCalls = 0;
  const provider = new RobinProvider({
    auth: { account: {}, get: signal => { authSignal = signal; return new Promise(resolve => { finishAuth = resolve; }); } },
    transport: { unary: async () => { rpcCalls++; return capability(); } }
  });
  const pending = provider.listModels();
  const rejected = assert.rejects(pending, { code: 'request_aborted' });
  await tick(); provider.stop(); await rejected;
  finishAuth(record); await tick();
  assert.equal(authSignal.aborted, true);
  assert.equal(rpcCalls, 0);
  assert.equal(provider.requestControllers.size, 0);
});

test('one cancelled metadata caller does not cancel another probe on the same Robin account', async t => {
  const calls = [];
  const provider = new RobinProvider({ auth: { account: {}, get: async () => record },
    transport: { unary: (_rpc, _token, _body, { signal }) => new Promise(resolve => { calls.push({ signal, resolve }); }) }
  });
  t.after(() => provider.stop());
  const controller = new AbortController();
  const first = provider.listModels(controller.signal);
  const rejected = assert.rejects(first, /one caller cancelled/);
  const second = provider.listModels();
  await tick(); assert.equal(calls.length, 2);
  controller.abort(new Error('one caller cancelled')); await rejected;
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, false);
  calls[1].resolve(capability());
  assert.deepEqual(await second, [ARGON_MODEL]);
  calls[0].resolve(capability()); await tick();
  assert.equal(provider.requestControllers.size, 0);
});

test('provider stop also cancels a quota RPC and discards a late adapter response', async () => {
  let finish, rpcSignal;
  const provider = new RobinProvider({ auth: { account: {}, get: async () => record },
    transport: { unary: (rpc, _token, _body, { signal }) => {
      assert.equal(rpc, GET_USAGE_INFO_PATH); rpcSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    } }
  });
  const pending = provider.getQuota();
  const rejected = assert.rejects(pending, { code: 'request_aborted' });
  await tick(); provider.stop(); await rejected;
  finish(Buffer.alloc(0)); await tick();
  assert.equal(rpcSignal.aborted, true);
  assert.equal(provider.requestControllers.size, 0);
});

test('metadata cancellation closes an actual HTTP/2 gRPC stream stalled on a loopback peer', async t => {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', session => { sessions.add(session); session.on('error', () => {}); session.on('close', () => sessions.delete(session)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const session of sessions) session.destroy(); server.close(resolve); }));
  let resolveReceived, resolveClosed, observedHeaders, observedStream;
  const received = new Promise(resolve => { resolveReceived = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  server.on('stream', (stream, headers) => {
    observedStream = stream; observedHeaders = headers;
    stream.on('error', () => {});
    stream.on('close', resolveClosed);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    resolveReceived();
    // Deliberately never send a response body or completion trailers.
  });
  let client;
  const transport = new RobinGrpcTransport({ origin: `http://127.0.0.1:${server.address().port}`,
    connectImpl: origin => { client = http2.connect(origin); return client; } });
  const provider = new RobinProvider({ auth: { account: {}, get: async () => record }, transport });
  t.after(() => provider.stop());
  const pending = provider.listModels();
  const rejected = assert.rejects(pending, { code: 'request_aborted', status: 499 });
  await received;
  assert.equal(observedHeaders[':path'], GET_USER_STATUS_PATH);
  assert.equal(observedHeaders.authorization, `Bearer ${record.accessToken}`);
  provider.stop(); await rejected; await closed;
  assert.equal(observedStream.rstCode, http2.constants.NGHTTP2_CANCEL);
  assert.equal(client.closed, true);
  assert.equal(provider.requestControllers.size, 0);
});

function poolHarness(t, providerFactory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-metadata-'));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  store.save({ id: 'a', accessToken: 'test', providerType: 'robin', accountType: 'gemini-app', capabilities: ['old-model'] });
  const pool = new RobinAccountPool({ store, providerFactory });
  t.after(() => { pool.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { pool, store };
}

test('cancelled or stopped pool catalog queries never turn into cached successful replies', async t => {
  let finish;
  const { pool } = poolHarness(t, () => ({ listModels: () => new Promise(resolve => { finish = resolve; }) }));
  const controller = new AbortController();
  const pending = pool.listModels(controller.signal, { force: true });
  const rejected = assert.rejects(pending, /cancel catalogue/);
  await tick(); controller.abort(new Error('cancel catalogue'));
  finish([ARGON_MODEL]); await rejected;
  pool.stop();
  await assert.rejects(pool.listModels(undefined, { force: true }), { name: 'AbortError' });
});

test('failed old metadata queries cannot advertise deleted or reauthorized account capabilities', async t => {
  for (const mutation of ['delete', 'reauthorize']) {
    let rejectQuery;
    const { pool, store } = poolHarness(t, account => ({ listModels: account.id === 'a'
      ? () => new Promise((_, reject) => { rejectQuery = reject; })
      : async () => ['healthy-model'] }));
    store.save({ id: 'b', accessToken: 'test', providerType: 'robin', accountType: 'gemini-app', capabilities: ['healthy-model'] });
    const pending = pool.listModels(undefined, { force: true });
    await tick();
    if (mutation === 'delete') pool.removeAccount('a');
    else store.update('a', { refreshToken: 'new-grant', capabilities: [] });
    rejectQuery(new Error('old request closed'));
    assert.deepEqual(await pending, ['healthy-model']);
    assert.equal(pool.status().find(account => account.id === 'b').state, 'available');
  }
});

test('ordinary directory refresh respects account quarantine and cooldown; an explicit recheck can recover', async t => {
  for (const category of ['account', 'quota', 'transient']) {
    let queries = 0;
    const { pool } = poolHarness(t, () => ({
      auth: { get: async () => record },
      listModels: async () => { queries++; return [ARGON_MODEL]; }
    }));
    const entry = pool.entries.get('a');
    pool.saveHealth(entry, category, category === 'account' ? 'authentication_error' : 'cooldown', 'temporarily unavailable',
      category === 'account' ? Infinity : Date.now() + 60_000);
    assert.deepEqual(await pool.listModels(undefined, { force: true }), ['old-model']);
    assert.deepEqual(await pool.listModels(undefined, { force: true }), ['old-model']);
    assert.equal(queries, 0, category);
    const result = await pool.recheckAccount('a');
    assert.equal(result.recovered, true);
    assert.equal(result.state, 'available');
    assert.deepEqual(result.models, [ARGON_MODEL]);
    assert.equal(queries, 1, 'only the explicit recheck contacts the provider');
  }
});

test('Robin model refresh removes obsolete experimental capability metadata', async t => {
  const { pool, store } = poolHarness(t, () => ({ listModels: async () => [ARGON_MODEL] }));
  store.update('a', { providerMetadata: { keep: 'value', robinCapabilities: {
    thinkingLevels: ['low', 'high'], fetchedAt: '2026-10-15T00:00:00.000Z'
  } } });
  assert.deepEqual(await pool.listModels(undefined, { force: true }), [ARGON_MODEL]);
  assert.equal(store.list()[0].providerMetadata.robinCapabilities, undefined);
  assert.equal(store.list()[0].providerMetadata.keep, 'value');
  assert.equal('thinkingLevels' in pool.status()[0], false);
});
