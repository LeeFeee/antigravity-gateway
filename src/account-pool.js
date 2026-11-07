'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DirectAntigravityProvider, DirectProviderError } = require('./direct-provider');
const { nativeCloudCodeFetch } = require('./agy-native-transport');
const { errorDetails, maskEmail } = require('./diagnostic-log');
const { ManagedAccountAuthProvider } = require('./managed-account-auth');
const { accountGrantGeneration } = require('./account-store');
const { recheckSignal, probeAccountInference } = require('./account-recheck');
const { CAPTURED_IMAGE_MODEL, imageModelName, assertImageModel } = require('./image-model-config');
const { isConversionError } = require('./conversion-errors');
const { GatewayError } = require('./protocol');
const { validateSearchParameters } = require('./antigravity-server-search');

const { SESSION_TTL_MS, SESSION_CAPACITY, TRANSIENT_COOLDOWN_MS, durationMs, retryDelay, affinityActive, geminiWeeklyPressure,
  geminiFiveHourResetTime, quotaRank, compareQuotaRanks, weightedPickWithRanks } = require('./account-scheduling');
const ACCOUNT_HEALTH_STATES = new Set(['verification_required', 'authentication_error', 'access_denied']);

function errorCategory(error) {
  if (isConversionError(error)) return 'request';
  const status = Number(error?.status) || 0;
  const source = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.cause?.code || ''} ${error?.cause?.message || ''}`;
  if (error?.code === 'request_timeout' || error?.code === 'request_aborted' || /abort(?:ed|error)|请求已取消|网关请求超时/i.test(source)) return 'request';
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
  constructor({ store, usageStore, agyPath = '', fetchImpl = nativeCloudCodeFetch, providerFactory, fsImpl = fs, stateFile = '', now = () => Date.now(), diagnosticReporter, directoryGuard = null } = {}) {
    this.store = store;
    this.usageStore = usageStore;
    this.agyPath = agyPath;
    this.fetchImpl = fetchImpl;
    this.fs = fsImpl;
    this.now = now;
    this.diagnosticReporter = typeof diagnosticReporter === 'function' ? diagnosticReporter : null;
    this.directoryGuard = directoryGuard;
    this.lastUnavailableDiagnosticAt = -Infinity;
    this.stateFile = stateFile || path.join(path.dirname(this.store.directory), 'state', 'account-pool.json');
    this.providerFactory = providerFactory || ((account) => {
      const report = (event, fields) => this.reportDiagnostic(event, account, fields);
      return new DirectAntigravityProvider({
        fetchImpl: this.fetchImpl,
        diagnosticReporter: report,
        directoryGuard: this.directoryGuard,
        localAuth: new ManagedAccountAuthProvider({
          account,
          store: this.store,
          fetchImpl: this.fetchImpl,
          agyPath: this.agyPath,
          diagnosticReporter: report
        })
      });
    });
    this.entries = new Map();
    this.sessions = new Map();
    this.health = new Map();
    this.rechecks = new Map();
    this.removedIdentities = new Set();
    this.weights = new Map();
    this.modelSupporters = new Map();
    this.modelCatalogsReady = false;
    this.modelCatalogDiscovery = null;
    this.loadState();
    this.reload();
  }

  bindDirectoryGuard(guard) {
    this.directoryGuard = guard;
    for (const entry of this.entries.values()) {
      entry.provider?.bindDirectoryGuard?.(guard);
    }
  }

  reportDiagnostic(event, account, fields = {}) {
    if (!this.diagnosticReporter) return;
    try {
      this.diagnosticReporter(event, {
        ...(account ? {
          accountId: String(account.id || ''),
          account: maskEmail(account.email),
          accountSource: String(account.source || 'managed-account')
        } : {}),
        ...fields
      });
    } catch {
      // Diagnostics must never affect routing or authentication.
    }
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
      // Validate once at the storage boundary, before constructing a provider.
      // Legacy persisted agy labels remain compatible; foreign credentials
      // must never enter Google Antigravity API routing.
      if (account.providerType === 'robin' || account.accountType === 'gemini-app') continue;
      const previous = old.get(account.id);
      const generation = accountGrantGeneration(account);
      const sameGrant = previous?.grantGeneration === generation;
      const persistedHealth = this.health.get(account.id);
      const healthMatches = persistedHealth?.grantGeneration
        ? persistedHealth.grantGeneration === generation
        : persistedHealth?.accountFingerprint === accountFingerprint(account);
      if (persistedHealth && (!healthMatches || (previous && !sameGrant)) && (!this.rechecks.has(account.id) || (previous && !sameGrant))) {
        this.health.delete(account.id);
        this.reportDiagnostic('account_health_cleared', account, {
          trigger: 'credential_fingerprint_changed',
          previousState: persistedHealth.state || ''
        });
        stateChanged = true;
      }
      const activeHealth = this.health.get(account.id);
      // An in-flight callback keeps this exact object. Ordinary reloads and
      // enabled/weight edits must not detach health or cooldown from routing.
      if (previous && !sameGrant) previous.provider?.localAuth?.disable?.();
      const entry = sameGrant ? previous : {
            account,
            grantGeneration: generation,
            provider: this.providerFactory(account),
            cooldownUntil: 0,
            modelCooldowns: new Map(),
            supportedModels: null,
            modelCatalogChecked: false,
            lastSuccessAt: '',
            lastFailureAt: '',
            lastError: ''
          };
      entry.account = { ...account, grantGeneration: generation };
      entry.healthState = activeHealth?.state || 'available';
      entry.healthReason = activeHealth?.reason || '';
      entry.healthSince = activeHealth?.since || '';
      entry.healthMessage = activeHealth?.message || '';
      if (activeHealth?.lastError) entry.lastError = activeHealth.lastError;
      next.set(account.id, entry);
      if (!previous || previous.provider !== entry.provider) changedEntries.push(entry);
    }
    for (const [accountId, entry] of old) {
      if (!next.has(accountId)) entry.provider?.localAuth?.disable?.();
    }
    for (const accountId of this.health.keys()) {
      if (!next.has(accountId)) { this.health.delete(accountId); stateChanged = true; }
    }
    this.entries = next;
    this.rebuildModelSupporters();
    this.modelCatalogsReady = [...this.entries.values()]
      .filter((entry) => entry.account.enabled !== false && this.isAccountHealthy(entry))
      .every((entry) => entry.modelCatalogChecked);
    if (this.cleanupSessions({ persist: false })) stateChanged = true;
    if (stateChanged) this.saveState();
    for (const entry of changedEntries) this.refreshAccountQuota(entry, { force: true, summaryOnly: false });
    this.reportDiagnostic('account_pool_loaded', null, {
      accountCount: this.entries.size,
      availableCount: [...this.entries.values()].filter((entry) => entry.healthState === 'available').length,
      unhealthyCount: [...this.entries.values()].filter((entry) => entry.healthState !== 'available').length,
      persistedAffinityCount: this.sessions.size
    });
    return this.status();
  }

  hasManagedAccounts() { return this.entries.size > 0; }

  canUseFallback() { return false; }

  noAccountError(model = '', { service = '' } = {}) {
    const entries = [...this.entries.values()];
    const quotaProtected = entries.some((entry) => entry.account.enabled !== false
      && this.quotaManager?.isQuotaProtected?.(entry.account.id, model));
    const now = this.now();
    const states = {};
    const modelCooldowns = [];
    const knownSupporters = this.modelSupporters.get(model);
    for (const entry of entries) {
      // Describe the same model/catalog gates used by isEntryEligible. General
      // account health alone does not explain a model-specific exclusion.
      const supportsModel = !model || (service === 'web-search'
        ? entry.provider.webSearchModelCatalog?.().includes(model) === true
        : (!knownSupporters?.size || knownSupporters.has(entry.account.id))
          && (!(entry.supportedModels instanceof Set) || entry.supportedModels.has(model)));
      const modelCooldownUntil = entry.modelCooldowns.get(model) || 0;
      const state = entry.account.enabled === false ? 'disabled'
        : entry.healthState !== 'available' ? entry.healthState
          : this.quotaManager?.isQuotaProtected?.(entry.account.id, model) ? 'quota_protected'
            : !supportsModel ? 'model_unsupported'
              : entry.cooldownUntil > now ? 'cooldown'
                : modelCooldownUntil > now ? 'model_cooldown' : 'available';
      states[state] = (states[state] || 0) + 1;
      if (state === 'model_cooldown') modelCooldowns.push(modelCooldownUntil);
    }
    // Only advertise a retry time when every account is blocked solely by this
    // model's existing cooldown. Expiry is a chance to retry, not proof that an
    // upstream quota or capacity problem has recovered. Never alter deadlines.
    const retryAfterSeconds = modelCooldowns.length && modelCooldowns.length === entries.length
      ? Math.ceil((Math.min(...modelCooldowns) - now) / 1000) : 0;
    if (now - this.lastUnavailableDiagnosticAt >= 10_000) {
      this.lastUnavailableDiagnosticAt = now;
      this.reportDiagnostic('account_pool_unavailable', null, {
        model, states, ...(retryAfterSeconds ? { retryAfterSeconds } : {})
      });
    }
    if (quotaProtected) return new DirectProviderError('暂无满足条件的账号：Gemini 5 小时额度低于 10% 或周额度低于 5% 的账号已受保护，请等待额度恢复或使用其他可用账号。', {
      code: 'account_quota_protected', status: 429
    });
    if (retryAfterSeconds) return Object.assign(new DirectProviderError(`模型 ${model} 的账号因上游限流暂时冷却，最早 ${retryAfterSeconds} 秒后可重试。`, {
      code: 'account_pool_unavailable', status: 429
    }), { retryAfterSeconds });
    return new DirectProviderError(model
      ? `当前没有可用于模型 ${model} 的 Antigravity 账号。${states.model_unsupported === entries.length ? '账号池的模型目录不支持该模型。' : ''}`
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
    // Affinity is a fixed window from account selection, not a sliding window
    // renewed by every successful request. This guarantees periodic rebalance.
    if (previous?.accountId === accountId && affinityActive(previous, now)) return;
    this.sessions.set(routingKey, { accountId, at: now, persistedAt: now });
    this.saveState();
  }

  deleteSession(routingKey) {
    if (routingKey && this.sessions.delete(routingKey)) this.saveState();
  }

  isCurrentEntry(entry) {
    return Boolean(entry && this.entries.get(entry.account.id) === entry
      && entry.grantGeneration === accountGrantGeneration(entry.account));
  }

  markAccountIssue(entry, error, context = {}) {
    if (!this.isCurrentEntry(entry)) return false;
    const health = accountHealth(error);
    const previousState = entry.healthState;
    const currentAccount = entry.provider?.localAuth?.account || entry.account;
    if (currentAccount?.id === entry.account.id && accountGrantGeneration(currentAccount) === entry.grantGeneration) {
      // Authentication refresh owns credential fields only, never dashboard
      // enable/weight settings that may have changed during its await.
      for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'projectId', 'authMethod']) {
        entry.account[key] = currentAccount[key];
      }
    }
    const record = {
      ...health,
      since: new Date(this.now()).toISOString(),
      accountFingerprint: accountFingerprint(entry.account),
      grantGeneration: entry.grantGeneration,
      lastError: String(error?.message || error || '').slice(0, 1000)
    };
    entry.healthState = record.state;
    entry.healthReason = record.reason;
    entry.healthSince = record.since;
    entry.healthMessage = record.message;
    entry.cooldownUntil = 0;
    this.health.set(entry.account.id, record);
    this.saveState();
    this.reportDiagnostic('account_health_quarantined', entry.account, {
      trigger: context.source || 'unknown',
      previousState,
      state: record.state,
      reason: record.reason,
      category: errorCategory(error),
      ...errorDetails(error)
    });
  }

  observeAccountFailure(entry, error, context = {}) {
    if (!this.isCurrentEntry(entry) || errorCategory(error) !== 'account') return false;
    entry.lastFailureAt = new Date(this.now()).toISOString();
    entry.lastError = String(error?.message || error || '');
    this.markAccountIssue(entry, error, context);
    return true;
  }

  isAccountHealthy(entry) {
    return entry?.healthState === 'available';
  }

  isRemovedIdentity(identity) {
    return accountIdentityKeys(identity).some((key) => this.removedIdentities.has(key));
  }

  clearAccountIssue(entry, context = {}) {
    if (!this.isCurrentEntry(entry)) return false;
    const previousState = entry.healthState;
    this.health.delete(entry.account.id);
    entry.healthState = 'available';
    entry.healthReason = '';
    entry.healthSince = '';
    entry.healthMessage = '';
    entry.lastError = '';
    entry.cooldownUntil = 0;
    entry.supportedModels = null;
    entry.modelCatalogChecked = false;
    this.rebuildModelSupporters();
    this.modelCatalogsReady = false;
    this.saveState();
    this.reportDiagnostic('account_health_cleared', entry.account, {
      trigger: context.source || 'unknown',
      previousState
    });
  }

  async recheckAccount(accountId, { signal } = {}) {
    if (this.rechecks.has(String(accountId))) return this.rechecks.get(String(accountId));
    const entry = this.entries.get(String(accountId || ''));
    if (!entry) throw new DirectProviderError('账号不存在或已被删除。', { code: 'account_not_found', status: 404 });
    if (entry.account.enabled === false) throw new DirectProviderError('账号已停用，无法重新检测。', { code: 'account_disabled', status: 409 });
    if (!ACCOUNT_HEALTH_STATES.has(entry.healthState)) {
      this.reportDiagnostic('account_recheck_skipped', entry.account, { state: entry.healthState, reason: 'account_not_unhealthy' });
      return { account: this.status().find((item) => item.id === entry.account.id), unchanged: true };
    }
    const pending = Promise.resolve().then(() => this.recheckEntry(entry, recheckSignal(signal))).finally(() => {
      if (this.rechecks.get(entry.account.id) === pending) this.rechecks.delete(entry.account.id);
    });
    this.rechecks.set(entry.account.id, pending);
    return pending;
  }

  currentRecheckEntry(entry) {
    const current = this.entries.get(entry.account.id);
    const latest = this.store.list().find(account => account.id === entry.account.id);
    const owned = entry.provider.localAuth?.account || entry.account;
    if (current !== entry || !latest || latest.enabled === false
      || accountGrantGeneration(latest) !== entry.grantGeneration
      || accountFingerprint(latest) !== accountFingerprint(owned)) {
      throw new DirectProviderError('账号已删除、停用或凭据已更换，请重新检测当前账号。', {
        code: 'account_recheck_changed', status: 409
      });
    }
    current.account = { ...latest, grantGeneration: entry.grantGeneration };
    // Token renewal during a failed recheck is not service recovery. Keep the
    // quarantine bound to the renewed credential instead of clearing on reload.
    const health = this.health.get(latest.id);
    if (health && health.accountFingerprint !== accountFingerprint(latest)) {
      health.accountFingerprint = accountFingerprint(latest);
      health.grantGeneration = entry.grantGeneration;
      this.saveState();
    }
    return current;
  }

  async recheckEntry(entry, signal) {
    const startedAt = this.now();
    this.reportDiagnostic('account_recheck_started', entry.account, {
      state: entry.healthState,
      reason: entry.healthReason,
      credentialExpiresAt: String(entry.account.expiresAt || ''),
      hasAccessToken: Boolean(entry.account.accessToken),
      hasRefreshToken: Boolean(entry.account.refreshToken)
    });
    try {
      await entry.provider.probeAuthentication(signal);
      const models = await entry.provider.listModels(signal, { force: true });
      this.currentRecheckEntry(entry);
      this.reportDiagnostic('account_recheck_inference_started', entry.account);
      const { model } = await probeAccountInference(entry.provider, models, signal);
      const current = this.currentRecheckEntry(entry);
      current.lastSuccessAt = new Date(this.now()).toISOString();
      this.clearAccountIssue(current, { source: 'manual_recheck' });
      this.refreshAccountQuota(current, { force: true, summaryOnly: false });
      this.reportDiagnostic('account_recheck_succeeded', current.account, { durationMs: this.now() - startedAt, model, inferenceVerified: true });
      return { account: this.status().find((item) => item.id === entry.account.id), recovered: true };
    } catch (error) {
      const current = this.currentRecheckEntry(entry);
      const category = errorCategory(error);
      if (category === 'account') this.observeAccountFailure(current, error, { source: 'manual_recheck' });
      this.reportDiagnostic('account_recheck_failed', entry.account, {
        durationMs: this.now() - startedAt,
        category,
        retainedState: current.healthState,
        ...errorDetails(error)
      });
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
    this.rebuildModelSupporters();
    this.modelCatalogsReady = [...this.entries.values()]
      .filter((candidate) => candidate.account.enabled !== false && this.isAccountHealthy(candidate))
      .every((candidate) => candidate.modelCatalogChecked);
    this.health.delete(id);
    this.weights.delete(id);
    for (const [routingKey, binding] of this.sessions) {
      if (binding.accountId === id) this.sessions.delete(routingKey);
    }
    try { this.quotaManager?.remove?.(id); } catch { /* stale quota data is non-authoritative */ }
    this.saveState();
    return { id, email: account.email || '', deleted: true };
  }

  eligible(model, excluded = new Set(), service = '') {
    const now = this.now();
    return [...this.entries.values()].filter((entry) => this.isEntryEligible(entry, model, excluded, now, service));
  }

  isEntryEligible(entry, model, excluded = new Set(), now = this.now(), service = '') {
    const knownSupporters = this.modelSupporters.get(model);
    return Boolean(entry
      && entry.account
      && entry.account.enabled !== false
      && this.isAccountHealthy(entry)
      && !excluded.has(entry.account.id)
      && entry.cooldownUntil <= now
      && (entry.modelCooldowns.get(model) || 0) <= now
      && !this.quotaManager?.isQuotaProtected?.(entry.account.id, model)
      && (service === 'web-search'
        ? entry.provider.webSearchModelCatalog?.().includes(model) === true
        : (!knownSupporters?.size || knownSupporters.has(entry.account.id))
          && (!(entry.supportedModels instanceof Set) || entry.supportedModels.has(model)))
    );
  }

  rebuildModelSupporters() {
    this.modelSupporters.clear();
    for (const entry of this.entries.values()) {
      if (!(entry.supportedModels instanceof Set)) continue;
      for (const model of entry.supportedModels) {
        const supporters = this.modelSupporters.get(model) || new Set();
        supporters.add(entry.account.id);
        this.modelSupporters.set(model, supporters);
      }
    }
  }

  recordModelCatalog(entry, models) {
    if (!this.isCurrentEntry(entry)) return [];
    const listed = [...new Set((Array.isArray(models) ? models : [])
      .map((model) => String(model || '').replace(/^models\//, '').trim())
      .filter(Boolean))];
    const authoritative = typeof entry.provider.modelCatalog === 'function'
      ? entry.provider.modelCatalog()
      : listed.length ? listed : null;
    entry.supportedModels = Array.isArray(authoritative)
      ? new Set(authoritative.map((model) => String(model || '').replace(/^models\//, '').trim()).filter(Boolean))
      : null;
    entry.modelCatalogChecked = true;
    this.rebuildModelSupporters();
    return listed;
  }

  async discoverEntryModels(entry, signal, options = {}) {
    const models = await entry.provider.listModels(signal, options);
    return this.recordModelCatalog(entry, models);
  }

  async ensureModelCatalogs(signal) {
    if (this.modelCatalogsReady) return;
    if (this.modelCatalogDiscovery) return this.modelCatalogDiscovery;
    const entries = [...this.entries.values()].filter((entry) => (
      entry.account.enabled !== false
      && this.isAccountHealthy(entry)
      && !entry.modelCatalogChecked
    ));
    if (!entries.length) {
      this.modelCatalogsReady = true;
      return;
    }
    this.modelCatalogDiscovery = Promise.allSettled(entries.map(async (entry) => {
      try { return await this.discoverEntryModels(entry, signal); }
      catch (error) {
        this.observeAccountFailure(entry, error, { source: 'model_discovery' });
        if (this.isCurrentEntry(entry)) {
          entry.modelCatalogChecked = true;
          entry.supportedModels = null;
        }
        return [];
      }
    })).then(() => {
      this.modelCatalogsReady = [...this.entries.values()]
        .filter(entry => entry.account.enabled !== false && this.isAccountHealthy(entry))
        .every(entry => entry.modelCatalogChecked);
    }).finally(() => {
      this.modelCatalogDiscovery = null;
    });
    return this.modelCatalogDiscovery;
  }

  weightedPickWithRanks(ranks) {
    return weightedPickWithRanks(ranks, this.weights);
  }

  refreshAccountQuota(entry, options = {}) {
    // Scheduling never waits for quota I/O. QuotaManager coalesces and limits
    // targeted refreshes; older custom managers can continue without them.
    if (!this.quotaManager?.refreshAccount || !this.isCurrentEntry(entry) || !this.isAccountHealthy(entry)) return;
    void this.quotaManager.refreshAccount(entry.account.id, options).catch(() => {});
  }

  geminiFiveHourResetTime(snapshot, now) {
    return geminiFiveHourResetTime(snapshot, now);
  }

  quotaRanks(model, candidates) {
    const now = this.now();
    return candidates.map((entry) => {
      const snapshot = this.quotaManager?.getSchedulingSnapshot
        ? this.quotaManager.getSchedulingSnapshot(entry.account.id, now)
        : this.quotaManager?.get(entry.account.id);
      const rank = quotaRank(entry, snapshot, now, this.quotaManager?.get(entry.account.id, model)?.available === false);
      if (!snapshot || rank.lane === 1 || rank.resetTime === Infinity) this.refreshAccountQuota(entry);
      return rank;
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

  selectAccount(model, routingKey, excluded, { preferredAccountId = '', allowSticky = true, service = '' } = {}) {
    if (allowSticky) {
      const now = this.now();
      const preferred = preferredAccountId ? this.entries.get(preferredAccountId) : null;
      if (preferred && this.isEntryEligible(preferred, model, excluded, now, service)) return preferred;
      const bound = routingKey ? this.sessions.get(routingKey) : null;
      const sticky = bound ? this.entries.get(bound.accountId) : null;
      const active = affinityActive(bound, now);
      // Includes the precomputed quota-protection flag. No quota snapshots, sorting,
      // refresh I/O, or account-list scan occurs during a healthy affinity window.
      if (active && sticky && this.isEntryEligible(sticky, model, excluded, now, service)) return sticky;
      // A helper's quota/catalog eligibility must not invalidate the original
      // planning/answer model's independently valid affinity.
      if (bound && routingKey && !service) this.deleteSession(routingKey);
    }

    this.cleanupSessions();
    const candidates = this.eligible(model, excluded, service);
    const ranks = this.quotaRanks(model, candidates);
    if (!ranks.length) return null;
    return this.weightedPickWithRanks(ranks);
  }

  attemptReporter(accountId, model) {
    return (event) => {
      if (event.phase === 'response') {
        this.usageStore?.recordUpstream({ accountId, model, success: event.success, count: true });
      }
    };
  }

  async send(normalized, model, options = {}) {
    if (!this.hasManagedAccounts()) throw this.noAccountError(model);

    await this.ensureModelCatalogs(options.signal);

    const routingKey = options.routingKey || options.sessionId;
    const attempted = new Set();
    let lastError;
    while (true) {
      if (options.signal?.aborted) throw lastError || options.signal.reason || new Error('请求已取消');
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
      let outputDelivered = false;
      try {
        const result = await entry.provider.send(normalized, model, {
          ...options,
          onDelta: typeof options.onDelta === 'function' ? delta => {
            if (delta != null && delta !== '') outputDelivered = true;
            options.onDelta(delta);
          } : undefined,
          onThinkingDelta: typeof options.onThinkingDelta === 'function' ? delta => {
            if (delta != null && delta !== '') outputDelivered = true;
            options.onThinkingDelta(delta);
          } : undefined,
          onUpstreamAttempt: (event) => {
            if (event.phase === 'response') responseSeen = true;
            this.attemptReporter(entry.account.id, model)(event);
          }
        });
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: true, count: true });
        this.usageStore?.recordUpstream({ accountId: entry.account.id, model, usage: result.usage, success: true, count: false });
        if (this.isCurrentEntry(entry)) {
          entry.lastSuccessAt = new Date(this.now()).toISOString();
          entry.lastError = '';
          if (routingKey && options.bindRouting !== false && entry.account.enabled !== false) this.bindSession(routingKey, entry.account.id);
        }
        return { ...result, accountId: entry.account.id };
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'request_aborted' || error?.code === 'request_timeout') {
          throw error;
        }
        lastError = error;
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: false, count: true });
        const category = errorCategory(error);
        if (!this.isCurrentEntry(entry)) {
          if (category === 'request' || outputDelivered) throw error;
          continue;
        }
        entry.lastFailureAt = new Date(this.now()).toISOString();
        entry.lastError = String(error.message || error);
        this.reportDiagnostic('account_model_attempt_failed', entry.account, {
          model, attempt: attempted.size, category, code: String(error?.code || ''), status: Number(error?.status) || 0
        });
        if (category === 'request') throw error;
        if (category === 'quota') {
          const delay = retryDelay(error.details || error.message);
          entry.modelCooldowns.set(model, this.now() + delay);
          this.refreshAccountQuota(entry);
        }
        else if (category === 'account') this.observeAccountFailure(entry, error, { source: 'model_request' });
        else entry.cooldownUntil = this.now() + TRANSIENT_COOLDOWN_MS;
        if (routingKey && options.bindRouting !== false) this.deleteSession(routingKey);
        // Once bytes have reached the client, a new account cannot replace
        // this generation inside the same response. Preserve the real error.
        if (outputDelivered) throw error;
      }
    }
    throw lastError || this.noAccountError(model);
  }

  async searchWeb(request, options = {}) {
    options.signal?.throwIfAborted();
    validateSearchParameters(request);
    if (!this.hasManagedAccounts()) throw this.noAccountError();
    await this.ensureModelCatalogs(options.signal);
    options.signal?.throwIfAborted();
    const preferred = this.entries.get(options.accountId);
    const declared = entry => entry?.account && entry.account.enabled !== false && this.isAccountHealthy(entry)
      && typeof entry?.provider.webSearchModelCatalog === 'function' ? entry.provider.webSearchModelCatalog() : [];
    const models = [...new Set([...declared(preferred), ...[...this.entries.values()].flatMap(declared)])];
    if (!models.length || (request?.model && !models.includes(request.model))) {
      throw new GatewayError('可用账号目录没有声明所需的搜索辅助模型。', { code: 'server_search_model_unavailable', status: 400 });
    }
    const routingKey = options.routingKey || options.sessionId;
    let entry, model;
    for (const candidate of request?.model ? [request.model] : models) {
      entry = this.selectAccount(candidate, routingKey, new Set(), {
        preferredAccountId: options.accountId, service: 'web-search'
      });
      if (entry) { model = candidate; break; }
    }
    if (!entry) throw this.noAccountError(request?.model || models[0], { service: 'web-search' });
    options.signal?.throwIfAborted();
    options.onAccountSelected?.({ accountId: entry.account.id, email: entry.account.email,
      source: entry.account.source || 'managed-account', model, attempt: 1 });
    let responseSeen = false, attemptStarted = false;
    try {
      const result = await entry.provider.searchWeb({ ...request, model }, {
        ...options,
        onUpstreamAttempt: event => {
          if (event.phase === 'start') attemptStarted = true;
          if (event.phase === 'response') responseSeen = true;
          this.attemptReporter(entry.account.id, model)(event);
        }
      });
      if (!responseSeen && attemptStarted) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: true, count: true });
      this.usageStore?.recordUpstream({ accountId: entry.account.id, model, usage: result.usage, success: true, count: false });
      if (this.isCurrentEntry(entry)) {
        entry.lastSuccessAt = new Date(this.now()).toISOString();
        entry.lastError = '';
      }
      // The auxiliary request never rebinds or extends the main-model session.
      return { ...result, model, accountId: entry.account.id };
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'request_aborted' || error?.code === 'request_timeout') throw error;
      if (!responseSeen && attemptStarted) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: false, count: true });
      if (!this.isCurrentEntry(entry)) throw error;
      entry.lastFailureAt = new Date(this.now()).toISOString();
      entry.lastError = String(error.message || error);
      const category = errorCategory(error);
      if (category === 'quota') {
        entry.modelCooldowns.set(model, this.now() + retryDelay(error.details || error.message));
        this.refreshAccountQuota(entry);
      } else if (category === 'account') this.observeAccountFailure(entry, error, { source: 'search_request' });
      else if (category !== 'request') entry.cooldownUntil = this.now() + TRANSIENT_COOLDOWN_MS;
      // A failed logical tool call counts once. Further attempts require a
      // new server-tool call and a new budget decision in the orchestrator.
      throw error;
    }
  }

  async generateImage(request, options = {}) {
    const model = imageModelName(request?.model);
    if (!this.hasManagedAccounts()) throw this.noAccountError(model);

    await this.ensureModelCatalogs(options.signal);
    assertImageModel(model, this.imageModelCatalog());

    const routingKey = options.routingKey || options.sessionId;
    const attempted = new Set();
    let lastError;
    while (true) {
      if (options.signal?.aborted) throw lastError || options.signal.reason || new Error('请求已取消');
      const entry = this.selectAccount(model, routingKey, attempted, {
        preferredAccountId: options.accountId, allowSticky: attempted.size === 0
      });
      if (!entry) break;
      attempted.add(entry.account.id);
      options.onAccountSelected?.({ accountId: entry.account.id, email: entry.account.email, source: entry.account.source || 'managed-account', model, attempt: attempted.size });
      let responseSeen = false;
      try {
        const result = await entry.provider.generateImage({ ...request, model }, {
          ...options,
          // Image fallback may use a different eligible account. Its request
          // must not borrow the original account's private native trajectory.
          nativeToolContext: entry.account.id === options.accountId ? options.nativeToolContext : undefined,
          onUpstreamAttempt: (event) => {
            if (event.phase === 'response') responseSeen = true;
            this.attemptReporter(entry.account.id, model)(event);
          }
        });
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: true, count: true });
        this.usageStore?.recordUpstream({ accountId: entry.account.id, model, usage: result.usage, success: true, count: false });
        if (this.isCurrentEntry(entry)) {
          entry.lastSuccessAt = new Date(this.now()).toISOString();
          entry.lastError = '';
          if (routingKey && options.bindRouting !== false && entry.account.enabled !== false) this.bindSession(routingKey, entry.account.id);
        }
        return { ...result, accountId: entry.account.id };
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'request_aborted' || error?.code === 'request_timeout') {
          throw error;
        }
        lastError = error;
        if (!responseSeen) this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: false, count: true });
        const category = errorCategory(error);
        if (!this.isCurrentEntry(entry)) {
          if (category === 'request') throw error;
          continue;
        }
        entry.lastFailureAt = new Date(this.now()).toISOString();
        entry.lastError = String(error.message || error);
        if (category === 'request') throw error;
        if (category === 'quota') {
          entry.modelCooldowns.set(model, this.now() + retryDelay(error.details || error.message));
          this.refreshAccountQuota(entry);
        }
        else if (category === 'account') this.observeAccountFailure(entry, error, { source: 'image_request' });
        else entry.cooldownUntil = this.now() + TRANSIENT_COOLDOWN_MS;
        if (routingKey && options.bindRouting !== false) this.deleteSession(routingKey);
      }
    }
    throw lastError || this.noAccountError(model);
  }

  async listModels(signal, options = {}) {
    if (!this.hasManagedAccounts()) throw this.noAccountError();
    const settled = await Promise.allSettled([...this.entries.values()]
      .filter((entry) => entry.account.enabled !== false && this.isAccountHealthy(entry))
      .map(async (entry) => {
        try { return await this.discoverEntryModels(entry, signal, options); }
        catch (error) {
          this.observeAccountFailure(entry, error, { source: 'model_discovery' });
          throw error;
        }
      }));
    this.modelCatalogsReady = [...this.entries.values()]
      .filter((entry) => entry.account.enabled !== false && this.isAccountHealthy(entry))
      .every((entry) => entry.modelCatalogChecked);
    const models = [...new Set(settled.flatMap((item) => item.status === 'fulfilled' ? item.value : []))];
    if (!models.length) throw settled.find((item) => item.status === 'rejected')?.reason || new Error('账号池没有返回模型目录。');
    return models;
  }

  modelInfo(model) {
    for (const entry of this.entries.values()) {
      if (entry.account.enabled === false || !this.isAccountHealthy(entry)) continue;
      const info = entry.provider.modelInfo(model);
      if (info) return info;
    }
    return null;
  }

  imageModelCatalog() {
    const models = [];
    for (const entry of this.entries.values()) {
      if (entry.account.enabled === false || !this.isAccountHealthy(entry)) continue;
      if (typeof entry.provider.imageModelCatalog === 'function') models.push(...entry.provider.imageModelCatalog());
      else if (entry.supportedModels?.has(CAPTURED_IMAGE_MODEL)) models.push(CAPTURED_IMAGE_MODEL);
    }
    return [...new Set(models)];
  }

  async resolveImageModel(requested, signal) {
    const model = imageModelName(requested);
    if (model !== CAPTURED_IMAGE_MODEL) await this.ensureModelCatalogs(signal);
    return assertImageModel(model, this.imageModelCatalog());
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
          : entry.cooldownUntil > now ? 'cooldown'
            : this.quotaManager?.protection?.(entry.account.id)?.protected ? 'quota_protected' : 'available',
      quotaProtection: this.quotaManager?.protection?.(entry.account.id) || null,
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
