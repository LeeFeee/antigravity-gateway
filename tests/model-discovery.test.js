'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Catalog, parseCatalog, toPiModels, toDshModels, listingUrl } = require('../integrations/model-discovery/catalog.cjs');

test('directory membership, capacities and fixed tier come from gateway metadata', () => {
  const models = parseCatalog({ data: [{ id: 'new-model', default_reasoning_level: 'low', input_modalities: ['text', 'image'] }],
    models: [{ slug: 'new-model', context_window: 1048576, max_output_tokens: 65536 }, { slug: 'removed-model' }] });
  const pi = toPiModels(models, { api: 'openai-responses', baseUrl: 'https://example.com/v1', models: [{ id: 'old-model' }] });
  assert.deepEqual(pi.map(m => m.id), ['new-model']);
  assert.equal(pi[0].contextWindow, 1048576);
  assert.equal(pi[0].maxTokens, 65536);
  assert.equal(pi[0].thinkingLevelMap.high, null);
  assert.equal(pi[0].thinkingLevelMap.low, 'low');
  assert.deepEqual(toDshModels(models, {})[0].reasoningEfforts, { low: 'low' });
});
test('invalid listings cannot replace the last working catalogue', () => {
  for (const body of [{}, { data: [] }, { data: [{}] }, { data: [{ id: 'a' }, { id: 'a' }] }]) assert.throws(() => parseCatalog(body));
  assert.equal(listingUrl('https://host/prefix/v1/', 'openai-responses'), 'https://host/prefix/v1/models');
  assert.equal(listingUrl('https://host/anthropic', 'anthropic-messages'), 'https://host/anthropic/v1/models');
  assert.throws(() => listingUrl('https://user:secret@host/v1', 'openai-responses'));
});
test('cache follows endpoint and credential, with failed refresh and cancellation kept distinct', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-discovery-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const opts = { baseUrl: 'https://example.invalid/v1', api: 'openai-responses', apiKey: 'private-test-key', force: true };
  global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'live-model' }], unwantedSecret: 'do-not-cache' }));
  const store = new Catalog(dir);
  assert.equal((await store.load(opts)).stale, false);
  const saved = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  assert.ok(!saved.includes(opts.apiKey) && !saved.includes('do-not-cache'));
  global.fetch = async () => { throw new Error('network offline'); };
  assert.equal((await new Catalog(dir).load(opts)).stale, true);
  await assert.rejects(store.load({ ...opts, apiKey: 'another-account' }), /network offline/);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(store.load({ ...opts, signal: controller.signal }), /cancelled/);
});
