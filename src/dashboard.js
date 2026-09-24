'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const DASHBOARD_ASSETS = Object.freeze({
  'community-qr.png': { file: 'community-qr.png', contentType: 'image/png' },
  'community-poster.png': { file: 'community-poster.png', contentType: 'image/png' },
  'html2canvas.min.js': {
    absolutePath: require.resolve('html2canvas/dist/html2canvas.min.js'),
    contentType: 'text/javascript; charset=utf-8'
  }
});
let htmlCache = '';
const assetCache = new Map();

function dashboardHtml() {
  if (!htmlCache) htmlCache = fs.readFileSync(DASHBOARD_FILE, 'utf8');
  return htmlCache;
}

function dashboardAsset(name) {
  const asset = DASHBOARD_ASSETS[name];
  if (!asset) return null;
  const filename = asset.absolutePath || path.join(__dirname, 'assets', asset.file);
  if (!assetCache.has(name)) assetCache.set(name, fs.readFileSync(filename));
  return { body: assetCache.get(name), contentType: asset.contentType };
}

const COUNTER_KEYS = [
  'clientRequests', 'upstreamCalls', 'successfulUpstreamCalls', 'failedUpstreamCalls',
  'inputTokens', 'outputTokens', 'thinkingTokens', 'cachedTokens', 'totalTokens'
];

function counters() {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));
}

function addCounters(target, source) {
  for (const key of COUNTER_KEYS) target[key] += Number(source?.[key]) || 0;
  return target;
}

function selectAccounts(source, accountIds) {
  return Object.fromEntries(Object.entries(source || {}).filter(([id]) => accountIds.has(id)));
}

function accountPoolUsage(usage, accountIds) {
  const byAccount = selectAccounts(usage.byAccount, accountIds);
  const byAccountModel = selectAccounts(usage.byAccountModel, accountIds);
  const hourlyByAccount = {};
  const hourlyByAccountModel = {};
  const hourlyByModel = {};
  const historyByTime = new Map((usage.history || []).map((row) => [row.at, row]));
  const timestamps = new Set([
    ...historyByTime.keys(),
    ...Object.keys(usage.hourlyByAccount || {}),
    ...Object.keys(usage.hourlyByAccountModel || {})
  ]);

  for (const at of timestamps) {
    const activeAccounts = selectAccounts(usage.hourlyByAccount?.[at], accountIds);
    const activeAccountModels = selectAccounts(usage.hourlyByAccountModel?.[at], accountIds);
    hourlyByAccount[at] = activeAccounts;
    hourlyByAccountModel[at] = activeAccountModels;
    const models = {};
    for (const accountModels of Object.values(activeAccountModels)) {
      for (const [model, values] of Object.entries(accountModels || {})) {
        addCounters((models[model] ||= counters()), values);
      }
    }
    hourlyByModel[at] = models;
  }

  const byModel = {};
  for (const accountModels of Object.values(byAccountModel)) {
    for (const [model, values] of Object.entries(accountModels || {})) {
      addCounters((byModel[model] ||= counters()), values);
    }
  }

  const lifetime = counters();
  for (const values of Object.values(byAccount)) addCounters(lifetime, values);
  // Client requests are recorded before an upstream account is selected, so
  // they remain a gateway-level metric. Every account-bound metric below is
  // derived exclusively from the current account pool.
  lifetime.clientRequests = Number(usage.lifetime?.clientRequests) || 0;
  const history = [...timestamps].sort().map((at) => {
    const values = counters();
    for (const accountValues of Object.values(hourlyByAccount[at] || {})) addCounters(values, accountValues);
    values.clientRequests = Number(historyByTime.get(at)?.clientRequests) || 0;
    return { at, ...values };
  });

  return {
    ...usage,
    lifetime,
    history,
    byModel,
    byAccount,
    hourlyByAccount,
    hourlyByModel,
    hourlyByAccountModel,
    byAccountModel
  };
}

function dashboardData({ usageStore, accountPool, quotaManager, version }) {
  const status = accountPool.status();
  const accountIds = new Set(status.map((account) => account.id));
  const usage = accountPoolUsage(usageStore.summary({ live: true, detailed: true }), accountIds);
  const accounts = status.map((account) => ({
    ...account,
    quota: quotaManager?.peek?.(account.id) || quotaManager?.get(account.id) || null
  }));
  return {
    version,
    generatedAt: new Date().toISOString(),
    refreshSeconds: 60,
    accounts,
    usage
  };
}

function browserCommand(url) {
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  if (process.platform === 'win32') return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', url]
  };
  return { command: 'xdg-open', args: [url] };
}

function openBrowser(url) {
  const target = browserCommand(url);
  const child = spawn(target.command, target.args, { detached: true, stdio: 'ignore', windowsHide: true });
  // A missing desktop opener must never terminate a headless gateway. The URL
  // is always printed so users can still open it manually.
  child.once('error', () => {});
  child.unref();
}

function checkDashboard(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error(`HTTP ${response.statusCode}`));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

module.exports = { accountPoolUsage, browserCommand, checkDashboard, dashboardAsset, dashboardData, dashboardHtml, openBrowser };
