'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS = '80';
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
const { DirectAntigravityProvider } = require('../src/direct-provider');
DirectAntigravityProvider.prototype.send = async function (_input, _model, { signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};
const { createServer } = require('../antigravity-gateway');

test('direct request deadline returns 504 and the server remains usable', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-test', max_tokens: 32, messages: [{ role: 'user', content: 'test' }] })
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.type, 'request_timeout');
  assert.equal((await fetch(`${base}/api/hello`)).status, 200);
});
