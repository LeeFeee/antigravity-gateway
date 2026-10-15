'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { RobinAccountAuthProvider } = require('../src/robin-auth');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { ARGON_MODEL } = require('../src/robin-provider');
const { ROBIN_PHENOTYPE_PACKAGE } = require('../src/robin-phenotype');
const { concatFields, messageField, stringField } = require('../src/robin-proto');

const input = { messages: [{ role: 'user', parts: [{ type: 'text', text: '读取笔记。' }] }], tools: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t, sendImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-grant-rotation-'));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  store.save({ id: 'a', subjectId: 'google-a', email: 'a@example.com', accessToken: 'access-0',
    refreshToken: 'refresh-0', expiresAt: '2000-01-01T00:00:00Z',
    providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  const stats = { refreshes: 0, stopped: 0, providers: 0 };
  const fetchImpl = async url => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const number = ++stats.refreshes;
      return Response.json({ access_token: `access-${number}`, refresh_token: `refresh-${number}`, expires_in: 3600 });
    }
    return new Response(messageField(1, concatFields([
      messageField(1, stringField(1, ROBIN_PHENOTYPE_PACKAGE)), stringField(4, 'synthetic-server')
    ])), { status: 200 });
  };
  let pool;
  pool = new RobinAccountPool({ store, providerFactory: account => {
    stats.providers++;
    const auth = new RobinAccountAuthProvider({ account, store, fetchImpl });
    return {
      auth,
      stop: () => { stats.stopped++; },
      send: async (_input, _model, options) => {
        const record = await auth.get(options.signal);
        pool.reload();
        return sendImpl ? sendImpl(record, options) : { text: 'done', toolCalls: [], usageKnown: false,
          upstreamAuthFingerprint: record.credentialFingerprint };
      },
      listModels: async signal => { await auth.get(signal); return [ARGON_MODEL]; },
      getQuota: async signal => { await auth.get(signal); return { groups: [] }; }
    };
  } });
  t.after(() => { pool.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { pool, store, stats };
}

test('OAuth refresh-token rotation preserves the current Robin tool task, account and affinity', async t => {
  let turns = 0;
  const { pool, store, stats } = harness(t, (record, options) => {
    turns++;
    assert.equal(options.requireExistingTurn, turns > 1);
    return { text: turns > 1 ? 'done' : '', toolCalls: turns > 1 ? []
      : [{ id: 'read_1', name: 'read_note', arguments: {} }], usageKnown: false,
      upstreamAuthFingerprint: record.credentialFingerprint };
  });
  const original = pool.entries.get('a');
  const options = { clientId: 'client', sessionId: 'conversation', routingKey: 'affinity' };
  const first = await pool.send(input, ARGON_MODEL, options);
  assert.equal(first.toolCalls.length, 1);
  assert.equal(pool.entries.get('a'), original);
  assert.equal(pool.activeTasks.size, 1);
  assert.equal(pool.sessions.get('affinity').accountId, 'a');
  assert.equal(store.list()[0].refreshToken, 'refresh-1');
  const second = await pool.send({ ...input, messages: [{ role: 'user', parts: [
    { type: 'tool_result', id: 'read_1', content: '笔记内容' }
  ] }] }, ARGON_MODEL, options);
  assert.equal(second.text, 'done');
  assert.equal(second.accountId, 'a');
  assert.equal(pool.activeTasks.size, 0);
  assert.equal(stats.providers, 1);
  assert.equal(stats.stopped, 0);
});

test('catalog, quota and explicit recheck accept only auth-provider-owned refresh-token rotation', async t => {
  for (const operation of ['catalog', 'quota', 'recheck']) {
    const { pool, store, stats } = harness(t);
    const original = pool.entries.get('a');
    if (operation === 'catalog') assert.deepEqual(await pool.listModels(undefined, { force: true }), [ARGON_MODEL]);
    if (operation === 'quota') assert.ok(await pool.refreshQuota('a'));
    if (operation === 'recheck') assert.equal((await pool.recheckAccount('a')).recovered, true);
    assert.equal(store.list()[0].refreshToken, 'refresh-1');
    pool.reload();
    assert.equal(pool.entries.get('a'), original, operation);
    assert.equal(stats.providers, 1);
    assert.equal(stats.stopped, 0);
  }
});

test('external replacement after a legitimate refresh still invalidates the old task and its late reply', async t => {
  let finish;
  const { pool, store, stats } = harness(t, record => new Promise(resolve => { finish = () => resolve({
    text: 'obsolete', toolCalls: [], usageKnown: false, upstreamAuthFingerprint: record.credentialFingerprint
  }); }));
  const pending = pool.send(input, ARGON_MODEL, { clientId: 'client', sessionId: 'conversation', routingKey: 'affinity' });
  const rejected = assert.rejects(pending, { code: 'robin_credentials_changed', status: 409 });
  while (!finish) await tick();
  assert.equal(store.list()[0].refreshToken, 'refresh-1');
  const old = pool.entries.get('a');
  store.update('a', { accessToken: 'external-access', refreshToken: 'external-refresh' });
  pool.reload();
  assert.notEqual(pool.entries.get('a'), old);
  finish();
  await rejected;
  assert.equal(stats.stopped, 1);
  assert.equal(pool.activeTasks.size, 0);
  assert.equal(store.list()[0].refreshToken, 'external-refresh');
  assert.equal(store.list()[0].providerMetadata.robinHealth, undefined);
});

test('successive owned refreshes retain one operation generation but cannot accept an externally restored older grant', async t => {
  const { pool, store, stats } = harness(t);
  const original = pool.entries.get('a');
  const auth = original.provider.auth;
  const generation = auth.authorizationKey;
  for (let number = 1; number <= 3; number++) {
    await auth.get(undefined, { forceRefresh: true });
    pool.reload();
    assert.equal(pool.entries.get('a'), original);
    assert.equal(auth.authorizationKey, generation);
    assert.equal(pool.currentAccount(original, generation).refreshToken, `refresh-${number}`);
  }
  const older = { ...store.list()[0], refreshToken: 'refresh-1' };
  assert.equal(auth.matchesAuthorization(generation, older), false);
  assert.equal(auth.matchesAuthorization('unrelated-generation', store.list()[0]), false);
  assert.equal(auth.matchesAuthorization(generation, { ...store.list()[0], subjectId: 'different-google-user' }), false);
  store.update('a', { accessToken: 'restored-old-access', refreshToken: 'refresh-1' });
  pool.reload();
  assert.notEqual(pool.entries.get('a'), original);
  assert.equal(pool.currentAccount(original, generation), null);
  assert.equal(stats.stopped, 1);
});
