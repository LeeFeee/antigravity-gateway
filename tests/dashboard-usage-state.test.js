'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { dashboardData, dashboardHtml } = require('../src/dashboard');

const now = Date.parse('2026-10-15T00:00:00Z'), at = new Date(now).toISOString();
class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const counters = (tokens = 0, calls = 0, failures = 0) => ({
  clientRequests: calls, upstreamCalls: calls, successfulUpstreamCalls: calls - failures, failedUpstreamCalls: failures,
  inputTokens: tokens * .8, outputTokens: tokens * .2, thinkingTokens: 0, cachedTokens: tokens * .3, totalTokens: tokens
});

function fixture(accounts, byAccount, byAccountModel) {
  const sum = values => values.reduce((output, item) => {
    for (const [key, value] of Object.entries(item)) output[key] = (output[key] || 0) + value;
    return output;
  }, counters());
  const byModel = {};
  for (const models of Object.values(byAccountModel)) for (const [model, value] of Object.entries(models)) {
    byModel[model] = sum([byModel[model] || counters(), value]);
  }
  const lifetime = sum(Object.values(byAccount));
  return { version: '1.5.1', generatedAt: at, accounts, usage: {
    lifetime, byAccount, byAccountModel, byModel, history: [{ at, ...lifetime }],
    hourlyByAccount: { [at]: byAccount }, hourlyByAccountModel: { [at]: byAccountModel }, hourlyByModel: { [at]: byModel }
  } };
}

function view(data, selected = 'all') {
  const html = dashboardHtml(), start = html.indexOf('  const COLORS='), end = html.indexOf('  async function load(){', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map(), context = vm.createContext({
    Date: ClockDate, inputData: data, selected,
    localStorage: { getItem: () => null },
    document: { getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', title: '', style: {} });
      return nodes.get(id);
    } }
  });
  vm.runInContext(html.slice(start, end) + '\nDATA=inputData;account=selected;render();', context, { timeout: 1000 });
  return { node: id => nodes.get(id), select: id => {
    context.selected = id;
    vm.runInContext('account=selected;render();', context, { timeout: 1000 });
  } };
}

test('an unmetered Robin account displays unknown tokens but real calls, failure rate and native quota', () => {
  const data = fixture([{ id: 'r', providerType: 'robin', enabled: true, state: 'available', models: ['gemini-4-argon'],
    quota: { groups: [{ buckets: [{ window: '5h', remainingFraction: .75, resetTime: at }] }] } }],
  { r: counters(0, 3, 1) }, { r: { 'gemini-4-argon': counters(0, 3, 1) } });
  const original = JSON.stringify(data);
  for (const selected of ['all', 'r']) {
    const snapshot = view(data, selected);
    for (const id of ['periodTotal', 'historyTotal', 'inputTokens', 'outputTokens', 'cacheTotal', 'cacheRate', 'cacheRateTop']) {
      assert.equal(snapshot.node(id).textContent, '--', id);
    }
    assert.equal(snapshot.node('requestCount').textContent, '3');
    assert.equal(snapshot.node('upstreamCalls').textContent, '3');
    assert.equal(snapshot.node('historyRequests').textContent, '3');
    assert.equal(snapshot.node('failureRate').textContent, '33.3%');
    assert.equal(snapshot.node('failureCount').textContent, '1 次失败');
    assert.match(snapshot.node('tokenScope').textContent, /未提供/);
    assert.match(snapshot.node('accounts').innerHTML, /Token 未提供 · 3 次上游/);
    assert.match(snapshot.node('accounts').innerHTML, /75%/);
    assert.doesNotMatch(snapshot.node('accounts').innerHTML, /0 Token/);
    assert.equal(snapshot.node('overviewBars').innerHTML, '');
    assert.match(snapshot.node('trendChart').innerHTML, /未提供 Token/);
    assert.doesNotMatch(snapshot.node('trendChart').innerHTML, /<svg/);
    assert.match(snapshot.node('modelDonut').innerHTML, /Token 未提供/);
    assert.match(snapshot.node('modelShareList').innerHTML, /无法计算占比/);
    assert.equal(snapshot.node('heatScale').style.visibility, 'hidden');
    assert.match(snapshot.node('heatmap').innerHTML, /Token 未提供/);
    assert.doesNotMatch(snapshot.node('heatmap').innerHTML, /· 0 Token/);
  }
  assert.equal(JSON.stringify(data), original, 'presentation must not rewrite stored counters');
});

test('mixed providers retain metered token totals and every request without false zero-token Robin series', () => {
  const data = fixture([{ id: 'c', enabled: true, providerType: 'cloudcode' }, { id: 'r', enabled: true, providerType: 'robin' }],
    { c: counters(100, 1), r: counters(999, 3, 1) },
    { c: { 'cloud-model': counters(100, 1) }, r: { 'gemini-4-argon': counters(999, 3, 1) } });
  const snapshot = view(data);
  assert.equal(snapshot.node('periodTotal').textContent, '100');
  assert.equal(snapshot.node('historyTotal').textContent, '100');
  assert.equal(snapshot.node('inputTokens').textContent, '80');
  assert.equal(snapshot.node('outputTokens').textContent, '20');
  assert.equal(snapshot.node('cacheTotal').textContent, '30');
  assert.equal(snapshot.node('cacheRate').textContent, '37.50%');
  assert.equal(snapshot.node('requestCount').textContent, '4');
  assert.equal(snapshot.node('upstreamCalls').textContent, '4');
  assert.equal(snapshot.node('failureRate').textContent, '25.0%');
  assert.match(snapshot.node('tokenScope').textContent, /仅统计已测量部分/);
  assert.match(snapshot.node('modelShareList').innerHTML, /cloud-model/);
  assert.doesNotMatch(snapshot.node('modelShareList').innerHTML, /gemini-4-argon|999/);
  assert.match(snapshot.node('trendLegend').innerHTML, /cloud-model/);
  assert.doesNotMatch(snapshot.node('trendLegend').innerHTML, /gemini-4-argon/);
  assert.equal(snapshot.node('heatScale').style.visibility, '');
  snapshot.select('r');
  assert.equal(snapshot.node('periodTotal').textContent, '--');
  assert.equal(snapshot.node('heatScale').style.visibility, 'hidden');
  snapshot.select('c');
  assert.equal(snapshot.node('periodTotal').textContent, '100');
  assert.equal(snapshot.node('requestCount').textContent, '1');
  assert.equal(snapshot.node('tokenScope').textContent, '所选账号与统计周期');
  assert.equal(snapshot.node('heatScale').style.visibility, '');
  assert.match(snapshot.node('trendChart').innerHTML, /<svg/);
});

test('a genuinely measured zero is not mistaken for missing usage, including an explicitly metered future Robin provider', () => {
  for (const providerType of ['cloudcode', 'robin']) {
    const account = { id: 'a', enabled: true, providerType, tokenUsageKnown: true };
    const data = fixture([account], { a: counters(0, 3) }, { a: { 'known-model': counters(0, 3) } });
    const snapshot = view(data);
    assert.equal(snapshot.node('periodTotal').textContent, '0');
    assert.equal(snapshot.node('historyTotal').textContent, '0');
    assert.equal(snapshot.node('requestCount').textContent, '3');
    assert.match(snapshot.node('accounts').innerHTML, /0 Token · 3 次上游/);
    assert.doesNotMatch(snapshot.node('accounts').innerHTML, /Token 未提供/);
    assert.equal(snapshot.node('tokenScope').textContent, '所选账号与统计周期');
    assert.equal(snapshot.node('heatScale').style.visibility, '');
  }
});

test('model names shared by a metered and unmetered account are combined only from the measured account', () => {
  const data = fixture([{ id: 'c', enabled: true }, { id: 'r', enabled: true, providerType: 'robin' }],
    { c: counters(100, 1), r: counters(900, 1) }, { c: { shared: counters(100, 1) }, r: { shared: counters(900, 1) } });
  const snapshot = view(data);
  assert.equal(snapshot.node('periodTotal').textContent, '100');
  assert.match(snapshot.node('modelDonut').innerHTML, /<strong>100<\/strong>/);
  assert.match(snapshot.node('modelShareList').innerHTML, /100\.00%/);
  assert.doesNotMatch(snapshot.node('modelShareList').innerHTML, /900|1,000/);
});

test('dashboard data declares missing usage without dropping requests, quota or rewriting persisted measurements', () => {
  const raw = fixture([], { c: counters(100, 1), r: counters(0, 3) },
    { c: { 'cloud-model': counters(100, 1) }, r: { 'gemini-4-argon': counters(0, 3) } }).usage;
  const original = JSON.stringify(raw), quota = { groups: [{ buckets: [{ window: '5h', remainingFraction: .5 }] }] };
  let summaryCalls = 0;
  const data = dashboardData({
    usageStore: { summary: () => { summaryCalls++; return raw; } },
    accountPool: { status: () => [{ id: 'c' }] },
    robinAccountPool: { status: () => [{ id: 'r', quota }] },
    quotaManager: { peek: id => { assert.equal(id, 'c'); return { groups: [] }; } }, version: '1.5.1'
  });
  assert.deepEqual(data.tokenUsageMetadata, { complete: false, unmeteredAccountIds: ['r'] });
  assert.equal(data.accounts[0].tokenUsageKnown, true);
  assert.equal(data.accounts[1].tokenUsageKnown, false);
  assert.equal(data.accounts[1].quota, quota);
  assert.equal(data.usage.lifetime.upstreamCalls, 4);
  assert.equal(data.usage.lifetime.totalTokens, 100);
  assert.equal(summaryCalls, 1, 'no extra telemetry or duplicate usage snapshot is needed');
  assert.equal(JSON.stringify(raw), original);
});

test('an empty pool retains the existing empty-state semantics without inventing an unmetered account', () => {
  const data = fixture([], {}, {}), snapshot = view(data);
  assert.equal(snapshot.node('periodTotal').textContent, '0');
  assert.equal(snapshot.node('requestCount').textContent, '0');
  assert.match(snapshot.node('accounts').innerHTML, /暂无可展示账号/);
  assert.doesNotMatch(snapshot.node('tokenScope').textContent, /未提供|已测量部分/);
});
