'use strict';

require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountPool, accountHealth, errorCategory } = require('../src/account-pool');
const { isHardQuotaError, isNonRetryableUpstreamError } = require('../src/agy-retry-policy');
const { AgySessionStore } = require('../src/agy-session-state');
const { clientError } = require('../src/client-error');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { agyBinaryPaths, discoverClientCredentials } = require('../src/local-agy-auth');
const { OAuthFlow } = require('../src/oauth-flow');
const { codexModelInfo } = require('../antigravity-gateway');

const CAPTURED_MODEL = 'gemini-3.8-flash-high';

function sseResponse(events) {
  const payload = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createProvider(t, fetchImpl, options = {}) {
  const dir = createTempDir(t, 'agw-parity-');
  return new DirectAntigravityProvider({
    sessionStore: new AgySessionStore({ directory: dir }),
    accessToken: 'test-token',
    projectId: 'test-project',
    retryBaseMs: 1,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:parity-test' }) },
    fetchImpl,
    ...options
  });
}

test('agy-retry-policy classifies Desktop 2.32.1 hard quota and non-retryable ErrorInfo reasons', () => {
  const quotaReset = JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'QUOTA_EXHAUSTED',
        metadata: { quotaResetDelay: '120s' }
      }]
    }
  });
  const capacityExhausted = JSON.stringify({
    error: {
      code: 503,
      status: 'UNAVAILABLE',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_CAPACITY_EXHAUSTED' }]
    }
  });
  const validationRequired = JSON.stringify({
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'VALIDATION_REQUIRED' }]
    }
  });
  const g1Credits = JSON.stringify({
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'INSUFFICIENT_G1_CREDITS_BALANCE' }]
    }
  });

  assert.equal(isHardQuotaError(402, '{}'), true);
  assert.equal(isHardQuotaError(429, quotaReset), true);
  assert.equal(isHardQuotaError(403, g1Credits), true);
  assert.equal(isNonRetryableUpstreamError(429, quotaReset), true);
  assert.equal(isNonRetryableUpstreamError(503, capacityExhausted), true);
  assert.equal(isNonRetryableUpstreamError(403, validationRequired), true);
  assert.equal(isNonRetryableUpstreamError(503, 'transient unavailable'), false);
});

test('sendInSession retries HTTP 408 on daily->normal and cuts off non-retryable hard quota / capacity errors immediately', async (t) => {
  const urls408 = [];
  const provider408 = createProvider(t, async (url) => {
    urls408.push(url);
    if (urls408.length === 1) return new Response('request timeout', { status: 408 });
    return sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok-after-408' }] }, finishReason: 'STOP' }] }]);
  }, { retryPolicy: 'legacy', maxRetries: 1 });
  const ok = await provider408.send({ messages: [{ role: 'user', text: 'hi' }] }, CAPTURED_MODEL, { sessionId: 's-408' });
  assert.equal(ok.text, 'ok-after-408');
  assert.equal(urls408.length, 2);
  assert.match(urls408[0], /daily-cloudcode-pa/);
  assert.match(urls408[1], /cloudcode-pa\.googleapis\.com/);

  const quotaBody = JSON.stringify({
    error: {
      code: 429,
      message: 'Quota exhausted.',
      status: 'RESOURCE_EXHAUSTED',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'QUOTA_EXHAUSTED',
        metadata: { quotaResetDelay: '600s' }
      }]
    }
  });
  let quotaCalls = 0;
  const providerQuota = createProvider(t, async () => {
    quotaCalls += 1;
    return new Response(quotaBody, { status: 429, headers: { 'content-type': 'application/json' } });
  }, { retryPolicy: 'legacy', maxRetries: 2 });
  await assert.rejects(
    providerQuota.send({ messages: [{ role: 'user', text: 'hi' }] }, CAPTURED_MODEL, { sessionId: 's-quota' }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(clientError(error).code, 'resource_exhausted');
      return true;
    }
  );
  assert.equal(quotaCalls, 1);

  const capBody = JSON.stringify({
    error: {
      code: 503,
      message: 'No capacity',
      status: 'UNAVAILABLE',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_CAPACITY_EXHAUSTED' }]
    }
  });
  let capCalls = 0;
  const providerCap = createProvider(t, async () => {
    capCalls += 1;
    return new Response(capBody, { status: 503, headers: { 'content-type': 'application/json' } });
  }, { retryPolicy: 'agy', maxRetries: 2 });
  await assert.rejects(
    providerCap.send({ messages: [{ role: 'user', text: 'hi' }] }, CAPTURED_MODEL, { sessionId: 's-cap' }),
    { status: 503 }
  );
  assert.equal(capCalls, 1);
});

test('account-pool classifies 402/credits as quota, MODEL_CAPACITY_EXHAUSTED as transient, and VALIDATION_REQUIRED as verification_required', () => {
  assert.equal(errorCategory({ status: 402, details: 'Payment required' }), 'quota');
  assert.equal(errorCategory({ status: 403, details: 'INSUFFICIENT_G1_CREDITS_BALANCE' }), 'quota');
  assert.equal(errorCategory({ status: 429, details: 'MODEL_CAPACITY_EXHAUSTED' }), 'transient');
  assert.equal(errorCategory({ status: 400, details: 'FAILED_PRECONDITION VALIDATION_REQUIRED' }), 'account');
  assert.deepEqual(
    accountHealth({ status: 403, details: '{"reason":"VALIDATION_REQUIRED"}' }),
    {
      state: 'verification_required',
      reason: 'google_account_verification',
      message: 'Google 要求完成账号安全核验；该账号已暂停路由，请完成核验或重新授权。'
    }
  );
});

test('in-band SSE value.error supports pre-content failover, hard-quota RESOURCE_EXHAUSTED preservation, and mid-stream recovery', async (t) => {
  const urls = [];
  const providerPreContent = createProvider(t, async (url) => {
    urls.push(url);
    if (urls.length === 1) {
      return sseResponse([{ error: { code: 503, message: 'temporary stream 503', status: 'UNAVAILABLE' } }]);
    }
    return sseResponse([{ candidates: [{ content: { parts: [{ text: 'recovered-precontent' }] }, finishReason: 'STOP' }] }]);
  }, { retryPolicy: 'legacy', maxRetries: 1 });
  const preRes = await providerPreContent.send({ messages: [{ role: 'user', text: 'hi' }] }, CAPTURED_MODEL, { sessionId: 's-inband-pre' });
  assert.equal(preRes.text, 'recovered-precontent');
  assert.equal(urls.length, 2);

  let inBandQuotaCalls = 0;
  const providerInBandQuota = createProvider(t, async () => {
    inBandQuotaCalls += 1;
    return sseResponse([{
      error: {
        code: 429,
        message: 'Quota exceeded.',
        status: 'RESOURCE_EXHAUSTED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'QUOTA_EXHAUSTED',
          metadata: { quotaResetDelay: '90s' }
        }]
      }
    }]);
  }, { retryPolicy: 'legacy', maxRetries: 2 });
  await assert.rejects(
    providerInBandQuota.send({ messages: [{ role: 'user', text: 'hi' }] }, CAPTURED_MODEL, { sessionId: 's-inband-quota' }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(clientError(error).code, 'resource_exhausted');
      return true;
    }
  );
  assert.equal(inBandQuotaCalls, 1);

  const originalSetTimeout = global.setTimeout;
  const backoffDelays = [];
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    backoffDelays.push(ms);
    return originalSetTimeout(fn, Math.min(ms, 2), ...args);
  });
  let midAttempts = 0;
  const providerMidRecovery = createProvider(t, async () => {
    midAttempts += 1;
    if (midAttempts === 1) {
      return sseResponse([
        { candidates: [{ content: { parts: [{ text: 'PART-1' }] } }] },
        { error: { code: 503, message: 'mid-stream backend cut', status: 'UNAVAILABLE' } }
      ]);
    }
    return sseResponse([
      { candidates: [{ content: { parts: [{ text: 'PART-2' }] }, finishReason: 'STOP' }] }
    ]);
  }, { retryPolicy: 'agy' });
  const deltas = [];
  const midRes = await providerMidRecovery.send(
    { messages: [{ role: 'user', text: 'hi' }] },
    CAPTURED_MODEL,
    { sessionId: 's-inband-mid', onDelta: (chunk) => deltas.push(chunk) }
  );
  assert.equal(midAttempts, 2);
  assert.equal(midRes.text, 'PART-1\nPART-2');
  assert.equal(deltas.join(''), 'PART-1\nPART-2');
  assert.equal(backoffDelays.filter((ms) => ms >= 4000).length, 1);

  // In legacy mode, a mid-stream in-band 503 after partial output must NOT duplicate text.
  let legacyMidAttempts = 0;
  const providerLegacyMid = createProvider(t, async () => {
    legacyMidAttempts += 1;
    return sseResponse([
      { candidates: [{ content: { parts: [{ text: 'PARTIAL' }] } }] },
      { error: { code: 503, message: 'mid-stream fail', status: 'UNAVAILABLE' } }
    ]);
  }, { retryPolicy: 'legacy', maxRetries: 2 });
  await assert.rejects(
    providerLegacyMid.send({ messages: [{ role: 'user', text: 'hi' }] }, CAPTURED_MODEL, { sessionId: 's-inband-legacy-mid' }),
    { code: 'direct_upstream_error', status: 503 }
  );
  assert.equal(legacyMidAttempts, 1);
});

test('SSE streamIdleTimeoutMs cancels stalled upstream bodies without polling global setTimeout', async (t) => {
  const globalTimersSeen = [];
  const originalSetTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    globalTimersSeen.push(ms);
    return originalSetTimeout(fn, ms, ...args);
  });

  let cancelCalled = false;
  const provider = createProvider(t, async () => new Response(new ReadableStream({
    pull() {
      // Never enqueue or close; simulate hung upstream socket.
      return new Promise(() => {});
    },
    cancel() {
      cancelCalled = true;
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }), {
    retryPolicy: 'legacy',
    streamIdleTimeoutMs: 25
  });

  await assert.rejects(
    provider.send({ messages: [{ role: 'user', text: 'stall' }] }, CAPTURED_MODEL, { sessionId: 's-stall' }),
    { code: 'upstream_read_error', status: 504 }
  );
  assert.equal(cancelCalled, true);
  assert.equal(globalTimersSeen.filter((ms) => ms === 25).length, 0);
});

test('Desktop language_server binary fallback discovers OAuth credentials and keeps empty scans uncached', (t) => {
  const dir = createTempDir(t, 'agw-desktop-creds-');
  const localAppData = path.join(dir, 'AppData', 'Local');
  const paths = agyBinaryPaths(dir, 'win32', { LOCALAPPDATA: localAppData });
  assert.equal(paths[0], path.resolve(localAppData, 'agy', 'bin', 'agy.exe'));
  assert.ok(paths.includes(path.resolve(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe')));

  // Empty scan before binary installation must not poison subsequent discovery.
  assert.deepEqual(discoverClientCredentials({ homeDir: dir, platform: 'win32', env: { LOCALAPPDATA: localAppData } }), []);

  const desktopBinary = path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe');
  fs.mkdirSync(path.dirname(desktopBinary), { recursive: true });
  const fakeId = '123456789012-desktopparityclient0001.apps.googleusercontent.com';
  const fakeSecret = 'GOCSPX-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz12';
  fs.writeFileSync(desktopBinary, Buffer.concat([Buffer.from('hdr\0'), Buffer.from(fakeId), Buffer.from('\0'), Buffer.from(fakeSecret), Buffer.from('\0end')]));

  const discovered = discoverClientCredentials({ homeDir: dir, platform: 'win32', env: { LOCALAPPDATA: localAppData } });
  assert.deepEqual(discovered, [{ clientId: fakeId, clientSecret: fakeSecret }]);
});

test('OAuthFlow defaults to 30x1s onboard polling and codexModelInfo supports 1M context for 3.6-flash and Gemini 4', (t) => {
  const flow = new OAuthFlow();
  assert.equal(flow.onboardAttempts, 30);
  assert.equal(flow.onboardPollMs, 1000);

  t.mock.method(AccountPool.prototype, 'modelInfo', () => null);
  for (const slug of ['gemini-3.6-flash', 'gemini-3.7-flash-high', 'gemini-3.8-flash-low', 'gemini-4-argon', 'gemini-4-carbon-high', 'gemini-4-hydrogen']) {
    assert.equal(codexModelInfo(slug, 0).context_window, 1048576, `${slug} should fall back to 1M context window`);
  }
  assert.equal(codexModelInfo('claude-sonnet-4-6', 0).context_window, 200000);
});
