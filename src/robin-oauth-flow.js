'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { openBrowser } = require('./oauth-flow');
const { oauthClient, responseJson } = require('./robin-auth');
const { fetchRobinServerToken } = require('./robin-phenotype');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json';
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gemini',
  'https://www.googleapis.com/auth/flexible-api',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function callbackInput(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  try {
    const url = new URL(source);
    return {
      code: String(url.searchParams.get('code') || '').trim(),
      state: String(url.searchParams.get('state') || '').trim(),
      error: String(url.searchParams.get('error') || '').trim()
    };
  } catch {
    return { code: source, state: '', error: '' };
  }
}

class RobinOAuthFlow {
  constructor({ fetchImpl = globalThis.fetch, platform = process.platform, timeoutMs = 5 * 60_000, openBrowserImpl = openBrowser } = {}) {
    this.fetchImpl = fetchImpl;
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.openBrowserImpl = openBrowserImpl;
    this.active = null;
  }

  async start({ onReady } = {}) {
    if (this.active) throw new Error('已有 Gemini 账号授权正在进行，请先完成或取消。');
    // Reserve the flow before awaiting the callback listener/browser opener.
    // Two simultaneous callers must not create competing OAuth states.
    const active = {};
    this.active = active;
    const state = crypto.randomBytes(24).toString('hex');
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    let callback, timeout, browserTimeout;
    try {
      callback = await this.callbackServer(state);
      const redirectUri = `http://127.0.0.1:${callback.port}/oauth2callback`;
      const client = oauthClient();
      const url = `${AUTH_ENDPOINT}?${new URLSearchParams({
        access_type: 'offline', client_id: client.clientId,
        code_challenge: challenge, code_challenge_method: 'S256',
        include_granted_scopes: 'true', prompt: 'consent', redirect_uri: redirectUri,
        response_type: 'code', scope: SCOPES.join(' '), state
      })}`;
      const browserOpened = await Promise.race([
        Promise.resolve().then(() => this.openBrowserImpl(url, this.platform)).catch(() => false),
        new Promise(resolve => { browserTimeout = setTimeout(() => resolve(false), 1500); })
      ]);
      clearTimeout(browserTimeout);
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(new Error('Gemini 账号授权已超时，没有保存任何凭据。')), this.timeoutMs);
      timeout.unref?.();
      let submit;
      const manual = new Promise(resolve => { submit = value => resolve(callbackInput(value)); });
      Object.assign(active, { url, browserOpened, submit, close: callback.close });
      onReady?.({ url, browserOpened, submit });
      const selected = await Promise.race([
        callback.result,
        manual,
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
      ]);
      if (!selected) throw new Error('没有收到有效的 Gemini 授权回调。');
      if (selected.error) throw new Error(`Gemini 账号授权失败：${selected.error}`);
      if (selected.state && selected.state !== state) throw new Error('Gemini 授权回调状态不匹配。');
      if (!selected.code) throw new Error('Gemini 授权回调中没有授权码。');
      return await this.exchange(selected.code, redirectUri, verifier, client, controller.signal);
    } finally {
      clearTimeout(timeout);
      clearTimeout(browserTimeout);
      callback?.close();
      if (this.active === active) this.active = null;
    }
  }

  submit(value) {
    if (!this.active?.submit) return false;
    this.active.submit(value);
    return true;
  }

  async exchange(code, redirectUri, verifier, client, signal) {
    const tokenResponse = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });
    const token = await responseJson(tokenResponse, 'Gemini OAuth token 交换');
    if (!token.access_token || !token.refresh_token) throw new Error('Gemini OAuth 未返回完整的 access token 和 refresh token。');
    const userResponse = await this.fetchImpl(USERINFO_ENDPOINT, {
      signal,
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    const user = await responseJson(userResponse, 'Gemini 账号信息读取');
    if (!user.email) throw new Error('Gemini 账号信息中没有邮箱。');
    const serverToken = await fetchRobinServerToken(token.access_token, {
      fetchImpl: this.fetchImpl,
      signal
    });
    return {
      providerType: 'robin',
      accountType: 'gemini-app',
      email: String(user.email),
      subjectId: String(user.id || user.sub || ''),
      accessToken: String(token.access_token),
      refreshToken: String(token.refresh_token),
      expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : '',
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      authMethod: 'gemini-oauth',
      source: 'robin-oauth',
      planName: '',
      modeVariantId: '95a4c0abcba24364',
      capabilities: [],
      providerMetadata: {
        robinServerToken: serverToken,
        robinServerTokenFetchedAt: new Date().toISOString()
      },
      enabled: true,
      weight: 1
    };
  }

  callbackServer(expectedState) {
    return new Promise((resolve, reject) => {
      let settle;
      const result = new Promise((done) => { settle = done; });
      const server = http.createServer((req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end('Method not allowed'); return; }
        let url;
        try { url = new URL(req.url, 'http://127.0.0.1'); }
        catch { res.writeHead(400); res.end('Invalid callback URL'); return; }
        if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end('Not found'); return; }
        const value = callbackInput(`http://127.0.0.1${url.pathname}${url.search}`);
        if (value?.state !== expectedState) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<h1>Authorization failed</h1><p>State mismatch.</p>');
          return;
        }
        const ok = Boolean(value.code && !value.error);
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(ok
          ? '<h1>Gemini authorization complete</h1><p>You can close this page and return to the gateway.</p>'
          : '<h1>Gemini authorization failed</h1><p>Return to the gateway for details.</p>');
        settle(value);
      });
      const close = () => { try { server.close(); } catch { /* already closed */ } };
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve({ port: server.address().port, result, close });
      });
    });
  }
}

module.exports = { RobinOAuthFlow, SCOPES, callbackInput };
