'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
let htmlCache = '';

function dashboardHtml() {
  if (!htmlCache) htmlCache = fs.readFileSync(DASHBOARD_FILE, 'utf8');
  return htmlCache;
}

function dashboardData({ usageStore, accountPool, quotaManager, version }) {
  const usage = usageStore.summary({ live: true, detailed: true });
  const status = accountPool.status();
  const accountIds = new Set([
    ...status.map((account) => account.id),
    ...Object.keys(usage.byAccount || {})
  ]);
  if (!accountIds.size) accountIds.add('local-agy-session');
  const byId = new Map(status.map((account) => [account.id, account]));
  const accounts = [...accountIds].map((id) => {
    const current = byId.get(id) || {
      id,
      email: id === 'local-agy-session' ? '本地 agy 登录账号' : '',
      enabled: true,
      state: 'available',
      modelCooldowns: []
    };
    return { ...current, quota: quotaManager?.get(id) || null };
  });
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

module.exports = { browserCommand, checkDashboard, dashboardData, dashboardHtml, openBrowser };
