'use strict';
const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const KEY = 'synthetic-media-security-key';
process.env.ANTIGRAVITY_GATEWAY_API_KEY = KEY;
delete process.env.ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS;
delete process.env.ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS;
const { MediaStore } = require('../src/multimedia');
const { AccountPool } = require('../src/account-pool');
const { createServer } = require('../antigravity-gateway');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/gateway-media-inputs/image-fixture.png'));
const owner = { authorization: `Bearer ${KEY}` };
let base, server, calls = 0;
const store = new MediaStore({ directory: path.join(directory, 'media') });

test.before(async () => {
  test.mock.method(AccountPool.prototype, 'send', async () => { calls++; return { text: 'ok', toolCalls: [], usage: {} }; });
  test.mock.method(AccountPool.prototype, 'generateImage', async () => ({ data: png.toString('base64'), mimeType: 'image/png', usage: {} }));
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  test.mock.restoreAll();
});
function post(route, body, headers = owner) {
  return fetch(base + route, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('JSON and multipart uploads cannot reserve generated purpose or forge server-owned origin', async () => {
  const html = Buffer.from('<html><script>document.title="synthetic"</script></html>');
  for (const purpose of ['generated', ' Generated ']) {
    const result = await post('/v1/files', { filename: 'audit.html', media_type: 'text/html', purpose,
      origin: 'gateway-generated-image-v1', visibility: 'public', data: html.toString('base64') });
    assert.equal(result.status, 400); assert.equal((await result.json()).error.type, 'reserved_file_purpose');
    const form = new FormData(); form.set('purpose', purpose);
    form.set('file', new Blob([html], { type: 'text/html' }), 'audit.html');
    const multipart = await fetch(base + '/v1/files', { method: 'POST', headers: owner, body: form });
    assert.equal(multipart.status, 400); assert.equal((await multipart.json()).error.type, 'reserved_file_purpose');
  }
  const result = await post('/v1/files', { filename: 'safe.png', media_type: 'image/png', data: png.toString('base64'),
    origin: 'gateway-generated-image-v1', visibility: 'public', sha256: '0'.repeat(64) });
  assert.equal(result.status, 200); const uploaded = await result.json();
  assert.equal(uploaded.origin, 'client-upload'); assert.equal(uploaded.visibility, 'private');
  assert.equal((await fetch(`${base}/v1/files/${uploaded.id}/content`)).status, 401);
});

test('HTML/SVG and MIME-spoofed uploads stay private and download as sandboxed attachments', async () => {
  for (const [mime, filename, text] of [
    ['text/html', 'audit.html', '<script>document.title="synthetic"</script>'],
    ['image/svg+xml', 'audit.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
    ['image/png', 'pretend.png', '<html><script>1</script></html>']
  ]) {
    const uploaded = await post('/v1/files', { filename, media_type: mime, data: Buffer.from(text).toString('base64') });
    assert.equal(uploaded.status, 200); const { id } = await uploaded.json();
    const route = `${base}/v1/files/${id}/content`;
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await fetch(route, { method })).status, 401);
      assert.equal((await fetch(route, { method, headers: { 'x-api-key': KEY } })).status, 404);
      const download = await fetch(route, { method, headers: owner });
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition'), /^attachment;/);
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('content-security-policy'), /sandbox/);
      assert.equal(await download.text(), method === 'HEAD' ? '' : text);
    }
  }
});

test('legacy generated purpose does not grant anonymous access, while real generated images retain public URLs', async () => {
  const old = await post('/v1/files', { filename: 'old.png', media_type: 'image/png', data: png.toString('base64') });
  const { id } = await old.json();
  const metadata = JSON.parse(fs.readFileSync(store.metadataPath(id), 'utf8'));
  metadata.purpose = 'generated'; delete metadata.origin; delete metadata.visibility;
  fs.writeFileSync(store.metadataPath(id), JSON.stringify(metadata));
  assert.equal((await fetch(`${base}/v1/files/${id}/content`)).status, 401);
  const owned = await fetch(`${base}/v1/files/${id}/content`, { headers: owner });
  assert.equal(owned.status, 200); assert.deepEqual(Buffer.from(await owned.arrayBuffer()), png);

  const generated = await post('/v1/images/generations', { prompt: 'Synthetic image.', response_format: 'url' });
  assert.equal(generated.status, 200); const result = await generated.json();
  for (const method of ['GET', 'HEAD']) {
    const publicImage = await fetch(result.data[0].url, { method });
    assert.equal(publicImage.status, 200); assert.equal(publicImage.headers.get('content-type'), 'image/png');
    assert.match(publicImage.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : png);
  }
});

test('default HTTP media paths are denied even on loopback and with forwarded-client headers', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'media-canary-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const canary = path.join(temporary, 'canary.txt'); fs.writeFileSync(canary, 'synthetic-private-canary');
  const start = calls;
  const headers = { ...owner, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' };
  for (const block of [{ type: 'input_file', file_path: canary }, { type: 'input_file', file_url: pathToFileURL(canary).href }]) {
    const response = await post('/v1/responses', { model: 'gemini-3.8-flash-high', input: [{ role: 'user', content: [block] }] }, headers);
    assert.equal(response.status, 403); assert.equal((await response.json()).error.type, 'media_local_path_not_allowed');
  }
  const message = await post('/v1/messages', { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: [
    { type: 'document', source: { type: 'file', file_path: canary } }
  ] }] });
  assert.equal(message.status, 403); assert.equal((await message.json()).error.type, 'media_local_path_not_allowed');
  assert.equal(calls, start);
});

test('non-object JSON is a client error for both protocols, uploads, images and token counting', async () => {
  const start = calls;
  for (const route of ['/v1/messages', '/v1/responses', '/v1/files', '/v1/images/generations', '/v1/messages/count_tokens']) {
    for (const value of [null, [], 'string', 1, true]) {
      const result = await post(route, value);
      assert.equal(result.status, 400, route); assert.equal((await result.json()).error.type, 'invalid_request_body');
    }
  }
  assert.equal(calls, start);
});
