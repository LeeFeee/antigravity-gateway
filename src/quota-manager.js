'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REFRESH_INTERVAL_MS = 30 * 60_000;
const TARGETED_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const LOAD_PATH = '/v1internal:loadCodeAssist';
const MODELS_PATH = '/v1internal:fetchAvailableModels';
const USAGE_PATH = '/v1internal:retrieveUserQuotaSummary';

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

function usageQuotaSnapshot(body) {
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  return groups.map((group, groupIndex) => {
    const buckets = (Array.isArray(group?.buckets) ? group.buckets : []).flatMap((bucket, bucketIndex) => {
      const rawRemaining = bucket?.remainingFraction ?? bucket?.remaining_fraction;
      const remaining = rawRemaining == null || String(rawRemaining).trim() === '' || typeof rawRemaining === 'boolean' ? NaN : Number(rawRemaining);
      if (!Number.isFinite(remaining)) return [];
      return [{
        id: String(bucket?.bucketId || bucket?.bucket_id || `${groupIndex}-${bucketIndex}`),
        displayName: String(bucket?.displayName || bucket?.display_name || bucket?.window || ''),
        window: String(bucket?.window || ''),
        remainingFraction: Math.max(0, Math.min(1, remaining)),
        resetTime: String(bucket?.resetTime || bucket?.reset_time || ''),
        description: String(bucket?.description || ''),
        available: remaining > 0
      }];
    });
    return {
      id: String(group?.groupId || group?.group_id || buckets[0]?.id?.replace(/-(?:weekly|5h)$/i, '') || `group-${groupIndex}`),
      displayName: String(group?.displayName || group?.display_name || `Group ${groupIndex + 1}`),
      description: String(group?.description || ''),
      buckets,
      available: buckets.length ? buckets.every((bucket) => bucket.available) : null
    };
  }).filter((group) => group.buckets.length);
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
      if (!response.ok) {
        const error = new Error(text || `HTTP ${response.status}`);
        error.status = response.status;
        lastError = error;
        continue;
      }
      return JSON.parse(text || '{}');
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error(`${path} 读取失败`);
}

class QuotaManager {
  constructor({ configDir, accountPool, fsImpl = fs, intervalMs = REFRESH_INTERVAL_MS, now = () => Date.now(), refreshConcurrency = 2 } = {}) {
    this.accountPool = accountPool;
    this.fs = fsImpl;
    this.intervalMs = intervalMs;
    this.now = now;
    this.refreshConcurrency = Math.max(1, Number(refreshConcurrency) || 2);
    this.directory = path.join(configDir, 'state');
    this.file = path.join(this.directory, 'quota.json');
    this.snapshots = this.load();
    this.timer = null;
    this.refreshing = null;
    this.refreshingAccounts = new Map();
    this.refreshAttempts = new Map();
    this.refreshQueue = [];
    this.activeRefreshes = 0;
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

  activeEntries() {
    const managedEntries = this.accountPool.hasManagedAccounts()
      ? [...this.accountPool.entries.values()]
      : [];
    const allEntries = managedEntries.length
      ? managedEntries
      : (this.accountPool.canUseFallback?.() ?? true)
          ? [{ account: { id: 'local-agy-session', email: '' }, provider: this.accountPool.fallbackProvider, healthState: 'available' }]
          : [];
    return allEntries;
  }

  usableEntry(entry) {
    return entry && entry.account.enabled !== false && (this.accountPool.isAccountHealthy?.(entry) ?? true);
  }

  currentEntry(accountId) {
    return this.activeEntries().find((entry) => entry.account.id === accountId);
  }

  async _refresh() {
    const allEntries = this.activeEntries();
    const activeIds = new Set(allEntries.map((entry) => entry.account.id));
    let changed = false;
    for (const id of Object.keys(this.snapshots)) {
      if (!activeIds.has(id)) { delete this.snapshots[id]; changed = true; }
    }
    const results = await Promise.allSettled(allEntries.filter((entry) => this.usableEntry(entry)).map((entry) => (
      this.refreshAccount(entry.account.id, { force: true, summaryOnly: false })
    )));
    if (changed || results.some((result) => result.status === 'fulfilled' && result.value)) this.save();
    return this.snapshots;
  }

  refreshAccount(accountId, { force = false, summaryOnly = true } = {}) {
    const entry = this.currentEntry(accountId);
    if (!this.usableEntry(entry)) return Promise.resolve(null);
    const pending = this.refreshingAccounts.get(accountId);
    if (pending) {
      if (pending.provider !== entry.provider) {
        return pending.promise.catch(() => null).then(() => this.refreshAccount(accountId, { force: true, summaryOnly }));
      }
      // A full refresh must still fetch catalog and plan data if it followed a
      // summary-only request. Both paths otherwise share the same per-account job.
      if (!summaryOnly && pending.summaryOnly) {
        return pending.promise.catch(() => null).then(() => this.refreshAccount(accountId, { force: true, summaryOnly: false }));
      }
      return pending.promise;
    }
    const last = this.refreshAttempts.get(accountId);
    if (!force && last?.provider === entry.provider && this.now() - last.at < TARGETED_REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve(this.snapshots[accountId] || null);
    }
    this.refreshAttempts.set(accountId, { at: this.now(), provider: entry.provider });
    const job = { entry, provider: entry.provider, summaryOnly };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    }).finally(() => {
      if (this.refreshingAccounts.get(accountId) === job) this.refreshingAccounts.delete(accountId);
    });
    this.refreshingAccounts.set(accountId, job);
    this.refreshQueue.push(job);
    this.drainRefreshQueue();
    return job.promise;
  }

  drainRefreshQueue() {
    while (this.activeRefreshes < this.refreshConcurrency && this.refreshQueue.length) {
      const job = this.refreshQueue.shift();
      this.activeRefreshes += 1;
      void Promise.resolve().then(() => this.refreshEntry(job.entry, job.summaryOnly, job.provider))
        .then(job.resolve, job.reject).finally(() => {
          this.activeRefreshes -= 1;
          this.drainRefreshQueue();
        });
    }
  }

  async refreshEntry(entry, summaryOnly, provider) {
    const accountId = entry.account.id;
    const isCurrent = () => this.currentEntry(accountId)?.provider === provider;
    if (!isCurrent() || !this.usableEntry(this.currentEntry(accountId))) return null;
    try {
      const token = await provider.access(AbortSignal.timeout(30_000));
      const [loadResult, modelsResult, usageResult] = await Promise.allSettled([
        summaryOnly ? Promise.resolve(null) : fetchJson(provider, token, LOAD_PATH, { metadata: { ideType: 'ANTIGRAVITY' } }),
        summaryOnly ? Promise.resolve(null) : fetchJson(provider, token, MODELS_PATH, {}),
        fetchJson(provider, token, USAGE_PATH, {})
      ]);
      if (!isCurrent() || !this.usableEntry(this.currentEntry(accountId))) return null;
      if ((summaryOnly || (loadResult.status === 'rejected' && modelsResult.status === 'rejected')) && usageResult.status === 'rejected') {
        if (summaryOnly) throw usageResult.reason;
        let failure = usageResult.reason;
        for (const result of [loadResult, modelsResult, usageResult]) {
          if (result.status === 'rejected' && this.accountPool.observeAccountFailure?.(this.currentEntry(accountId), result.reason, { source: summaryOnly ? 'quota_summary_refresh' : 'quota_full_refresh' })) {
            failure = result.reason;
            break;
          }
        }
        throw failure;
      }
      const previous = this.snapshots[accountId] || {};
      const credits = !summaryOnly && loadResult.status === 'fulfilled'
        ? creditSnapshot(loadResult.value)
        : { plan: previous.plan || '', creditType: previous.creditType || '', creditAmount: previous.creditAmount ?? null, minimumCreditAmountForUsage: previous.minimumCreditAmountForUsage ?? null };
      const models = !summaryOnly && modelsResult.status === 'fulfilled' ? modelQuotaSnapshot(modelsResult.value) : previous.models || {};
      const groups = usageResult.status === 'fulfilled' ? usageQuotaSnapshot(usageResult.value) : previous.groups || [];
      const now = this.now();
      const observedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + this.intervalMs).toISOString();
      const groupsExpiresAt = usageResult.status === 'fulfilled' ? expiresAt : previous.groupsExpiresAt || previous.expiresAt || '';
      const modelsExpiresAt = !summaryOnly && modelsResult.status === 'fulfilled' ? expiresAt : previous.modelsExpiresAt || previous.expiresAt || '';
      const values = Object.values(models);
      const available = groups.length && Date.parse(groupsExpiresAt) > now
        ? groups.some((group) => group.available)
        : values.length && Date.parse(modelsExpiresAt) > now ? values.some((item) => item.available)
          : !summaryOnly && loadResult.status === 'fulfilled' ? credits.available : null;
      const snapshot = {
        ...previous,
        accountId,
        email: entry.account.email,
        observedAt,
        expiresAt,
        // Each source owns its freshness. A successful plan/catalog request
        // cannot make an old quota summary fresh, or vice versa.
        groupsObservedAt: usageResult.status === 'fulfilled' ? observedAt : previous.groupsObservedAt || previous.observedAt || '',
        groupsExpiresAt,
        modelsExpiresAt,
        ...credits,
        available,
        groups,
        models
      };
      this.snapshots[accountId] = snapshot;
      // The periodic full-pool refresh persists its batch once, rather than
      // writing the complete quota file once for every account.
      if (!this.refreshing) this.save();
      return snapshot;
    } catch (error) {
      if (isCurrent() && this.usableEntry(this.currentEntry(accountId))) {
        const summaryDenied = summaryOnly && Number(error?.status) === 403
          && !/verify\s*your\s*account|account.*verif|security.*challenge/i.test(String(error.message || ''));
        if (summaryDenied) {
          // One optional quota endpoint can deny access while generation still
          // works. Confirm through the existing full probe before quarantining;
          // explicit Google verification challenges remain immediate failures.
          void this.refreshAccount(accountId, { summaryOnly: false }).catch(() => {});
        } else {
          this.accountPool.observeAccountFailure?.(this.currentEntry(accountId), error, { source: summaryOnly ? 'quota_summary_refresh' : 'quota_full_refresh' });
        }
      }
      throw error;
    }
  }

  save() {
    this.fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.fs.writeFileSync(temporary, `${JSON.stringify(this.snapshots, null, 2)}\n`);
    this.fs.renameSync(temporary, this.file);
  }

  remove(accountId) {
    this.refreshAttempts.delete(accountId);
    if (!Object.prototype.hasOwnProperty.call(this.snapshots, accountId)) return false;
    delete this.snapshots[accountId];
    this.save();
    return true;
  }

  get(accountId, model = '') {
    const snapshot = this.snapshots[accountId];
    if (!snapshot) return null;
    const expiresAt = Date.parse(snapshot.expiresAt) || 0;
    if (expiresAt && expiresAt <= this.now()) return null;
    const modelExpiresAt = Date.parse(snapshot.modelsExpiresAt || snapshot.expiresAt) || 0;
    if (model && modelExpiresAt && modelExpiresAt <= this.now()) return null;
    return this.snapshot(accountId, model, false);
  }

  getSchedulingSnapshot(accountId, now = this.now()) {
    const snapshot = this.snapshots[accountId];
    if (!snapshot) return null;
    const expiresAt = Date.parse(snapshot.groupsExpiresAt || snapshot.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now ? snapshot : null;
  }

  peek(accountId, model = '') {
    return this.snapshot(accountId, model, true);
  }

  snapshot(accountId, model = '', allowExpired = false) {
    const snapshot = this.snapshots[accountId];
    if (!snapshot) return null;
    const expiresAt = Date.parse(snapshot.expiresAt) || 0;
    const stale = Boolean(expiresAt && expiresAt <= this.now());
    if (stale && !allowExpired) return null;
    const modelQuota = model ? snapshot.models?.[model] : null;
    const sourceExpiresAt = Date.parse(model
      ? snapshot.modelsExpiresAt || snapshot.expiresAt
      : snapshot.groupsExpiresAt || snapshot.expiresAt) || 0;
    const sourceStale = Boolean(sourceExpiresAt && sourceExpiresAt <= this.now());
    return modelQuota
      ? { ...snapshot, ...modelQuota, accountAvailable: snapshot.available, stale: stale || sourceStale }
      : { ...snapshot, stale: stale || sourceStale };
  }
}

module.exports = { QuotaManager, REFRESH_INTERVAL_MS, TARGETED_REFRESH_MIN_INTERVAL_MS, creditSnapshot, modelQuotaSnapshot, usageQuotaSnapshot };
