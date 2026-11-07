'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const directory = path.join(__dirname, 'fixtures/official-auth-20261107');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8'));
const header = (request, name) => request.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

test('official terminal OAuth evidence includes PKCE and full scopes without claiming Google authorization', () => {
  const result = fixture('login');
  assert.equal(result.requestObserved, true);
  assert.equal(result.authorizationCompletedWithGoogle, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.authorizationUrl.endpoint, 'https://accounts.google.com/o/oauth2/auth');
  const query = result.authorizationUrl.query;
  assert.equal(query.code_challenge_method, 'S256');
  assert.equal(query.code_challenge, '[REDACTED]');
  assert.equal(query.redirect_uri, 'https://antigravity.google/oauth-callback');
  assert.deepEqual(query.scope.split(' '), [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
    'https://www.googleapis.com/auth/aicode',
    'openid'
  ]);
  const request = result.requests.find((item) => item.body.grant_type === 'authorization_code');
  assert.deepEqual(Object.keys(request.body).sort(), ['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.equal(request.version, 'HTTP/2.0');
  assert.equal(header(request, 'user-agent'), 'Go-http-client/2.0');
  assert.equal(header(request, 'content-type'), 'application/x-www-form-urlencoded');
});

test('official refresh has a distinct Go OAuth transport and exact refresh form', () => {
  const result = fixture('refresh');
  const requests = result.requests.filter((item) => item.body.grant_type === 'refresh_token');
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request.body).sort(), ['client_id', 'client_secret', 'grant_type', 'refresh_token']);
    assert.equal(request.url, 'https://oauth2.googleapis.com/token');
    assert.equal(header(request, 'user-agent'), 'Go-http-client/2.0');
    assert.equal(request.body.refresh_token, '[REDACTED]');
  }
  assert.ok(result.requests.some((item) => item.method === 'GET' && item.url === 'https://www.googleapis.com/oauth2/v2/userinfo'));
  const load = result.requests.find((item) => item.url.endsWith(':loadCodeAssist'));
  assert.deepEqual(load.body, { metadata: { ideType: 'ANTIGRAVITY' } });
  assert.match(header(load, 'user-agent'), /^antigravity\/cli\/1\.5\.2 .*host_path=isolated-auth-probe\/1\.0\)$/);
});

test('official eligibility onboarding and unfinished-operation poll preserve exact request family', () => {
  for (const name of ['onboard', 'onboard-pending']) {
    const result = fixture(name);
    const request = result.requests.find((item) => item.url.endsWith(':onboardUser'));
    assert.equal(request.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser');
    assert.equal(request.method, 'POST');
    assert.equal(request.version, 'HTTP/1.1');
    assert.deepEqual(request.body, { tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } });
    assert.equal(header(request, 'user-agent'), 'antigravity/cli/1.5.2 (aidev_client; os_type=darwin; arch=arm64; cl=1015175089; auth_method=consumer)');
    assert.equal(header(request, 'x-goog-api-client'), undefined);
    assert.ok(!result.requests.some((item) => /streamGenerateContent|generateContent/.test(item.url)));
  }
  const pending = fixture('onboard-pending');
  const post = pending.requests.find((item) => item.url.endsWith(':onboardUser'));
  assert.equal(post.mockResponse.done, false);
  const poll = pending.requests.find((item) => item.url.includes('/operations/'));
  assert.equal(poll.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal/operations/synthetic-onboard');
  assert.equal(poll.method, 'GET');
  assert.deepEqual(poll.body, {});
  assert.equal(poll.mockResponse.done, true);
});

test('all saved auth evidence uses isolated mock responses and contains no raw token or OAuth secret', () => {
  for (const name of ['login', 'refresh', 'onboard', 'onboard-pending']) {
    const result = fixture(name);
    assert.equal(result.mockOnly, true);
    assert.equal(result.realAccountRead, false);
    assert.equal(result.realUpstream, false);
    assert.match(result.binarySha256, /^[a-f0-9]{64}$/);
    assert.match(result.versionOutput, /1\.5\.2/);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /synthetic-(?:old|refreshed|refresh)-token|ya29\.|Bearer [A-Za-z0-9]/);
    for (const request of result.requests) {
      for (const [key, value] of request.headers) {
        if (/^(authorization|cookie|set-cookie)$/i.test(key)) assert.equal(value, '[REDACTED]');
      }
      for (const source of [request.body, request.mockResponse]) {
        for (const [key, value] of Object.entries(source)) {
          if (/^(client_secret|access_token|refresh_token|id_token|code_verifier|code|state)$/i.test(key) && typeof value === 'string') assert.equal(value, '[REDACTED]');
        }
      }
    }
  }
});
