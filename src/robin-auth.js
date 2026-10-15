'use strict';

const crypto = require('node:crypto');
const { fetchRobinServerToken } = require('./robin-phenotype');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_ID = '839509190550-l232s7lupkp6f57818eshd7u4sl4920h.apps.googleusercontent.com';
// OAuth installed-app credentials are application identifiers, not a server
// secret. Keep an environment override for future Gemini desktop rotations.
const DEFAULT_CLIENT_SECRET_B64 = 'R09DU1BYLWNkZWIwR0NrVE1MWUZURWhLQTMxcGhGQ0JSc24=';

function robinCredentialFingerprint(account = {}) {
  return crypto.createHash('sha256').update(JSON.stringify([
    account.accessToken || '', account.refreshToken || '', account.clientId || ''
  ])).digest('hex');
}

function robinAuthorizationKey(account = {}) {
  return crypto.createHash('sha256').update(JSON.stringify([
    account.id, account.subjectId || '', String(account.email || '').toLowerCase(),
    account.refreshToken || ''
  ])).digest('hex');
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function oauthClient(account = {}) {
  return {
    clientId: firstString(account.clientId, process.env.ANTIGRAVITY_ROBIN_OAUTH_CLIENT_ID) || DEFAULT_CLIENT_ID,
    clientSecret: firstString(account.clientSecret, process.env.ANTIGRAVITY_ROBIN_OAUTH_CLIENT_SECRET)
      || Buffer.from(DEFAULT_CLIENT_SECRET_B64, 'base64').toString('utf8')
  };
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text || '{}'); }
  catch { throw new Error(`${label}返回了无效 JSON。`); }
  if (!response.ok) {
    const detail = firstString(body.error_description, body.error?.message, body.error, body.message) || `HTTP ${response.status}`;
    const error = new Error(`${label}失败：${detail}`);
    error.status = response.status;
    error.code = body.error || 'robin_oauth_error';
    throw error;
  }
  return body;
}

class RobinAccountAuthProvider {
  constructor({ account, store, fetchImpl = globalThis.fetch, diagnosticReporter } = {}) {
    if (!account || !store) throw new Error('RobinAccountAuthProvider requires account and store');
    this.account = account;
    this.authorizationKey = robinAuthorizationKey(account);
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.diagnosticReporter = typeof diagnosticReporter === 'function' ? diagnosticReporter : null;
    this.disabled = false;
    this.pending = null;
    this.controller = null;
  }

  disable() {
    this.disabled = true;
    this.controller?.abort(new Error('Gemini 账号已从账号池删除。'));
  }

  matchesAuthorization(expectedKey, account) {
    // The provider owns ordinary OAuth refreshes, including a rotated refresh
    // token. Keep its original operation generation, but accept only its latest
    // saved grant. A different on-disk grant never joins an in-flight task.
    return !this.disabled && expectedKey === this.authorizationKey
      && robinAuthorizationKey(account) === robinAuthorizationKey(this.account);
  }

  async sharedOperation(operation, signal) {
    signal?.throwIfAborted();
    if (!this.pending) {
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(() => controller.abort(new Error('Gemini 授权请求超时。')), AUTH_TIMEOUT_MS);
      timer.unref?.();
      this.pending = Promise.resolve().then(() => operation(controller.signal)).finally(() => {
        clearTimeout(timer);
        this.pending = null;
        if (this.controller === controller) this.controller = null;
      });
    }
    if (!signal) return this.pending;
    // Credential refresh is shared by all sessions on this account. Aborting
    // one HTTP request stops only its wait, not another session's refresh.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }

  saveCredentials(updates, expected) {
    if (this.disabled) throw new Error('Gemini 账号已从账号池删除。');
    const current = this.store.list().find((account) => account.id === expected.id);
    if (!current) throw new Error('Gemini 账号已从账号池删除。');
    if (current.refreshToken !== expected.refreshToken || current.accessToken !== expected.accessToken) {
      const error = new Error('Gemini 账号授权已更换，请使用最新授权重试。');
      error.code = 'robin_credentials_changed';
      error.status = 409;
      throw error;
    }
    this.account = this.store.update(current.id, {
      ...updates,
      providerMetadata: { ...current.providerMetadata, ...updates.providerMetadata }
    });
  }

  isConfigured() {
    return Boolean(this.account.accessToken || this.account.refreshToken);
  }

  async get(signal, { forceRefresh = false } = {}) {
    signal?.throwIfAborted();
    if (this.disabled) throw new Error('Gemini 账号已从账号池删除。');
    const expiresAt = Date.parse(this.account.expiresAt || '');
    const usable = this.account.accessToken
      && Number.isFinite(expiresAt)
      && expiresAt > Date.now() + 60_000;
    if (!forceRefresh && usable) {
      if (this.serverToken()) return this.record();
      return this.sharedOperation((sharedSignal) => this.loadServerToken(sharedSignal), signal);
    }
    if (!this.account.refreshToken) {
      const error = new Error('Gemini OAuth 已过期且缺少 refresh token，请重新授权。');
      error.code = 'robin_reauthorization_required';
      error.status = 401;
      throw error;
    }
    return this.sharedOperation((sharedSignal) => this.refresh(sharedSignal), signal);
  }

  async refresh(signal) {
    const expected = { ...this.account };
    const startedAt = Date.now();
    this.report('robin_token_refresh_started', { accountId: this.account.id });
    const client = oauthClient(this.account);
    try {
      const response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: this.account.refreshToken,
          grant_type: 'refresh_token'
        })
      });
      const body = await responseJson(response, 'Gemini OAuth token 刷新');
      if (this.disabled) throw new Error('Gemini 账号已从账号池删除。');
      const accessToken = firstString(body.access_token);
      if (!accessToken) throw new Error('Gemini OAuth token 刷新未返回 access token。');
      const serverToken = await fetchRobinServerToken(accessToken, { fetchImpl: this.fetchImpl, signal });
      this.saveCredentials({
        providerType: 'robin',
        accountType: 'gemini-app',
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        accessToken,
        refreshToken: firstString(body.refresh_token) || expected.refreshToken,
        expiresAt: body.expires_in
          ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString()
          : expected.expiresAt,
        providerMetadata: {
          robinServerToken: serverToken,
          robinServerTokenFetchedAt: new Date().toISOString()
        }
      }, expected);
      this.report('robin_token_refresh_succeeded', {
        accountId: this.account.id,
        durationMs: Date.now() - startedAt,
        expiresAt: this.account.expiresAt
      });
      return this.record();
    } catch (error) {
      this.report('robin_token_refresh_failed', {
        accountId: this.account.id,
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || 0,
        code: String(error?.code || '')
      });
      throw error;
    }
  }

  record() {
    return {
      accessToken: this.account.accessToken,
      serverToken: this.serverToken(),
      refreshToken: this.account.refreshToken,
      expiry: this.account.expiresAt ? new Date(this.account.expiresAt) : null,
      providerType: 'robin',
      credentialFingerprint: robinCredentialFingerprint(this.account),
      accountId: this.account.id,
      sourcePath: `robin-account:${this.account.id}`
    };
  }

  metadata() {
    return this.account.providerMetadata && typeof this.account.providerMetadata === 'object'
      ? this.account.providerMetadata
      : {};
  }

  serverToken() {
    return firstString(this.metadata().robinServerToken);
  }

  async loadServerToken(signal) {
    const expected = { ...this.account };
    const startedAt = Date.now();
    this.report('robin_server_token_started', { accountId: this.account.id });
    try {
      const serverToken = await fetchRobinServerToken(this.account.accessToken, {
        fetchImpl: this.fetchImpl,
        signal
      });
      if (this.disabled) throw new Error('Gemini 账号已从账号池删除。');
      this.saveCredentials({
        providerMetadata: {
          robinServerToken: serverToken,
          robinServerTokenFetchedAt: new Date().toISOString()
        }
      }, expected);
      this.report('robin_server_token_succeeded', {
        accountId: this.account.id,
        durationMs: Date.now() - startedAt
      });
      return this.record();
    } catch (error) {
      this.report('robin_server_token_failed', {
        accountId: this.account.id,
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || 0,
        code: String(error?.code || '')
      });
      throw error;
    }
  }

  report(event, fields) {
    try { this.diagnosticReporter?.(event, fields); }
    catch { /* diagnostics must never alter auth behavior */ }
  }
}

module.exports = {
  DEFAULT_CLIENT_ID,
  RobinAccountAuthProvider,
  robinAuthorizationKey,
  robinCredentialFingerprint,
  oauthClient,
  responseJson
};
