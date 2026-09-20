'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { dashboardData, dashboardHtml } = require('../src/dashboard');
const { UsageStore } = require('../src/usage-store');

test('dashboard packages live account, quota, model and hourly usage without credentials', (t) => {
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
  const result = dashboardData({
    usageStore,
    version: '0.8.0',
    accountPool: { status: () => [{ id: 'account-1', email: 'one@example.com', enabled: true, state: 'available', modelCooldowns: [] }] },
    quotaManager: { get: () => ({ available: true, models: { 'gemini-3.8-flash-high': { remainingFraction: 0.75 } } }) }
  });
  assert.equal(result.version, '0.8.0');
  assert.equal(result.accounts[0].email, 'one@example.com');
  assert.equal(result.accounts[0].quota.models['gemini-3.8-flash-high'].remainingFraction, 0.75);
  assert.equal(result.usage.byAccountModel['account-1']['gemini-3.8-flash-high'].totalTokens, 100);
  assert.equal(Object.keys(result.usage.hourlyByAccountModel).length, 2);
  assert.equal(JSON.stringify(result).includes('accessToken'), false);
  assert.equal(JSON.stringify(result).includes('refreshToken'), false);
});

test('dashboard HTML is self-contained and contains the required monitoring surfaces', () => {
  const html = dashboardHtml();
  assert.match(html, /Token 消耗看板/);
  assert.match(html, /账号池与额度/);
  assert.match(html, /小时活跃热力图/);
  assert.match(html, /模型消耗分布/);
  assert.match(html, /每日 Token 构成/);
  assert.match(html, /fetch\('\/dashboard\/data'/);
  assert.doesNotMatch(html, /https?:\/\/[^'" ]+\.(?:js|css)/);
});
