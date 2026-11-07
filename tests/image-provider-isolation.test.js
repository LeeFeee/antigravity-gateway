'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const test = require('node:test');
const png = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/gateway-media-inputs/image-fixture.png'));
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { AccountPool } = require('../src/account-pool');
const { createServer } = require('../antigravity-gateway');

async function server(t) {
  const instance = createServer();
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('unsupported image models cannot silently spend account credentials or quota', async t => {
  let cloudCalls = 0;
  t.mock.method(AccountPool.prototype, 'generateImage', async () => {
    cloudCalls++;
    return { data: png.toString('base64'), mimeType: 'image/png', accountId: 'synthetic-cloud' };
  });
  const base = await server(t);
  const generated = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-4-argon', prompt: '画一个蓝色圆形。' })
  });
  assert.equal(generated.status, 400);
  assert.equal((await generated.json()).error.type, 'unsupported_image_model');
  const form = new FormData();
  form.append('model', 'gemini-4-argon'); form.append('prompt', '把圆形改成绿色。');
  form.append('image', new Blob([Buffer.from('synthetic-input')], { type: 'image/png' }), 'reference.png');
  const edited = await fetch(`${base}/v1/images/edits`, { method: 'POST', body: form });
  assert.equal(edited.status, 400);
  assert.equal((await edited.json()).error.type, 'unsupported_image_model');
  assert.equal(cloudCalls, 0);
});

test('default image requests and the explicit historical image alias preserve the image path', async t => {
  const calls = [];
  t.mock.method(AccountPool.prototype, 'generateImage', async payload => {
    calls.push(payload);
    return { data: png.toString('base64'), mimeType: 'image/png', accountId: 'synthetic-cloud' };
  });
  const base = await server(t);
  for (const model of [undefined, 'gpt-image-1', 'gemini-3.1-flash-image']) {
    const response = await fetch(`${base}/v1/images/generations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '画一个写有 Argon 的标志。', size: '1024x1024', response_format: 'b64_json' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, 1); assert.equal(body.data[0].b64_json, png.toString('base64'));
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.aspectRatio === '1:1'));
  assert.ok(calls.every(call => call.model === 'gemini-3.1-flash-image'));
});

test('an image model discovered from the image catalog reaches the pool unchanged', async t => {
  const model = 'synthetic-image-catalog-model';
  t.mock.method(AccountPool.prototype, 'imageModelCatalog', () => [model]);
  t.mock.method(AccountPool.prototype, 'ensureModelCatalogs', async () => {});
  const calls = [];
  t.mock.method(AccountPool.prototype, 'generateImage', async payload => {
    calls.push(payload);
    return { data: png.toString('base64'), mimeType: 'image/png', accountId: 'synthetic-cloud' };
  });
  const base = await server(t);
  const response = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'Draw a blue circle.' })
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, model);
});

test('an explicit alias to an unsupported image model is rejected for both image operations', async t => {
  const previous = process.env.ANTIGRAVITY_MODEL_ALIASES;
  process.env.ANTIGRAVITY_MODEL_ALIASES = JSON.stringify({ 'native-picture': 'gemini-4-argon' });
  t.after(() => { if (previous === undefined) delete process.env.ANTIGRAVITY_MODEL_ALIASES; else process.env.ANTIGRAVITY_MODEL_ALIASES = previous; });
  let calls = 0;
  t.mock.method(AccountPool.prototype, 'generateImage', async () => { calls++; throw new Error('unexpected Cloud Code generation'); });
  const base = await server(t);
  const response = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'native-picture', prompt: '画一个蓝色圆形。' }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, 'unsupported_image_model');
  const form = new FormData();
  form.append('model', 'native-picture'); form.append('prompt', '改成绿色。');
  form.append('image', new Blob([Buffer.from('synthetic-input')], { type: 'image/png' }), 'reference.png');
  const edited = await fetch(`${base}/v1/images/edits`, { method: 'POST', body: form });
  assert.equal(edited.status, 400);
  assert.equal((await edited.json()).error.type, 'unsupported_image_model');
  assert.equal(calls, 0);
});
