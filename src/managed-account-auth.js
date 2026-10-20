'use strict';

const crypto = require('node:crypto');
const { errorDetails } = require('./diagnostic-log');
const { LocalAgyAuthProvider } = require('./local-agy-auth');

function privateAccountIdentity(account) {
  const subject = String(account.subjectId || '').trim();
  const email = String(account.email || '').trim().toLowerCase();
  // A local record ID can survive a credential import/replacement. Bind the
  // private native history to the actual identity, not only to that record.
  // Known identities stay stable through ordinary token refresh/rotation.
  // Without identity metadata, a different grant must not inherit old state.
  const identity = subject ? ['subject', subject] : email ? ['email', email]
    : account.refreshToken ? ['refresh-token', account.refreshToken]
    : account.accessToken ? ['access-token', account.accessToken]
    : ['unidentified', crypto.randomUUID()];
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function authRecord(account) {
  return {
    accessToken: account.accessToken || '',
    refreshToken: account.refreshToken || '',
    expiry: account.expiresAt ? new Date(account.expiresAt) : null,
    projectId: account.projectId || '',
    authMethod: account.authMethod || 'consumer',
    // This identifier is local-only. Do not migrate unbound legacy state: its
    // contents cannot prove which Google identity originally produced it.
    sourcePath: `managed-account:${account.id}:identity:${privateAccountIdentity(account)}`
  };
}

class ManagedAccountAuthProvider {
  constructor({ account, store, fetchImpl = globalThis.fetch, agyPath = '', diagnosticReporter } = {}) {
    this.account = account;
    this.store = store;
    this.disabled = false;
    this.diagnosticReporter = typeof diagnosticReporter === 'function' ? diagnosticReporter : null;
    this.provider = new LocalAgyAuthProvider({
      fetchImpl,
      agyPath,
      clientCredentials: account.clientId && account.clientSecret
        ? [{ clientId: account.clientId, clientSecret: account.clientSecret }]
        : [],
      useKeychain: false,
      authFile: '__managed_account__'
    });
    this.provider.paths = [];
    this.provider.last = authRecord(account);
  }

  isConfigured() { return true; }

  disable() { this.disabled = true; }

  load() { return this.provider.last; }

  async get(signal, options) {
    if (this.disabled) throw new Error('账号已从账号池删除。');
    const before = this.provider.last;
    const forceRefresh = Boolean(options?.forceRefresh);
    const expiry = before?.expiry instanceof Date ? before.expiry.valueOf() : Date.parse(before?.expiry || '');
    const refreshExpected = forceRefresh || !before?.accessToken || !Number.isFinite(expiry) || expiry <= Date.now() + 60_000;
    const startedAt = Date.now();
    if (refreshExpected) this.report('managed_token_refresh_started', {
      forceRefresh,
      previousExpiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : '',
      hasAccessToken: Boolean(before?.accessToken),
      hasRefreshToken: Boolean(before?.refreshToken)
    });
    let record;
    try {
      record = await this.provider.get(signal, options);
    } catch (error) {
      if (refreshExpected) this.report('managed_token_refresh_failed', {
        durationMs: Date.now() - startedAt,
        ...errorDetails(error)
      });
      throw error;
    }
    if (this.disabled) throw new Error('账号已从账号池删除。');
    if (record !== before || record.accessToken !== this.account.accessToken || record.refreshToken !== this.account.refreshToken) {
      this.account = this.store.save({
        ...this.account,
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        expiresAt: record.expiry instanceof Date ? record.expiry.toISOString() : '',
        projectId: record.projectId || this.account.projectId,
        clientId: this.account.clientId,
        clientSecret: this.account.clientSecret,
        authMethod: record.authMethod || this.account.authMethod
      });
    }
    if (refreshExpected) this.report('managed_token_refresh_succeeded', {
      durationMs: Date.now() - startedAt,
      refreshed: record !== before || record.accessToken !== before?.accessToken,
      refreshTokenChanged: Boolean(before?.refreshToken && record.refreshToken && record.refreshToken !== before.refreshToken),
      expiresAt: record.expiry instanceof Date && !Number.isNaN(record.expiry.valueOf()) ? record.expiry.toISOString() : ''
    });
    return record;
  }

  report(event, fields) {
    try { this.diagnosticReporter?.(event, fields); }
    catch { /* diagnostics are best effort */ }
  }
}

module.exports = { ManagedAccountAuthProvider };
