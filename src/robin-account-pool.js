'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { RobinAccountAuthProvider, robinAuthorizationKey: authorizationKey,
  robinCredentialFingerprint: credentialFingerprint } = require('./robin-auth');
const { ARGON_MODEL, RobinProvider, RobinProviderError } = require('./robin-provider');

const ROBIN_SESSION_TTL_MS = Math.max(0, Number(process.env.ANTIGRAVITY_ROBIN_AFFINITY_TTL_SECONDS || 5 * 60 * 60) * 1000);
const ROBIN_QUOTA_TTL_MS = 30 * 60_000;
const ROBIN_QUOTA_RETRY_MS = 5 * 60_000;

function entryAuthorizationKey(entry) {
  return entry.provider.auth?.authorizationKey || authorizationKey(entry.account);
}

function matchesAuthorization(entry, account, expectedKey = entryAuthorizationKey(entry)) {
  return typeof entry.provider.auth?.matchesAuthorization === 'function'
    ? entry.provider.auth.matchesAuthorization(expectedKey, account)
    : authorizationKey(account) === expectedKey;
}

function upstreamSessionScope(normalized, options) {
  const sessionId = options.sessionId || options.routingKey || 'session';
  // Claude's auxiliary classifier can run while the main task is waiting for
  // a client tool. It shares account affinity, but never the task/tool stream.
  const kind = normalized?.autoMode ? 'auto-mode'
    : ['compaction', 'no-client-tools'].includes(options.auxiliaryScope) ? options.auxiliaryScope : '';
  return kind ? { sessionId, kind } : sessionId;
}

function robinErrorCategory(error) {
  if (error?.code === 'robin_unimplemented' || error?.code === 'request_aborted') return 'request';
  const status = Number(error?.status || error?.statusCode || 0);
  const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  if (status === 401 || status === 403 || /invalid_grant|reauthori[sz]|verify your account/.test(message)) return 'account';
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/.test(message)) return 'quota';
  if (status >= 500 || /timeout|timed out|econn|network|unavailable|reset/.test(message)) return 'transient';
  return 'request';
}

class RobinAccountPool {
  constructor({ store, providerFactory, fetchImpl = globalThis.fetch, now = () => Date.now(), diagnosticReporter, usageStore } = {}) {
    if (!store) throw new Error('RobinAccountPool requires an account store');
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.diagnosticReporter = typeof diagnosticReporter === 'function' ? diagnosticReporter : null;
    this.usageStore = usageStore || null;
    this.providerFactory = providerFactory || ((account) => {
      const auth = new RobinAccountAuthProvider({ account, store, fetchImpl, diagnosticReporter });
      return new RobinProvider({ auth, fetchImpl, diagnosticReporter });
    });
    this.entries = new Map();
    this.sessions = new Map();
    this.weights = new Map();
    this.activeTasks = new Map();
    this.activeRequests = new Set();
    this.quotaRefreshes = new Map();
    this.quotaAttempts = new Map();
    this.quotaTimer = null;
    this.quotaController = new AbortController();
    this.stateFile = path.join(path.dirname(store.directory), 'state', 'robin-account-pool.json');
    this.loadSessions();
    this.reload();
  }

  reload() {
    const stored = this.store.list().filter((account) => account.providerType === 'robin' && account.accountType === 'gemini-app');
    const keep = new Set(stored.map((account) => account.id));
    for (const [id, entry] of this.entries) {
      if (!keep.has(id)) {
        entry.provider.auth?.disable?.();
        entry.provider.stop?.();
        entry.provider.forgetConversations?.();
        this.entries.delete(id);
      }
    }
    for (const account of stored) {
      let current = this.entries.get(account.id);
      if (current && !matchesAuthorization(current, account)) {
        current.provider.auth?.disable?.();
        current.provider.stop?.();
        if ((current.account.subjectId || current.account.email) !== (account.subjectId || account.email)) {
          current.provider.forgetConversations?.();
        }
        this.entries.delete(account.id);
        this.quotaRefreshes.delete(account.id);
        this.quotaAttempts.delete(account.id);
        current = null;
      }
      if (current) {
        if (!account.enabled && current.account.enabled) current.provider.stop?.();
        current.account = account;
        if (current.provider.auth) current.provider.auth.account = account;
      }
      else this.entries.set(account.id, {
        account,
        provider: this.providerFactory(account),
        models: new Set(account.capabilities || []),
        catalogKnown: Boolean(account.capabilities?.length),
        unhealthyUntil: 0,
        lastError: ''
      });
      const entry = this.entries.get(account.id);
      const health = account.providerMetadata?.robinHealth;
      const validHealth = health && health.credentialFingerprint === credentialFingerprint(account);
      entry.unhealthyUntil = validHealth
        ? (health.category === 'account' ? Infinity : Number(health.until) || 0)
        : 0;
      entry.healthCategory = validHealth ? health.category : '';
      entry.healthState = validHealth ? health.state : '';
      entry.healthSince = validHealth ? health.since : '';
      entry.lastError = validHealth ? String(health.message || '') : '';
    }
    return stored;
  }

  hasManagedAccounts() { return this.reload().some((account) => account.enabled); }

  eligible(model, excluded = new Set()) {
    this.reload();
    const now = this.now();
    return [...this.entries.values()].filter((entry) => {
      if (!entry.account.enabled || excluded.has(entry.account.id) || entry.unhealthyUntil > now) return false;
      if (this.quotaDepleted(entry.account)) return false;
      if (!model) return true;
      return entry.models.has(model) || (!entry.catalogKnown && (entry.account.capabilities || []).includes(model));
    });
  }

  supportsModel(model) {
    return this.eligible(model).length > 0;
  }

  ownsModel(model) {
    if (model === ARGON_MODEL) return true;
    this.reload();
    return [...this.entries.values()].some((entry) => (
      entry.account.enabled
      && (entry.models.has(model) || (entry.account.capabilities || []).includes(model))
    ));
  }

  selectAccount(model, routingKey, excluded = new Set()) {
    this.cleanupSessions();
    const candidates = this.eligible(model, excluded);
    if (!candidates.length) return null;
    const bound = routingKey ? this.sessions.get(routingKey) : null;
    const sticky = bound && candidates.find((entry) => entry.account.id === bound.accountId);
    if (sticky) return sticky;
    let selected = null;
    let selectedWeight = -Infinity;
    const total = candidates.reduce((sum, entry) => sum + Math.max(1, Number(entry.account.weight) || 1), 0);
    for (const entry of candidates) {
      const id = entry.account.id;
      const weight = (this.weights.get(id) || 0) + Math.max(1, Number(entry.account.weight) || 1);
      this.weights.set(id, weight);
      if (weight > selectedWeight) { selected = entry; selectedWeight = weight; }
    }
    if (selected) this.weights.set(selected.account.id, this.weights.get(selected.account.id) - total);
    return selected;
  }

  async send(normalized, model, options = {}) {
    const requestKey = JSON.stringify([options.clientId || 'client', upstreamSessionScope(normalized, options)]);
    if (this.activeRequests.has(requestKey)) throw new RobinProviderError('该 Argon 会话已有请求正在处理。', {
      code: 'robin_session_busy', status: 409
    });
    this.activeRequests.add(requestKey);
    try { return await this.sendRequest(normalized, model, options, requestKey); }
    finally { this.activeRequests.delete(requestKey); }
  }

  cancelTask(normalized, options = {}) {
    const scope = upstreamSessionScope(normalized, options);
    const requestKey = JSON.stringify([options.clientId || 'client', scope]);
    const accountId = this.activeTasks.get(requestKey);
    if (!accountId) return false;
    const upstreamSessionId = JSON.stringify([options.clientId || 'client', scope, 'robin', accountId]);
    this.entries.get(accountId)?.provider.cancelTask?.(upstreamSessionId);
    this.activeTasks.delete(requestKey);
    // Keep account affinity and the last completed native conversation cursor.
    // The rejected tool call never reached the client and must not stay pending.
    return true;
  }

  async sendRequest(normalized, model, options, requestKey) {
    const excluded = new Set();
    this.reload();
    const taskAccountId = this.activeTasks.get(requestKey);
    const taskAccount = taskAccountId ? this.entries.get(taskAccountId) : null;
    if (taskAccountId && (!taskAccount || !taskAccount.account.enabled)) {
      this.activeTasks.delete(requestKey);
      throw new RobinProviderError('当前 Argon 任务的账号已被禁用或删除。', { code: 'robin_task_account_unavailable', status: 409 });
    }
    let lastError = null;
    while (true) {
      options.signal?.throwIfAborted();
      const entry = taskAccount || this.selectAccount(model, options.routingKey || options.sessionId || '', excluded);
      if (!entry) {
        if (lastError) throw lastError;
        if ([...this.entries.values()].some(candidate => candidate.account.enabled
            && candidate.unhealthyUntil <= this.now() && candidate.models.has(model)
            && this.quotaDepleted(candidate.account))) {
          throw new RobinProviderError('可用 Gemini 账号的 Argon 任务额度已耗尽。', { code: 'robin_quota_error', status: 429 });
        }
        throw new RobinProviderError(`没有可用于模型 ${model} 的 Gemini 账号。`, { code: 'robin_model_unavailable', status: 503 });
      }
      excluded.add(entry.account.id);
      options.onAccountSelected?.({
        accountId: entry.account.id,
        email: entry.account.email,
        source: 'robin-account-pool',
        attempt: excluded.size
      });
      let emitted = false;
      const expectedAuthorization = entryAuthorizationKey(entry);
      const initialFingerprint = credentialFingerprint(entry.account);
      const upstreamSessionId = JSON.stringify([options.clientId || 'client', upstreamSessionScope(normalized, options), 'robin', entry.account.id]);
      try {
        const result = await entry.provider.send(normalized, model, {
          ...options, sessionId: upstreamSessionId, accountId: entry.account.id,
          requireExistingTurn: Boolean(taskAccount),
          onDelta: options.onDelta ? (delta) => { if (delta) emitted = true; options.onDelta(delta); } : undefined,
          onThinkingDelta: options.onThinkingDelta ? (delta) => { if (delta) emitted = true; options.onThinkingDelta(delta); } : undefined
        });
        if (!this.currentAccount(entry, expectedAuthorization)) {
          entry.provider.cancelTask?.(upstreamSessionId);
          throw new RobinProviderError('Gemini 账号授权已更换或删除，本轮不能继续交付旧任务。', {
            code: 'robin_credentials_changed', status: 409
          });
        }
        if (result.toolCalls?.length) this.activeTasks.set(requestKey, entry.account.id);
        else this.activeTasks.delete(requestKey);
        this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: true, count: true });
        if (result.usageKnown !== false) {
          this.usageStore?.recordUpstream({ accountId: entry.account.id, model, usage: result.usage, success: true, count: false });
        }
        this.saveHealth(entry, '', '', '', 0, { lastSuccessAt: new Date(this.now()).toISOString() }, expectedAuthorization,
          result.upstreamAuthFingerprint || initialFingerprint);
        if (options.routingKey) this.bind(options.routingKey, entry.account.id);
        return { ...result, accountId: entry.account.id, accountEmail: entry.account.email, providerType: 'robin' };
      } catch (error) {
        if (error?.code !== 'robin_tool_result_missing' && error?.code !== 'robin_session_busy') {
          this.activeTasks.delete(requestKey);
        }
        if (options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'request_aborted') {
          this.activeTasks.delete(requestKey);
          throw error;
        }
        const failure = error instanceof RobinProviderError ? error : new RobinProviderError(String(error?.message || error), {
          code: String(error?.code || 'robin_upstream_error'),
          status: Number(error?.status || error?.statusCode) || 502,
          details: String(error?.details || '')
        });
        lastError = failure;
        if (!this.currentAccount(entry, expectedAuthorization)) throw failure;
        const category = robinErrorCategory(error);
        const message = String(error?.message || error);
        this.usageStore?.recordUpstream({ accountId: entry.account.id, model, success: false, count: true });
        if (category !== 'request') {
          const until = category === 'account' ? Infinity : this.now() + (category === 'quota' ? 5 * 60_000 : 10_000);
          const state = category === 'quota' ? 'quota_exhausted' : category === 'transient' ? 'cooldown'
            : /verify your account/i.test(message) ? 'verification_required'
              : Number(error?.status) === 403 ? 'access_denied' : 'authentication_error';
          this.saveHealth(entry, category, state, message, until, { lastFailureAt: new Date(this.now()).toISOString() }, expectedAuthorization,
            error.upstreamAuthFingerprint || initialFingerprint);
        }
        // Once a client saw text or a tool call, replaying on another account
        // can duplicate both output and client side effects.
        if (category === 'request' || taskAccount || emitted) throw failure;
      }
    }
  }

  async listModels(signal, { force = false } = {}) {
    signal?.throwIfAborted();
    this.quotaController.signal.throwIfAborted();
    this.reload();
    const models = new Set();
    for (const entry of this.entries.values()) {
      if (!entry.account.enabled) continue;
      // Directory refresh is not an account recheck. A quarantined/cooling
      // credential must not be probed on every client's model-list request.
      if (entry.unhealthyUntil > this.now()) {
        for (const model of entry.models) models.add(model);
        continue;
      }
      if (!force && entry.catalogKnown) {
        for (const model of entry.models) models.add(model);
        continue;
      }
      const expectedAuthorization = entryAuthorizationKey(entry);
      try {
        const discovered = await this.discoverCapabilities(entry, signal);
        signal?.throwIfAborted();
        const latest = this.currentAccount(entry, expectedAuthorization);
        if (!latest) continue;
        entry.models = new Set(discovered);
        entry.catalogKnown = true;
        for (const model of discovered) models.add(model);
        const capabilities = [...entry.models];
        const providerMetadata = { ...latest.providerMetadata };
        delete providerMetadata.robinCapabilities;
        entry.account = this.store.update(entry.account.id, { capabilities, providerMetadata });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (this.quotaController.signal.aborted) throw this.quotaController.signal.reason;
        if (!this.currentAccount(entry, expectedAuthorization)) continue;
        for (const model of entry.models) models.add(model);
      }
    }
    return [...models].sort();
  }

  async discoverCapabilities(entry, signal) {
    const models = await entry.provider.listModels(signal);
    if (!Array.isArray(models)) throw new RobinProviderError('Gemini 账号能力响应无效。', {
      code: 'robin_protocol_error', status: 502
    });
    return models;
  }

  status() {
    this.reload();
    return [...this.entries.values()].map((entry) => ({
      id: entry.account.id,
      email: entry.account.email,
      providerType: 'robin',
      accountType: 'gemini-app',
      planName: entry.account.planName,
      quota: this.quotaSnapshot(entry.account),
      models: [...entry.models],
      enabled: entry.account.enabled,
      available: entry.account.enabled && entry.unhealthyUntil <= this.now() && !this.quotaDepleted(entry.account),
      state: !entry.account.enabled ? 'disabled' : entry.unhealthyUntil > this.now()
        ? entry.healthState || 'unavailable' : this.quotaDepleted(entry.account) ? 'quota_exhausted' : 'available',
      healthMessage: entry.unhealthyUntil > this.now() ? entry.lastError : '',
      healthSince: entry.healthSince,
      modelCooldowns: [],
      lastError: entry.lastError,
      lastSuccessAt: entry.account.lastSuccessAt,
      lastFailureAt: entry.account.lastFailureAt
    }));
  }

  quotaSnapshot(account) {
    const snapshot = account.providerMetadata?.robinQuota;
    if (!snapshot) return null;
    const fetchedAt = Date.parse(snapshot.fetchedAt);
    const stale = !Number.isFinite(fetchedAt) || this.now() - fetchedAt >= ROBIN_QUOTA_TTL_MS
      || (snapshot.groups || []).some((group) => (group.buckets || []).some((bucket) => (
        bucket.resetTime && Date.parse(bucket.resetTime) <= this.now()
      )));
    return { ...snapshot, stale };
  }

  quotaDepleted(account) {
    const quota = this.quotaSnapshot(account);
    // Never let an absent/expired snapshot block a live request. The upstream
    // request remains authoritative, and ongoing tool tasks stay on their
    // original stream even if a background snapshot changes.
    return Boolean(quota && !quota.stale && (quota.groups || []).some(group => (
      (group.buckets || []).some(bucket => ['5h', 'weekly'].includes(bucket.window)
        && bucket.remainingFraction === 0)
    )));
  }

  async refreshQuota(id, { signal } = {}) {
    if (this.quotaController.signal.aborted) return null;
    if (this.quotaRefreshes.has(id)) return this.quotaRefreshes.get(id);
    this.reload();
    const entry = this.entries.get(id);
    if (!entry?.account.enabled || entry.unhealthyUntil > this.now() || !entry.provider.getQuota) return null;
    const snapshot = this.quotaSnapshot(entry.account);
    if (snapshot && !snapshot.stale) return snapshot;
    if (this.now() - (this.quotaAttempts.get(id) ?? -Infinity) < ROBIN_QUOTA_RETRY_MS) return snapshot;
    this.quotaAttempts.set(id, this.now());
    const controllerSignal = this.quotaController.signal;
    const expectedAuthorization = entryAuthorizationKey(entry);
    const pending = (async () => {
      try {
        const combined = AbortSignal.any([controllerSignal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
        const quota = await entry.provider.getQuota(combined);
        combined.throwIfAborted();
        const latest = this.currentAccount(entry, expectedAuthorization);
        // Never resurrect deleted accounts or overwrite credentials refreshed
        // concurrently by the auth provider.
        if (!latest) return null;
        entry.account = this.store.update(id, {
          ...(quota.planName ? { planName: quota.planName } : {}),
          providerMetadata: {
            ...latest.providerMetadata, robinQuota: { ...quota, fetchedAt: new Date(this.now()).toISOString() }
          }
        });
        return this.quotaSnapshot(entry.account);
      } catch {
        // Optional quota telemetry must not disable an otherwise usable account.
        this.diagnosticReporter?.('robin_quota_refresh_failed', { accountId: id });
        return this.quotaSnapshot(entry.account);
      }
    })();
    this.quotaRefreshes.set(id, pending);
    try { return await pending; }
    finally { if (this.quotaRefreshes.get(id) === pending) this.quotaRefreshes.delete(id); }
  }

  async refreshQuotas() {
    this.reload();
    // Bound concurrency independently of model requests and Cloud Code quota.
    for (const id of this.entries.keys()) {
      if (this.quotaController.signal.aborted) break;
      await this.refreshQuota(id);
    }
  }

  start() {
    if (this.quotaTimer) return;
    if (this.quotaController.signal.aborted) this.quotaController = new AbortController();
    this.quotaTimer = setInterval(() => { void this.refreshQuotas().catch(() => {}); }, ROBIN_QUOTA_RETRY_MS);
    this.quotaTimer.unref?.();
    void this.refreshQuotas().catch(() => {});
  }

  currentAccount(entry, expectedAuthorization = entryAuthorizationKey(entry)) {
    const latest = this.store.list().find((account) => account.id === entry.account.id);
    return this.entries.get(entry.account.id) === entry && latest?.enabled
      && matchesAuthorization(entry, latest, expectedAuthorization) ? latest : null;
  }

  saveHealth(entry, category, state, message, until, extra = {}, expectedAuthorization, expectedFingerprint) {
    const latest = this.currentAccount(entry, expectedAuthorization);
    if (!latest || (expectedFingerprint && credentialFingerprint(latest) !== expectedFingerprint)) return;
    const { providerMetadata, ...recordExtra } = extra;
    // An in-flight request cannot mutate a new authorization/token's health.
    entry.account = this.store.update(latest.id, {
      ...recordExtra,
      lastError: message,
      providerMetadata: {
        ...latest.providerMetadata,
        ...(providerMetadata || {}),
        robinHealth: category ? {
          category, state, message, until: Number.isFinite(until) ? until : null,
          since: new Date(this.now()).toISOString(),
          credentialFingerprint: credentialFingerprint(latest)
        } : null
      }
    });
    entry.unhealthyUntil = until;
    entry.healthCategory = category;
    entry.healthState = state;
    entry.healthSince = entry.account.providerMetadata.robinHealth?.since || '';
    entry.lastError = message;
  }

  async recheckAccount(id, { signal } = {}) {
    this.reload();
    const entry = this.entries.get(id);
    if (!entry) throw new RobinProviderError(`找不到 Gemini 账号: ${id}`, { code: 'robin_account_not_found', status: 404 });
    const expectedAuthorization = entryAuthorizationKey(entry);
    await entry.provider.auth.get(signal, { forceRefresh: true });
    const models = await this.discoverCapabilities(entry, signal);
    const latest = this.currentAccount(entry, expectedAuthorization);
    if (!latest) throw new RobinProviderError('Gemini 账号授权已更换，请重新检测当前账号。', {
      code: 'robin_credentials_changed', status: 409
    });
    entry.models = new Set(models);
    entry.catalogKnown = true;
    const providerMetadata = { ...latest.providerMetadata };
    delete providerMetadata.robinCapabilities;
    entry.account = this.store.update(entry.account.id, { providerMetadata });
    this.saveHealth(entry, '', '', '', 0, {
      capabilities: models,
      lastSuccessAt: new Date(this.now()).toISOString()
    }, expectedAuthorization);
    void this.refreshQuota(id).catch(() => {});
    return { ...this.status().find((account) => account.id === id), recovered: true };
  }

  removeAccount(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new RobinProviderError(`找不到 Gemini 账号: ${id}`, { code: 'robin_account_not_found', status: 404 });
    entry.provider.auth?.disable?.();
    entry.provider.stop?.();
    entry.provider.forgetConversations?.();
    this.store.delete(id);
    this.entries.delete(id);
    for (const [key, value] of this.sessions) if (value.accountId === id) this.sessions.delete(key);
    this.saveSessions();
    return { id, deleted: true, providerType: 'robin' };
  }

  bind(routingKey, accountId) {
    if (!routingKey || !accountId) return;
    const previous = this.sessions.get(routingKey);
    if (previous?.accountId === accountId && this.now() - previous.at < ROBIN_SESSION_TTL_MS) return;
    this.sessions.set(routingKey, { accountId, at: this.now() });
    this.saveSessions();
  }

  cleanupSessions() {
    const now = this.now();
    let changed = false;
    for (const [key, value] of this.sessions) {
      if (ROBIN_SESSION_TTL_MS <= 0 || now - value.at >= ROBIN_SESSION_TTL_MS || !this.entries.has(value.accountId)) {
        this.sessions.delete(key);
        changed = true;
      }
    }
    if (changed) this.saveSessions();
  }

  loadSessions() {
    try {
      const body = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [key, value] of Object.entries(body.sessions || {})) {
        if (value?.accountId && Number.isFinite(value?.at)) this.sessions.set(key, value);
      }
    } catch { /* no prior Robin affinity state */ }
  }

  saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({ sessions: Object.fromEntries(this.sessions) }, null, 2)}\n`);
      fs.renameSync(temporary, this.stateFile);
    } catch { /* affinity persistence is best effort */ }
  }

  stop() {
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    this.quotaTimer = null;
    this.quotaController.abort();
    for (const entry of this.entries.values()) entry.provider.stop?.();
    this.activeTasks.clear();
  }
}

module.exports = { ROBIN_SESSION_TTL_MS, ROBIN_QUOTA_TTL_MS, ROBIN_QUOTA_RETRY_MS, RobinAccountPool, robinErrorCategory };
