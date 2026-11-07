'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { OAuthFlow, operationUrl } = require('../src/oauth-flow');
const { AGY_OAUTH_PROFILE, cliUserAgent } = require('../src/agy-request-profile');
const { nativeCloudCodeFetch, nativeRequestProfile } = require('../src/agy-native-transport');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');
const { AccountStore, accountGrantGeneration } = require('../src/account-store');

const credentials = [{ clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }];
const json = value => new Response(JSON.stringify(value), { status: 200 });
const makeFlow = fetchImpl => new OAuthFlow({ fetchImpl, clientCredentials: credentials, timeoutMs: 3000,
  openBrowserImpl: async () => false, onboardPollMs: 0 });
const authorize = (flow, inspect = () => {}) => flow.start({ openBrowser: false, onReady: ({ url }) => {
  const parsed = new URL(url);
  inspect(parsed);
  const callback = new URL(parsed.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', parsed.searchParams.get('state'));
  callback.searchParams.set('code', 'synthetic-code');
  flow.submit(callback.href);
} });

test('dashboard OAuth binds S256 PKCE to its own state and local callback using captured scopes and headers', async () => {
  const captured = require('./fixtures/official-auth-20261107/login.json');
  const requests = [];
  let authorization;
  const flow = makeFlow(async (url, options = {}) => {
    requests.push({ url, options });
    if (url === AGY_OAUTH_PROFILE.tokenEndpoint) return json({ access_token: 'access-synthetic', refresh_token: 'refresh-synthetic' });
    if (url === AGY_OAUTH_PROFILE.userinfoEndpoint) return json({ email: 'fixture@example.invalid', id: 'fixture-subject' });
    return json({ cloudaicompanionProject: 'fixture-project' });
  });
  const account = await authorize(flow, value => { authorization = value; });
  assert.equal(account.projectId, 'fixture-project');
  assert.equal(authorization.origin + authorization.pathname, captured.authorizationUrl.endpoint);
  assert.equal(authorization.searchParams.get('scope'), captured.authorizationUrl.query.scope);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, 'localhost');
  assert.equal(redirect.pathname, '/oauth-callback');
  assert.notEqual(redirect.href, captured.authorizationUrl.query.redirect_uri);
  const token = requests[0], form = new URLSearchParams(token.options.body);
  assert.deepEqual([...form.keys()], ['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.match(form.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.equal(form.get('redirect_uri'), redirect.href);
  assert.equal(token.options.headers['user-agent'], 'Go-http-client/2.0');
  assert.equal(token.options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(requests[1].url, 'https://www.googleapis.com/oauth2/v2/userinfo');
  assert.equal(requests[1].options.headers['user-agent'], 'Go-http-client/2.0');
  assert.equal(requests[2].url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.deepEqual(JSON.parse(requests[2].options.body), { metadata: { ideType: 'ANTIGRAVITY' } });
  assert.equal(requests[2].options.headers['user-agent'], cliUserAgent());
  assert.equal(flow.active, null);
});

test('separate authorization sessions rotate state and PKCE; raw code without state never exchanges', async () => {
  const values = [];
  const flow = makeFlow(async () => { throw Error('must not exchange an unbound code'); });
  for (let index = 0; index < 2; index++) {
    await assert.rejects(flow.start({ openBrowser: false, onReady: ({ url }) => {
      values.push(new URL(url)); flow.submit('unbound-code');
    } }), /状态不匹配/);
  }
  assert.notEqual(values[0].searchParams.get('state'), values[1].searchParams.get('state'));
  assert.notEqual(values[0].searchParams.get('code_challenge'), values[1].searchParams.get('code_challenge'));
});

test('first onboard follows the actual operation GET and parses protobuf Any response', async () => {
  const fixture = require('./fixtures/official-auth-20261107/onboard-pending.json');
  const observedPost = fixture.requests.find(item => item.url.endsWith(':onboardUser'));
  const observedPoll = fixture.requests.find(item => item.url.includes('/operations/'));
  const requests = [];
  const flow = makeFlow(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith(':onboardUser')) return json(observedPost.mockResponse);
    if (url.includes('/operations/')) return json(observedPoll.mockResponse);
    throw Error('unexpected request');
  });
  assert.equal(await flow._onboard('synthetic-access', 'free-tier'), 'synthetic-onboard-project');
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].options.body), observedPost.body);
  assert.deepEqual(requests[0].options.headers, { authorization: 'Bearer synthetic-access', 'user-agent': cliUserAgent(), 'content-type': 'application/json' });
  assert.equal(requests[1].url, observedPoll.url);
  assert.equal(requests[1].options.method, 'GET');
  assert.equal(requests[1].options.body, undefined);
  assert.equal(requests[1].options.headers['content-type'], undefined);
});

test('onboard errors, missing or hostile operation names fail without repeating registration or leaking authorization', async () => {
  for (const response of [{ done: false }, { name: 'https://attacker.invalid/steal' }, { name: 'operations/../token' },
    { name: 'operations/%2e%2e' }, { done: true, error: { code: 7, message: 'eligibility rejected' } }]) {
    let calls = 0;
    const flow = makeFlow(async () => { calls++; return json(response); });
    await assert.rejects(flow._onboard('synthetic-access', 'free-tier'));
    assert.equal(calls, 1);
  }
  assert.throws(() => operationUrl('operations/a?token=secret'));
});

test('onboard cancellation and bounded polling do not restart the registration POST', async () => {
  const methods = [];
  const flow = makeFlow(async (_url, options) => { methods.push(options.method); return json({ name: 'operations/pending', done: false }); });
  flow.onboardAttempts = 3;
  await assert.rejects(flow._onboard('synthetic-access', 'free-tier'), /3 次状态检查/);
  assert.deepEqual(methods, ['POST', 'GET', 'GET']);
  const controller = new AbortController();
  const cancelled = makeFlow(async () => { controller.abort(new Error('test-cancel')); return json({ name: 'operations/pending', done: false }); });
  await assert.rejects(cancelled._onboard('synthetic-access', 'free-tier', controller.signal), /test-cancel/);
});

test('managed refresh uses the captured form and headers while preserving identity and avoiding local credential discovery', async () => {
  const account = { id: 'managed-fixture', grantGeneration: 'synthetic-grant', subjectId: 'fixture-subject', email: 'fixture@example.invalid', projectId: 'fixture-project',
    accessToken: 'expired-synthetic', refreshToken: 'refresh-synthetic', expiresAt: '2020-01-01T00:00:00Z', ...credentials[0] };
  const saved = [], requests = [];
  let current = { ...account };
  const store = {
    list: () => [{ ...current }],
    updateCredentials: AccountStore.prototype.updateCredentials,
    save(value, { expectedGrant } = {}) {
      if (accountGrantGeneration(current) !== expectedGrant) return null;
      current = { ...value, grantGeneration: expectedGrant };
      saved.push(current);
      return current;
    }
  };
  const auth = new ManagedAccountAuthProvider({ account, store,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return json({ access_token: 'new-synthetic', expires_in: 3600 }); } });
  const identity = auth.load().sourcePath;
  assert.deepEqual(auth.provider.paths, []);
  assert.equal(auth.provider.useKeychain, false);
  const result = await auth.get();
  assert.equal(result.sourcePath, identity);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, account.id);
  assert.equal(saved[0].grantGeneration, account.grantGeneration);
  assert.equal(saved[0].refreshToken, account.refreshToken);
  assert.equal(requests[0].url, AGY_OAUTH_PROFILE.tokenEndpoint);
  assert.equal(requests[0].options.headers['user-agent'], 'Go-http-client/2.0');
  assert.deepEqual([...new URLSearchParams(requests[0].options.body).keys()], ['client_id', 'client_secret', 'grant_type', 'refresh_token']);
  assert.equal(new OAuthFlow().fetchImpl, nativeCloudCodeFetch);
});

test('only captured OAuth endpoints select HTTP2 profile and model endpoints retain their original profile', () => {
  assert.equal(nativeRequestProfile('https://oauth2.googleapis.com/token'), 'oauth');
  assert.equal(nativeRequestProfile('https://www.googleapis.com/oauth2/v2/userinfo'), 'oauth');
  assert.equal(nativeRequestProfile('https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser'), 'antigravity');
  for (const url of ['https://oauth2.googleapis.com/elsewhere', 'https://www.googleapis.com/storage/v1',
    'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com.attacker.invalid/token', 'https://user@oauth2.googleapis.com/token']) {
    assert.equal(nativeRequestProfile(url), null);
  }
});
