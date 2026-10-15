'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { MediaStore, canonicalMedia, mediaPartFromBlock } = require('../src/multimedia');
const { normalizeAnthropic, normalizeChat, normalizeResponses } = require('../src/protocol');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { robinAttachment } = require('../src/robin-provider');
const { decodeFields, firstField, stringValue } = require('../src/robin-proto');
const { createServer } = require('../antigravity-gateway');
const bytes = Buffer.from('%PDF-1.7\n附件字节保持原样\n');
const encoded = bytes.toString('base64');
const fileData = 'data:application/pdf;base64,' + encoded;
const blocks = {
  messages: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData, filename: 'note.pdf' } },
  'chat/completions': { type: 'file', file: { filename: 'note.pdf', file_data: fileData } },
  responses: { type: 'input_file', filename: 'note.pdf', file_data: fileData }
};
const normalizers = { messages: normalizeAnthropic, 'chat/completions': normalizeChat, responses: normalizeResponses };
function payload(endpoint, model, block = blocks[endpoint]) {
  return { model, max_tokens: 32, ...(endpoint === 'responses'
    ? { input: [{ role: 'user', content: [block] }] }
    : { messages: [{ role: 'user', content: [block] }] }) };
}

test('inline file data URLs normalize to the same exact bytes and MIME in all three protocols', () => {
  for (const endpoint of Object.keys(blocks)) {
    const normalized = normalizers[endpoint](payload(endpoint, 'gemini-4-argon'));
    const media = normalized.messages[0].parts.find(part => part.type === 'media');
    assert.ok(media, endpoint); assert.equal(media.mediaType, 'application/pdf', endpoint);
    assert.equal(media.filename, 'note.pdf', endpoint);
    assert.equal(media.data, encoded, endpoint);
    assert.deepEqual(Buffer.from(media.data, 'base64'), bytes, endpoint);
  }
});

test('standard Chat file wrappers preserve uploaded IDs and filenames without losing legacy flat files', () => {
  const id = 'file_' + 'a'.repeat(32);
  const nested = mediaPartFromBlock({ type: 'file', file: { file_id: id, filename: 'clip.mp4' } }, 'chat');
  assert.equal(nested.fileId, id); assert.equal(nested.filename, 'clip.mp4');
  const flat = mediaPartFromBlock({ type: 'file', file_id: id, filename: 'clip.mp4' }, 'chat');
  assert.equal(flat.fileId, id); assert.equal(flat.filename, 'clip.mp4');
});

test('generic MIME uses the existing filename type map; explicit types and unknown extensions keep their meaning', () => {
  for (const [filename, mime] of [['clip.MP4', 'video/mp4'], ['scene.png', 'image/png'], ['sound.wav', 'audio/wav'], ['note.pdf', 'application/pdf']]) {
    assert.equal(canonicalMedia({ filename, mediaType: 'application/octet-stream', data: encoded }).mediaType, mime);
  }
  assert.equal(canonicalMedia({ filename: 'scene.png', mediaType: 'image/jpeg', data: encoded }).mediaType, 'image/jpeg');
  assert.equal(canonicalMedia({ filename: 'opaque.bin', mediaType: 'application/octet-stream', data: encoded }).mediaType, 'application/octet-stream');
  assert.equal(canonicalMedia({ filename: 'note.pdf', data: encoded }).data, encoded);
});

test('Files uploads and old generic metadata resolve by filename while retaining scope checks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-compatible-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new MediaStore({ directory });
  const saved = store.save(bytes, { filename: 'clip.mp4', mediaType: 'application/octet-stream', scope: 'caller' });
  assert.equal(saved.mediaType, 'video/mp4');
  const metadata = JSON.parse(fs.readFileSync(store.metadataPath(saved.id), 'utf8'));
  metadata.mediaType = 'application/octet-stream';
  fs.writeFileSync(store.metadataPath(saved.id), JSON.stringify(metadata));
  const media = await store.resolve({ type: 'media', fileId: saved.id, mediaType: 'application/octet-stream' }, { scope: 'caller' });
  assert.equal(media.mediaType, 'video/mp4'); assert.deepEqual(Buffer.from(media.data, 'base64'), bytes);
  await assert.rejects(store.resolve({ type: 'media', fileId: saved.id }, { scope: 'other' }), { code: 'media_file_not_found' });
});

test('malformed inline data URLs are rejected instead of being partially decoded as a corrupt file', () => {
  for (const data of ['data:application/pdf;base64,%%%invalid%%%', 'data:application/pdf,not-base64', 'data:application/pdf;base64,']) {
    assert.throws(() => canonicalMedia({ filename: 'note.pdf', data }), { code: 'invalid_media' });
  }
});

test('the unified attachment shape produces the correct Cloud Code inline data and Robin native file types', () => {
  // These are wire-format checks with synthetic bytes, not semantic media tests.
  for (const [filename, mime, nativeType] of [['clip.mp4', 'video/mp4', 2], ['scene.png', 'image/png', 1], ['sound.wav', 'audio/wav', 4], ['note.pdf', 'application/pdf', 11]]) {
    const normalized = normalizeResponses(payload('responses', 'gemini-4-argon', {
      type: 'input_file', filename, mime_type: 'application/octet-stream', file_data: encoded
    }));
    const part = normalized.messages[0].parts.find(part => part.type === 'media');
    const cloud = buildDirectRequest(normalized, 'synthetic-cloud', 'synthetic-project', 'synthetic-session');
    assert.deepEqual(cloud.request.contents[0].parts.find(part => part.inlineData).inlineData, { mimeType: mime, data: encoded });
    const attachment = decodeFields(robinAttachment({ ...part, robinBlobId: '/contrib_service/ttl_1d/synthetic' }));
    const blob = decodeFields(firstField(attachment, 1, 2).value);
    assert.equal(Number(firstField(blob, 2, 0).value), nativeType);
    assert.equal(stringValue(firstField(blob, 3, 2)), mime);
  }
});

test('real protocol handlers deliver file data URL bytes unchanged to either provider and reject bad input before dispatch', async t => {
  const calls = [];
  t.mock.method(DirectAntigravityProvider.prototype, 'isConfigured', () => true);
  t.mock.method(RobinAccountPool.prototype, 'listModels', async () => ['gemini-4-argon']);
  const receive = provider => async (input, model) => {
    calls.push({ provider, input, model });
    return { text: '收到笔记。', toolCalls: [], usage: provider === 'robin' ? null : {}, usageKnown: provider !== 'robin' };
  };
  t.mock.method(DirectAntigravityProvider.prototype, 'send', receive('cloudcode'));
  t.mock.method(RobinAccountPool.prototype, 'send', receive('robin'));
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const model of ['gemini-4-argon', 'gemini-cloud-test']) for (const endpoint of Object.keys(blocks)) {
    const response = await fetch(base + '/v1/' + endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(endpoint, model)) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const call = calls.at(-1), part = call.input.messages[0].parts.find(part => part.type === 'media');
    assert.equal(call.provider, model === 'gemini-4-argon' ? 'robin' : 'cloudcode');
    assert.equal(part.mediaType, 'application/pdf');
    assert.deepEqual(Buffer.from(part.data, 'base64'), bytes);
    assert.equal(part.data, encoded);
  }
  assert.equal(calls.length, 6);
  const bad = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload('responses', 'gemini-4-argon', { type: 'input_file', filename: 'note.pdf', file_data: 'data:application/pdf;base64,%%%' })) });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error.type, 'invalid_media');
  assert.equal(calls.length, 6);
});
