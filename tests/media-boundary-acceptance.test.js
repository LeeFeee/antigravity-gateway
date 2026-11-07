'use strict';

// Real HTTP handlers, account scheduling, normalization and Direct provider;
// only the final transport is replaced with a loopback synthetic Google server.
const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const KEY = 'synthetic-media-boundary-key';
const MODEL = 'gemini-3.8-flash-high';
const SINGLE_LIMIT = 10000, TOTAL_LIMIT = 15000;
process.env.ANTIGRAVITY_GATEWAY_API_KEY = KEY;
process.env.ANTIGRAVITY_GATEWAY_MEDIA_LIMIT = String(SINGLE_LIMIT);
process.env.ANTIGRAVITY_GATEWAY_TOTAL_MEDIA_LIMIT = String(TOTAL_LIMIT);
process.env.ANTIGRAVITY_DIRECT_MAX_RETRIES = '0';
process.env.ANTIGRAVITY_DIRECT_RETRY_POLICY = 'legacy';
delete process.env.ANTIGRAVITY_GATEWAY_DEBUG;

const fixtures = path.join(__dirname, 'fixtures/gateway-media-inputs');
const png = fs.readFileSync(path.join(fixtures, 'image-fixture.png'));
const mp4 = fs.readFileSync(path.join(fixtures, 'video-fixture.mp4'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const owner = { authorization: `Bearer ${KEY}` };
// Both authentication forms are valid; credentialScope deliberately distinguishes them.
const otherScope = { 'x-api-key': KEY };
let gateway, upstream, base, store;
const requests = [], generation = [], upstreamErrors = [];

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
}
function media(endpoint, kind, bytes, mime = kind === 'video' ? 'video/mp4' : 'image/png') {
  return endpoint === 'messages'
    ? { type: kind, source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } }
    : { type: `input_${kind}`, [`${kind}_url`]: `data:${mime};base64,${bytes.toString('base64')}` };
}
function text(endpoint, value) { return { type: endpoint === 'messages' ? 'text' : 'input_text', text: value }; }
function payload(endpoint, content, extra = {}) {
  return { model: MODEL, max_tokens: 64, ...(endpoint === 'messages'
    ? { messages: [{ role: 'user', content }] } : { input: [{ role: 'user', content }] }), ...extra };
}
async function request(route, body, { method = 'POST', auth = owner, session = '', raw = false } = {}) {
  const response = await fetch(base + route, { method, headers: { ...auth,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { 'x-session-id': session } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes,
    body: raw || !bytes.length ? null : JSON.parse(bytes.toString('utf8')) };
}
const send = (endpoint, body, options) => request(`/v1/${endpoint}`, body, options);
async function upload(bytes, filename, media_type) {
  const result = await request('/v1/files', { filename, media_type, data: bytes.toString('base64') });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
function inlineParts(call) { return call.request.contents.flatMap(item => item.parts || []).filter(part => part.inlineData); }
function assertMedia(part, bytes, mime) {
  assert.equal(part.inlineData.mimeType, mime);
  assert.equal(part.inlineData.data, bytes.toString('base64'));
  assert.deepEqual(Buffer.from(part.inlineData.data, 'base64'), bytes);
  assert.equal(digest(Buffer.from(part.inlineData.data, 'base64')), digest(bytes));
}
function assertError(result, status, type) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.type, type, JSON.stringify(result.body));
  assert.ok(result.body.error.message);
}

test.before(async () => {
  assert.equal(png.length, 186); assert.equal(mp4.length, 8999);
  assert.equal(digest(png), '1951c0eba94f38034442b3e0cdbcecd1f033c5d73265616cf2dfef49f8663da7');
  assert.equal(digest(mp4), '17ce432bfbce3c7ac17881b97156ee227082375d338ad3d57811a1ca06b5bed4');
  upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requests.push({ path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith(':fetchAvailableModels')) return res.end(JSON.stringify({ models: { [MODEL]: {
        displayName: 'Synthetic media fixture model', maxTokens: 1048576, maxOutputTokens: 65536,
        supportsImages: true, supportsVideo: true, supportedMimeTypes: { 'image/png': true, 'video/mp4': true }
      } } }));
      if (req.url.endsWith(':retrieveUserQuotaSummary')) return res.end('{"groups":[]}');
      if (req.url.endsWith(':loadCodeAssist')) return res.end('{"cloudaicompanionProject":"synthetic-media-project"}');
      assert.match(req.url, /^\/v1internal:streamGenerateContent\?alt=sse$/);
      generation.push(body);
      const mismatch = inlineParts(body).some(part => part.inlineData.mimeType === 'image/jpeg'
        && Buffer.from(part.inlineData.data, 'base64').equals(png));
      if (mismatch) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'SYNTHETIC_MIME_MISMATCH: PNG bytes declared as image/jpeg' } }));
      }
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{
        text: 'SYNTHETIC_MEDIA_ANSWER', thoughtSignature: 'synthetic-media-signature'
      }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 } } }) + '\n\n');
    } catch (error) {
      upstreamErrors.push(error.message); res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const upstreamBase = await listen(upstream);
  process.env.ANTIGRAVITY_DIRECT_BASE_URL = upstreamBase;
  const originalFetch = globalThis.fetch;
  const allowed = new Set([upstreamBase]);
  const guardedFetch = (input, options) => {
    assert.ok(allowed.has(new URL(String(input)).origin), 'Test denies non-loopback fixture network');
    return originalFetch(input, options);
  };
  test.mock.method(globalThis, 'fetch', guardedFetch);
  test.mock.method(require('../src/agy-native-transport'), 'nativeCloudCodeFetch', guardedFetch);
  const { AccountStore } = require('../src/account-store');
  new AccountStore({ configDir: directory }).save({ id: 'synthetic-media-account', email: 'media@example.invalid',
    subjectId: 'synthetic-media-subject', accessToken: 'synthetic-not-a-real-google-token',
    expiresAt: new Date(Date.now() + 86400000).toISOString(), projectId: 'synthetic-media-project',
    providerType: 'cloudcode', accountType: 'antigravity', authMethod: 'oauth', capabilities: [MODEL] });
  const { MediaStore } = require('../src/multimedia');
  store = new MediaStore({ directory: path.join(directory, 'media') });
  gateway = require('../antigravity-gateway').createServer();
  base = await listen(gateway); allowed.add(base);
});
test.after(async () => {
  await close(gateway); await close(upstream);
  assert.deepEqual(upstreamErrors, []);
  test.mock.restoreAll();
});

for (const endpoint of ['messages', 'responses']) {
  test(`${endpoint}: mixed text/image/video order and original valid bytes survive full HTTP forwarding`, async () => {
    const content = [text(endpoint, 'BEFORE'), media(endpoint, 'image', png), text(endpoint, 'BETWEEN'),
      media(endpoint, 'video', mp4), text(endpoint, 'AFTER'), media(endpoint, 'image', png)];
    const result = await send(endpoint, payload(endpoint, content));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const parts = generation.at(-1).request.contents[0].parts;
    assert.deepEqual(parts.map(part => part.text ?? part.inlineData?.mimeType),
      ['BEFORE', 'image/png', 'BETWEEN', 'video/mp4', 'AFTER', 'image/png']);
    assertMedia(parts[1], png, 'image/png'); assertMedia(parts[3], mp4, 'video/mp4'); assertMedia(parts[5], png, 'image/png');
  });

  test(`${endpoint}: single-file and aggregate byte limits reject locally with zero upstream requests`, async () => {
    const start = requests.length;
    const oversized = Buffer.alloc(SINGLE_LIMIT + 1, 0x61);
    assertError(await send(endpoint, payload(endpoint, [media(endpoint, 'video', oversized)])), 413, 'media_too_large');
    assertError(await send(endpoint, payload(endpoint, [media(endpoint, 'video', mp4), media(endpoint, 'video', mp4)])), 413, 'media_total_too_large');
    assert.equal(requests.length, start);
  });
}

test('Files: upload/readback, scoped references, deletion and missing backing data fail clearly without upstream traffic', async () => {
  const saved = await upload(mp4, 'clip.mp4', 'video/mp4');
  const readback = await request(`/v1/files/${saved.id}/content`, undefined, { method: 'GET', raw: true });
  assert.equal(readback.status, 200); assert.deepEqual(readback.bytes, mp4);
  const reference = { type: 'input_video', file_id: saved.id };
  const accepted = await send('responses', payload('responses', [reference]));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assertMedia(inlineParts(generation.at(-1))[0], mp4, 'video/mp4');
  const start = requests.length;
  assertError(await request(`/v1/files/${saved.id}`, undefined, { method: 'GET', auth: otherScope }), 404, 'file_not_found');
  assertError(await request(`/v1/files/${saved.id}`, undefined, { method: 'DELETE', auth: otherScope }), 404, 'file_not_found');
  assertError(await send('responses', payload('responses', [reference]), { auth: otherScope }), 404, 'media_file_not_found');
  const deleted = await request(`/v1/files/${saved.id}`, undefined, { method: 'DELETE' });
  assert.deepEqual(deleted.body, { id: saved.id, object: 'file', deleted: true });
  assert.equal(deleted.status, 200);
  assertError(await request(`/v1/files/${saved.id}`, undefined, { method: 'GET' }), 404, 'file_not_found');
  assertError(await request(`/v1/files/${saved.id}`, undefined, { method: 'DELETE' }), 404, 'file_not_found');
  assertError(await send('responses', payload('responses', [reference])), 404, 'media_file_not_found');
  assertError(await send('messages', payload('messages', [{ type: 'video', source: { type: 'file', file_id: saved.id } }])), 404, 'media_file_not_found');
  const missing = await upload(png, 'missing.png', 'image/png');
  fs.unlinkSync(store.contentPath(missing.id));
  assertError(await send('responses', payload('responses', [{ type: 'input_image', file_id: missing.id }])), 404, 'media_file_not_found');
  assert.equal(requests.length, start);
});

test('Files: private upload GET/HEAD enforce auth and scope; generated artifacts retain anonymous public delivery', async () => {
  const saved = await upload(png, 'private.png', 'image/png');
  const start = requests.length;
  for (const method of ['GET', 'HEAD']) {
    const route = `/v1/files/${saved.id}/content`;
    const owned = await request(route, undefined, { method, raw: true });
    assert.equal(owned.status, 200); assert.equal(owned.headers.get('content-length'), String(png.length));
    assert.deepEqual(owned.bytes, method === 'HEAD' ? Buffer.alloc(0) : png);
    assert.equal((await request(route, undefined, { method, auth: {}, raw: true })).status, 401);
    assert.equal((await request(route, undefined, { method, auth: otherScope, raw: true })).status, 404);
  }
  const generated = store.saveGeneratedImage(png, { filename: 'generated.png', mediaType: 'image/png', scope: 'synthetic-private-owner' });
  for (const method of ['GET', 'HEAD']) {
    const result = await request(`/v1/files/${generated.id}/content`, undefined, { method, auth: {}, raw: true });
    assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/png');
    assert.deepEqual(result.bytes, method === 'HEAD' ? Buffer.alloc(0) : png);
  }
  assert.equal(requests.length, start);
});

test('Files upload rejects an oversized object before persistence or upstream traffic', async () => {
  const before = fs.readdirSync(path.join(directory, 'media')).sort(), start = requests.length;
  const result = await request('/v1/files', { filename: 'too-large.bin', media_type: 'application/octet-stream', data: Buffer.alloc(SINGLE_LIMIT + 1).toString('base64') });
  assertError(result, 413, 'media_too_large');
  assert.deepEqual(fs.readdirSync(path.join(directory, 'media')).sort(), before);
  assert.equal(requests.length, start);
});

test('byte limits are inclusive: exact single-file and aggregate limits still reach upstream unchanged', async () => {
  const exactlySingle = Buffer.alloc(SINGLE_LIMIT, 0x61);
  const saved = await upload(exactlySingle, 'exact-single.txt', 'text/plain');
  const first = await send('responses', payload('responses', [{ type: 'input_file', file_id: saved.id }]));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assertMedia(inlineParts(generation.at(-1))[0], exactlySingle, 'text/plain');
  const complement = Buffer.alloc(TOTAL_LIMIT - mp4.length, 0x62);
  const second = await send('responses', payload('responses', [media('responses', 'video', mp4), {
    type: 'input_file', filename: 'exact-total.txt', file_data: `data:text/plain;base64,${complement.toString('base64')}`
  }]));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const parts = inlineParts(generation.at(-1));
  assert.equal(parts.length, 2); assertMedia(parts[0], mp4, 'video/mp4'); assertMedia(parts[1], complement, 'text/plain');
});

test('Responses previous_response_id preserves original video across turns and rejects foreign or deleted-file continuations', async () => {
  const session = 'media-response-continuation';
  const saved = await upload(mp4, 'history.mp4', 'video/mp4');
  const first = await send('responses', payload('responses', [text('responses', 'Watch this.'), { type: 'input_video', file_id: saved.id }]), { session });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const original = structuredClone(generation.at(-1).request.contents[0]);
  const secondPayload = payload('responses', [text('responses', 'Recall the clip.')], { previous_response_id: first.body.id });
  const second = await send('responses', secondPayload, { session });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const contents = generation.at(-1).request.contents;
  assert.deepEqual(contents[0], original); assertMedia(inlineParts(generation.at(-1))[0], mp4, 'video/mp4');
  assert.equal(contents[1].parts[0].thoughtSignature, 'synthetic-media-signature');
  const start = requests.length;
  assertError(await send('responses', secondPayload, { session, auth: otherScope }), 400, 'previous_response_not_found');
  assertError(await send('responses', payload('responses', [media('responses', 'video', mp4)], {
    previous_response_id: second.body.id
  }), { session }), 413, 'media_total_too_large');
  await request(`/v1/files/${saved.id}`, undefined, { method: 'DELETE' });
  assertError(await send('responses', payload('responses', [text('responses', 'Again.')], { previous_response_id: second.body.id }), { session }), 404, 'media_file_not_found');
  assert.equal(requests.length, start);
});

test('Messages multi-turn replay retains original video and restores the matching synthetic answer signature', async () => {
  const session = 'media-messages-continuation';
  const firstPayload = payload('messages', [text('messages', 'Watch this.'), media('messages', 'video', mp4)]);
  const first = await send('messages', firstPayload, { session });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const original = structuredClone(generation.at(-1).request.contents[0]);
  const second = await send('messages', { ...firstPayload, messages: [...firstPayload.messages,
    { role: 'assistant', content: first.body.content }, { role: 'user', content: 'Recall the clip.' }] }, { session });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const contents = generation.at(-1).request.contents;
  assert.deepEqual(contents[0], original); assertMedia(inlineParts(generation.at(-1))[0], mp4, 'video/mp4');
  assert.equal(contents[1].parts[0].thoughtSignature, 'synthetic-media-signature');
});

for (const endpoint of ['messages', 'responses']) {
  test(`${endpoint}: mismatched declared MIME reaches fake upstream byte-identically and its rejection remains visible`, async () => {
    const start = generation.length;
    const result = await send(endpoint, payload(endpoint, [media(endpoint, 'image', png, 'image/jpeg')]));
    assertError(result, 400, 'direct_upstream_error');
    assert.match(result.body.error.message, /SYNTHETIC_MIME_MISMATCH/);
    assert.equal(generation.length, start + 1);
    assertMedia(inlineParts(generation.at(-1))[0], png, 'image/jpeg');
  });
}

test('malformed inline data URL is rejected locally rather than decoded or re-encoded', async () => {
  const start = requests.length;
  const result = await send('responses', payload('responses', [{ type: 'input_image', image_url: 'data:image/png;base64,%%%invalid%%%' }]));
  assertError(result, 400, 'invalid_media_url');
  const file = await send('responses', payload('responses', [{ type: 'input_file', filename: 'bad.png', file_data: 'data:image/png;base64,%%%invalid%%%' }]));
  assertError(file, 400, 'invalid_media'); assert.equal(requests.length, start);
});
