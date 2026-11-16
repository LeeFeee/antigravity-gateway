'use strict';

const { accountGrantGeneration } = require('./account-store');
const { GEMINI_CLIENT_VERSION, GEMINI_BUNDLE_ID } = require('./gemini-request-profile');
const { decodeFields, field, messageField: m, stringField: s, intField: i, concatFields: c } = require('./gemini-wire');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CONFIG_ENDPOINT = 'https://www.googleapis.com/experimentsandconfigs/v1/getExperimentsAndConfigs';
const CONFIG_PACKAGE = `com.google.gemini.macos.user#@${GEMINI_BUNDLE_ID}`;

function authError(message, code = 'gemini_auth_error', status = 401) { return Object.assign(new Error(message), { code, status }); }

async function boundedBody(response, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > limit) throw authError('Gemini 授权响应超过限制。', 'gemini_auth_response_invalid', 502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function geminiConfigurationRequest() {
  const [major, minor, patch] = GEMINI_CLIENT_VERSION.split('.').map(BigInt);
  const version = major * 1000000000000n + minor * 1000000n + patch;
  // Current app's account configuration package and version were captured.
  // Request only that package; do not initialize telemetry/upload packages.
  return c([m(2, m(1, c([s(1, CONFIG_PACKAGE), i(2, version), m(3, i(1, 0))]))), i(4, 1), s(7, GEMINI_BUNDLE_ID)]);
}

async function fetchGeminiServerToken(accessToken, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (!accessToken) throw authError('Gemini 缺少访问凭据。');
  const response = await fetchImpl(CONFIG_ENDPOINT, { method: 'POST', signal,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/x-protobuf', 'x-ios-bundle-identifier': GEMINI_BUNDLE_ID },
    body: geminiConfigurationRequest() });
  const bytes = await boundedBody(response, 16 * 1024 * 1024);
  if (!response.ok) throw authError(`Gemini 服务配置读取失败（HTTP ${response.status}）。`,
    response.status === 401 ? 'gemini_reauthorization_required' : 'gemini_server_token_failed', response.status);
  let fields;
  try { fields = decodeFields(bytes); } catch { throw authError('Gemini 服务配置格式无效。', 'gemini_server_token_invalid', 502); }
  for (const entry of fields) {
    if (entry.number !== 1 || entry.wireType !== 2) continue;
    const details = field(entry.value, 1, 2), packageName = details && field(details, 1, 2)?.toString('utf8');
    const token = field(entry.value, 4, 2)?.toString('utf8');
    // Never use a token for a different package merely because it appears
    // first in a multi-package response.
    if (packageName === CONFIG_PACKAGE && token) return token;
  }
  throw authError('Gemini 未返回对应账号配置的服务令牌。', 'gemini_server_token_missing', 502);
}

function waitForShared(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

class GeminiAccountAuth {
  constructor({ account, store, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 30000, initializationId = '' } = {}) {
    if (account?.providerType !== 'gemini' || !store) throw new TypeError('Gemini auth requires its own managed account and store');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid Gemini auth timeout');
    this.account = account;
    this.grant = accountGrantGeneration(account);
    Object.assign(this, { store, fetchImpl, now, timeoutMs, initializationId });
    this.disabled = false;
    this.pending = null;
  }

  current() {
    if (this.disabled) throw authError('Gemini 账号已停用。', 'gemini_account_unavailable', 409);
    const current = this.store.list().find(account => account.id === this.account.id);
    if (!current || accountGrantGeneration(current) !== this.grant) throw authError('Gemini 账号已删除或重新授权。', 'gemini_account_grant_changed', 409);
    const initializing = this.initializationId && current.providerMetadata.initialization?.jobId === this.initializationId
      && current.providerMetadata.initialization?.running === true;
    if (this.initializationId && !initializing) throw authError('Gemini 初始化任务已取消或更换。', 'gemini_initialization_changed', 409);
    if (!initializing && current.providerMetadata.initialization?.complete === false) {
      throw authError('Gemini 账号尚未完成初始化，请在看板继续处理。', 'gemini_initialization_required', 409);
    }
    if (!current.enabled && !initializing) throw authError('Gemini 账号已停用。', 'gemini_account_unavailable', 409);
    this.account = current;
    return current;
  }

  save(updates) {
    const current = this.current();
    const saved = this.store.save({ ...current, ...updates,
      providerMetadata: { ...current.providerMetadata, ...updates.providerMetadata } }, { expectedGrant: this.grant });
    if (!saved) throw authError('Gemini 账号授权已更换，已丢弃旧刷新结果。', 'gemini_account_grant_changed', 409);
    this.account = saved;
    return saved;
  }

  disable() {
    this.disabled = true;
    this.controller?.abort(authError('Gemini 账号已停用。', 'gemini_account_unavailable', 409));
  }

  async credentials({ signal, forceRefresh = false } = {}) {
    signal?.throwIfAborted();
    const current = this.current();
    if (!forceRefresh && current.accessToken && Date.parse(current.expiresAt) > this.now() + 60000 && current.providerMetadata.serverToken) {
      return { accessToken: current.accessToken, serverToken: current.providerMetadata.serverToken };
    }
    if (!this.pending) {
      const controller = new AbortController(); this.controller = controller;
      const timer = setTimeout(() => controller.abort(authError('Gemini 凭据刷新超时。', 'gemini_auth_timeout', 504)), this.timeoutMs);
      this.pending = this.refresh(controller.signal, forceRefresh).finally(() => {
        clearTimeout(timer); this.pending = null;
        if (this.controller === controller) this.controller = null;
      });
      this.pending.catch(() => {});
    }
    return waitForShared(this.pending, signal);
  }

  async refresh(signal, forceRefresh) {
    let account = this.current();
    if (forceRefresh || !account.accessToken || !(Date.parse(account.expiresAt) > this.now() + 60000)) {
      if (!account.refreshToken || !account.clientId || !account.clientSecret) throw authError('Gemini 授权不完整，请从看板重新认证。', 'gemini_reauthorization_required');
      const response = await this.fetchImpl(TOKEN_ENDPOINT, { method: 'POST', signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: account.clientId, client_secret: account.clientSecret,
          refresh_token: account.refreshToken, grant_type: 'refresh_token' }) });
      let token;
      try { token = JSON.parse((await boundedBody(response, 1024 * 1024)).toString('utf8')); }
      catch (error) {
        signal.throwIfAborted();
        if (error.code) throw error;
        throw authError('Gemini 令牌响应格式无效。', 'gemini_token_response_invalid', 502);
      }
      if (!response.ok) throw authError('Gemini 令牌刷新失败。',
        token.error === 'invalid_grant' ? 'gemini_reauthorization_required' : 'gemini_token_refresh_failed',
        token.error === 'invalid_grant' ? 401 : response.status);
      if (typeof token.access_token !== 'string' || !token.access_token || !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0) {
        throw authError('Gemini 令牌响应缺少有效访问凭据或有效期。', 'gemini_token_response_invalid', 502);
      }
      signal.throwIfAborted();
      // Persist a rotated refresh token before the separate configuration
      // lookup. A failure there must not lose the newly issued OAuth grant.
      account = this.save({ accessToken: token.access_token,
        refreshToken: typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : account.refreshToken,
        expiresAt: new Date(this.now() + Number(token.expires_in) * 1000).toISOString(),
        providerMetadata: { serverToken: '', serverTokenFetchedAt: '' } });
    }
    const serverToken = await fetchGeminiServerToken(account.accessToken, { signal, fetchImpl: this.fetchImpl });
    signal.throwIfAborted();
    account = this.save({ providerMetadata: { serverToken, serverTokenFetchedAt: new Date(this.now()).toISOString() } });
    return { accessToken: account.accessToken, serverToken };
  }
}

module.exports = { GeminiAccountAuth, fetchGeminiServerToken, geminiConfigurationRequest };
