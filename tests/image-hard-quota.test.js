'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AccountStore } = require('../src/account-store');
const { AccountPool, errorCategory, retryDelay } = require('../src/account-pool');

const IMAGE_MODEL = 'gemini-3.1-flash-image';
const MAIN_MODEL = 'gemini-3.8-flash-low';
const captured = require('./fixtures/gateway-internal-image-native-20261107/internal-image.json');
const quotaBody = captured.trace.find(item => item.type === 'native-body' && item.body?.error?.code === 429)?.body;
assert.ok(quotaBody, 'The real internal image attempt must retain its complete 429 body');
const imageBody = { response: { candidates: [{ finishReason: 'STOP', content: { parts: [
  { inlineData: { mimeType: 'image/png', data: Buffer.from('synthetic-image').toString('base64') } }
] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } } };

function provider(fetchImpl) {
  return new DirectAntigravityProvider({ accessToken: 'synthetic-token', projectId: 'synthetic-project',
    baseUrl: '', maxRetries: 1, retryBaseMs: 1, sessionStore: {}, fetchImpl });
}

test('captured hard image quota stops after one physical call and retains the original 429/reset', async () => {
  const calls = [];
  const direct = provider(async url => { calls.push(new URL(url).hostname); return Response.json(quotaBody, { status: 429 }); });
  await assert.rejects(direct.generateImage({ prompt: 'Synthetic image.' }), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'direct_image_upstream_error');
    assert.equal(errorCategory(error), 'quota');
    assert.deepEqual(JSON.parse(error.details), quotaBody);
    assert.ok(retryDelay(error.details) > 60_000);
    return true;
  });
  assert.deepEqual(calls, ['daily-cloudcode-pa.googleapis.com']);
});

test('reset without hard quota, hard quota without reset, and 5xx preserve host failover and bounded retry', async () => {
  const noReset = structuredClone(quotaBody);
  noReset.error.details = noReset.error.details.filter(item => item['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo');
  delete noReset.error.details[0].metadata.quotaResetDelay;
  delete noReset.error.details[0].metadata.quotaResetTimeStamp;
  const transient = structuredClone(quotaBody);
  transient.error.details[0].reason = 'RATE_LIMIT_EXCEEDED';
  for (const [status, body] of [[429, transient], [429, noReset], [503, quotaBody]]) {
    const calls = [];
    const direct = provider(async url => {
      calls.push(new URL(url).hostname);
      return calls.length <= 2 ? Response.json(body, { status }) : Response.json(imageBody);
    });
    const result = await direct.generateImage({ prompt: 'Synthetic image.' });
    assert.equal(result.mimeType, 'image/png');
    assert.deepEqual(calls, ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com']);
  }
});

for (const backup of [false, true]) {
  test(`hard image quota applies only the image cooldown and preserves main affinity${backup ? ' while using an eligible backup' : ''}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-hard-image-quota-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new AccountStore({ configDir: directory });
    const accounts = Array.from({ length: backup ? 2 : 1 }, (_, index) => store.save({
      email: `quota-${index}@example.test`, accessToken: `synthetic-token-${index}`, projectId: `synthetic-project-${index}`
    }));
    const calls = [], refreshes = [];
    const pool = new AccountPool({ store, providerFactory: account => {
      const index = accounts.findIndex(item => item.id === account.id);
      return provider(async (url, options) => {
        if (url.endsWith(':fetchAvailableModels')) return Response.json({
          models: { [MAIN_MODEL]: {} }, imageGenerationModelIds: [IMAGE_MODEL]
        });
        assert.ok(url.endsWith(':generateContent'));
        calls.push({ index, host: new URL(url).hostname, body: JSON.parse(options.body) });
        return index === 0 ? Response.json(quotaBody, { status: 429 }) : Response.json(imageBody);
      });
    } });
    t.after(() => pool.stop());
    pool.quotaManager = {
      isQuotaProtected: () => false,
      get: () => null,
      refreshAccount: async id => { refreshes.push(id); }
    };
    pool.bindSession('main-session', accounts[0].id);
    const binding = structuredClone(pool.sessions.get('main-session'));
    const options = { accountId: accounts[0].id, routingKey: 'main-session', bindRouting: false,
      nativeToolContext: { trajectoryId: '11111111-2222-3333-4444-555555555555', stepIndex: 2 } };
    const before = Date.now(), expectedDelay = retryDelay(JSON.stringify(quotaBody));
    if (backup) {
      const result = await pool.generateImage({ model: IMAGE_MODEL, prompt: 'Synthetic image.' }, options);
      assert.equal(result.accountId, accounts[1].id);
      assert.equal(calls[1].body.requestId.split('/').at(-1), '1');
      assert.notEqual(calls[1].body.requestId.split('/').at(-2), options.nativeToolContext.trajectoryId);
    } else {
      await assert.rejects(pool.generateImage({ model: IMAGE_MODEL, prompt: 'Synthetic image.' }, options), error => {
        assert.equal(error.status, 429);
        assert.deepEqual(JSON.parse(error.details), quotaBody);
        return true;
      });
    }
    assert.deepEqual(calls.map(({ index, host }) => [index, host]), backup
      ? [[0, 'daily-cloudcode-pa.googleapis.com'], [1, 'daily-cloudcode-pa.googleapis.com']]
      : [[0, 'daily-cloudcode-pa.googleapis.com']]);
    const first = pool.entries.get(accounts[0].id), until = first.modelCooldowns.get(IMAGE_MODEL);
    assert.ok(until >= before + expectedDelay - 1000 && until <= Date.now() + expectedDelay + 1000);
    assert.deepEqual([...first.modelCooldowns.keys()], [IMAGE_MODEL]);
    assert.equal(first.healthState, 'available');
    assert.equal(first.cooldownUntil, 0);
    assert.equal(pool.health.size, 0);
    assert.ok(refreshes.includes(accounts[0].id));
    assert.deepEqual(pool.sessions.get('main-session'), binding);
    assert.equal(pool.isEntryEligible(first, MAIN_MODEL), true);
    assert.equal(pool.isEntryEligible(first, IMAGE_MODEL), false);
  });
}
