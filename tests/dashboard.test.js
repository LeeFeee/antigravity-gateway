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
  const end = html.indexOf('  function heatDays(){', start);
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

test('dashboard renders both account controls only for actionable account abnormalities', () => {
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
    assert.ok(html.indexOf('class="account-alert"') < html.indexOf('class="account-actions"'), 'health warning precedes its inline actions');
    assert.ok(html.indexOf('class="account-actions"') < html.indexOf('class="quota-groups"'), 'actions belong to the health row, not quota details');
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

test('dashboard healthy, cooling and disabled accounts do not expose account management controls', () => {
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
    assert.doesNotMatch(html, /data-account-action="(?:recheck|delete)"/, account.id);
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
  assert.doesNotMatch(html, /data-account-action=/);
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
  assert.doesNotMatch(noGemini, /data-account-action=/);
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
  assert.match(html, /\.is-capturing \.account-actions/);
  assert.match(html, /visibleGroups=quotaOverview\?\(q\.groups\|\|\[\]\)\.filter\(isGeminiGroup\)/);
  assert.match(html, /antigravity-dashboard-quota-view/);
  assert.match(html, /localStorage\.getItem\(QUOTA_VIEW_KEY\)/);
  assert.match(html, /localStorage\.setItem\(QUOTA_VIEW_KEY,quotaOverview\?'overview':'details'\)/);
  assert.match(html, /antigravity-dashboard-range-hours/);
  assert.match(html, /\[24,72,168,720\]\.includes\(savedHours\)/);
  assert.match(html, /localStorage\.setItem\(RANGE_KEY,String\(hours\)\)/);
  assert.match(html, /syncRangeButtons\(\);syncQuotaViewToggle\(\);load\(\)/);
  assert.match(html, /小时活跃热力图/);
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
