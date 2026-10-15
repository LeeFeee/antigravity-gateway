'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { RobinAccountAuthProvider } = require('../src/robin-auth');
const { ROBIN_PHENOTYPE_PACKAGE } = require('../src/robin-phenotype');
const { messageField, stringField } = require('../src/robin-proto');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const phenotype = () => new Response(messageField(1, Buffer.concat([
  messageField(1, stringField(1, ROBIN_PHENOTYPE_PACKAGE)), stringField(4, 'server-token')
])), { status: 200 });

function harness(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-auth-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  const account = store.save({ id: 'robin-one', email: 'one@example.com', accessToken: 'old-access',
    refreshToken: 'refresh', expiresAt: '2000-01-01T00:00:00Z', providerType: 'robin', accountType: 'gemini-app' });
  const auth = new RobinAccountAuthProvider({ account, store, fetchImpl });
  t.after(() => auth.disable());
  return { auth, store, account };
}

test('Robin concurrent sessions share refresh but caller cancellation is isolated', async (t) => {
  let release, refreshSignal, calls = 0;
  const { auth } = harness(t, async (_url, options) => {
    calls++;
    if (calls > 1) return phenotype();
    refreshSignal = options.signal;
    await new Promise((resolve) => { release = resolve; });
    return Response.json({ access_token: 'new-access', expires_in: 3600 });
  });
  const controller = new AbortController();
  const first = auth.get(controller.signal);
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const second = auth.get();
  await tick();
  controller.abort();
  await rejection;
  assert.equal(refreshSignal.aborted, false);
  release();
  assert.equal((await second).accessToken, 'new-access');
  assert.equal(calls, 2, 'one OAuth call plus one configuration call');
});

test('Robin in-flight refresh neither resurrects deleted accounts nor overwrites new authorization', async (t) => {
  for (const mutation of ['delete', 'reauthorize', 'disable']) {
    let release;
    let calls = 0;
    const { auth, store, account } = harness(t, async () => {
      if (++calls === 1) return Response.json({ access_token: 'refreshed-access', expires_in: 3600 });
      await new Promise((resolve) => { release = resolve; });
      return phenotype();
    });
    const pending = auth.get();
    const rejected = assert.rejects(pending);
    await tick();
    if (mutation === 'delete') store.delete(account.id);
    if (mutation === 'reauthorize') store.update(account.id, { accessToken: 'replacement-access', refreshToken: 'replacement-refresh' });
    if (mutation === 'disable') auth.disable();
    release();
    await rejected;
    if (mutation === 'delete') assert.deepEqual(store.list(), []);
    else assert.equal(store.list()[0].accessToken, mutation === 'reauthorize' ? 'replacement-access' : 'old-access');
  }
});

test('Robin refresh preserves concurrent account configuration changes', async (t) => {
  let release, calls = 0;
  const { auth, store, account } = harness(t, async () => {
    if (++calls === 1) return Response.json({ access_token: 'new-access', expires_in: 3600 });
    await new Promise((resolve) => { release = resolve; });
    return phenotype();
  });
  const pending = auth.get();
  await tick();
  store.update(account.id, { enabled: false, weight: 7, providerMetadata: { custom: 'keep' } });
  release();
  await pending;
  const saved = store.list()[0];
  assert.equal(saved.enabled, false);
  assert.equal(saved.weight, 7);
  assert.equal(saved.providerMetadata.custom, 'keep');
  assert.equal(saved.accessToken, 'new-access');
});
