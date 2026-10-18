'use strict';

const https = require('node:https');
const { cookieHeader } = require('./gemini-windows-auth');
const { WINDOWS_USER_AGENT } = require('./gemini-windows-protocol');

const ORIGIN = 'https://gemini.google.com';
const USAGE_PATH = '/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery';
// Official UsagePageQuery, observed in UsagePageLoading-DX38tEpa.js and
// UsagePageSurface-CJLuUqL2.js on 2026-10-18. This is a read-only persisted query,
// not ProcessSession, ConsumeGeminiQuota, or a preference/credits mutation.
const WINDOWS_USAGE_QUERY = '2/dWbCvkVB0X16r9NPnxifeOAAqdCqMf0xeWvau9yPy7g=';
const WINDOWS_QUOTA_SOURCE = 'gemini-windows-usage';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PLAN_NAMES = new Map([
  ['TIER1', 'Google AI Pro'], ['TIER2', 'Google AI Ultra'],
  ['TIER_NEON', 'Google AI Ultra'], ['TIER_HELIUM', 'Google AI Plus']
]);

function quotaError(message, status = 502) {
  return Object.assign(new Error(message), { status, code: 'gemini_windows_quota_error' });
}

function windowsQuotaSnapshot(source, now = Date.now()) {
  if (!source || !Array.isArray(source.pools)) throw quotaError('Windows Gemini 用量响应缺少额度池。');
  const buckets = [];
  for (const [type, window, displayName] of [
    ['GXU_FIVE_HOURLY', '5h', '5 小时额度'], ['GXU_WEEKLY', 'weekly', '周额度']
  ]) {
    const matches = source.pools.filter(pool => pool?.poolType === type);
    // Unknown/duplicate pools and credit balances must not become a fabricated
    // full or empty task budget. percentageUsed is a 0..1 fraction, not 0..100.
    if (matches.length !== 1) continue;
    const pool = matches[0], used = pool.percentageUsed;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1) continue;
    const reset = typeof pool.gxu?.windowRefreshesAt === 'string' ? Date.parse(pool.gxu.windowRefreshesAt) : NaN;
    buckets.push({ id: `gemini-windows-gxu-${window}`, window, displayName,
      remainingFraction: 1 - used, resetTime: Number.isFinite(reset) ? new Date(reset).toISOString() : '', available: used < 1 });
  }
  if (!buckets.length) throw quotaError('Windows Gemini 用量响应没有可识别的 5 小时或周额度。');
  const planName = PLAN_NAMES.get(source.subscriptionTier);
  return {
    providerType: 'robin', source: WINDOWS_QUOTA_SOURCE, fetchedAt: new Date(now).toISOString(),
    ...(typeof source.subscriptionTier === 'string' ? { subscriptionTier: source.subscriptionTier } : {}),
    ...(planName ? { planName } : {}),
    groups: [{ id: 'gemini-robin', displayName: 'Gemini App', description: 'Windows Gemini 用量额度',
      buckets, available: buckets.every(bucket => bucket.available) }]
  };
}

function parseWindowsQuota(text, now = Date.now()) {
  let frames;
  try { frames = JSON.parse(text.replace(/^\)\]\}'\s*/, '')); }
  catch { throw quotaError('Windows Gemini 用量响应不是完整 JSON。'); }
  if (!Array.isArray(frames)) throw quotaError('Windows Gemini 用量响应格式无效。');
  if (frames.at(-1)?.hasNext === true) throw quotaError('Windows Gemini 用量响应被截断。');
  const usage = [];
  for (const frame of frames) {
    // Do not turn an error/null field into a 100% remaining balance. Errors in
    // unrelated upsell fields may coexist with a valid getUsageInfo response.
    if (frame?.errors != null && !Array.isArray(frame.errors)) throw quotaError('Windows Gemini 用量错误格式无效。');
    if ((frame?.errors || []).some(error => !Array.isArray(error?.path)
      || ['getUsageInfo', 'pools', 'percentageUsed'].some(key => error.path.includes(key)))) {
      throw quotaError('Windows Gemini 上游未能完整查询用量。');
    }
    const value = frame?.data?.viewer?.rpcs?.getUsageInfo;
    if (value) usage.push(value);
  }
  if (usage.length !== 1) throw quotaError('Windows Gemini 用量响应缺少唯一 getUsageInfo 结果。');
  return windowsQuotaSnapshot(usage[0], now);
}

async function fetchWindowsQuota(record, { signal, requestImpl = https.get } = {}) {
  const authUser = String(record.authUser || '0');
  if (!/^\d{1,3}$/.test(authUser)) throw quotaError('无效的 Google 账号索引。', 400);
  const combined = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  const url = new URL(USAGE_PATH, ORIGIN);
  url.searchParams.set('query_signature', WINDOWS_USAGE_QUERY);
  url.searchParams.set('variables', JSON.stringify({
    g1Request: { entrypoints: ['GEMINI_USAGE_SETTINGS_UPGRADE_BANNER',
      'GEMINI_USAGE_SETTINGS_AI_CREDITS_UPSELL_CARD', 'GEMINI_USAGE_SETTINGS_UPGRADE_AND_CREDITS_BANNER'] },
    workspaceRequest: {}
  }));
  if (authUser !== '0') url.searchParams.set('authuser', authUser);
  const headers = { Cookie: cookieHeader(record.cookies), 'User-Agent': WINDOWS_USER_AGENT,
    Origin: ORIGIN, Accept: 'application/json' };
  const load = (target, redirects = 0) => new Promise((resolve, reject) => {
    const req = requestImpl(target, { signal: combined, maxHeaderSize: 256 * 1024, headers }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, target); } catch { reject(quotaError('Windows 用量查询重定向无效。')); return; }
        const accountPrefix = `/u/${authUser}`;
        const selected = next.searchParams.get('authuser') || (next.pathname === accountPrefix + USAGE_PATH ? authUser : '0');
        if (!res.headers.location || redirects >= 3 || next.origin !== ORIGIN || next.username || next.password
          || ![USAGE_PATH, accountPrefix + USAGE_PATH].includes(next.pathname) || selected !== authUser
          || next.searchParams.get('query_signature') !== WINDOWS_USAGE_QUERY) {
          reject(quotaError('Windows 用量查询跳转到了登录页、其他账号或未支持的地址。')); return;
        }
        resolve(load(next, redirects + 1)); return;
      }
      if (res.statusCode !== 200) {
        res.resume(); reject(quotaError(`Windows Gemini 用量查询失败：HTTP ${res.statusCode}。`, res.statusCode)); return;
      }
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) req.destroy(quotaError('Windows Gemini 用量响应超过限制。'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(quotaError('Windows Gemini 用量响应被截断。')));
      res.on('end', () => {
        try { combined.throwIfAborted(); resolve(parseWindowsQuota(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
  });
  return load(url);
}

module.exports = { WINDOWS_USAGE_QUERY, WINDOWS_QUOTA_SOURCE, windowsQuotaSnapshot, parseWindowsQuota, fetchWindowsQuota };
