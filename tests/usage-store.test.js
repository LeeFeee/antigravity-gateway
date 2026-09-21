'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { HOUR_MS, UsageStore } = require('../src/usage-store');
const { OAuthFlow, callbackInput, defaultTierId } = require('../src/oauth-flow');
const { QuotaManager, creditSnapshot, modelQuotaSnapshot, usageQuotaSnapshot } = require('../src/quota-manager');
const { TerminalConsole, chart } = require('../src/terminal-console');

test('usage store separates client requests, upstream calls, tokens and five-minute persistence', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-usage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-09-19T00:03:00Z');
  const store = new UsageStore({ configDir: directory, now: () => now });
  store.recordClientRequest();
  store.recordUpstream({ model: 'model-a', accountId: 'account-a', success: false });
  store.recordUpstream({
    model: 'model-a', accountId: 'account-b', success: true,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 125 }
  });
  const live = store.summary({ live: true }).lifetime;
  assert.equal(live.clientRequests, 1);
  assert.equal(live.upstreamCalls, 2);
  assert.equal(live.failedUpstreamCalls, 1);
  assert.equal(live.inputTokens, 100);
  assert.equal(live.cachedTokens, 40);
  assert.equal(live.totalTokens, 125);
  const detailed = store.summary({ live: true, detailed: true });
  const hour = detailed.history.at(-1).at;
  assert.equal(detailed.hourlyByAccount[hour]['account-b'].totalTokens, 125);
  assert.equal(detailed.hourlyByModel[hour]['model-a'].upstreamCalls, 2);
  assert.equal(detailed.hourlyByAccountModel[hour]['account-b']['model-a'].outputTokens, 20);
  assert.equal(detailed.byAccountModel['account-b']['model-a'].inputTokens, 100);
  assert.equal(fs.existsSync(store.file), false);
  now += 5 * 60_000;
  store.tick();
  assert.equal(fs.existsSync(store.file), true);
  const restored = new UsageStore({ configDir: directory, now: () => now });
  assert.equal(restored.summary({ live: true }).lifetime.totalTokens, 125);
  assert.equal(restored.summary({ live: true, detailed: true }).byAccountModel['account-b']['model-a'].totalTokens, 125);
});

test('usage store rolls the displayed histogram only when the hour changes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-hour-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-09-19T10:15:00Z');
  const store = new UsageStore({ configDir: directory, now: () => now });
  store.recordUpstream({ usage: { total_tokens: 10 } });
  store.refreshDashboard();
  assert.equal(store.summary().hourly.at(-1).totalTokens, 0);
  now += HOUR_MS;
  store.refreshDashboard();
  assert.equal(store.summary().hourly.at(-2).totalTokens, 10);
});

test('OAuth callback parser accepts a complete callback URL and the chart has 24 columns', () => {
  assert.deepEqual(callbackInput('http://localhost:51121/oauth-callback?code=abc&state=xyz'), {
    code: 'abc', state: 'xyz', error: ''
  });
  const hourly = Array.from({ length: 24 }, (_, index) => ({ totalTokens: index }));
  const output = chart(hourly, 100);
  assert.match(output, /最近24小时：/);
  assert.match(output, /合计 276 Token/);
});

test('OAuth tier selection prefers the advertised default tier', () => {
  assert.equal(defaultTierId({
    allowedTiers: [{ id: 'other-tier' }, { id: 'recommended-tier', isDefault: true }],
    currentTier: { id: 'current-tier' }
  }), 'recommended-tier');
  assert.equal(defaultTierId({ currentTier: { id: 'current-tier' } }), 'current-tier');
  assert.equal(defaultTierId({}), 'free-tier');
});

test('quota snapshot reads Google One AI credits without inventing token balances', () => {
  assert.deepEqual(creditSnapshot({ paidTier: { id: 'pro', availableCredits: [{
    creditType: 'GOOGLE_ONE_AI', creditAmount: '25000', minimumCreditAmountForUsage: '50'
  }] } }), {
    plan: 'pro', creditType: 'GOOGLE_ONE_AI', creditAmount: 25000,
    minimumCreditAmountForUsage: 50, available: true
  });
  assert.equal(creditSnapshot({ currentTier: { id: 'free' } }).available, null);
  assert.equal(creditSnapshot({ paidTier: { availableCredits: [{
    creditType: 'GOOGLE_ONE_AI', minimumCreditAmountForUsage: '50'
  }] } }).available, null);
});

test('model quota snapshot reads remaining fractions and reset times from the real catalog shape', () => {
  assert.deepEqual(modelQuotaSnapshot({ models: {
    'gemini-3.8-flash-high': { quotaInfo: { remainingFraction: 0.75, resetTime: '2026-09-20T00:00:00Z' } },
    'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0 } }
  } }), {
    'gemini-3.8-flash-high': { remainingFraction: 0.75, resetTime: '2026-09-20T00:00:00Z', available: true },
    'claude-sonnet-4-6': { remainingFraction: 0, resetTime: '', available: false }
  });
});

test('usage quota snapshot preserves agy weekly and five-hour shared model groups', () => {
  const groups = usageQuotaSnapshot({ groups: [{
    displayName: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro',
    buckets: [
      { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9783292, resetTime: '2026-09-23T02:34:00Z' },
      { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-09-21T07:41:36Z' }
    ]
  }, {
    displayName: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
    buckets: [
      { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1 },
      { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.5 }
    ]
  }] });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    id: 'gemini', displayName: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro', available: true,
    buckets: [
      { id: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9783292, resetTime: '2026-09-23T02:34:00Z', description: '', available: true },
      { id: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-09-21T07:41:36Z', description: '', available: true }
    ]
  });
  assert.equal(groups[1].id, '3p');
  assert.deepEqual(groups[1].buckets.map((bucket) => [bucket.window, bucket.remainingFraction]), [['weekly', 1], ['5h', 0.5]]);
});

test('quota manager persists official usage groups and keeps catalog quota for routing compatibility', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-quota-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = {
    access: async () => 'access-token',
    baseUrls: () => ['https://example.test'],
    userAgent: 'test',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).includes('loadCodeAssist')) {
        assert.deepEqual(body, { metadata: { ideType: 'ANTIGRAVITY' } });
        return new Response(JSON.stringify({ paidTier: { id: 'pro' } }), { status: 200 });
      }
      assert.deepEqual(body, {});
      if (String(url).includes('retrieveUserQuotaSummary')) return new Response(JSON.stringify({ groups: [{
        displayName: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75 },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5 }
        ]
      }] }), { status: 200 });
      return new Response(JSON.stringify({ models: {
        'gemini-3.8-flash-high': { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-09-20T00:00:00Z' } }
      } }), { status: 200 });
    }
  };
  const accountPool = {
    hasManagedAccounts: () => true,
    entries: new Map([['account-1', { account: { id: 'account-1', email: 'one@example.com' }, provider }]])
  };
  const manager = new QuotaManager({ configDir: directory, accountPool });
  await manager.refresh();
  assert.equal(manager.get('account-1', 'gemini-3.8-flash-high').remainingFraction, 0.5);
  assert.equal(manager.peek('account-1').groups[0].buckets[0].window, 'weekly');
  assert.equal(manager.peek('account-1').groups[0].buckets[1].remainingFraction, 0.5);
  assert.equal(fs.existsSync(manager.file), true);
  manager.snapshots['account-1'].expiresAt = '2020-01-01T00:00:00.000Z';
  assert.equal(manager.get('account-1'), null);
  assert.equal(manager.peek('account-1').stale, true);
  assert.equal(manager.peek('account-1', 'gemini-3.8-flash-high').remainingFraction, 0.5);
});

test('OAuth flow prints a usable URL, accepts a pasted callback, and returns a persistent account', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body ? String(options.body) : '' });
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 });
    if (String(url).includes('/userinfo')) return new Response(JSON.stringify({ email: 'person@example.com' }), { status: 200 });
    return new Response(JSON.stringify({ cloudaicompanionProject: { id: 'project-1' } }), { status: 200 });
  };
  const flow = new OAuthFlow({
    fetchImpl,
    clientCredentials: [{ clientId: 'client-id', clientSecret: 'client-secret' }],
    openBrowserImpl: async () => false,
    timeoutMs: 2000
  });
  const account = await flow.start({ onReady: ({ url }) => {
    const auth = new URL(url);
    const redirect = auth.searchParams.get('redirect_uri');
    const state = auth.searchParams.get('state');
    setImmediate(() => flow.submit(`${redirect}?code=authorization-code&state=${state}`));
  } });
  assert.equal(account.email, 'person@example.com');
  assert.equal(account.refreshToken, 'refresh');
  assert.equal(account.projectId, 'project-1');
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests.at(-1).body), { metadata: { ideType: 'ANTIGRAVITY' } });
});

test('OAuth flow initializes a first-login Antigravity project before saving the account', async () => {
  const requests = [];
  let onboardCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    requests.push({ url: target, options, body: options.body ? String(options.body) : '' });
    if (target.includes('/token')) return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 });
    if (target.includes('/userinfo')) return new Response(JSON.stringify({ email: 'new@example.com' }), { status: 200 });
    if (target.endsWith(':loadCodeAssist')) {
      return new Response(JSON.stringify(onboardCalls >= 2
        ? { cloudaicompanionProject: { id: 'new-project' } }
        : { allowedTiers: [{ id: 'pro-tier', isDefault: true }] }), { status: 200 });
    }
    if (target.endsWith(':onboardUser')) {
      onboardCalls += 1;
      return new Response(JSON.stringify(onboardCalls === 1
        ? { done: false }
        : { done: true, response: {} }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${target}`);
  };
  const flow = new OAuthFlow({
    fetchImpl,
    clientCredentials: [{ clientId: 'client-id', clientSecret: 'client-secret' }],
    openBrowserImpl: async () => false,
    timeoutMs: 2000,
    onboardPollMs: 0
  });
  const account = await flow.start({ onReady: ({ url }) => {
    const auth = new URL(url);
    const redirect = auth.searchParams.get('redirect_uri');
    setImmediate(() => flow.submit(`${redirect}?code=authorization-code&state=${auth.searchParams.get('state')}`));
  } });
  assert.equal(account.projectId, 'new-project');
  assert.equal(onboardCalls, 2);
  const onboard = requests.find((item) => item.url.endsWith(':onboardUser'));
  assert.deepEqual(JSON.parse(onboard.body), {
    tier_id: 'pro-tier',
    metadata: { ide_type: 'ANTIGRAVITY', ide_version: '2.9.1', ide_name: 'antigravity' }
  });
  assert.equal(onboard.options.headers['x-goog-api-client'], 'gl-node/22.21.1');
  assert.match(onboard.options.headers['user-agent'], /google-api-nodejs-client\/10\.3\.0/);
});

test('OAuth flow prefers the official Antigravity client over an earlier embedded client', async () => {
  let selectedClient = '';
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/token')) {
      selectedClient = new URLSearchParams(String(options.body)).get('client_id');
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), { status: 200 });
    }
    if (target.includes('/userinfo')) return new Response(JSON.stringify({ email: 'person@example.com' }), { status: 200 });
    return new Response(JSON.stringify({ cloudaicompanionProject: { id: 'project-1' } }), { status: 200 });
  };
  const flow = new OAuthFlow({
    fetchImpl,
    clientCredentials: [
      { clientId: '884354919052-old.apps.googleusercontent.com', clientSecret: 'old-secret' },
      { clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', clientSecret: 'current-secret' }
    ],
    openBrowserImpl: async () => false,
    timeoutMs: 2000
  });
  await flow.start({ onReady: ({ url }) => {
    const auth = new URL(url);
    setImmediate(() => flow.submit(`${auth.searchParams.get('redirect_uri')}?code=code&state=${auth.searchParams.get('state')}`));
  } });
  assert.equal(selectedClient, '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
});

test('terminal add command always prints the complete fallback URL and reloads the account pool', async () => {
  const output = new PassThrough();
  output.setEncoding('utf8');
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  let saved;
  let reloads = 0;
  const terminal = new TerminalConsole({
    output,
    accountStore: { save: (account) => (saved = { id: 'id-1', ...account }) },
    accountPool: { reload: () => { reloads += 1; }, status: () => [{ id: 'id-1' }] },
    quotaManager: { refresh: async () => {} },
    oauthFlow: {
      active: null,
      start: async ({ onReady }) => {
        onReady({ url: 'https://accounts.google.com/example?complete=yes', browserOpened: false });
        return { email: 'person@example.com', accessToken: 'access', refreshToken: 'refresh' };
      }
    }
  });
  await terminal.addAccount();
  assert.equal(saved.email, 'person@example.com');
  assert.equal(reloads, 1);
  assert.match(rendered, /https:\/\/accounts\.google\.com\/example\?complete=yes/);
  assert.match(rendered, /如果浏览器没有自动打开网页/);
  assert.match(rendered, /完整 localhost 回调链接/);
});

test('terminal explains that a callback pasted outside an active OAuth flow is stale', async () => {
  const output = new PassThrough();
  output.setEncoding('utf8');
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const terminal = new TerminalConsole({
    output,
    oauthFlow: { active: null },
    accountPool: { status: () => [] }
  });
  await terminal.handle('http://localhost:51121/oauth-callback?code=already-used&state=old');
  assert.match(rendered, /当前没有正在等待的账号授权/);
  assert.match(rendered, /重新输入 add/);
  assert.doesNotMatch(rendered, /未知终端命令/);
});

test('terminal accepts acc as the account pool query command', async () => {
  const output = new PassThrough();
  output.setEncoding('utf8');
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const terminal = new TerminalConsole({
    output,
    oauthFlow: { active: null },
    accountPool: {
      status: () => [{
        id: 'account-1', email: 'person@example.com', enabled: true, state: 'available',
        modelCooldowns: [], lastSuccessAt: '', lastError: ''
      }]
    }
  });
  await terminal.handle('acc');
  assert.match(rendered, /账号池/);
  assert.match(rendered, /person@example\.com/);
  assert.doesNotMatch(rendered, /未知终端命令/);
});
