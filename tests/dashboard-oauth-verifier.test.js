'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { prepare, loadState, accountEvidence, requestEvidence, observerSource, refreshCopy, isolatedEnvironment } = require('../scripts/verify-dashboard-oauth');
const { AccountStore } = require('../src/account-store');
const { OAuthFlow } = require('../src/oauth-flow');
const { DashboardAccountAuth } = require('../src/dashboard-account-auth');

const response = value => new Response(JSON.stringify(value), { status: 200 });
const secrets = ['access-synthetic-456', 'refresh-synthetic-789', 'secret-synthetic-123', 'code-synthetic-123', 'subject-synthetic-123', 'fixture-private@example.invalid', 'private-project-123'];
const fixtureAccount = () => ({ accessToken: secrets[0], refreshToken: secrets[1], clientSecret: secrets[2], clientId: 'synthetic-client',
  subjectId: secrets[4], email: secrets[5], projectId: secrets[6], expiresAt: new Date(Date.now() + 3600_000).toISOString() });
function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
}
async function prepared(t) {
  const state = await prepare({ agyPath: process.execPath, probeVersion: async () => '1.5.2', nativeResolver: () => {} });
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  return state;
}

test('preflight only prepares an owner-only empty directory and sanitized environment; it never starts OAuth', async t => {
  let probes = 0, unpacked = 0;
  const state = await prepare({ agyPath: process.execPath, probeVersion: async (_binary, env) => {
    probes++;
    assert.equal(fs.existsSync(path.join(env.HOME, '.gemini')), false);
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR']);
    return '1.5.2';
  }, nativeResolver: options => {
    unpacked++;
    assert.equal(options.binaryPath, '');
    assert.match(options.cacheDir, /agw-oauth-live-[^/]+\/config\/native$/);
  } });
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  assert.equal(probes, 1); assert.equal(unpacked, 1);
  assert.equal(state.phase, 'prepared'); assert.equal(state.authorizationStarted, false);
  assert.deepEqual(fs.readdirSync(path.join(state.root, 'config/accounts')), []);
  assert.equal(fs.statSync(state.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(state.stateFile).mode & 0o777, 0o600);
  assert.equal(loadState(state.stateFile).root, state.root);
  assert.deepEqual(Object.keys(isolatedEnvironment(state)).sort(), [
    'ANTIGRAVITY_CLI_PATH', 'ANTIGRAVITY_GATEWAY_CONFIG_DIR', 'ANTIGRAVITY_GATEWAY_HOST', 'ANTIGRAVITY_GATEWAY_PORT', 'HOME', 'PATH', 'TMPDIR'
  ]);
  assert.equal(fs.existsSync(state.reportFile), false);
  assert.equal(fs.existsSync(path.join(state.root, 'observations.jsonl')), false);
});

test('observer preserves form field names and status evidence without credential values, query, headers or arbitrary keys', () => {
  for (const body of [new URLSearchParams({ code: secrets[3], client_secret: secrets[2], grant_type: 'authorization_code', [secrets[0]]: secrets[1] }),
    new URLSearchParams({ code: secrets[3], client_secret: secrets[2], grant_type: 'authorization_code', [secrets[0]]: secrets[1] }).toString()]) {
    const evidence = requestEvidence(`https://oauth2.googleapis.com/token?private=${secrets[3]}`, {
      method: 'POST', body, headers: { authorization: `Bearer ${secrets[0]}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Go-http-client/2.0' }
    });
    assert.deepEqual(evidence.bodyFields, ['client_secret', 'code', 'grant_type']);
    assert.equal(evidence.unknownBodyFieldCount, 1);
    assert.equal(evidence.grantType, 'authorization_code'); assert.equal(evidence.goOAuthUserAgent, true);
    assert.equal(evidence.configuredProfile, 'oauth-http2'); assertNoSecrets(evidence);
  }
  assert.equal(requestEvidence('https://daily-cloudcode-pa.googleapis.com/v1internal/operations/secret-id').path, '/v1internal/operations/[operation]');
  assert.doesNotThrow(() => requestEvidence('https://oauth2.googleapis.com/token', { body: 'null' }));
});

test('observer refuses inference, unlisted OAuth endpoints, alternate origins and ports', () => {
  for (const url of ['https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent', 'https://oauth2.googleapis.com/elsewhere',
    'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com:444/token', 'https://user@oauth2.googleapis.com/token',
    'https://oauth2.googleapis.com.attacker.invalid/token', 'https://www.googleapis.com/storage/v1', 'https://example.invalid/']) {
    assert.throws(() => requestEvidence(url));
  }
});

test('account reports contain only field presence and lifecycle booleans', () => {
  const evidence = accountEvidence({ ...fixtureAccount(), id: 'private-record', enabled: true, providerType: 'cloudcode' });
  assert.equal(Object.values(evidence.fields).every(Boolean), true);
  assert.equal(evidence.expiresInFuture, true); assert.equal(evidence.enabled, true); assertNoSecrets(evidence);
  assert.equal(accountEvidence({}).expiresInFuture, false);
});

test('native observer calls the original transport and discards arbitrary diagnostic errors', async () => {
  const lines = [];
  let actualCalls = 0, diagnosticWrites = 0;
  class Transport { async fetch(_url, options) { actualCalls++; if (options.fail) throw Error(secrets[0]); return response({}); } }
  class Diagnostic { write() { diagnosticWrites++; } }
  class Dashboard { async start() { this.job = { status: 'completed', promise: Promise.resolve() }; return {}; } }
  const sandbox = { Headers, URL, URLSearchParams, require: file => {
    if (file === 'node:fs') return { appendFileSync: (_file, line) => lines.push(JSON.parse(line)) };
    if (file === 'node:crypto') return require('node:crypto');
    if (file.endsWith('/agy-native-transport.js')) return { AgyNativeTransport: Transport };
    if (file.endsWith('/diagnostic-log.js')) return { DiagnosticLog: Diagnostic };
    if (file.endsWith('/dashboard-account-auth.js')) return { DashboardAccountAuth: Dashboard };
    throw Error('Unexpected preload import');
  }, process: { umask: () => {} } };
  vm.runInNewContext(observerSource('/unused-redacted-trace'), sandbox);
  const transport = new Transport();
  await transport.fetch('https://oauth2.googleapis.com/token', { body: new URLSearchParams({ code: secrets[3] }) });
  await assert.rejects(transport.fetch('https://oauth2.googleapis.com/token', { fail: true }));
  new Diagnostic().write('raw', { details: secrets[0] });
  await new Dashboard().start(); await delay(0);
  assert.equal(actualCalls, 2); assert.equal(diagnosticWrites, 0);
  assert.equal(lines.some(item => item.event === 'response' && item.status === 200), true);
  assert.equal(lines.some(item => item.event === 'failure' && item.category === 'transport_error'), true);
  assert.equal(lines.some(item => item.event === 'authorization' && item.stage === 'completed'), true);
  assertNoSecrets(lines);
});

test('synthetic dashboard OAuth saves through the real store and refreshes only an expired disposable copy', async t => {
  const state = await prepared(t);
  const store = new AccountStore({ configDir: path.join(state.root, 'config') });
  let reloads = 0, quotaJobs = 0, tokenExchanges = 0;
  const flow = new OAuthFlow({ clientCredentials: [{ clientId: 'synthetic-client', clientSecret: secrets[2] }], timeoutMs: 5000,
    openBrowserImpl: async () => { throw Error('The mock must not open a browser'); }, fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/token')) {
        tokenExchanges++;
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('code'), secrets[3]);
        assert.match(form.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
        return response({ access_token: secrets[0], refresh_token: secrets[1], expires_in: 3600 });
      }
      if (url.endsWith('/userinfo')) return response({ id: secrets[4], email: secrets[5] });
      assert.equal(url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
      return response({ cloudaicompanionProject: secrets[6] });
    } });
  const dashboard = new DashboardAccountAuth({ flow, store, pool: { reload: () => reloads++ }, quotaManager: {
    refreshAccount: async (_id, options) => { quotaJobs++; assert.deepEqual(options, { force: true, summaryOnly: false }); }
  } });
  t.after(() => dashboard.stop());
  const job = await dashboard.start();
  for (let index = 0; index < 100 && dashboard.job.status !== 'waiting'; index++) await delay(5);
  const authorization = new URL(dashboard.job.url), callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', secrets[3]);
  dashboard.submit(job.id, callback.href);
  await dashboard.job.promise; await delay(0);
  assert.equal(dashboard.job.status, 'completed'); assert.equal(tokenExchanges, 1); assert.equal(reloads, 1); assert.equal(quotaJobs, 1);
  const accountFile = path.join(store.directory, fs.readdirSync(store.directory)[0]);
  assert.equal(fs.statSync(accountFile).mode & 0o777, 0o600);
  const original = fs.readFileSync(accountFile);
  let refreshCalls = 0;
  const evidence = await refreshCopy(state, { fetchImpl: async (url, options) => {
    refreshCalls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), secrets[1]);
    assert.equal(options.headers['user-agent'], 'Go-http-client/2.0');
    return response({ access_token: 'new-synthetic-token', expires_in: 3600 });
  } });
  assert.equal(refreshCalls, 1); assert.equal(evidence.passed, true); assert.equal(evidence.originalAccountUnchanged, true);
  assert.equal(evidence.observations[0].status, 200); assert.equal(evidence.accessTokenChanged, true);
  assert.deepEqual(fs.readFileSync(accountFile), original);
  assert.equal(fs.existsSync(path.join(state.root, 'refresh-copy')), false);
  assertNoSecrets(evidence); assert.equal(JSON.stringify(evidence).includes('new-synthetic-token'), false);
});

test('failed copy refresh removes only the disposable copy and preserves the newly authorized account', async t => {
  const state = await prepared(t), store = new AccountStore({ configDir: path.join(state.root, 'config') });
  store.save(fixtureAccount());
  const before = fs.readFileSync(path.join(store.directory, fs.readdirSync(store.directory)[0]));
  await assert.rejects(refreshCopy(state, { fetchImpl: async () => new Response(JSON.stringify({ error_description: secrets[0] }), { status: 400 }) }));
  assert.equal(fs.existsSync(path.join(state.root, 'refresh-copy')), false);
  assert.deepEqual(fs.readFileSync(path.join(store.directory, fs.readdirSync(store.directory)[0])), before);
});
