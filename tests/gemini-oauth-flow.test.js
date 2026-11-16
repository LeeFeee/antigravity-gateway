'use strict';

// Listener/PKCE/cancellation checks only. Real Google exchange and dashboard
// first-use acceptance are separate evidence; no synthetic token is supplied.
const assert = require('node:assert/strict');
const test = require('node:test');
const { GeminiOAuthFlow } = require('../src/gemini-oauth-flow');

test('Gemini OAuth exposes its complete PKCE URL without app discovery and closes on cancellation', async () => {
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const controller = new AbortController();
  const flow = new GeminiOAuthFlow({ fetchImpl: () => assert.fail('no token exchange was authorized') });
  const result = flow.start({ signal: controller.signal, onReady: ready });
  result.catch(() => {});
  const { url, browserOpened } = await waiting;
  const parsed = new URL(url), p = parsed.searchParams;
  assert.equal(parsed.origin, 'https://accounts.google.com');
  assert.equal(parsed.pathname, '/o/oauth2/v2/auth');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.match(p.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.get('include_granted_scopes'), 'false');
  assert.deepEqual(p.get('scope').split(' '), ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/flexible-api']);
  assert.equal(browserOpened, false);
  await assert.rejects(flow.start(), /已有账号授权/);
  controller.abort(new Error('cancelled by dashboard'));
  await assert.rejects(result, /cancelled by dashboard/);
  assert.equal(flow.active, null);
  assert.equal(flow.starting, false);
});

test('Gemini callback state mismatch cannot invoke token exchange; bounded flow expires', async () => {
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const flow = new GeminiOAuthFlow({ timeoutMs: 500, fetchImpl: () => assert.fail('invalid callback must not exchange') });
  const result = flow.start({ onReady: ready }); result.catch(() => {});
  const { url } = await waiting;
  const callback = new URL(new URL(url).searchParams.get('redirect_uri'));
  callback.search = 'code=not-a-real-code&state=wrong';
  assert.equal((await fetch(callback)).status, 400);
  await assert.rejects(result, error => error.code === 'gemini_oauth_timeout');
  assert.equal(flow.active, null);
});
