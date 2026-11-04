'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { GeminiAccountStore } = require('../src/gemini-account-store');
const { AccountPool } = require('../src/account-pool');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { probeAccountInference } = require('../src/account-recheck');
const tick = () => new Promise(resolve => setImmediate(resolve));
const MODEL = 'gemini-4-argon';
const denial = () => Object.assign(new Error('This service has been disabled: TOS_VIOLATION'), { status: 403 });

function fixture(t, channel, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-recheck-'));
  const cloud = channel === 'cloudcode';
  const store = cloud ? new AccountStore({ configDir: dir }) : new GeminiAccountStore({ configDir: dir });
  const record = store.save({ id: 'a', subjectId: 'test-a', email: 'a@example.com', accessToken: 'test-access', refreshToken: 'test-refresh',
    providerType: cloud ? 'cloudcode' : 'robin', accountType: cloud ? 'antigravity' : 'gemini-app', capabilities: [MODEL],
    authMethod: channel === 'windows' ? 'gemini-windows-session' : 'oauth',
    providerMetadata: channel === 'windows' ? { geminiWindows: { cookies: [{ name: 'SID', value: 'test', domain: '.google.com' }] } } : {} });
  let attempts = 0;
  const provider = {
    localAuth: { account: record }, auth: { account: record, get: async () => ({}) },
    probeAuthentication: async () => ({ ok: true, status: 200 }), listModels: async () => [MODEL],
    send: async (...args) => { attempts++; return send(...args); }
  };
  const pool = cloud ? new AccountPool({ store, providerFactory: () => provider }) : new RobinAccountPool({ store, providerFactory: () => provider });
  const entry = pool.entries.get('a');
  if (cloud) pool.markAccountIssue(entry, denial());
  else pool.saveHealth(entry, 'account', 'access_denied', 'TOS_VIOLATION', Infinity);
  // Verification must not change any client's account affinity.
  if (cloud) pool.bindSession('existing-conversation', 'a'); else pool.bind('existing-conversation', 'a');
  t.after(() => { pool.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { pool, provider, store, entry, attempts: () => attempts, state: () => pool.status().find(a => a.id === 'a')?.state };
}

for (const channel of ['cloudcode', 'oauth', 'windows']) {
  test(`${channel}: catalog success alone never restores an unavailable account`, async t => {
    let outcome = denial();
    const f = fixture(t, channel, async (input, model, options) => {
      assert.equal(model, MODEL); assert.deepEqual(input.tools, []);
      assert.equal(input.messages.length, 1); assert.equal(input.messages[0].role, 'user');
      assert.match(options.sessionId, /^account-recheck-/); assert.equal(options.reuseConversation, false);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    for (const failure of [denial(), Object.assign(new Error('quota exceeded'), { status: 429 }),
      Object.assign(new Error('network timeout'), { status: 502 }), { text: '', toolCalls: [] },
      { text: 'calling tool', toolCalls: [{ id: 'unexpected' }] }]) {
      outcome = failure;
      await assert.rejects(f.pool.recheckAccount('a'));
      f.pool.reload(); assert.equal(f.state(), 'access_denied');
    }
    outcome = { text: 'OK', toolCalls: [] };
    const recovered = await f.pool.recheckAccount('a');
    assert.equal(recovered.recovered, true); assert.equal(f.state(), 'available');
    assert.equal(f.pool.sessions.size, 1); assert.equal(f.pool.sessions.get('existing-conversation').accountId, 'a');
    assert.equal(f.attempts(), 6);
  });

  test(`${channel}: concurrent manual rechecks share one inference request`, async t => {
    let resolve;
    const f = fixture(t, channel, () => new Promise(done => { resolve = done; }));
    const first = f.pool.recheckAccount('a'), second = f.pool.recheckAccount('a');
    await tick(); assert.equal(f.attempts(), 1); assert.equal(f.state(), 'access_denied');
    resolve({ text: 'OK', toolCalls: [] });
    assert.ok((await first).recovered); assert.ok((await second).recovered);
    assert.equal(f.pool.rechecks.size, 0);
  });

  test(`${channel}: cancelled recheck cannot restore an account after a late answer`, async t => {
    let resolve;
    const f = fixture(t, channel, () => new Promise(done => { resolve = done; }));
    const controller = new AbortController();
    const pending = f.pool.recheckAccount('a', { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await tick(); controller.abort(); resolve({ text: 'OK', toolCalls: [] });
    await rejected; assert.equal(f.state(), 'access_denied'); assert.equal(f.pool.rechecks.size, 0);
  });

  for (const mutation of ['delete', 'replace', 'disable']) test(`${channel}: late inference cannot restore a ${mutation}d account`, async t => {
    let resolve;
    const f = fixture(t, channel, () => new Promise(done => { resolve = done; }));
    const pending = f.pool.recheckAccount('a');
    const rejected = assert.rejects(pending, { code: channel === 'cloudcode' ? 'account_recheck_changed' : 'robin_credentials_changed' });
    await tick();
    if (mutation === 'delete') f.pool.removeAccount('a');
    else f.store.update('a', mutation === 'disable' ? { enabled: false } : { refreshToken: 'different-grant' });
    resolve({ text: 'OK', toolCalls: [] }); await rejected;
    const latest = f.store.list().find(a => a.id === 'a');
    if (mutation === 'delete') assert.equal(latest, undefined);
    else assert.equal(latest.lastSuccessAt || '', '');
  });
}

test('Cloud Code reproduces catalog HTTP 200 followed by inference HTTP 403/TOS without recovery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-real-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: dir }); store.save({ id: 'a', accessToken: 'test-access', projectId: 'test' });
  const calls = [];
  const pool = new AccountPool({ store, providerFactory: () => new DirectAntigravityProvider({
    localAuth: null, accessToken: 'test-access', projectId: 'test', authFile: '', maxRetries: 0,
    baseUrl: 'https://example.invalid', sessionStore: new AgySessionStore({ directory: '' }),
    fetchImpl: async url => {
      calls.push(url);
      return url.includes('fetchAvailableModels') ? Response.json({ models: { 'gemini-test-flash': {} } })
        : Response.json({ error: { code: 403, message: 'This service has been disabled: TOS_VIOLATION', status: 'PERMISSION_DENIED' } }, { status: 403 });
    }
  }) });
  t.after(() => pool.stop()); pool.markAccountIssue(pool.entries.get('a'), denial());
  await assert.rejects(pool.recheckAccount('a'), error => error.status === 403 && /TOS_VIOLATION/.test(error.message));
  assert.equal(calls.filter(url => url.includes('streamGenerateContent')).length, 1);
  assert.equal(pool.status()[0].state, 'access_denied');
});

test('Cloud Code token renewal during failed recheck keeps quarantine across reload and restart', async t => {
  let f;
  f = fixture(t, 'cloudcode', async () => { throw Object.assign(new Error('network timeout'), { status: 502 }); });
  f.provider.probeAuthentication = async () => {
    const renewed = f.store.update('a', { accessToken: 'refreshed-access' });
    f.provider.localAuth.account = renewed;
    f.pool.reload(); assert.equal(f.state(), 'access_denied');
    return { ok: true };
  };
  await assert.rejects(f.pool.recheckAccount('a'));
  f.pool.reload(); assert.equal(f.state(), 'access_denied');
  const restored = new AccountPool({ store: f.store, providerFactory: () => f.provider });
  assert.equal(restored.status()[0].state, 'access_denied'); restored.stop();
});

test('manual inference selects a text model and refuses an image-only catalog', async () => {
  let selected;
  const provider = { send: async (_input, model) => { selected = model; return { text: 'OK' }; } };
  await probeAccountInference(provider, ['gemini-image', 'claude-sonnet', 'gemini-flash-low']);
  assert.equal(selected, 'gemini-flash-low');
  await assert.rejects(probeAccountInference(provider, ['gemini-image']), { code: 'account_recheck_model_missing' });
});

test('Robin OAuth renewal cannot clear quarantine after unsuccessful inference', async t => {
  const f = fixture(t, 'oauth', async () => { throw new Error('network timeout'); });
  f.provider.auth.get = async () => {
    f.provider.auth.account = f.store.update('a', { accessToken: 'renewed-access' });
    f.pool.reload(); assert.equal(f.state(), 'access_denied');
    return {};
  };
  await assert.rejects(f.pool.recheckAccount('a'));
  f.pool.reload(); assert.equal(f.state(), 'access_denied');
  const restored = new RobinAccountPool({ store: f.store, providerFactory: () => f.provider });
  assert.equal(restored.status()[0].state, 'access_denied'); restored.stop();
});
