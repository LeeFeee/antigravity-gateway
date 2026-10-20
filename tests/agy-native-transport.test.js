'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgyNativeTransport, resolveNativeBinary } = require('../src/agy-native-transport');

async function fixture(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-test-'));
  const binary = resolveNativeBinary({ cacheDir: directory });
  const transport = new AgyNativeTransport({ binaryPath: binary });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    transport.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { transport, url: `http://127.0.0.1:${server.address().port}`, directory, binary };
}

test('native bridge preserves agy HTTP framing and streams a large response with backpressure', async t => {
  let seen;
  const content = 'event payload\n'.repeat(100000);
  const { transport, url } = await fixture(t, (req, res) => {
    seen = { headers: req.headers, rawHeaders: req.rawHeaders, version: req.httpVersion };
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      seen.body = body;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(content);
    });
  });
  const response = await transport.fetch(url, { method: 'POST',
    headers: { authorization: 'Bearer local-test', 'user-agent': 'agy-test', 'content-type': 'application/json', accept: 'text/event-stream' },
    body: '{"hello":true}' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), content);
  assert.equal(seen.version, '1.1');
  assert.equal(seen.headers['transfer-encoding'], 'chunked');
  assert.equal(seen.headers['content-length'], undefined);
  assert.equal(seen.headers['accept-encoding'], 'gzip');
  assert.equal(seen.headers.accept, undefined);
  assert.equal(seen.headers['sec-fetch-mode'], undefined);
  assert.equal(seen.body, '{"hello":true}');
  assert.deepEqual(seen.rawHeaders.filter((_, i) => i % 2 === 0), [
    'Host', 'User-Agent', 'Transfer-Encoding', 'Authorization', 'Content-Type', 'Accept-Encoding'
  ]);
});

test('native bridge isolates simultaneous requests', async t => {
  const { transport, url } = await fixture(t, (req, res) => {
    const delay = Number(req.url.slice(1)) * 2;
    setTimeout(() => res.end(`answer:${req.url}`), delay);
  });
  const values = await Promise.all(Array.from({ length: 12 }, async (_, i) => (await transport.fetch(`${url}/${i}`)).text()));
  assert.deepEqual(values, Array.from({ length: 12 }, (_, i) => `answer:/${i}`));
});

test('native metadata RPCs use captured Content-Length and retain exact UTF-8 bytes', async t => {
  const seen = [];
  const { transport, url } = await fixture(t, (req, res) => {
    const parts = [];
    req.on('data', part => parts.push(part));
    req.on('end', () => {
      seen.push({ headers: req.headers, rawHeaders: req.rawHeaders, bytes: Buffer.concat(parts) });
      res.writeHead(204); res.end();
    });
  });
  const body = '{"project":"测试-project"}';
  for (const endpoint of ['fetchAvailableModels', 'retrieveUserQuotaSummary', 'loadCodeAssist', 'fetchUserInfo', 'fetchAdminControls', 'listExperiments']) {
    const response = await transport.fetch(`${url}/v1internal:${endpoint}`, { method: 'POST', body,
      headers: { authorization: 'Bearer local-test', 'user-agent': 'agy-test', 'content-type': 'application/json' } });
    assert.equal(response.status, 204);
    const r = seen.at(-1);
    assert.equal(r.headers['content-length'], String(Buffer.byteLength(body)));
    assert.equal(r.headers['transfer-encoding'], undefined);
    assert.deepEqual(r.bytes, Buffer.from(body));
    assert.deepEqual(r.rawHeaders.filter((_, i) => i % 2 === 0), [
      'Host', 'User-Agent', 'Content-Length', 'Authorization', 'Content-Type', 'Accept-Encoding'
    ]);
  }
});

test('metadata framing selection does not change generation or uncaptured paths', async t => {
  const seen = [];
  const { transport, url } = await fixture(t, (req, res) => {
    req.resume(); req.on('end', () => { seen.push(req.headers); res.end('OK'); });
  });
  for (const endpoint of ['streamGenerateContent?alt=sse', 'generateContent', 'fetchAvailableModelsExtra']) {
    assert.equal(await (await transport.fetch(`${url}/v1internal:${endpoint}`, { method: 'POST', body: '{"test":true}' })).text(), 'OK');
    assert.equal(seen.at(-1)['transfer-encoding'], 'chunked');
    assert.equal(seen.at(-1)['content-length'], undefined);
  }
});

test('native bridge aborts before headers without breaking another request', async t => {
  const { transport, url } = await fixture(t, (req, res) => { if (req.url === '/ok') res.end('ok'); });
  const controller = new AbortController();
  const pending = transport.fetch(`${url}/wait`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(await (await transport.fetch(`${url}/ok`)).text(), 'ok');
});

test('native bridge propagates cancellation after response headers', async t => {
  const { transport, url } = await fixture(t, (req, res) => { res.writeHead(200); res.write('first'); });
  const controller = new AbortController();
  const response = await transport.fetch(url, { signal: controller.signal });
  const reading = response.text();
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
});

test('native bridge cancels unread response bodies and supports no-content responses', async t => {
  const { transport, url } = await fixture(t, (req, res) => {
    if (req.url === '/empty') { res.writeHead(204); res.end(); }
    else { res.writeHead(200); res.write('partial'); }
  });
  const partial = await transport.fetch(url);
  await partial.body.cancel();
  const response = await transport.fetch(`${url}/empty`);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

test('native bridge does not follow redirects or expose credentials in errors', async t => {
  const { transport, url } = await fixture(t, (req, res) => {
    if (req.url === '/target') throw new Error('redirect must not be followed');
    res.writeHead(302, { location: '/target' }); res.end();
  });
  const response = await transport.fetch(url, { headers: { authorization: 'Bearer secret-token' } });
  assert.equal(response.status, 302);
  await response.text();
  await assert.rejects(transport.fetch('http://127.0.0.1:1/private?token=secret-token'), error => {
    assert.doesNotMatch(error.message, /secret-token|private/); return true;
  });
});

test('native executable cache is verified before execution', async t => {
  const { directory, binary } = await fixture(t, (req, res) => res.end());
  fs.writeFileSync(binary, 'not a valid helper');
  assert.throws(() => resolveNativeBinary({ cacheDir: directory }), { code: 'native_transport_integrity' });
});

test('native TLS matches captured agy extensions, including signature algorithms beyond JA3', async t => {
  const expected = require('./fixtures/agy-1.4.2-tls.json');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-hello-'));
  const binary = resolveNativeBinary({ cacheDir: directory });
  const sockets = new Set();
  let captured;
  const hello = new Promise(resolve => { captured = resolve; });
  const proxy = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let stage = 'connect', buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'connect') {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        assert.match(buffer.subarray(0, end).toString(), /^CONNECT daily-cloudcode-pa\.googleapis\.com:443 HTTP\/1\.1/);
        buffer = buffer.subarray(end + 4); stage = 'tls';
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      }
      if (stage === 'tls' && buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt16BE(3)) {
        captured(buffer.subarray(5, 5 + buffer.readUInt16BE(3))); stage = 'done';
      }
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const transport = new AgyNativeTransport({ binaryPath: binary, env: { ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '', no_proxy: '' } });
  t.after(async () => {
    transport.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const request = transport.fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  const handshake = await Promise.race([hello, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('no ClientHello')), 5000); timer.unref(); })]);
  controller.abort(); await rejected;
  assert.equal(handshake[0], 1);
  const raw = handshake.subarray(4);
  let offset = 0;
  const uint16 = () => { const n = raw.readUInt16BE(offset); offset += 2; return n; };
  assert.equal(uint16(), expected.legacyVersion);
  offset += 32;
  const sessionLength = raw[offset++]; assert.equal(sessionLength, expected.sessionIdLength); offset += sessionLength;
  const cipherLength = uint16(), cipherEnd = offset + cipherLength, ciphers = [];
  while (offset < cipherEnd) ciphers.push(uint16());
  assert.deepEqual(ciphers, expected.cipherSuites);
  const compressionLength = raw[offset++]; offset += compressionLength;
  const extensionLength = uint16(), end = offset + extensionLength, extensions = [], keyShares = [];
  while (offset < end) {
    const type = uint16(), length = uint16(), value = raw.subarray(offset, offset + length); offset += length;
    if (type !== 51) extensions.push([type, value.toString('hex')]);
    else for (let p = 2; p < value.length;) {
      const group = value.readUInt16BE(p), bytes = value.readUInt16BE(p + 2); p += 4;
      keyShares.push({ group, bytes }); p += bytes;
    }
  }
  assert.deepEqual(extensions, expected.extensions);
  assert.deepEqual(keyShares, [{ group: 4588, bytes: 1216 }, { group: 29, bytes: 32 }]);
});
