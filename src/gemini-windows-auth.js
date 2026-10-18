'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { WINDOWS_USER_AGENT } = require('./gemini-windows-protocol');
const { robinAuthorizationKey, robinCredentialFingerprint } = require('./robin-auth');

const GEMINI_ORIGIN = 'https://gemini.google.com';
const COOKIE_NAMES = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'SIDCC',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-1PSIDCC', '__Secure-3PSIDCC', '__Secure-STRP']);

function windowsAuthError(message, status = 401) {
  const error = new Error(message); error.status = status; error.code = 'gemini_windows_auth_error'; return error;
}

function normalizeCookies(input, now = Date.now()) {
  if (!Array.isArray(input)) throw windowsAuthError('Windows Gemini 授权缺少 Cookie 列表。');
  const unique = new Map();
  for (const item of input) {
    const domain = String(item?.domain || '').replace(/^\./, '').toLowerCase();
    if (!COOKIE_NAMES.has(item?.name) || domain !== 'google.com' || (item.path && item.path !== '/')) continue;
    const value = String(item.value || '');
    if (!value || value.length > 16384 || /[\x00-\x20\x7f;,]/.test(value)) continue;
    const expires = Number(item.expires ?? -1);
    if (expires !== -1 && (!Number.isFinite(expires) || expires * 1000 <= now)) continue;
    unique.set(item.name, { name: item.name, value, domain: '.google.com', path: '/', expires, secure: true });
  }
  const cookies = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!cookies.some(c => ['SAPISID', '__Secure-3PAPISID'].includes(c.name))
      || !cookies.some(c => ['SID', '__Secure-1PSID', '__Secure-3PSID'].includes(c.name))) {
    throw windowsAuthError('Windows Gemini 登录态不完整或已过期，请重新添加 Windows Gemini 账号。');
  }
  return cookies;
}

function cookieHeader(cookies) { return normalizeCookies(cookies).map(c => `${c.name}=${c.value}`).join('; '); }

function windowsAuthorization(cookies, now = Date.now()) {
  const values = new Map(normalizeCookies(cookies, now).map(c => [c.name, c.value]));
  const time = Math.floor(now / 1000);
  return [
    ['SAPISIDHASH', values.get('SAPISID') || values.get('__Secure-3PAPISID')],
    ['SAPISID1PHASH', values.get('__Secure-1PAPISID')],
    ['SAPISID3PHASH', values.get('__Secure-3PAPISID')]
  ].filter(([, value]) => value).map(([name, value]) => `${name} ${time}_${
    crypto.createHash('sha1').update(`${time} ${value} ${GEMINI_ORIGIN}`).digest('hex')}`).join(' ');
}

function rotatedCookies(cookies, headers = []) {
  const byName = new Map(cookies.map(c => [c.name, c]));
  for (const header of headers) {
    const [pair, ...attributes] = header.split(';'); const i = pair.indexOf('=');
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    const attrs = Object.fromEntries(attributes.map(a => { const [k, ...v] = a.trim().split('='); return [k.toLowerCase(), v.join('=')]; }));
    if (!COOKIE_NAMES.has(name) || String(attrs.domain || '').replace(/^\./, '') !== 'google.com') continue;
    const expires = attrs['max-age'] !== undefined ? Date.now() / 1000 + Number(attrs['max-age'])
      : attrs.expires ? Date.parse(attrs.expires) / 1000 : -1;
    byName.set(name, { name, value, domain: '.google.com', path: attrs.path || '/', expires, secure: true });
  }
  return normalizeCookies([...byName.values()]);
}

function parseBootstrap(html) {
  const match = html.match(/WIZ_global_data\s*=\s*({[\s\S]*?});/);
  let data; try { data = match && JSON.parse(match[1]); } catch { /* reported below */ }
  if (!data || typeof data.oPEP7c !== 'string' || !data.oPEP7c.includes('@') || !data.S06Grb) {
    throw windowsAuthError('Windows Gemini 登录已失效，请重新登录该账号。');
  }
  if (data.GK6dn !== 'https://geminiweb-pa.clients6.google.com') throw windowsAuthError('Windows Gemini 返回了未支持的服务地址。', 502);
  if (!data.PI9WOb || !data.d2zJAe || !data.cfb2h) throw windowsAuthError('Windows Gemini 页面缺少请求初始化数据。', 502);
  return { email: data.oPEP7c, subjectId: String(data.S06Grb), serverToken: data.PI9WOb,
    apiKey: data.d2zJAe, build: data.cfb2h, endpoint: `${data.GK6dn}/v1/processSession` };
}

// Gemini's response headers can exceed Node fetch's default 16 KiB limit.
// Bound both headers and body; redirects may retain cookies only on this origin.
function fetchWindowsBootstrap(cookies, { signal, requestImpl = https.get, authUser = '0' } = {}) {
  if (!/^\d{1,3}$/.test(String(authUser))) throw windowsAuthError('无效的 Google 账号索引。', 400);
  const initial = new URL(authUser === '0' ? '/app' : `/app?authuser=${authUser}`, GEMINI_ORIGIN);
  const load = (target, redirects = 0) => new Promise((resolve, reject) => {
    const request = requestImpl(target, { signal, maxHeaderSize: 256 * 1024,
      headers: { Cookie: cookieHeader(cookies), 'User-Agent': WINDOWS_USER_AGENT } }, response => {
      if (response.statusCode !== 200) {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
          const next = new URL(response.headers.location, target);
          if (next.origin === GEMINI_ORIGIN && !next.username && !next.password) {
            response.resume(); resolve(load(next, redirects + 1)); return;
          }
        }
        response.resume(); reject(windowsAuthError(`Windows Gemini 登录检查失败：HTTP ${response.statusCode}。`, response.statusCode === 429 ? 429 : 401)); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) request.destroy(windowsAuthError('Windows Gemini 初始化页面超过限制。', 502));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ ...parseBootstrap(Buffer.concat(chunks).toString('utf8')),
          cookies: rotatedCookies(cookies, response.headers['set-cookie'] || []) }); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
  return load(initial);
}

class GeminiWindowsAuthProvider {
  constructor({ account, store, bootstrap = fetchWindowsBootstrap } = {}) {
    this.account = account; this.store = store; this.bootstrap = bootstrap;
    this.authorizationKey = robinAuthorizationKey(account); this.disabled = false;
    this.cached = null; this.pending = null;
  }
  disable() { this.disabled = true; this.controller?.abort(); this.cached = null; }
  matchesAuthorization(key, account) {
    return !this.disabled && key === this.authorizationKey && robinAuthorizationKey(account) === robinAuthorizationKey(this.account);
  }
  async get(signal) {
    signal?.throwIfAborted();
    if (this.disabled) throw windowsAuthError('Windows Gemini 账号已停用。');
    if (this.cached && this.cached.until > Date.now()) return this.record();
    if (!this.pending) {
      this.controller = new AbortController();
      const expected = robinAuthorizationKey(this.account);
      const settings = this.account.providerMetadata.geminiWindows;
      this.pending = this.bootstrap(settings.cookies, {
        authUser: settings.authUser || '0', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)])
      }).then(result => {
        if (result.subjectId !== this.account.subjectId || result.email.toLowerCase() !== this.account.email.toLowerCase()) {
          throw windowsAuthError('Windows Gemini 当前登录账号与网关保存账号不一致，请重新添加账号。');
        }
        const latest = this.store.list().find(a => a.id === this.account.id);
        if (this.disabled || !latest || robinAuthorizationKey(latest) !== expected) throw windowsAuthError('Windows Gemini 授权已更换或删除。');
        this.account = this.store.update(latest.id, { providerMetadata: { ...latest.providerMetadata,
          geminiWindows: { ...latest.providerMetadata.geminiWindows, cookies: result.cookies } } });
        this.cached = { ...result, until: Date.now() + 5 * 60_000 };
      }).finally(() => { this.pending = null; });
    }
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    return this.record();
  }
  record() {
    if (this.disabled) throw windowsAuthError('Windows Gemini 账号已停用。');
    const settings = this.account.providerMetadata.geminiWindows;
    return { ...this.cached, cookies: normalizeCookies(settings.cookies), authUser: settings.authUser || '0',
      instanceId: settings.instanceId, credentialFingerprint: robinCredentialFingerprint(this.account) };
  }
}

module.exports = { GeminiWindowsAuthProvider, cookieHeader, fetchWindowsBootstrap, normalizeCookies,
  parseBootstrap, rotatedCookies, windowsAuthorization, windowsAuthError };
