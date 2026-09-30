'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DirectAntigravityProvider, DirectProviderError } = require('./direct-provider');
const { ManagedAccountAuthProvider } = require('./managed-account-auth');

const SESSION_TTL_MS = 72 * 60 * 60_000;
const SESSION_PERSIST_INTERVAL_MS = 5 * 60_000;
const SESSION_CAPACITY = 2000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const ACCOUNT_HEALTH_STATES = new Set(['verification_required', 'authentication_error', 'access_denied']);

function geminiGroup(snapshot) {
  return (snapshot?.groups || []).find((group) => /gemini/i.test([
    group?.id, group?.displayName, group?.description
  ].filter(Boolean).join(' ')));
}

function geminiWeeklyPressure(snapshot, now) {
  const bucket = geminiGroup(snapshot)?.buckets?.find((item) => (
    String(item?.window || '').toLowerCase() === 'weekly'
    || String(item?.id || '').toLowerCase().endsWith('-weekly')
  ));
  const raw = bucket?.remainingFraction;
  const remaining = raw == null || String(raw).trim() === '' || typeof raw === 'boolean' ? NaN : Number(raw);
  const resetAt = Date.parse(bucket?.resetTime || '');
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt) || resetAt <= now) return { kind: 'unknown', band: 0 };
  if (remaining <= 0 || bucket.available === false) return { kind: 'exhausted', band: 0 };
  const hours = Math.max((resetAt - now) / 3_600_000, 1 / 60);
  const pressure = Math.min(1, remaining) / hours;
  return { kind: 'pressure', band: Math.floor(Math.log2(pressure)) };
}

function compareQuotaRanks(left, right) {
  return left.depleted - right.depleted
    || left.lane - right.lane
    || right.band - left.band
    || (left.resetTime === right.resetTime ? 0 : left.resetTime < right.resetTime ? -1 : 1);
}

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
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.cause?.code || ''} ${error?.cause?.message || ''}`;
  if (/abort(?:ed|error)|请求已取消/i.test(source)) return 'request';
  if (status === 429 || /resource.*exhausted|quota|rate.?limit/i.test(source)) return 'quota';
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|enotfound|eai_again|socket|tls|dns/i.test(source)) return 'transient';
  if (status === 401 || status === 403 || (status >= 400 && status < 500 && /direct_refresh_failed/i.test(source)) || /invalid_grant|refresh token|auth.*missing|登录态|unauthenticated|permission.?denied|forbidden|verify\s*your\s*account|account.*verif|security.*challenge|account.*(?:disabled|suspended)/i.test(source)) return 'account';
  if (status === 408 || status === 425 || status >= 500) return 'transient';
  return 'request';
}

function accountHealth(error) {
  const status = Number(error?.status) || 0;
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`;
  if (/verify\s*your\s*account|account.*verif|security.*challenge|安全核验|验证.*账号/i.test(source)) {
    return {
      state: 'verification_required',
      reason: 'google_account_verification',
      message: 'Google 要求完成账号安全核验；该账号已暂停路由，请完成核验或重新授权。'
    };
  }
  if (status === 401 || /direct_refresh_failed|invalid_grant|refresh token|auth.*missing|登录态|unauthenticated/i.test(source)) {
    return {
      state: 'authentication_error',
      reason: 'authentication_failed',
      message: '账号凭据已失效或认证失败；该账号已暂停路由，请重新授权。'
    };
  }
  return {
    state: 'access_denied',
    reason: 'account_access_denied',
    message: 'Google 拒绝该账号访问；该账号已暂停路由，请检查账号状态后重新授权。'
  };
}

function normalizedPersistentState(raw = {}) {
  const affinities = raw?.affinities && typeof raw.affinities === 'object' ? raw.affinities : {};
  const health = raw?.health && typeof raw.health === 'object' ? raw.health : {};
  const removedIdentities = Array.isArray(raw?.removedIdentities) ? raw.removedIdentities.map(String).filter(Boolean) : [];
  return { affinities, health, removedIdentities };
}

function accountIdentityKeys(account = {}) {
  return [
    account.subjectId ? `subject:${String(account.subjectId).trim()}` : '',
    account.email ? `email:${String(account.email).trim().toLowerCase()}` : ''
  ].filter(Boolean).map((value) => crypto.createHash('sha256').update(value).digest('hex'));
}

function accountFingerprint(account = {}) {
  return crypto.createHash('sha256').update([
    account.id,
    account.accessToken,
    account.refreshToken,
    account.projectId,
    account.clientId
  ].map((value) => String(value || '')).join('\0')).digest('hex');
}

class AccountPool {
  constructor({ store, fallbackProvider, usageStore, agyPath = '', fetchImpl = globalThis.fetch, providerFactory, fsImpl = fs, stateFile = '', now = () => Date.now() } = {}) {
    this.store = store;
    this.fallbackProvider = fallbackProvider;
    this.usageStore = usageStore;
    this.agyPath = agyPath;
    this.fetchImpl = fetchImpl;
    this.fs = fsImpl;
    this.now = now;
    this.stateFile = stateFile || path.join(path.dirname(this.store.directory), 'state', 'account-pool.json');
    this.providerFactory = providerFactory || ((account) => new DirectAntigravityProvider({
      fetchImpl: this.fetchImpl,
      localAuth: new ManagedAccountAuthProvider({ account, store: this.store, fetchImpl: this.fetchImpl, agyPath: this.agyPath })
    }));
    this.entries = new Map();
    this.sessions = new Map();
    this.health = new Map();
    this.removedIdentities = new Set();
    this.weights = new Map();
    this.loadState();
    this.reload();
  }

  loadState() {
    let state;
    try { state = normalizedPersistentState(JSON.parse(this.fs.readFileSync(this.stateFile, 'utf8'))); }
    catch { state = normalizedPersistentState(); }
    for (const [routingKey, value] of Object.entries(state.affinities)) {
      const at = Number(value?.at);
      if (routingKey && value?.accountId && Number.isFinite(at)) {
        this.sessions.set(routingKey, { accountId: String(value.accountId), at, persistedAt: at });
      }
    }
    for (const [accountId, value] of Object.entries(state.health)) {
      if (accountId && ACCOUNT_HEALTH_STATES.has(value?.state)) this.health.set(accountId, { ...value });
    }
    for (const key of state.removedIdentities) this.removedIdentities.add(key);
  }

  saveState() {
    try {
      this.fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const affinities = Object.fromEntries([...this.sessions].map(([routingKey, value]) => [routingKey, {
        accountId: value.accountId,
        at: value.at
      }]));
      const health = Object.fromEntries(this.health);
      const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      this.fs.writeFileSync(temporary, `${JSON.stringify({
        version: 1,
        affinityTtlHours: SESSION_TTL_MS / 3_600_000,
        savedAt: new Date(this.now()).toISOString(),
        affinities,
        health,
        removedIdentities: [...this.removedIdentities]
      }, null, 2)}\n`);
      this.fs.renameSync(temporary, this.stateFile);
      for (const value of this.sessions.values()) value.persistedAt = value.at;
    } catch {
      // Routing persistence is an optimization. A read-only or full disk must
      // never prevent the gateway from serving requests with in-memory state.
    }
  }

  reload() {
    const old = this.entries;
    const next = new Map();
    let stateChanged = false;
    const changedEntries = [];
    for (const account of this.store.list()) {
      const previous = old.get(account.id);
      const persistedHealth = this.health.get(account.id);
      if (persistedHealth && persistedHealth.accountFingerprint !== accountFingerprint(account)) {
        this.health.delete(account.id);
        stateChanged = true;
      }
      const activeHealth = this.health.get(account.id);
      const entry = previous && previous.account.updatedAt === account.updatedAt
        ? { ...previous, account, provider: previous.provider }
        : { account, provider: this.providerFactory(account), cooldownUntil: 0, modelCooldowns: new Map(), lastSuccessAt: '', lastFailureAt: '', lastError: '' };
      entry.healthState = activeHealth?.state || 'available';
      entry.healthReason = activeHealth?.reason || '';
      entry.healthSince = activeHealth?.since || '';
      entry.healthMessage = activeHealth?.message || '';
      if (activeHealth?.lastError) entry.lastError = activeHealth.lastError;
      next.set(account.id, entry);
      if (!previous || previous.provider !== entry.provider) changedEntries.push(entry);
    }
    for (const accountId of this.health.keys()) {
      if (!next.has(accountId)) { this.health.delete(accountId); stateChanged = true; }
    }
    this.entries = next;
    if (this.cleanupSessions({ persist: false })) stateChanged = true;
    if (stateChanged) this.saveState();
    for (const entry of changedEntries) this.refreshAccountQuota(entry, { force: true, summaryOnly: false });
    return this.status();
  }

  hasManagedAccounts() { return this.entries.size > 0; }

  canUseFallback() { return this.removedIdentities.size === 0; }

  noAccountError(model = '') {
    return new DirectProviderError(model
      ? `当前没有可用于模型 ${model} 的 Antigravity 账号。`
      : '当前账号池没有可用的 Antigravity 账号。', {
      code: 'account_pool_unavailable', status: 429
    });
  }

  cleanupSessions({ persist = true } = {}) {
    const cutoff = this.now() - SESSION_TTL_MS;
    let changed = false;
    for (const [id, value] of this.sessions) {
      if (value.at < cutoff || !this.entries.has(value.accountId)) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    while (this.sessions.size > SESSION_CAPACITY) {
      this.sessions.delete(this.sessions.keys().next().value);
      changed = true;
    }
    if (changed && persist) this.saveState();
    return changed;
  }

  bindSession(routingKey, accountId) {
    if (!routingKey) return;
    const previous = this.sessions.get(routingKey);
    const now = this.now();
    this.sessions.set(routingKey, { accountId, at: now, persistedAt: previous?.persistedAt || 0 });
    if (!previous || previous.accountId !== accountId || now - (previous.persistedAt || 0) >= SESSION_PERSIST_INTERVAL_MS) this.saveState();
  }

  deleteSession(routingKey) {
    if (routingKey && this.sessions.delete(routingKey)) this.saveState();
  }

  markAccountIssue(entry, error) {
    const health = accountHealth(error);
    const currentAccount = entry.provider?.localAuth?.account || entry.account;
    if (currentAccount?.id === entry.account.id) entry.account = { ...entry.account, ...currentAccount };
    const record = {
      ...health,
      since: new Date(this.now()).toISOString(),
      accountFingerprint: accountFingerprint(entry.account),
      lastError: String(error?.message || error || '').slice(0, 1000)
    };
    entry.healthState = record.state;
    entry.healthReason = record.reason;
    entry.healthSince = record.since;
    entry.healthMessage = record.message;
    entry.cooldownUntil = 0;
    this.health.set(entry.account.id, record);
    this.saveState();
  }

  observeAccountFailure(entry, error) {
    if (errorCategory(error) !== 'account') return false;
    entry.lastFailureAt = new Date(this.now()).toISOString();
    entry.lastError = String(error?.message || error || '');
    this.markAccountIssue(entry, error);
    return true;
  }

  isAccountHealthy(entry) {
    return entry?.healthState === 'available';
  }

  isRemovedIdentity(identity) {
    return accountIdentityKeys(identity).some((key) => this.removedIdentities.has(key));
  }

  clearAccountIssue(entry) {
    this.health.delete(entry.account.id);
    entry.healthState = 'available';
    entry.healthReason = '';
    entry.healthSince = '';
    entry.healthMessage = '';
    entry.lastError = '';
    entry.cooldownUntil = 0;
    this.saveState();
  }

  async recheckAccount(accountId, { signal } = {}) {
    const entry = this.entries.get(String(accountId || ''));
    if (!entry) throw new DirectProviderError('账号不存在或已被删除。', { code: 'account_not_found', status: 404 });
    if (entry.account.enabled === false) throw new DirectProviderError('账号已停用，无法重新检测。', { code: 'account_disabled', status: 409 });
    if (!ACCOUNT_HEALTH_STATES.has(entry.healthState)) {
      return { account: this.status().find((item) => item.id === entry.account.id), unchanged: true };
    }
    try {
      await entry.provider.probeAuthentication(signal);
      entry.lastSuccessAt = new Date(this.now()).toISOString();
      this.clearAccountIssue(entry);
      this.refreshAccountQuota(entry, { force: true, summaryOnly: false });
      return { account: this.status().find((item) => item.id === entry.account.id), recovered: true };
    } catch (error) {
      const category = errorCategory(error);
      if (category === 'account') this.observeAccountFailure(entry, error);
      // Network and upstream failures deliberately keep the previous health
      // state: an unreachable network is not evidence that verification failed.
      throw error;
    }
  }

  removeAccount(accountId) {
    const id = String(accountId || '');
    const entry = this.entries.get(id);
    const removed = this.store.delete(id);
    if (!entry && !removed) throw new DirectProviderError('账号不存在或已被删除。', { code: 'account_not_found', status: 404 });
    const account = removed || entry.account;
    entry?.provider?.localAuth?.disable?.();
    for (const key of accountIdentityKeys(account)) this.removedIdentities.add(key);
    this.entries.delete(id);
    this.health.delete(id);
    this.weights.delete(id);
    for (const [routingKey, binding] of this.sessions) {
      if (binding.accountId === id) this.sessions.delete(routingKey);
    }
    try { this.quotaManager?.remove?.(id); } catch { /* stale quota data is non-authoritative */ }
    this.saveState();
    return { id, email: account.email || '', deleted: true };
  }

  eligible(model, excluded = new Set()) {
    const now = this.now();
    return [...this.entries.values()].filter((entry) => (
      entry.account.enabled !== false
      && this.isAccountHealthy(entry)
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

  refreshAccountQuota(entry, options = {}) {
    // Scheduling never waits for quota I/O. QuotaManager coalesces and limits
    // targeted refreshes; older custom managers can continue without them.
    if (!this.quotaManager?.refreshAccount || !this.isAccountHealthy(entry)) return;
    void this.quotaManager.refreshAccount(entry.account.id, options).catch(() => {});
  }

  geminiFiveHourResetTime(snapshot, now) {
    const bucket = geminiGroup(snapshot)?.buckets?.find((item) => String(item?.window || '').toLowerCase() === '5h');
    const resetTime = Date.parse(bucket?.resetTime || '');
    return Number.isFinite(resetTime) && resetTime > now ? resetTime : Infinity;
  }

  quotaRanks(model, candidates) {
    const now = this.now();
    return candidates.map((entry) => {
      const snapshot = this.quotaManager?.getSchedulingSnapshot
        ? this.quotaManager.getSchedulingSnapshot(entry.account.id, now)
        : this.quotaManager?.get(entry.account.id);
      const weekly = geminiWeeklyPressure(snapshot, now);
      const resetTime = this.geminiFiveHourResetTime(snapshot, now);
      if (!snapshot || weekly.kind === 'unknown' || resetTime === Infinity) this.refreshAccountQuota(entry);
      return {
        entry,
        depleted: this.quotaManager?.get(entry.account.id, model)?.available === false ? 1 : 0,
        lane: { pressure: 0, unknown: 1, exhausted: 2 }[weekly.kind],
        band: weekly.band,
        resetTime
      };
    }).sort(compareQuotaRanks);
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
    // A read-only candidate order must not spend weights on unused backups.
    return output.concat(this.quotaRanks(model, this.eligible(model, excluded)).map(({ entry }) => entry));
  }

  selectAccount(model, routingKey, excluded, { preferredAccountId = '', allowSticky = true } = {}) {
    this.cleanupSessions();
    const candidates = this.eligible(model, excluded);
    if (allowSticky) {
      const preferred = candidates.find((entry) => entry.account.id === preferredAccountId);
      const bound = routingKey ? this.sessions.get(routingKey) : null;
      const sticky = bound && candidates.find((entry) => entry.account.id === bound.accountId);
      // Successful continuations neither recalculate quota pressure nor change
      // weighted rotation; image tools retain their explicitly preferred account.
      if (preferred || sticky) return preferred || sticky;
    }
    const ranks = this.quotaRanks(model, candidates);
    if (!ranks.length) return null;
    return this.weightedPick(ranks.filter((rank) => compareQuotaRanks(rank, ranks[0]) === 0).map(({ entry }) => entry));
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
      if (!this.canUseFallback()) throw this.noAccountError(model);
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

    const routingKey = options.routingKey || options.sessionId;
    const attempted = new Set();
    let lastError;
    while (true) {
      const entry = this.selectAccount(model, routingKey, attempted, { allowSticky: attempted.size === 0 });
      if (!entry) break;
      attempted.add(entry.account.id);
      options.onAccountSelected?.({
        accountId: entry.account.id,
        email: entry.account.email,
        source: entry.account.source || 'managed-account',
        attempt: attempted.size
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
        entry.lastSuccessAt = new Date(this.now()).toISOString();
        entry.lastError = '';
        if (routingKey && options.bindRouting !== false) this.bindSession(routingKey, entry.account.id);
        return { ...result, accountId: entry.account.id };
      } catch (error) {
        lastError = error;
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: false, count: true });
        entry.lastFailureAt = new Date(this.now()).toISOString();
        entry.lastError = String(error.message || error);
        const category = errorCategory(error);
        if (category === 'request') throw error;
        if (category === 'quota') {
          entry.modelCooldowns.set(model, this.now() + retryDelay(error.details || error.message));
          this.refreshAccountQuota(entry);
        }
        else if (category === 'account') this.observeAccountFailure(entry, error);
        else entry.cooldownUntil = this.now() + 15_000;
        if (routingKey && options.bindRouting !== false) this.deleteSession(routingKey);
      }
    }
    throw lastError || this.noAccountError(model);
  }

  async generateImage(request, options = {}) {
    const model = 'gemini-3.1-flash-image';
    if (!this.hasManagedAccounts()) {
      if (!this.canUseFallback()) throw this.noAccountError(model);
      options.onAccountSelected?.({ accountId: 'local-agy-session', email: '', source: 'local-agy-session', attempt: 1 });
      let responseSeen = false;
      const result = await this.fallbackProvider.generateImage(request, {
        ...options,
        onUpstreamAttempt: (event) => {
          if (event.phase === 'response') {
            responseSeen = true;
            this.usageStore?.recordUpstream({ accountId: 'local-agy-session', model, success: event.success, count: true });
          }
        }
      });
      if (!responseSeen) this.usageStore?.recordUpstream({ accountId: 'local-agy-session', model, success: true, count: true });
      this.usageStore?.recordUpstream({ accountId: 'local-agy-session', model, usage: result.usage, success: true, count: false });
      return { ...result, accountId: 'local-agy-session' };
    }

    const routingKey = options.routingKey || options.sessionId;
    const attempted = new Set();
    let lastError;
    while (true) {
      const entry = this.selectAccount(model, routingKey, attempted, {
        preferredAccountId: options.accountId, allowSticky: attempted.size === 0
      });
      if (!entry) break;
      attempted.add(entry.account.id);
      options.onAccountSelected?.({ accountId: entry.account.id, email: entry.account.email, source: entry.account.source || 'managed-account', attempt: attempted.size });
      let responseSeen = false;
      try {
        const result = await entry.provider.generateImage(request, {
          ...options,
          onUpstreamAttempt: (event) => {
            if (event.phase === 'response') responseSeen = true;
            this.attemptReporter(entry.account.id, model)(event);
          }
        });
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: true, count: true });
        this.usageStore?.recordUpstream({ accountId: entry.account.id, model, usage: result.usage, success: true, count: false });
        entry.lastSuccessAt = new Date(this.now()).toISOString();
        entry.lastError = '';
        if (routingKey && options.bindRouting !== false) this.bindSession(routingKey, entry.account.id);
        return { ...result, accountId: entry.account.id };
      } catch (error) {
        lastError = error;
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: false, count: true });
        entry.lastFailureAt = new Date(this.now()).toISOString();
        entry.lastError = String(error.message || error);
        const category = errorCategory(error);
        if (category === 'request') throw error;
        if (category === 'quota') {
          entry.modelCooldowns.set(model, this.now() + retryDelay(error.details || error.message));
          this.refreshAccountQuota(entry);
        }
        else if (category === 'account') this.observeAccountFailure(entry, error);
        else entry.cooldownUntil = this.now() + 15_000;
        if (routingKey && options.bindRouting !== false) this.deleteSession(routingKey);
      }
    }
    throw lastError || this.noAccountError(model);
  }

  async listModels(signal, options = {}) {
    if (!this.hasManagedAccounts()) {
      if (!this.canUseFallback()) throw this.noAccountError();
      return this.fallbackProvider.listModels(signal, options);
    }
    const settled = await Promise.allSettled([...this.entries.values()]
      .filter((entry) => entry.account.enabled !== false && this.isAccountHealthy(entry))
      .map(async (entry) => {
        try { return await entry.provider.listModels(signal, options); }
        catch (error) {
          this.observeAccountFailure(entry, error);
          throw error;
        }
      }));
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
    const now = this.now();
    return [...this.entries.values()].map((entry) => ({
      id: entry.account.id,
      email: entry.account.email,
      enabled: entry.account.enabled !== false,
      weight: entry.account.weight,
      state: entry.account.enabled === false
        ? 'disabled'
        : entry.healthState !== 'available'
          ? entry.healthState
          : entry.cooldownUntil > now ? 'cooldown' : 'available',
      healthReason: entry.healthReason,
      healthSince: entry.healthSince,
      healthMessage: entry.healthMessage,
      cooldownUntil: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : '',
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      lastError: entry.lastError,
      modelCooldowns: [...entry.modelCooldowns.entries()].filter(([, until]) => until > now)
        .map(([model, until]) => ({ model, until: new Date(until).toISOString() }))
    }));
  }

  stop() {
    this.cleanupSessions({ persist: false });
    this.saveState();
  }
}

module.exports = { AccountPool, SESSION_TTL_MS, accountHealth, geminiWeeklyPressure, durationMs, errorCategory, retryDelay };
