'use strict';
const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'media-trusted-http-'));
const inputRoot = path.join(workspace, 'input'); fs.mkdirSync(inputRoot);
const canary = path.join(inputRoot, 'canary.txt'); fs.writeFileSync(canary, 'synthetic-allowed-media');
const denied = path.join(directory, 'credential-canary.json'); fs.writeFileSync(denied, 'synthetic-denied-credential');
const link = path.join(inputRoot, 'credential-link.json'); fs.symlinkSync(denied, link);
process.env.ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS = '1';
process.env.ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS = JSON.stringify([inputRoot, directory]);
process.env.ANTIGRAVITY_GATEWAY_API_KEY = 'synthetic-local-policy-key';
const { AccountPool } = require('../src/account-pool');
const { createServer } = require('../antigravity-gateway');
const requests = [];

test('explicit local HTTP media policy permits allowed files but refuses configuration roots and escaping symlinks before dispatch', async t => {
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.mock.method(AccountPool.prototype, 'send', async normalized => {
    requests.push(normalized); return { text: 'synthetic accepted', toolCalls: [], usage: {} };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = block => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-local-policy-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash-high', input: [{ role: 'user', content: [block] }] })
  });
  for (const block of [{ type: 'input_file', file_path: canary }, { type: 'input_file', file_url: pathToFileURL(canary).href }]) {
    const response = await request(block);
    assert.equal(response.status, 200, await response.text());
    const media = requests.at(-1).messages[0].parts.find(part => part.type === 'media');
    assert.equal(Buffer.from(media.data, 'base64').toString(), 'synthetic-allowed-media');
  }
  for (const file of [denied, link]) {
    const response = await request({ type: 'input_file', file_path: file });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.type, 'media_local_path_not_allowed');
  }
  assert.equal(requests.length, 2);
});
