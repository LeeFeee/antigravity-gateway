'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
const { AccountPool } = require('../src/account-pool');
const { codexModelInfo, createServer } = require('../antigravity-gateway');

test('model capability flags and MIME metadata replace the unconditional image promise', t => {
  let metadata = null;
  t.mock.method(AccountPool.prototype, 'modelInfo', () => metadata);
  assert.deepEqual(codexModelInfo('unknown-model', 0).input_modalities, ['text']);
  metadata = { supportsImages: false, supportsVideo: true, supportsAudio: false,
    supportedMimeTypes: { 'image/png': true, 'video/mp4': true, 'audio/wav': true } };
  const video = codexModelInfo('video-only', 0);
  assert.deepEqual(video.input_modalities, ['text']);
  assert.equal(video.supports_images, false); assert.equal(video.supports_video, true); assert.equal(video.supports_audio, false);
  assert.equal(video.supports_image_detail_original, false);
  assert.deepEqual(video.supported_mime_types, metadata.supportedMimeTypes);
  video.supported_mime_types['video/mp4'] = false;
  assert.equal(metadata.supportedMimeTypes['video/mp4'], true, 'catalog edits cannot mutate account metadata');
  metadata = { supportsImages: true, supportedMimeTypes: { 'audio/wav': true, 'video/mp4': false } };
  const image = codexModelInfo('mixed-input', 0);
  assert.deepEqual(image.input_modalities, ['text', 'image']);
  assert.equal(image.supports_audio, true); assert.equal(image.supports_video, false);
  assert.equal(image.supports_image_detail_original, false, 'ordinary image support does not establish original-detail capability');
});

test('captured model names expose a single fixed level; budget configurations do not invent level choices', t => {
  t.mock.method(AccountPool.prototype, 'modelInfo', () => ({ supportsThinking: true, thinkingLevel: 1 }));
  for (const level of ['high', 'medium', 'low']) {
    const model = codexModelInfo('gemini-3.8-flash-' + level, 0);
    assert.equal(model.default_reasoning_level, level);
    assert.deepEqual(model.supported_reasoning_levels.map(item => item.effort), [level]);
    assert.equal(model.fixed_thinking_config.thinkingLevel, level.toUpperCase());
  }
  const budget = codexModelInfo('gpt-oss-120b-medium', 0);
  assert.equal(budget.default_reasoning_level, null);
  assert.deepEqual(budget.supported_reasoning_levels, []);
  assert.equal(budget.fixed_thinking_config.thinkingBudget, 8192);
  t.mock.method(AccountPool.prototype, 'modelInfo', () => null);
  const unknown = codexModelInfo('unverified-high', 0);
  assert.equal(unknown.default_reasoning_level, null);
  assert.deepEqual(unknown.supported_reasoning_levels, []);
  assert.equal(Object.hasOwn(unknown, 'fixed_thinking_config'), false);
});

test('actual model directory preserves media metadata separately from the Codex input enum', async t => {
  const model = 'gemini-3.8-flash-high';
  t.mock.method(AccountPool.prototype, 'hasManagedAccounts', () => true);
  t.mock.method(AccountPool.prototype, 'listModels', async () => [model]);
  t.mock.method(AccountPool.prototype, 'imageModelCatalog', () => ['gemini-3.1-flash-image']);
  t.mock.method(AccountPool.prototype, 'modelInfo', () => ({ displayName: 'Verified metadata model', maxTokens: 123456,
    supportsImages: false, supportsVideo: true, supportsAudio: true, supportedMimeTypes: { 'video/mp4': true, 'audio/wav': true } }));
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json(), data = body.data[0], codex = body.models[0];
  assert.deepEqual(body.image_generation_model_ids, ['gemini-3.1-flash-image']);
  assert.equal(data.display_name, 'Verified metadata model');
  assert.equal(data.supports_images, false); assert.equal(data.supports_video, true); assert.equal(data.supports_audio, true);
  assert.deepEqual(data.supported_mime_types, { 'video/mp4': true, 'audio/wav': true });
  assert.deepEqual(codex.input_modalities, ['text']);
  assert.equal(codex.context_window, 123456);
  assert.deepEqual(data.supported_reasoning_levels.map(value => value.effort), ['high']);
});
