'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { discoverClientCredentials } = require('./local-agy-auth');
const { cliUserAgent, AGY_OAUTH_PROFILE } = require('./agy-request-profile');
const { nativeCloudCodeFetch } = require('./agy-native-transport');

const AUTH_ENDPOINT = AGY_OAUTH_PROFILE.authorizationEndpoint;
const TOKEN_ENDPOINT = AGY_OAUTH_PROFILE.tokenEndpoint;
const USERINFO_ENDPOINT = AGY_OAUTH_PROFILE.userinfoEndpoint;
const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';
const API_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
const ONBOARD_USER_ENDPOINT = `${API_BASE_URL}/v1internal:onboardUser`;
const BASE_URLS = [API_BASE_URL];
const CALLBACK_PORT = 51121;
const PREFERRED_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const SCOPES = AGY_OAUTH_PROFILE.scopes;

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function openBrowser(url, platform = process.platform) {
  const command = platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? 'powershell.exe' : 'xdg-open';
  const args = platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${String(url).replaceAll("'", "''")}'`]
    : [url];
  return new Promise((resolve) => {
    const child = execFile(command, args, { windowsHide: true }, (error) => resolve(!error));
    child.unref?.();
  });
}

function callbackInput(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  try {
    const url = new URL(source);
    return {
      code: firstString(url.searchParams.get('code')),
      state: firstString(url.searchParams.get('state')),
      error: firstString(url.searchParams.get('error'))
    };
  } catch {
    return { code: source, state: '', error: '' };
  }
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text || '{}'); } catch { throw new Error(`${label}返回了无效 JSON。`); }
  if (!response.ok) throw new Error(`${label}失败：${firstString(body.error_description, body.error?.message, body.error, body.message) || `HTTP ${response.status}`}`);
  return body;
}

function extractProject(body) {
  const value = body?.cloudaicompanionProject ?? body?.projectId ?? body?.project;
  if (typeof value === 'string') return value.trim();
  return firstString(value?.id, value?.projectId, value?.project_id);
}

function defaultTierId(body) {
  const tiers = Array.isArray(body?.allowedTiers) ? body.allowedTiers : [];
  const selected = tiers.find((tier) => tier?.isDefault === true && firstString(tier?.id));
  return firstString(selected?.id, body?.currentTier?.id) || 'free-tier';
}

function operationUrl(name) {
  // The observed operation name is relative, e.g. operations/<id>. Never
  // turn an upstream-controlled string into an arbitrary credentialed URL.
  const value = firstString(name);
  if (!/^operations\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(value)) {
    throw new Error('Antigravity 初始化没有返回可识别的 operation 标识。');
  }
  return `${API_BASE_URL}/v1internal/${value}`;
}

function wait(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new Error('账号授权已取消。'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

class OAuthFlow {
  constructor({
    fetchImpl = nativeCloudCodeFetch,
    agyPath = '',
    platform = process.platform,
    timeoutMs = 5 * 60_000,
    clientCredentials = [],
    openBrowserImpl = openBrowser,
    onboardAttempts = 5,
    onboardPollMs = 2000
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.agyPath = agyPath;
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.clientCredentials = clientCredentials;
    this.openBrowserImpl = openBrowserImpl;
    this.onboardAttempts = onboardAttempts;
    this.onboardPollMs = onboardPollMs;
    this.active = null;
  }

  async start(options = {}) {
    if (this.active || this.starting) throw new Error('已有账号授权正在进行，请先完成或取消当前授权。');
    this.starting = true;
    try { return await this._start(options); }
    finally { this.starting = false; }
  }

  async _start({ onReady, onCode, openBrowser: launchBrowser = true, signal, requireState = true } = {}) {
    signal?.throwIfAborted();
    const candidates = this.clientCredentials.length ? this.clientCredentials : discoverClientCredentials({ agyPath: this.agyPath });
    // agy currently embeds more than one historical OAuth client. The
    // official local session and the maintained Antigravity login flow use
    // this client; choosing the first arbitrary binary string can authorize
    // Google successfully but fail to provision an Antigravity project.
    const credential = candidates.find((candidate) => candidate.clientId === PREFERRED_OAUTH_CLIENT_ID) || candidates[0];
    if (!credential) throw new Error('无法从本地 agy 安装中发现 OAuth 客户端配置。');
    const state = crypto.randomBytes(24).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const callback = await this._callbackServer(state, { requireState });
    const redirectUri = `http://localhost:${callback.port}/oauth-callback`;
    const params = new URLSearchParams({
      access_type: 'offline', client_id: credential.clientId, prompt: 'consent', redirect_uri: redirectUri,
      response_type: 'code', scope: SCOPES.join(' '), state,
      code_challenge: codeChallenge, code_challenge_method: 'S256'
    });
    params.sort();
    const url = `${AUTH_ENDPOINT}?${params}`;
    // A locked-down desktop can leave the operating-system browser launcher
    // hanging. Never delay printing the complete manual URL for that reason.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('账号授权已超时，没有保存任何凭据。请从看板重新发起授权。')), this.timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort(signal.reason || new Error('账号授权已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
    let submit;
    const manual = new Promise((resolve) => { submit = (value) => resolve(callbackInput(value)); });
    const active = { url, browserOpened: false, submit, close: callback.close };
    this.active = active;
    try {
      if (signal?.aborted) abort();
      controller.signal.throwIfAborted();
      let openerTimeout;
      try {
        active.browserOpened = launchBrowser && await Promise.race([
          Promise.resolve().then(() => this.openBrowserImpl(url, this.platform)).catch(() => false),
          new Promise(resolve => { openerTimeout = setTimeout(() => resolve(false), 1500); })
        ]);
      } finally { clearTimeout(openerTimeout); }
      controller.signal.throwIfAborted();
      onReady?.({ url, browserOpened: active.browserOpened, submit });
      controller.signal.throwIfAborted();
      const selected = await Promise.race([
        callback.result,
        manual,
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
      ]);
      if (!selected) throw new Error('没有收到有效的授权回调。');
      if (selected.error) throw new Error(`账号授权失败：${selected.error}`);
      if ((requireState || selected.state) && selected.state !== state) throw new Error('账号授权回调状态不匹配。');
      if (!selected.code) throw new Error('账号授权回调中没有授权码。');
      onCode?.();
      const account = await this._exchange(
        selected.code,
        redirectUri,
        candidates.filter((candidate) => candidate.clientId === credential.clientId),
        controller.signal,
        codeVerifier
      );
      return account;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      callback.close();
      if (this.active === active) this.active = null;
    }
  }

  submit(value) {
    if (!this.active) return false;
    this.active.submit(value);
    return true;
  }

  async _exchange(code, redirectUri, credentials, signal, codeVerifier) {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier || '')) throw new Error('OAuth PKCE 会话已失效，请从看板重新授权。');
    let token;
    let tokenCredential;
    let lastError;
    for (const credential of credentials) {
      signal?.throwIfAborted();
      try {
        const form = new URLSearchParams({
          code, code_verifier: codeVerifier, client_id: credential.clientId, client_secret: credential.clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code'
        });
        form.sort();
        const tokenResponse = await this.fetchImpl(TOKEN_ENDPOINT, {
          method: 'POST', signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': AGY_OAUTH_PROFILE.userAgent },
          body: form
        });
        token = await responseJson(tokenResponse, 'OAuth token 交换');
        tokenCredential = credential;
        break;
      } catch (error) { lastError = error; }
    }
    if (!token) throw lastError || new Error('OAuth token 交换失败。');
    const accessToken = firstString(token.access_token, token.accessToken);
    const refreshToken = firstString(token.refresh_token, token.refreshToken);
    if (!accessToken || !refreshToken) throw new Error('OAuth 未返回完整的 access token 和 refresh token。');

    const userResponse = await this.fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': AGY_OAUTH_PROFILE.userAgent }, signal
    });
    const user = await responseJson(userResponse, 'Google 账号信息读取');
    const email = firstString(user.email);
    const subjectId = firstString(user.id, user.sub);
    if (!email) throw new Error('Google 账号信息中没有邮箱。');

    let projectId = '';
    let loadBody = null;
    let loadError = null;
    for (const base of BASE_URLS) {
      try {
        const response = await this.fetchImpl(`${base}${LOAD_CODE_ASSIST_PATH}`, {
          method: 'POST', signal,
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            'user-agent': cliUserAgent()
          },
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
        });
        const body = await responseJson(response, 'Antigravity 项目发现');
        loadBody = body;
        projectId = extractProject(body);
        if (projectId) break;
        // A successful first-login response may only contain tier choices.
        // Preserve it for onboardUser instead of treating it as a failure.
        if (Array.isArray(body?.allowedTiers) || body?.currentTier) break;
      } catch (error) {
        loadError = error;
      }
    }
    if (!projectId && loadBody) {
      projectId = await this._onboard(accessToken, defaultTierId(loadBody), signal);
      if (!projectId) projectId = await this._pollProject(accessToken, signal);
    }
    if (!projectId) {
      throw loadError || new Error('Google OAuth 授权已完成，但 Antigravity 没有为该账号返回 project ID，因此账号尚未添加。请确认该账号能够在官方 Antigravity 中正常使用后从看板重新授权。');
    }
    return {
      email, subjectId, accessToken, refreshToken, projectId,
      clientId: tokenCredential.clientId,
      clientSecret: tokenCredential.clientSecret,
      expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : '',
      authMethod: 'consumer', source: 'manual-oauth', enabled: true, weight: 1
    };
  }

  async _onboard(accessToken, tierId, signal) {
    const headers = { authorization: `Bearer ${accessToken}`, 'user-agent': cliUserAgent() };
    signal?.throwIfAborted();
    const response = await this.fetchImpl(ONBOARD_USER_ENDPOINT, {
      method: 'POST', signal,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ tierId, metadata: { ideType: 'ANTIGRAVITY' } })
    });
    let body = await responseJson(response, 'Antigravity 账号初始化');
    let name = firstString(body?.name);
    const attempts = Math.max(1, Math.trunc(this.onboardAttempts) || 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      signal?.throwIfAborted();
      if (body?.error) throw new Error(`Antigravity 账号初始化失败：${firstString(body.error.message) || 'operation 返回错误'}`);
      if (body?.done === true) {
        // Some successful onboarding operations only acknowledge completion.
        // Confirm the project through loadCodeAssist if the response omits it.
        return extractProject(body?.response);
      }
      const target = operationUrl(name);
      if (attempt === attempts) break;
      await wait(this.onboardPollMs, signal);
      const poll = await this.fetchImpl(target, { method: 'GET', headers, signal });
      body = await responseJson(poll, 'Antigravity 初始化进度查询');
      name = firstString(body?.name, name);
    }
    throw new Error(`Antigravity 账号初始化在 ${attempts} 次状态检查后仍未完成。`);
  }

  async _pollProject(accessToken, signal) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.onboardAttempts; attempt += 1) {
      for (const base of BASE_URLS) {
        try {
          const response = await this.fetchImpl(`${base}${LOAD_CODE_ASSIST_PATH}`, {
            method: 'POST', signal,
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
              'user-agent': cliUserAgent()
            },
            body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
          });
          const body = await responseJson(response, 'Antigravity 项目确认');
          const projectId = extractProject(body);
          if (projectId) return projectId;
        } catch (error) {
          lastError = error;
        }
      }
      if (attempt < this.onboardAttempts) await wait(this.onboardPollMs, signal);
    }
    if (lastError) throw lastError;
    return '';
  }

  _callbackServer(expectedState, { requireState = true } = {}) {
    return new Promise((resolve, reject) => {
      let settle;
      const result = new Promise((done) => { settle = done; });
      const server = http.createServer((req, res) => {
        let url;
        try { url = new URL(req.url, 'http://localhost'); }
        catch { res.writeHead(400); res.end('Invalid URL'); return; }
        if (url.pathname !== '/oauth-callback') { res.writeHead(404); res.end('Not found'); return; }
        if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
        const value = callbackInput(`http://localhost${url.pathname}${url.search}`);
        if ((requireState || value?.state) && value?.state !== expectedState) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<h1>Authorization failed</h1><p>State mismatch. Return to the dashboard.</p>');
          return;
        }
        res.writeHead(value?.code && !value?.error ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(value?.code && !value?.error
          ? '<h1>Authorization complete</h1><p>You can close this page and return to Antigravity Gateway.</p>'
          : '<h1>Authorization failed</h1><p>Return to the dashboard for details.</p>');
        settle(value);
      });
      const listen = (port, allowFallback) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          if (allowFallback && error.code === 'EADDRINUSE') listen(0, false);
          else reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve({
            port: server.address().port,
            result,
            close: () => server.close(() => {})
          });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      };
      listen(CALLBACK_PORT, true);
    });
  }
}

module.exports = { OAuthFlow, callbackInput, defaultTierId, extractProject, operationUrl, openBrowser };
