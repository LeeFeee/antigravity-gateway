'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { dashboardAsset, dashboardData, dashboardHtml } = require('../src/dashboard');
const { UsageStore } = require('../src/usage-store');

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
