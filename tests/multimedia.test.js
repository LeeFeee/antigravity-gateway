'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MediaStore, mediaPartFromBlock } = require('../src/multimedia');
const { buildDirectRequest, DirectAntigravityProvider } = require('../src/direct-provider');
const { normalizeAnthropic, prepareNativeMultimodal } = require('../src/protocol');

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Anthropic, Chat and Responses media blocks normalize to one canonical shape', () => {
  const encoded = Buffer.from('image-data').toString('base64');
  const anthropic = mediaPartFromBlock({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: encoded } }, 'anthropic');
  assert.equal(anthropic.type, 'media');
  assert.match(anthropic.id, /^media_/);
  assert.equal(anthropic.mediaType, 'image/png');
  assert.equal(anthropic.data, encoded);
  const chat = mediaPartFromBlock({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${encoded}`, detail: 'high' } }, 'chat');
  assert.equal(chat.mediaType, 'image/jpeg');
  assert.equal(chat.data, encoded);
  assert.equal(chat.detail, 'high');
  const responses = mediaPartFromBlock({ type: 'input_video', video_url: 'https://example.com/demo.mp4' }, 'responses');
  assert.equal(responses.url, 'https://example.com/demo.mp4');
});

test('media store persists uploads and resolves file IDs for an account scope', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-media-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new MediaStore({ directory });
  const saved = store.save(Buffer.from('abc'), { filename: 'sample.png', mediaType: 'image/png', scope: 'scope-a' });
  const resolved = await store.resolve({ type: 'media', fileId: saved.id }, { scope: 'scope-a' });
  assert.equal(Buffer.from(resolved.data, 'base64').toString(), 'abc');
  await assert.rejects(() => store.resolve({ type: 'media', fileId: saved.id }, { scope: 'scope-b' }), /找不到多媒体文件/);
});

test('stored file metadata replaces a generic input MIME type', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-media-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new MediaStore({ directory });
  const saved = store.save(Buffer.from('png'), { filename: 'reference.png', mediaType: 'image/png', scope: 'scope-a' });
  const resolved = await store.resolve({ type: 'media', fileId: saved.id, mediaType: 'application/octet-stream' }, { scope: 'scope-a' });
  assert.equal(resolved.mediaType, 'image/png');
});

test('a generated gateway file URL resolves locally without a network fetch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-media-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new MediaStore({ directory, fetchImpl: async () => { throw new Error('network should not be used'); } });
  const saved = store.save(Buffer.from('image'), { filename: 'generated.jpg', mediaType: 'image/jpeg', scope: 'scope-a' });
  const resolved = await store.resolve({ type: 'media', url: `http://gateway.example/v1/files/${saved.id}/content` }, { scope: 'scope-a' });
  assert.equal(resolved.fileId, saved.id);
  assert.equal(resolved.mediaType, 'image/jpeg');
  assert.equal(Buffer.from(resolved.data, 'base64').toString(), 'image');
});

test('native multimodal preparation lets the model choose image generation without keyword routing', () => {
  const normalized = normalizeAnthropic({
    model: 'gemini-test',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('x').toString('base64') } },
      { type: 'text', text: 'Use this however the task requires.' }
    ] }]
  });
  const prepared = prepareNativeMultimodal(normalized);
  assert.equal(prepared.imageToolInjected, true);
  assert.equal(prepared.normalized.tools.at(-1).name, 'generate_image');
  assert.match(prepared.normalized.system, /attachment by itself never means/i);
  assert.doesNotMatch(prepared.normalized.system, /gateway/i);
  const request = buildDirectRequest(prepared.normalized, 'gemini-test', 'project', 'session');
  assert.equal(request.request.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(request.request.tools[0].functionDeclarations.at(-1).name, 'generate_image');
});

test('explicit client tool choice is preserved and does not inject the native image tool', () => {
  const normalized = {
    model: 'gemini-test', system: '', messages: [{ role: 'user', text: 'run it', parts: [{ type: 'text', text: 'run it' }] }],
    tools: [{ name: 'shell', description: '', schema: { type: 'object' } }],
    toolChoice: { type: 'tool', name: 'shell' }, stream: false, structuredSchema: null, autoMode: false
  };
  const prepared = prepareNativeMultimodal(normalized);
  assert.equal(prepared.imageToolInjected, false);
  assert.deepEqual(prepared.normalized.tools.map((tool) => tool.name), ['shell']);
});

test('private image generation mirrors the captured agy image_gen request', async () => {
  const seen = [];
  const provider = new DirectAntigravityProvider({
    localAuth: {
      isConfigured: () => true,
      get: async () => ({ accessToken: 'token', refreshToken: 'refresh', projectId: 'aicode-consumers', expiry: new Date(Date.now() + 60_000) })
    },
    maxRetries: 0,
    fetchImpl: async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body) });
      return response({ response: {
        candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') } }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
        modelVersion: 'gemini-3.1-flash-image'
      } });
    }
  });
  const reference = Buffer.from('ref').toString('base64');
  const result = await provider.generateImage({ prompt: 'turn it green', aspectRatio: '1:1', images: [{ mediaType: 'image/png', data: reference }] });
  assert.equal(result.data, Buffer.from('jpeg').toString('base64'));
  assert.equal(seen[0].url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
  assert.equal(seen[0].body.requestType, 'image_gen');
  assert.equal(seen[0].body.model, 'gemini-3.1-flash-image');
  assert.deepEqual(seen[0].body.request.contents[0].parts, [
    { text: 'turn it green' },
    { inlineData: { mimeType: 'image/png', data: reference } }
  ]);
});
