'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REFRESH_INTERVAL_MS = 30 * 60_000;
const LOAD_PATH = '/v1internal:loadCodeAssist';
const MODELS_PATH = '/v1internal:fetchAvailableModels';

function creditSnapshot(body) {
  const paidTier = body?.paidTier && typeof body.paidTier === 'object' ? body.paidTier : {};
  const credits = Array.isArray(paidTier.availableCredits) ? paidTier.availableCredits : [];
  const credit = credits.find((item) => String(item?.creditType || '').toUpperCase() === 'GOOGLE_ONE_AI');
  const amount = Number(credit?.creditAmount);
  const minimum = Number(credit?.minimumCreditAmountForUsage);
  return {
    plan: String(paidTier.id || body?.currentTier?.id || ''),
    creditType: credit ? 'GOOGLE_ONE_AI' : '',
    creditAmount: Number.isFinite(amount) ? amount : null,
    minimumCreditAmountForUsage: Number.isFinite(minimum) ? minimum : null,
    available: credit && Number.isFinite(amount) && Number.isFinite(minimum) ? amount >= minimum : null
  };
}

function modelQuotaSnapshot(body) {
  const raw = body?.models;
  const entries = Array.isArray(raw)
    ? raw.map((value) => [String(value?.name || value?.id || value?.model || '').replace(/^models\//, ''), value])
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([id, value]) => [String(id).replace(/^models\//, ''), value])
      : [];
  const models = {};
  for (const [id, value] of entries) {
    if (!id) continue;
    const quota = value?.quotaInfo || value?.quota_info || {};
    const remaining = Number(quota.remainingFraction ?? quota.remaining_fraction);
    if (!Number.isFinite(remaining)) continue;
    models[id] = {
      remainingFraction: Math.max(0, Math.min(1, remaining)),
      resetTime: String(quota.resetTime || quota.reset_time || ''),
      available: remaining > 0
    };
  }
  return models;
}

async function fetchJson(provider, token, path, body) {
  let lastError;
  for (const base of provider.baseUrls()) {
    try {
      const response = await provider.fetchImpl(`${base}${path}`, {
        method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          accept: '*/*',
          'content-type': 'application/json',
          'user-agent': provider.userAgent
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
      return JSON.parse(text || '{}');
    } catch (error) { lastError = error.message; }
  }
  throw new Error(lastError || `${path} 读取失败`);
}

class QuotaManager {
  constructor({ configDir, accountPool, fsImpl = fs, intervalMs = REFRESH_INTERVAL_MS } = {}) {
    this.accountPool = accountPool;
    this.fs = fsImpl;
    this.intervalMs = intervalMs;
    this.directory = path.join(configDir, 'state');
    this.file = path.join(this.directory, 'quota.json');
    this.snapshots = this.load();
    this.timer = null;
    this.refreshing = null;
  }

  load() {
    try {
      const body = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      return body && typeof body === 'object' ? body : {};
    } catch { return {}; }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    setTimeout(() => { void this.refresh().catch(() => {}); }, 1000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _refresh() {
    const entries = this.accountPool.hasManagedAccounts()
      ? [...this.accountPool.entries.values()]
      : [{ account: { id: 'local-agy-session', email: '' }, provider: this.accountPool.fallbackProvider }];
    const activeIds = new Set(entries.map((entry) => entry.account.id));
    let changed = false;
    for (const id of Object.keys(this.snapshots)) {
      if (!activeIds.has(id)) { delete this.snapshots[id]; changed = true; }
    }
    const results = await Promise.allSettled(entries.map(async (entry) => {
      const token = await entry.provider.access(AbortSignal.timeout(30_000));
      const [loadResult, modelsResult] = await Promise.allSettled([
        fetchJson(entry.provider, token, LOAD_PATH, { metadata: { ideType: 'ANTIGRAVITY' } }),
        fetchJson(entry.provider, token, MODELS_PATH, {})
      ]);
      if (loadResult.status === 'rejected' && modelsResult.status === 'rejected') {
        throw new Error(`${loadResult.reason?.message || '套餐读取失败'}；${modelsResult.reason?.message || '模型额度读取失败'}`);
      }
      const credits = loadResult.status === 'fulfilled' ? creditSnapshot(loadResult.value) : creditSnapshot({});
      const models = modelsResult.status === 'fulfilled' ? modelQuotaSnapshot(modelsResult.value) : {};
      const values = Object.values(models);
      const available = values.length ? values.some((item) => item.available) : credits.available;
      return [entry.account.id, {
        accountId: entry.account.id,
        email: entry.account.email,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.intervalMs).toISOString(),
        ...credits,
        available,
        models
      }];
    }));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const [id, snapshot] = result.value;
      this.snapshots[id] = snapshot;
      changed = true;
    }
    if (changed) this.save();
    return this.snapshots;
  }

  save() {
    this.fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.fs.writeFileSync(temporary, `${JSON.stringify(this.snapshots, null, 2)}\n`);
    this.fs.renameSync(temporary, this.file);
  }

  get(accountId, model = '') {
    const snapshot = this.snapshots[accountId];
    if (!snapshot) return null;
    const expiresAt = Date.parse(snapshot.expiresAt) || 0;
    if (expiresAt && expiresAt <= Date.now()) return null;
    return this.snapshot(accountId, model, false);
  }

  peek(accountId, model = '') {
    return this.snapshot(accountId, model, true);
  }

  snapshot(accountId, model = '', allowExpired = false) {
    const snapshot = this.snapshots[accountId];
    if (!snapshot) return null;
    const expiresAt = Date.parse(snapshot.expiresAt) || 0;
    const stale = Boolean(expiresAt && expiresAt <= Date.now());
    if (stale && !allowExpired) return null;
    const modelQuota = model ? snapshot.models?.[model] : null;
    return modelQuota
      ? { ...snapshot, ...modelQuota, accountAvailable: snapshot.available, stale }
      : { ...snapshot, stale };
  }
}

module.exports = { QuotaManager, REFRESH_INTERVAL_MS, creditSnapshot, modelQuotaSnapshot };
