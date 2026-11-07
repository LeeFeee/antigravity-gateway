'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { dashboardAsset, dashboardData, dashboardHtml } = require('../src/dashboard');
const { UsageStore } = require('../src/usage-store');

function renderAccountHtml(accounts, { overview = false, byAccount = {} } = {}) {
  const html = dashboardHtml();
  const start = html.indexOf("  const COLORS=");
  const end = html.indexOf('  function heatDays(', start);
  assert.ok(start >= 0 && end > start, 'dashboard account rendering script is available');
  const nodes = new Map();
  const context = {
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { innerHTML: '' });
        return nodes.get(id);
      }
    },
    localStorage: {
      getItem(key) {
        return key === 'antigravity-dashboard-quota-view' && overview ? 'overview' : null;
      }
    },
    inputData: { accounts, usage: { byAccount } }
  };
  vm.runInNewContext(html.slice(start, end) + '\nDATA=inputData;renderAccounts();', context, { timeout: 1000 });
  return nodes.get('accounts').innerHTML;
}

function quotaGroups() {
  return [
    {
      id: 'gemini', displayName: 'Gemini Models', description: 'Gemini Flash, Gemini Pro',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9821, resetTime: '2026-10-02T08:44:08Z' },
        { id: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-09-30T12:16:58Z' }
      ]
    },
    {
      id: '3p', displayName: 'Claude and GPT Models', description: 'Claude Opus, Claude Sonnet, GPT-OSS',
      buckets: [{ id: '3p-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-10-05T00:00:00Z' }]
    }
  ];
}

test('quota protection is a warning state, not an authentication failure requiring recheck', () => {
  const html = renderAccountHtml([{
    id: 'protected', email: 'protected@example.com', providerType: 'cloudcode', enabled: true,
    state: 'quota_protected', quota: { groups: quotaGroups() }
  }]);
  assert.match(html, /Gemini 额度保护/);
  assert.match(html, /dot warn/);
  assert.doesNotMatch(html, /data-account-action="recheck"|认证异常/);
  assert.match(html, /Claude 和 GPT/);
});

test('dashboard renders only the active Google Antigravity API account group', () => {
  const html = renderAccountHtml([
    { id: 'active', email: 'active@example.com', providerType: 'cloudcode', enabled: true, state: 'available' },
    { id: 'old', email: 'old@example.com', providerType: 'robin', enabled: true, state: 'available' }
  ]);
  assert.match(html, /Google Antigravity API|active@example.com/);
  assert.doesNotMatch(html, /old@example.com|Robin|Gemini App/);
});

function cssBlock(css, selector) {
  const start = css.indexOf(selector + '{');
  assert.ok(start >= 0, 'CSS block exists: ' + selector);
  let depth = 1;
  let end = start + selector.length + 1;
  const contentStart = end;
  while (end < css.length && depth) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0, 'CSS block is complete: ' + selector);
  return css.slice(contentStart, end - 1);
}

test('dashboard overview contains all nine metrics once and no duplicate metrics in trend', () => {
  const html = dashboardHtml();
  const overview = html.slice(html.indexOf('<article class="card overview"'), html.indexOf('<article class="card trend"'));
  const trend = html.slice(html.indexOf('<article class="card trend"'), html.indexOf('<div class="column left-column"'));
  for (const id of ['historyTotal', 'historyRequests', 'inputTokens', 'outputTokens', 'cacheTotal', 'cacheRate', 'upstreamCalls', 'cacheRateTop', 'failureRate', 'failureCount']) {
    assert.equal((overview.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
    assert.ok(!trend.includes('id="' + id + '"'), id);
  }
  assert.equal((overview.match(/class="stat-slab"/g) || []).length, 9);
  assert.match(overview, /历史缓存命中率/);
  assert.match(overview, /缓存命中率 · 时段/);
});

test('dashboard chart panels do not crop long ranges or force a desktop heatmap width', () => {
  const css = dashboardHtml().match(/<style>([\s\S]*?)<\/style>/)[1].split('/* Bailey-inspired visual system.')[1];
  assert.match(cssBlock(css, '.card'), /overflow:visible/);
  assert.match(css, /\n    \.trend\{height:auto;/);
  assert.match(css, /\n    \.trend\{height:auto;min-height:350px/);
  assert.match(css, /\n    \.heat\{height:auto;min-height:350px;align-self:stretch;display:flex;flex-direction:column/);
  assert.match(cssBlock(css, '.heat .card-body'), /flex:1/);
  assert.match(cssBlock(css, '.heat .card-body'), /gap:12px;padding-top:14px/);
  assert.match(cssBlock(css, '.heatmap-wrap'), /flex:1 0 230px;min-height:230px/);
  assert.match(cssBlock(css, '.heatmap-wrap'), /padding:16px 0 30px/);
  assert.match(cssBlock(css, '.heat-calendar'), /height:100%/);
  assert.match(cssBlock(css, '.heat-calendar'), /align-content:space-between/);
  assert.match(cssBlock(css, '.heat-axis'), /bottom:0/);
  assert.match(cssBlock(css, '.heat-axis'), /height:30px/);
  assert.match(cssBlock(css, '.overview-stats'), /grid-template-rows:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(cssBlock(css, '.heat-calendar'), /grid-template-rows:repeat\(7,var\(--day-size\)\)/);
  assert.match(cssBlock(css, '.heat-calendar'), /repeat\(var\(--heat-weeks\),var\(--day-size\)\)/);
  assert.match(cssBlock(css, '.heat-calendar'), /width:100%/);
  assert.match(cssBlock(css, '.heatmap-wrap'), /min-width:0/);
  assert.match(cssBlock(css, '#trendChart'), /min-height:230px/);
  assert.doesNotMatch(css, /min-width:5[13]0px|height:360px/);
});

test('activity uses the same legend, plot padding and axis baseline as the trend chart', () => {
  const html = dashboardHtml();
  const heat = html.slice(html.indexOf('<article class="card heat">'), html.indexOf('<article class="card model-share">'));
  assert.ok(heat.indexOf('id="heatScale"') < heat.indexOf('id="heatmap"'));
  assert.match(html, /T=16,B=30,plotW=/);
  assert.match(html, /class="heat-month" x=".*?y="22"/);
  assert.match(html, /class="heat-axis" viewBox="0 0 .*? 30"/);
  assert.ok(html.includes("$('heatScale').style.setProperty('--chart-legend-height',entry.contentRect.height+'px')"));
});

test('daily activity shares the neutral palette across cells, legend and focus borders', () => {
  const css = dashboardHtml().match(/<style>([\s\S]*?)<\/style>/)[1].split('/* Bailey-inspired visual system.')[1];
  const palette = cssBlock(css, ':root');
  assert.match(palette, /--heat-ink:var\(--text-soft\)/);
  assert.match(palette, /--heat-zero:#e7e7e9;--heat-1:#c4c4c7;--heat-2:#a1a1a6;--heat-3:var\(--muted\);--heat-4:var\(--ink\)/);
  assert.match(cssBlock(css, '.heat-day:focus-visible'), /outline-color:var\(--heat-ink\)/);
  assert.match(css, /\.heat-day:not\(\.outside\):hover\{outline-color:var\(--heat-ink\)/);
  for (let level = 1; level <= 4; level++) {
    assert.match(cssBlock(css, '.heat-day[data-level="' + level + '"]'), new RegExp('background:var\\(--heat-' + level + '\\)'));
    assert.match(cssBlock(css, '.heat-scale i:nth-of-type(' + (level + 1) + ')'), new RegExp('background:var\\(--heat-' + level + '\\)'));
  }
});

test('dashboard 30-day plot retains all models and heatmap cells with finite responsive geometry', () => {
  const html = dashboardHtml(), start = html.indexOf('  const COLORS='), end = html.indexOf('  function render(){', start);
  const nodes = new Map();
  const at = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  const byModel = Object.fromEntries(['one', 'two', 'three', 'four', 'five'].map((name, i) => [name, { totalTokens: 100000000 * (i + 1) }]));
  const context = {
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', style: {}, clientWidth: 272, clientHeight: 420 }); return nodes.get(id); } },
    localStorage: { getItem() { return null; } },
    inputData: { accounts: [{ id: 'a', providerType: 'cloudcode' }], usage: { history: [{ at, totalTokens: 1500000000 }], hourlyByModel: { [at]: byModel } } }
  };
  vm.runInNewContext(html.slice(start, end) + '\nDATA=inputData;hours=720;renderHeatmap();svg=trendSvg();curve=smoothPath([{x:0,y:0},{x:10,y:10},{x:20,y:0}]);', context, { timeout: 2000 });
  assert.equal((nodes.get('heatmap').innerHTML.match(/class="heat-day[" ]/g) || []).length, 11 * 7);
  assert.match(nodes.get('heatmap').innerHTML, /--heat-weeks:11/);
  assert.match(nodes.get('heatmap').innerHTML, /class="heat-month"/);
  assert.doesNotMatch(nodes.get('heatCaption').textContent, /最近 30 天/);
  assert.match(nodes.get('trendLegend').innerHTML, /five.*four.*three.*其他模型/);
  assert.match(context.svg, /viewBox="0 0 272 420"/);
  assert.equal((context.svg.match(/class="trend-area"/g) || []).length, 4);
  assert.equal((context.svg.match(/class="point is-last"/g) || []).length, 4);
  assert.match(context.svg, /text-anchor="start"/);
  assert.match(context.svg, /text-anchor="end"/);
  assert.doesNotMatch(context.svg, /NaN|Infinity|preserveAspectRatio="none"/);
  assert.match(context.curve, /C3\.333 3\.333 6\.667 10 10 10 C13\.333 10 16\.667 3\.333 20 0/);
});

test('daily activity fills the available width and is independent of the top period filter', () => {
  const html = dashboardHtml(), start = html.indexOf('  const COLORS='), end = html.indexOf('  function sparkline(', start);
  const now = new Date(2026, 10, 2, 12, 30).getTime();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const records = [
    [new Date(2026, 10, 2, 0).toISOString(), 100],
    [new Date(2026, 10, 2, 10).toISOString(), 250],
    [new Date(2026, 10, 1, 23).toISOString(), 75],
    [new Date(2026, 9, 30, 10).toISOString(), 0],
    [new Date(2026, 10, 2, 23).toISOString(), 999], // Future records must not leak into today.
    [new Date(2026, 9, 1, 0).toISOString(), 888]
  ];
  const nodes = new Map();
  const context = vm.createContext({
    Date: ClockDate,
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', style: {} }); return nodes.get(id); } },
    localStorage: { getItem() { return null; } },
    inputData: { accounts: [{ id: 'a' }, { id: 'b' }], usage: {
      history: records.map(([at, totalTokens]) => ({ at, totalTokens })),
      hourlyByAccount: Object.fromEntries(records.map(([at, totalTokens]) => [at, { a: { totalTokens: totalTokens / 5 }, b: { totalTokens: totalTokens * 4 / 5 } }]))
    } }
  });
  vm.runInContext(html.slice(start, end) + '\nDATA=inputData;', context);
  let firstDate, calendar;
  for (const range of [24, 72, 168, 720]) {
    context.range = range;
    vm.runInContext('hours=range;result=heatDays();renderHeatmap();', context);
    assert.equal(context.result.length, 42);
    firstDate ??= context.result[0].date;
    assert.equal(context.result[0].date, firstDate, 'range switching does not shift the six-week calendar');
    calendar ??= nodes.get('heatmap').innerHTML;
    assert.equal(nodes.get('heatmap').innerHTML, calendar, 'range switching must not change heatmap dates, values or colors');
    assert.equal(context.result.find(day => day.date === '2026-11-02').total, 350);
    assert.equal(context.result.find(day => day.date === '2026-11-03').inRange, false);
    assert.equal(context.result.filter(day => !day.inRange).every(day => day.total === null), true);
    assert.equal((nodes.get('heatmap').innerHTML.match(/class="heat-day[" ]/g) || []).length, 77);
    assert.match(nodes.get('heatmap').innerHTML, /2026-11-02 · 350 Token/);
  }
  assert.equal(context.result.find(day => day.date === '2026-11-01').total, 75);
  assert.equal(context.result.find(day => day.date === '2026-10-31').total, null, 'missing history is not a measured zero');
  assert.equal(context.result.find(day => day.date === '2026-10-30').total, 0);
  assert.match(nodes.get('heatmap').innerHTML, /2026-10-31 · 无记录/);
  assert.match(nodes.get('heatmap').innerHTML, /2026-10-30 · 0 Token/);
  for (const width of [268, 323, 372, 453, 696, 1200]) {
    context.width = width;
    vm.runInContext('weeks=heatWeekCount(width);result=heatDays(weeks);', context);
    const used = context.weeks * 18 + (context.weeks - 1) * 6;
    assert.ok(used <= width && width - used < 24, 'fills all full columns without overflowing');
    assert.equal(context.result.length, context.weeks * 7);
  }
  vm.runInContext("account='a';result=heatDays();renderHeatmap();", context);
  assert.equal(context.result.find(day => day.date === '2026-11-02').total, 70);
  assert.match(nodes.get('heatmap').innerHTML, /2026-11-02 · 70 Token/);
  assert.doesNotMatch(dashboardHtml(), /每格 1 小时/);
});

test('daily activity includes both repeated hours at the daylight-saving boundary', () => {
  const html = dashboardHtml(), start = html.indexOf('  const COLORS='), end = html.indexOf('  function sparkline(', start);
  const now = Date.parse('2026-11-02T20:00:00Z');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    Date: ClockDate, localStorage: { getItem() { return null; } },
    inputData: { accounts: [], usage: { history: [
      { at: '2026-11-01T05:00:00Z', totalTokens: 120 },
      { at: '2026-11-01T06:00:00Z', totalTokens: 180 }
    ] } }
  };
  vm.runInNewContext(html.slice(start, end) + '\nDATA=inputData;hours=720;result=heatDays();', context);
  assert.equal(context.result.filter(day => day.inRange).reduce((sum, day) => sum + day.total, 0), 300);
});

test('dashboard responsive account layout keeps controls inline and quota values above their progress bar', () => {
  const css = dashboardHtml().match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(css);
  assert.match(cssBlock(css, '.account-health'), /display:flex/);
  assert.doesNotMatch(cssBlock(css, '.account-actions'), /margin-top:/);
  assert.match(cssBlock(css, '.quota-bucket'), /grid-template-areas:"name bar number meta"/);
  assert.match(cssBlock(css, '.quota-bucket-name'), /grid-area:name/);
  assert.match(cssBlock(css, '.quota-number'), /grid-area:number/);
  assert.match(cssBlock(css, '.quota-bucket .quota-meta'), /grid-area:meta/);
  const mobile = cssBlock(css, '@media(max-width:680px)');
  assert.match(cssBlock(mobile, '.account-health'), /flex-direction:column/);
  assert.match(cssBlock(mobile, '.account-actions'), /order:-1/);
  assert.match(cssBlock(mobile, '.quota-bucket'), /grid-template-areas:"name number meta" "bar bar bar"/);
});

test('dashboard renders recheck for actionable abnormalities and one delete control for every account', () => {
  for (const [state, label] of [
    ['verification_required', '需安全核验'],
    ['authentication_error', '认证异常'],
    ['access_denied', '访问受限']
  ]) {
    const html = renderAccountHtml([{
      id: 'account-' + state, email: 'test@example.com', enabled: true, state,
      healthMessage: '账号需要用户处理', healthSince: '2026-09-30T00:00:00Z',
      quota: { groups: quotaGroups() }
    }]);
    assert.match(html, /class="account-health"/);
    assert.match(html, /class="account-alert"/);
    assert.match(html, /账号需要用户处理/);
    assert.match(html, /发现时间：/);
    assert.ok(html.includes(label), state);
    assert.equal((html.match(/data-account-action="recheck"/g) || []).length, 1, state);
    assert.equal((html.match(/data-account-action="delete"/g) || []).length, 1, state);
    assert.ok(html.indexOf('data-account-action="delete"') < html.indexOf('class="account-alert"'), 'delete belongs to the account header');
    assert.ok(html.indexOf('class="account-alert"') < html.indexOf('class="account-actions"'), 'health warning precedes its recheck action');
    assert.ok(html.indexOf('class="account-actions"') < html.indexOf('class="quota-groups"'), 'recheck belongs to the health row, not quota details');
  }
});

test('dashboard abnormal accounts keep warning and controls without a server health message', () => {
  for (const [state, label] of [
    ['verification_required', '需安全核验'],
    ['authentication_error', '认证异常'],
    ['access_denied', '访问受限']
  ]) {
    const html = renderAccountHtml([{ id: state, enabled: true, state }]);
    assert.match(html, /class="account-alert"/);
    const warning = html.match(/class="account-alert">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(warning?.includes(label), 'fallback warning for ' + state);
    assert.match(html, /data-account-action="recheck"/);
    assert.match(html, /data-account-action="delete"/);
    assert.doesNotMatch(html, /发现时间：/);
  }
});

test('dashboard healthy, cooling and disabled accounts expose delete without recheck', () => {
  for (const account of [
    { id: 'healthy', enabled: true, state: 'available' },
    { id: 'healthy-old-message', enabled: true, state: 'available', healthMessage: 'Previous verification failure' },
    { id: 'implicit-healthy', enabled: true },
    { id: 'cooling', enabled: true, state: 'cooldown' },
    { id: 'disabled', enabled: false, state: 'disabled' },
    { id: 'disabled-abnormal', enabled: false, state: 'verification_required', healthMessage: 'Previous verification failure' }
  ]) {
    const html = renderAccountHtml([account]);
    assert.doesNotMatch(html, /class="account-health"/, account.id);
    assert.doesNotMatch(html, /class="account-actions"/, account.id);
    assert.doesNotMatch(html, /data-account-action="recheck"/, account.id);
    assert.equal((html.match(/data-account-action="delete"/g) || []).length, 1, account.id);
    assert.match(html, /class="quota-groups"/, 'quota details remain for ' + account.id);
  }
});

test('dashboard escapes abnormal account labels, identifiers and health messages', () => {
  const html = renderAccountHtml([{
    id: 'id" onclick="alert(1)', email: '<img src=x onerror=alert(1)>', enabled: true,
    state: 'authentication_error', healthMessage: '<script>alert("token")</script> & account',
    quota: { groups: [] }
  }]);
  assert.match(html, /data-account-id="id&quot; onclick=&quot;alert\(1\)"/);
  assert.match(html, /data-account-label="&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(html, /&lt;script&gt;alert\(&quot;token&quot;\)&lt;\/script&gt; &amp; account/);
  assert.doesNotMatch(html, /<script>|<img| onclick="/);
});

test('dashboard account quota output preserves weekly and five-hour percentage and reset information', () => {
  const html = renderAccountHtml([{
    id: 'healthy', enabled: true, state: 'available', quota: { groups: quotaGroups() }
  }]);
  assert.match(html, /每周剩余额度/);
  assert.match(html, /5 小时剩余额度/);
  assert.match(html, /class="quota-number">98\.21%<\/div>/);
  assert.match(html, /class="quota-number">100%<\/div>/);
  assert.ok(html.includes(new Date('2026-10-02T08:44:08Z').toLocaleString('zh-CN')));
  assert.ok(html.includes(new Date('2026-09-30T12:16:58Z').toLocaleString('zh-CN')));
  assert.match(html, /Gemini 模型组/);
  assert.match(html, /Claude 和 GPT 模型组/);
  assert.match(html, /data-account-action="delete"/);
  assert.doesNotMatch(html, /data-account-action="recheck"/);
});

test('dashboard saved quota overview shows only Gemini without changing abnormal account controls', () => {
  const html = renderAccountHtml([{
    id: 'abnormal', enabled: true, state: 'access_denied', quota: { groups: quotaGroups() }
  }], { overview: true });
  assert.match(html, /Gemini 模型组/);
  assert.doesNotMatch(html, /Claude 和 GPT 模型组|Claude Opus|42%/);
  assert.match(html, /98\.21%/);
  assert.match(html, /data-account-action="recheck"/);
  assert.match(html, /data-account-action="delete"/);

  const noGemini = renderAccountHtml([{
    id: 'healthy', enabled: true, state: 'available', quota: { groups: quotaGroups().slice(1) }
  }], { overview: true });
  assert.match(noGemini, /暂无 Gemini 模型组额度快照/);
  assert.match(noGemini, /data-account-action="delete"/);
  assert.doesNotMatch(noGemini, /data-account-action="recheck"/);
});

test('dashboard uses the account pool as the only account and usage scope', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-dashboard-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-09-20T12:15:00Z');
  const usageStore = new UsageStore({ configDir: directory, now: () => now });
  usageStore.recordUpstream({
    accountId: 'account-1', model: 'gemini-3.8-flash-high',
    usage: { input_tokens: 80, output_tokens: 20, cache_read_tokens: 30, total_tokens: 100 },
    success: true
  });
  now += 60 * 60_000;
  usageStore.recordUpstream({ accountId: 'account-1', model: 'claude-sonnet-4-6', success: false });
  usageStore.recordUpstream({
    accountId: 'local-agy-session', model: 'legacy-model',
    usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 }, success: true
  });
  const result = dashboardData({
    usageStore,
    version: '0.8.0',
    accountPool: { status: () => [{ id: 'account-1', email: 'one@example.com', enabled: true, state: 'available', modelCooldowns: [] }] },
    robinAccountPool: { status: () => { throw new Error('retired account store must not be read'); } },
    quotaManager: { peek: () => ({ available: true, stale: false, groups: [{
      id: 'gemini', displayName: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-09-23T02:34:00Z' },
        { id: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-09-21T07:41:36Z' }
      ]
    }] }) }
  });
  assert.equal(result.version, '0.8.0');
  assert.equal(result.accounts[0].email, 'one@example.com');
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].quota.groups[0].buckets[0].remainingFraction, 0.75);
  assert.equal(result.usage.byAccountModel['account-1']['gemini-3.8-flash-high'].totalTokens, 100);
  assert.equal(result.usage.lifetime.totalTokens, 100);
  assert.equal(result.usage.byAccount['local-agy-session'], undefined);
  assert.equal(result.usage.byAccountModel['local-agy-session'], undefined);
  assert.equal(result.usage.byModel['legacy-model'], undefined);
  assert.equal(result.accounts.some((account) => account.id === 'local-agy-session'), false);
  assert.equal(Object.keys(result.usage.hourlyByAccountModel).length, 2);
  assert.equal(JSON.stringify(result).includes('accessToken'), false);
  assert.equal(JSON.stringify(result).includes('refreshToken'), false);
});

test('dashboard HTML contains the required monitoring surfaces and bundled assets', () => {
  const html = dashboardHtml();
  assert.match(html, /Token 消耗看板/);
  assert.match(html, /账号池与额度/);
  assert.match(html, /id="quotaViewToggle"/);
  assert.match(html, /额度概览/);
  assert.match(html, /额度详情/);
  assert.match(html, /需安全核验/);
  assert.match(html, /认证异常/);
  assert.match(html, /account-alert/);
  assert.match(html, /重新检测/);
  assert.match(html, /删除账号/);
  assert.match(html, /data-account-action="recheck"/);
  assert.match(html, /data-account-action="delete"/);
  assert.match(html, /\/dashboard\/accounts\//);
  assert.match(html, /window\.confirm/);
  assert.match(html, /\.is-capturing \.account-action/);
  assert.match(html, /visibleGroups=quotaOverview\?\(q\.groups\|\|\[\]\)\.filter\(isGeminiGroup\)/);
  assert.match(html, /antigravity-dashboard-quota-view/);
  assert.match(html, /localStorage\.getItem\(QUOTA_VIEW_KEY\)/);
  assert.match(html, /localStorage\.setItem\(QUOTA_VIEW_KEY,quotaOverview\?'overview':'details'\)/);
  assert.match(html, /antigravity-dashboard-range-hours/);
  assert.match(html, /\[24,72,168,720\]\.includes\(savedHours\)/);
  assert.match(html, /localStorage\.setItem\(RANGE_KEY,String\(hours\)\)/);
  assert.match(html, /syncRangeButtons\(\);syncQuotaViewToggle\(\);load\(\)/);
  assert.match(html, /Token 活动/);
  assert.match(html, /模型消耗占比/);
  assert.match(html, /\/dashboard\/assets\/community-qr\.png/);
  assert.match(html, /\/dashboard\/assets\/community-poster\.png/);
  assert.match(html, /生成图片/);
  assert.match(html, /id="saveOverlay"/);
  assert.match(html, /长按下方图片/);
  assert.match(html, /foreignObjectRendering/);
  assert.match(html, /onclone/);
  assert.match(html, /canvasLooksRendered/);
  assert.match(html, /shareImageSources/);
  assert.match(html, /options\.x=-documentLeft/);
  assert.match(html, /options\.y=-documentTop/);
  assert.doesNotMatch(html, /cloneNode\(true\)/);
  assert.doesNotMatch(html, /left:-100000px/);
  assert.doesNotMatch(html, /navigator\.(?:canShare|share)\b/);
  assert.doesNotMatch(html, /最高模型余额/);
  assert.doesNotMatch(html, /每日 Token 构成/);
  assert.match(html, /每周剩余额度/);
  assert.match(html, /5 小时剩余额度/);
  assert.match(html, /agy \/usage/);
  assert.match(html, /hourlyByAccountModel/);
  assert.match(html, /fetch\('\/dashboard\/data'/);
  assert.doesNotMatch(html, /https?:\/\/[^'" ]+\.(?:js|css)/);

  const qr = dashboardAsset('community-qr.png');
  assert.equal(qr.contentType, 'image/png');
  assert.deepEqual([...qr.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
