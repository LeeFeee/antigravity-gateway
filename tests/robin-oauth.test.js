'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { RobinOAuthFlow } = require('../src/robin-oauth-flow');

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(1500, () => req.destroy(new Error('callback test timed out')));
    req.on('error', reject);
    req.end();
  });
}

test('Robin callback rejects malformed URLs, methods and wrong states without settling or crashing', async t => {
  const flow = new RobinOAuthFlow();
  const callback = await flow.callbackServer('expected-state');
  t.after(() => callback.close());
  let settled = false;
  callback.result.then(() => { settled = true; });
  assert.equal(await request(callback.port, 'http://['), 400);
  assert.equal(await request(callback.port, '/oauth2callback?state=expected-state&code=not-used', 'POST'), 405);
  assert.equal(await request(callback.port, '/oauth2callback?state=wrong&code=not-used'), 400);
  assert.equal(settled, false);
  assert.equal(await request(callback.port, '/oauth2callback?state=expected-state&code=accepted-code'), 200);
  assert.deepEqual(await callback.result, { code: 'accepted-code', state: 'expected-state', error: '' });
});

test('a headless browser-opener failure still permits manual Robin OAuth completion', async t => {
  let callback, closed = 0;
  const flow = new RobinOAuthFlow({ openBrowserImpl: () => { throw new Error('no browser'); } });
  const listen = flow.callbackServer.bind(flow);
  flow.callbackServer = async state => {
    callback = await listen(state);
    return { ...callback, close: () => { closed++; callback.close(); } };
  };
  t.after(() => callback?.close());
  flow.exchange = async (code, redirect, verifier) => {
    assert.equal(code, 'manual-code');
    assert.equal(new URL(redirect).port, String(callback.port));
    assert.ok(verifier.length >= 43);
    return { providerType: 'robin' };
  };
  const result = await flow.start({ onReady: ({ url, browserOpened }) => {
    assert.equal(browserOpened, false);
    const state = new URL(url).searchParams.get('state');
    assert.equal(flow.submit(`http://127.0.0.1:${callback.port}/oauth2callback?state=${state}&code=manual-code`), true);
  } });
  assert.equal(result.providerType, 'robin');
  assert.equal(flow.active, null);
  assert.equal(closed, 1);
});

test('a readiness callback failure releases the Robin OAuth listener and active-flow lock', async t => {
  let callback, closed = 0;
  const flow = new RobinOAuthFlow({ openBrowserImpl: async () => false });
  const listen = flow.callbackServer.bind(flow);
  flow.callbackServer = async state => {
    callback = await listen(state);
    return { ...callback, close: () => { closed++; callback.close(); } };
  };
  t.after(() => callback?.close());
  await assert.rejects(flow.start({ onReady: () => { throw new Error('console stopped'); } }), /console stopped/);
  assert.equal(flow.active, null);
  assert.equal(closed, 1);
});

test('Robin reserves its OAuth flow during asynchronous setup and releases it if setup fails', async () => {
  let fail;
  const flow = new RobinOAuthFlow();
  let listeners = 0;
  flow.callbackServer = () => {
    listeners++;
    return new Promise((_resolve, reject) => { fail = reject; });
  };
  const first = flow.start();
  const rejected = assert.rejects(first, /listener unavailable/);
  assert.equal(flow.submit('premature-code'), false);
  await assert.rejects(flow.start(), /已有 Gemini 账号授权/);
  assert.equal(listeners, 1);
  fail(new Error('listener unavailable'));
  await rejected;
  assert.equal(flow.active, null);
});
