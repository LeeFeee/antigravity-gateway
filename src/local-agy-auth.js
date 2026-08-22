'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
let discoveredClientCredentials;

class LocalAgyAuthError extends Error {
  constructor(message, { code = 'local_agy_auth_error', status = 401, cause } = {}) {
    super(message, { cause });
    this.name = 'LocalAgyAuthError';
    this.code = code;
    this.status = status;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function expiryDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds);
  }
  const text = firstString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function normalizeRecord(raw, sourcePath) {
  if (!raw || typeof raw !== 'object') return null;
  // agy/Antigravity standalone currently stores this shape in
  // ~/.gemini/jetski-standalone-oauth-token.
  const token = raw.token && typeof raw.token === 'object' ? raw.token : raw;
  const accessToken = firstString(token.access_token, token.accessToken);
  const refreshToken = firstString(token.refresh_token, token.refreshToken);
  if (!accessToken && !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiry: expiryDate(token.expiry ?? token.expiry_date ?? token.expires_at ?? token.expiresAt ?? raw.expiry_date),
    projectId: firstString(raw.project_id, raw.projectId, token.project_id, token.projectId),
    authMethod: firstString(raw.auth_method, raw.authMethod) || 'consumer',
    sourcePath
  };
}

function defaultPaths(homeDir = os.homedir()) {
  return [
    path.join(homeDir, '.gemini', 'jetski-standalone-oauth-token'),
    path.join(homeDir, '.gemini', 'oauth_creds.json')
  ];
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeClientCredentials(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return source.map((item) => ({
    clientId: firstString(item?.clientId, item?.client_id),
    clientSecret: firstString(item?.clientSecret, item?.client_secret)
  })).filter((item) => item.clientId && item.clientSecret);
}

function agyBinaryPaths(homeDir = os.homedir()) {
  return [
    process.env.ANTIGRAVITY_CLI_PATH,
    path.join(homeDir, '.local', 'bin', 'agy'),
    path.join(homeDir, '.antigravity', 'antigravity', 'bin', 'agy'),
    '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity'
  ].filter(Boolean).map((item) => path.resolve(item));
}

function discoverClientCredentials({ homeDir = os.homedir(), agyPath = '' } = {}) {
  if (discoveredClientCredentials) return discoveredClientCredentials;
  const configured = normalizeClientCredentials(
    process.env.ANTIGRAVITY_GOOGLE_CLIENT_ID && process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET
      ? [{ clientId: process.env.ANTIGRAVITY_GOOGLE_CLIENT_ID, clientSecret: process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET }]
      : []
  );
  if (configured.length) return (discoveredClientCredentials = configured);
  const paths = agyPath ? [path.resolve(agyPath), ...agyBinaryPaths(homeDir)] : agyBinaryPaths(homeDir);
  const candidates = [];
  for (const file of [...new Set(paths)]) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      // The official agy binary contains the installed OAuth client metadata.
      // Read it only at runtime; no client credential is stored in this repo.
      const text = fs.readFileSync(file).toString('latin1');
      const ids = [...new Set(text.match(/[0-9]{8,}-[a-z0-9-]{20,}\.apps\.googleusercontent\.com/gi) || [])];
      const secrets = [...new Set(text.match(/GOCSPX-[A-Za-z0-9_-]{20,}/g) || [])];
      for (const clientId of ids) for (const clientSecret of secrets) candidates.push({ clientId, clientSecret });
      if (candidates.length) break;
    } catch { /* another installation path may exist */ }
  }
  return (discoveredClientCredentials = candidates);
}

class LocalAgyAuthProvider {
  constructor({
    homeDir = os.homedir(),
    authFile = process.env.ANTIGRAVITY_LOCAL_AUTH_FILE || '',
    fetchImpl = globalThis.fetch,
    tokenEndpoint = TOKEN_ENDPOINT,
    clientCredentials = []
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.tokenEndpoint = tokenEndpoint;
    this.clientCredentials = normalizeClientCredentials(clientCredentials);
    this.paths = authFile ? [path.resolve(authFile)] : defaultPaths(homeDir);
    this.last = null;
  }

  find() {
    for (const file of this.paths) {
      if (!fs.existsSync(file)) continue;
      const record = normalizeRecord(safeReadJson(file), file);
      if (record) return record;
    }
    return null;
  }

  isConfigured() {
    return Boolean(this.find());
  }

  load() {
    const record = this.find();
    if (record) this.last = record;
    return record;
  }

  async refresh(signal, refreshToken) {
    if (!refreshToken) throw new LocalAgyAuthError('本地 agy 登录态缺少 refresh token。', { code: 'local_agy_refresh_missing' });
    const candidates = this.clientCredentials.length ? this.clientCredentials : discoverClientCredentials();
    if (!candidates.length) throw new LocalAgyAuthError('无法从本地 agy 安装中发现 OAuth 客户端配置。', { code: 'local_agy_client_credentials_missing' });
    let lastStatus = 401;
    for (const candidate of candidates) {
      const form = new URLSearchParams({ client_id: candidate.clientId, client_secret: candidate.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
      let response;
      try {
        response = await this.fetchImpl(this.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal });
      } catch (cause) {
        throw new LocalAgyAuthError('本地 agy 登录态刷新请求失败。', { code: 'local_agy_refresh_failed', status: 502, cause });
      }
      const text = await response.text();
      lastStatus = response.status;
      let body = {};
      try { body = JSON.parse(text); } catch { /* try the next embedded client */ }
      const accessToken = firstString(body.access_token, body.accessToken);
      if (response.ok && accessToken) {
        const previous = this.last || this.load() || {};
        this.last = { ...previous, accessToken, refreshToken: firstString(body.refresh_token, refreshToken), expiry: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000) : null };
        // Do not write the refreshed plaintext token back. agy remains the owner
        // of its credential store; this process keeps the refreshed value in memory.
        return this.last;
      }
      if (response.status >= 500) break;
    }
    throw new LocalAgyAuthError('本地 agy 登录态刷新失败。', { code: 'local_agy_refresh_failed', status: lastStatus });
  }

  async get(signal, { forceRefresh = false } = {}) {
    const record = this.load() || this.last;
    if (!record) throw new LocalAgyAuthError('未找到本地 agy 登录态。请先在 agy/Antigravity 中完成登录。', { code: 'local_agy_auth_missing' });
    if (!forceRefresh && record.accessToken && (!record.expiry || record.expiry > new Date(Date.now() + 60_000))) return record;
    if (record.refreshToken) return this.refresh(signal, record.refreshToken);
    if (record.accessToken) return record;
    throw new LocalAgyAuthError('本地 agy 登录态没有可用 token。', { code: 'local_agy_auth_invalid' });
  }
}

module.exports = {
  LocalAgyAuthError,
  LocalAgyAuthProvider,
  TOKEN_ENDPOINT,
  discoverClientCredentials,
  defaultPaths,
  normalizeRecord
};
