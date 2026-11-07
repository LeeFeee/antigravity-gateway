'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { AccountPool } = require('../src/account-pool');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { imageModelName } = require('../src/image-model-config');

function poolFixture(t, catalogs, { failFirst = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-image-models-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  const accounts = catalogs.map((_, index) => store.save({ email: `${index}@example.test`,
    accessToken: `synthetic-${index}`, refreshToken: `synthetic-refresh-${index}`, projectId: `project-${index}`,
    createdAt: new Date(1700000000000 + index * 1000).toISOString() }));
  const requests = [], usage = [], selected = [];
  const pool = new AccountPool({ store, usageStore: { recordUpstream: event => usage.push(event) },
    providerFactory: account => {
      const index = accounts.findIndex(item => item.id === account.id);
      return new DirectAntigravityProvider({ accessToken: 'synthetic-token', projectId: account.projectId,
        baseUrl: 'https://synthetic.invalid', maxRetries: 0,
        fetchImpl: async (url, options) => {
          const body = JSON.parse(options.body);
          if (url.endsWith(':fetchAvailableModels')) return Response.json({ models: {}, imageGenerationModelIds: catalogs[index] });
          assert.ok(url.endsWith(':generateContent'));
          requests.push({ index, body });
          if (failFirst && index === 0) return Response.json({ error: { message: 'synthetic exhausted' } }, { status: 429 });
          return Response.json({ response: { candidates: [{ content: { parts: [
            { inlineData: { mimeType: 'image/png', data: Buffer.from('synthetic png').toString('base64') } }
          ] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } } });
        }
      });
    }
  });
  t.after(() => pool.stop());
  return { pool, accounts, requests, usage, selected,
    options: { onAccountSelected: value => selected.push(value) } };
}

test('image selection, account support, request payload, usage and result use the same discovered model', async t => {
  const model = 'synthetic-image-model';
  const { pool, accounts, requests, usage, selected, options } = poolFixture(t,
    [['gemini-3.1-flash-image'], [model]]);
  const result = await pool.generateImage({ model, prompt: 'A blue circle.' }, options);
  assert.equal(result.accountId, accounts[1].id);
  assert.equal(result.model, model, 'missing upstream modelVersion must fall back to the requested model');
  assert.deepEqual(selected.map(item => [item.accountId, item.model]), [[accounts[1].id, model]]);
  assert.deepEqual(requests.map(item => [item.index, item.body.model, item.body.requestType]), [[1, model, 'image_gen']]);
  assert.ok(usage.length > 0 && usage.every(item => item.model === model));
  assert.deepEqual(pool.imageModelCatalog(), ['gemini-3.1-flash-image', model]);
});

test('a new image model 429 cools only that selected model and preserves the normal pool switch', async t => {
  const model = 'synthetic-image-model';
  const { pool, accounts, requests, options } = poolFixture(t, [[model], [model]], { failFirst: true });
  const result = await pool.generateImage({ model, prompt: 'A blue circle.' }, options);
  assert.equal(result.accountId, accounts[1].id);
  assert.deepEqual(requests.map(item => item.index), [0, 1]);
  const cooldowns = pool.entries.get(accounts[0].id).modelCooldowns;
  assert.ok(cooldowns.get(model) > Date.now());
  assert.equal(cooldowns.has('gemini-3.1-flash-image'), false);
});

test('unknown image IDs are rejected before generation and aliases stay explicit', async t => {
  const { pool, requests } = poolFixture(t, [['gemini-3.1-flash-image']]);
  await assert.rejects(pool.generateImage({ model: 'synthetic-unknown-image', prompt: 'Draw.' }), { code: 'unsupported_image_model' });
  assert.equal(requests.length, 0);
  assert.equal(await pool.resolveImageModel('gpt-image-1'), 'gemini-3.1-flash-image');
  assert.equal(imageModelName(undefined, 'synthetic-default-image'), 'synthetic-default-image');
  assert.equal(imageModelName('gpt-image-1', 'synthetic-default-image'), 'gemini-3.1-flash-image');
  assert.throws(() => imageModelName({}), { code: 'unsupported_image_model' });
});

test('image generation inherits only its original account trajectory and keeps fallback isolated', async t => {
  const model = 'gemini-3.1-flash-image';
  const { pool, accounts, requests, options } = poolFixture(t, [[model], [model]], { failFirst: true });
  const trajectoryId = '11111111-2222-3333-4444-555555555555';
  const result = await pool.generateImage({ model, prompt: 'A blue circle.' }, { ...options,
    accountId: accounts[0].id, nativeToolContext: { trajectoryId, stepIndex: 2 }, bindRouting: false });
  assert.equal(result.accountId, accounts[1].id);
  assert.deepEqual(requests.map(item => item.index), [0, 1]);
  assert.equal(requests[0].body.requestId.split('/').slice(-2).join('/'), `${trajectoryId}/2`);
  assert.notEqual(requests[1].body.requestId.split('/').at(-2), trajectoryId);
  assert.equal(requests[1].body.requestId.split('/').at(-1), '1');
});
