'use strict';

const { DirectAntigravityProvider, DirectProviderError } = require('./direct-provider');
const { ManagedAccountAuthProvider } = require('./managed-account-auth');

const SESSION_TTL_MS = 60 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

function durationMs(value) {
  const source = String(value || '');
  let total = 0;
  let matched = false;
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)(ms|[smhd])/gi)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += amount * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] || 0);
  }
  return matched ? total : 0;
}

function retryDelay(details, fallback = DEFAULT_COOLDOWN_MS) {
  const source = String(details || '');
  const resetAt = source.match(/(?:quotaResetTimeStamp|resetTime|reset_at)[^0-9]{0,16}(\d{4}-\d{2}-\d{2}T[^"'\s,}]+)/i);
  if (resetAt) {
    const delay = Date.parse(resetAt[1]) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return Math.max(1000, Math.min(MAX_COOLDOWN_MS, delay));
  }
  const duration = source.match(/(?:quotaResetDelay|retryDelay|retry_after|retry after|reset after)[^0-9]{0,24}((?:\d+(?:\.\d+)?(?:ms|[smhd]))+)/i);
  const milliseconds = durationMs(duration?.[1]);
  if (milliseconds > 0) return Math.max(1000, Math.min(MAX_COOLDOWN_MS, milliseconds));
  const seconds = source.match(/(?:retry_after|retry after)[^0-9]{0,8}(\d+(?:\.\d+)?)/i);
  return seconds ? Math.max(1000, Math.min(MAX_COOLDOWN_MS, Number(seconds[1]) * 1000)) : fallback;
}

function errorCategory(error) {
  const status = Number(error?.status) || 0;
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`;
  if (status === 401 || /invalid_grant|refresh token|auth.*missing|登录态|unauthenticated/i.test(source)) return 'auth';
  if (status === 429 || /resource.*exhausted|quota|rate.?limit/i.test(source)) return 'quota';
  if (status >= 500 || /fetch failed|network|timeout|econnreset|socket/i.test(source)) return 'transient';
  return 'request';
}

class AccountPool {
  constructor({ store, fallbackProvider, usageStore, agyPath = '', fetchImpl = globalThis.fetch, providerFactory } = {}) {
    this.store = store;
    this.fallbackProvider = fallbackProvider;
    this.usageStore = usageStore;
    this.agyPath = agyPath;
    this.fetchImpl = fetchImpl;
    this.providerFactory = providerFactory || ((account) => new DirectAntigravityProvider({
      fetchImpl: this.fetchImpl,
      localAuth: new ManagedAccountAuthProvider({ account, store: this.store, fetchImpl: this.fetchImpl, agyPath: this.agyPath })
    }));
    this.entries = new Map();
    this.sessions = new Map();
    this.weights = new Map();
    this.reload();
  }

  reload() {
    const old = this.entries;
    const next = new Map();
    for (const account of this.store.list()) {
      const previous = old.get(account.id);
      next.set(account.id, previous && previous.account.updatedAt === account.updatedAt
        ? { ...previous, account, provider: previous.provider }
        : { account, provider: this.providerFactory(account), cooldownUntil: 0, modelCooldowns: new Map(), lastSuccessAt: '', lastFailureAt: '', lastError: '' });
    }
    this.entries = next;
    this.cleanupSessions();
    return this.status();
  }

  hasManagedAccounts() { return this.entries.size > 0; }

  cleanupSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, value] of this.sessions) {
      if (value.at < cutoff || !this.entries.has(value.accountId)) this.sessions.delete(id);
    }
    while (this.sessions.size > 2000) this.sessions.delete(this.sessions.keys().next().value);
  }

  eligible(model, excluded = new Set()) {
    const now = Date.now();
    return [...this.entries.values()].filter((entry) => (
      entry.account.enabled !== false
      && !excluded.has(entry.account.id)
      && entry.cooldownUntil <= now
      && (entry.modelCooldowns.get(model) || 0) <= now
    ));
  }

  weightedPick(candidates) {
    const effectiveWeight = (entry) => Math.max(1, Number(entry.account.weight) || 1);
    const total = candidates.reduce((sum, entry) => sum + effectiveWeight(entry), 0);
    let selected = null;
    let selectedWeight = -Infinity;
    for (const entry of candidates) {
      const id = entry.account.id;
      const current = (this.weights.get(id) || 0) + effectiveWeight(entry);
      this.weights.set(id, current);
      if (current > selectedWeight) { selected = entry; selectedWeight = current; }
    }
    if (selected) this.weights.set(selected.account.id, (this.weights.get(selected.account.id) || 0) - total);
    return selected;
  }

  orderedCandidates(model, sessionId) {
    this.cleanupSessions();
    const output = [];
    const excluded = new Set();
    const bound = sessionId ? this.sessions.get(sessionId) : null;
    const sticky = bound ? this.entries.get(bound.accountId) : null;
    if (sticky && this.eligible(model).includes(sticky)) {
      output.push(sticky);
      excluded.add(sticky.account.id);
    }
    // A quota snapshot is advisory rather than an authorization gate. Prefer
    // accounts whose credit state is healthy or unknown, but retain depleted
    // accounts as a final fallback in case the cached snapshot is stale. This
    // avoids wasting routine requests on a known-empty account without letting
    // a half-hourly observation overrule the live upstream response.
    const remaining = this.eligible(model, excluded);
    const groups = [
      remaining.filter((entry) => this.quotaManager?.get(entry.account.id, model)?.available !== false),
      remaining.filter((entry) => this.quotaManager?.get(entry.account.id, model)?.available === false)
    ];
    for (const group of groups) {
      const groupExcluded = new Set();
      while (true) {
        const next = this.weightedPick(group.filter((entry) => !groupExcluded.has(entry.account.id)));
        if (!next) break;
        output.push(next);
        excluded.add(next.account.id);
        groupExcluded.add(next.account.id);
      }
    }
    return output;
  }

  attemptReporter(accountId, model) {
    return (event) => {
      if (event.phase === 'response') {
        this.usageStore?.recordUpstream({ accountId, model, success: event.success, count: true });
      }
    };
  }

  async send(normalized, model, options = {}) {
    if (!this.hasManagedAccounts()) {
      options.onAccountSelected?.({
        accountId: 'local-agy-session',
        email: '',
        source: 'local-agy-session',
        attempt: 1
      });
      let responseSeen = false;
      const result = await this.fallbackProvider.send(normalized, model, {
        ...options,
        onUpstreamAttempt: (event) => {
          if (event.phase === 'response') {
            responseSeen = true;
            this.usageStore?.recordUpstream({ accountId: 'local-agy-session', model, success: event.success, count: true });
          }
        }
      });
      // Custom/fake providers used by tests may not expose transport attempts.
      if (!responseSeen) this.usageStore?.recordUpstream({ accountId: 'local-agy-session', model, success: true, count: true });
      this.usageStore?.recordUpstream({ accountId: 'local-agy-session', model, usage: result.usage, success: true, count: false });
      return result;
    }

    const candidates = this.orderedCandidates(model, options.sessionId);
    if (!candidates.length) {
      throw new DirectProviderError(`当前没有可用于模型 ${model} 的 Antigravity 账号。`, {
        code: 'account_pool_unavailable', status: 429
      });
    }
    let lastError;
    for (let index = 0; index < candidates.length; index += 1) {
      const entry = candidates[index];
      options.onAccountSelected?.({
        accountId: entry.account.id,
        email: entry.account.email,
        source: entry.account.source || 'managed-account',
        attempt: index + 1
      });
      let responseSeen = false;
      try {
        const result = await entry.provider.send(normalized, model, {
          ...options,
          onUpstreamAttempt: (event) => {
            if (event.phase === 'response') responseSeen = true;
            this.attemptReporter(entry.account.id, model)(event);
          }
        });
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: true, count: true });
        this.usageStore?.recordUpstream({ accountId: entry.account.id, model, usage: result.usage, success: true, count: false });
        entry.lastSuccessAt = new Date().toISOString();
        entry.lastError = '';
        if (options.sessionId) this.sessions.set(options.sessionId, { accountId: entry.account.id, at: Date.now() });
        return { ...result, accountId: entry.account.id };
      } catch (error) {
        lastError = error;
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: false, count: true });
        entry.lastFailureAt = new Date().toISOString();
        entry.lastError = String(error.message || error);
        const category = errorCategory(error);
        if (category === 'request') throw error;
        if (category === 'quota') {
          entry.modelCooldowns.set(model, Date.now() + retryDelay(error.details || error.message));
          void this.quotaManager?.refresh().catch(() => {});
        }
        else if (category === 'auth') entry.cooldownUntil = Date.now() + 5 * 60_000;
        else entry.cooldownUntil = Date.now() + 15_000;
        if (options.sessionId) this.sessions.delete(options.sessionId);
      }
    }
    throw lastError;
  }

  async listModels(signal, options = {}) {
    if (!this.hasManagedAccounts()) return this.fallbackProvider.listModels(signal, options);
    const settled = await Promise.allSettled([...this.entries.values()]
      .filter((entry) => entry.account.enabled !== false)
      .map((entry) => entry.provider.listModels(signal, options)));
    const models = [...new Set(settled.flatMap((item) => item.status === 'fulfilled' ? item.value : []))];
    if (!models.length) throw settled.find((item) => item.status === 'rejected')?.reason || new Error('账号池没有返回模型目录。');
    return models;
  }

  modelInfo(model) {
    for (const entry of this.entries.values()) {
      const info = entry.provider.modelInfo(model);
      if (info) return info;
    }
    return this.fallbackProvider.modelInfo(model);
  }

  status() {
    const now = Date.now();
    return [...this.entries.values()].map((entry) => ({
      id: entry.account.id,
      email: entry.account.email,
      enabled: entry.account.enabled !== false,
      weight: entry.account.weight,
      state: entry.cooldownUntil > now ? 'cooldown' : 'available',
      cooldownUntil: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : '',
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      lastError: entry.lastError,
      modelCooldowns: [...entry.modelCooldowns.entries()].filter(([, until]) => until > now)
        .map(([model, until]) => ({ model, until: new Date(until).toISOString() }))
    }));
  }
}

module.exports = { AccountPool, durationMs, errorCategory, retryDelay };
