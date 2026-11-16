'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { Readable } = require('node:stream');
const tls = require('node:tls');
const { AccountStoragePermissions } = require('./account-storage-permissions');

const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
const PASSWORD_MASK = '********';
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const DEFAULT_NO_PROXY = '127.0.0.1,localhost';

function captureInitialProxyEnv(env = process.env) {
  return Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, typeof env[key] === 'string' ? env[key] : undefined]));
}

const INITIAL_PROXY_ENV = captureInitialProxyEnv(process.env);

function cleanUrlString(url) {
  const formatted = url.toString();
  return url.pathname === '/' && !url.search && !url.hash ? formatted.replace(/\/$/, '') : formatted;
}

function validateProxyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/[\r\n\0]/.test(value)) throw new Error('代理地址不能包含控制字符。');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('代理地址格式无效，请使用如 http://127.0.0.1:7897 或 socks5://127.0.0.1:7897。'); }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('代理协议只支持 http://、https://、socks5:// 或 socks5h://，且必须包含主机名。');
  }
  return cleanUrlString(parsed);
}

function redactProxyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = PASSWORD_MASK;
    return cleanUrlString(parsed);
  } catch {
    return '';
  }
}

function hasProxyPassword(raw) {
  try { return Boolean(raw && new URL(raw).password); } catch { return false; }
}

function restoreMaskedPassword(nextUrl, previousUrl) {
  if (!nextUrl || !previousUrl) return nextUrl;
  try {
    const next = new URL(nextUrl);
    const prev = new URL(previousUrl);
    if (next.password === PASSWORD_MASK && prev.password
      && next.protocol === prev.protocol && next.hostname === prev.hostname
      && next.port === prev.port && next.username === prev.username) {
      next.password = prev.password;
      return cleanUrlString(next);
    }
  } catch { /* ignore */ }
  return nextUrl;
}

function normalizeNoProxy(value, fallback = DEFAULT_NO_PROXY) {
  if (value === undefined || value === null) return fallback;
  const cleaned = String(value).replace(/[\r\n\0]+/g, ',').split(',').map(item => item.trim()).filter(Boolean).join(',');
  return cleaned;
}

function shouldBypassProxy(targetUrl, noProxy) {
  const list = String(noProxy || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  if (list.includes('*')) return true;
  let host;
  let port;
  try {
    const parsed = new URL(targetUrl);
    host = parsed.hostname.toLowerCase();
    port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } catch { return false; }
  for (const rawRule of list) {
    const [ruleHost, rulePort] = rawRule.includes(':') && !rawRule.startsWith('[')
      ? [rawRule.slice(0, rawRule.lastIndexOf(':')), rawRule.slice(rawRule.lastIndexOf(':') + 1)]
      : [rawRule, ''];
    if (rulePort && rulePort !== port) continue;
    const domain = ruleHost.startsWith('.') ? ruleHost.slice(1) : ruleHost;
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function proxyAuthorizationHeader(proxyParsed) {
  if (!proxyParsed.username && !proxyParsed.password) return null;
  const creds = `${decodeURIComponent(proxyParsed.username || '')}:${decodeURIComponent(proxyParsed.password || '')}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

function openProxyConnectSocket(proxyParsed, targetHost, targetPort, signal) {
  const client = proxyParsed.protocol === 'https:' ? https : http;
  const proxyAuth = proxyAuthorizationHeader(proxyParsed);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const req = client.request({
      host: proxyParsed.hostname,
      port: Number(proxyParsed.port) || (proxyParsed.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {})
      }
    });
    function onAbort() {
      req.destroy();
      done(reject, signal?.reason || new DOMException('The request was aborted.', 'AbortError'));
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(reject, new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
        return;
      }
      done(resolve, socket);
    });
    req.on('error', error => done(reject, error));
    req.end();
  });
}

function incomingToResponse(incoming, targetUrl) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  const body = ['GET', 'HEAD'].includes(incoming.req?.method || 'GET') && (incoming.statusCode === 204 || incoming.statusCode === 304)
    ? null
    : Readable.toWeb(incoming);
  const response = new Response(body, {
    status: incoming.statusCode || 502,
    statusText: incoming.statusMessage || '',
    headers
  });
  Object.defineProperty(response, 'url', { value: targetUrl, enumerable: true });
  return response;
}

async function fetchThroughHttpProxy(targetUrl, proxyUrl, options = {}) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const { method = 'GET', headers: inputHeaders = {}, signal, body } = options;
  const headers = Object.fromEntries(new Headers(inputHeaders));
  const proxyAuth = proxyAuthorizationHeader(proxy);

  if (target.protocol === 'https:') {
    const port = Number(target.port) || 443;
    const rawSocket = await openProxyConnectSocket(proxy, target.hostname, port, signal);
    const bareHost = target.hostname.replace(/^\[|\]$/g, '');
    const tlsSocket = tls.connect({
      socket: rawSocket,
      ...(net.isIP(bareHost) ? {} : { servername: bareHost })
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn(val);
      };
      const req = https.request({
        hostname: target.hostname,
        port,
        path: target.pathname + target.search,
        method,
        headers,
        createConnection: () => tlsSocket
      }, res => done(resolve, incomingToResponse(res, targetUrl)));
      function onAbort() {
        req.destroy();
        tlsSocket.destroy();
        done(reject, signal?.reason || new DOMException('The request was aborted.', 'AbortError'));
      }
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', err => { tlsSocket.destroy(); done(reject, err); });
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
  }

  const client = proxy.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(val);
    };
    const req = client.request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method,
      path: targetUrl,
      headers: {
        ...headers,
        Host: target.host,
        ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {})
      }
    }, res => done(resolve, incomingToResponse(res, targetUrl)));
    function onAbort() {
      req.destroy();
      done(reject, signal?.reason || new DOMException('The request was aborted.', 'AbortError'));
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', err => done(reject, err));
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

class ProxyConfigManager {
  constructor({
    configDir,
    fsImpl = fs,
    env = process.env,
    initialEnv = INITIAL_PROXY_ENV,
    platform = process.platform,
    permissions,
    onApplied
  } = {}) {
    if (!configDir) throw new Error('ProxyConfigManager requires configDir');
    this.configDir = configDir;
    this.fs = fsImpl;
    this.env = env;
    this.initialEnv = { ...initialEnv };
    this.file = path.join(configDir, 'state', 'proxy.json');
    this.permissions = permissions || new AccountStoragePermissions({ fsImpl, platform });
    this.onApplied = typeof onApplied === 'function' ? onApplied : null;
    this.configured = false;
    this.current = this.#emptyConfig();
    this.load();
  }

  #emptyConfig() {
    return { enabled: false, proxyUrl: '', noProxy: DEFAULT_NO_PROXY, mediaUseProxy: false, updatedAt: '' };
  }

  load() {
    try {
      const stat = this.fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        this.configured = false;
        this.current = this.#emptyConfig();
        return;
      }
      this.permissions.file(this.file);
      const parsed = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      const proxyUrl = parsed?.proxyUrl ? validateProxyUrl(parsed.proxyUrl) : '';
      this.configured = true;
      this.current = {
        enabled: Boolean(parsed?.enabled && proxyUrl),
        proxyUrl,
        noProxy: normalizeNoProxy(parsed?.noProxy, DEFAULT_NO_PROXY),
        mediaUseProxy: Boolean(parsed?.mediaUseProxy),
        updatedAt: String(parsed?.updatedAt || '')
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.configured = false;
        this.current = this.#emptyConfig();
        return;
      }
      this.configured = false;
      this.current = this.#emptyConfig();
    }
  }

  effectiveEnvProxy() {
    if (this.configured) return this.current.enabled ? this.current.proxyUrl : '';
    return this.env.HTTPS_PROXY || this.env.https_proxy || this.env.HTTP_PROXY || this.env.http_proxy || '';
  }

  apply() {
    if (this.configured) {
      for (const key of PROXY_ENV_KEYS) delete this.env[key];
      if (this.current.enabled && this.current.proxyUrl) {
        this.env.HTTPS_PROXY = this.current.proxyUrl;
        this.env.https_proxy = this.current.proxyUrl;
        this.env.HTTP_PROXY = this.current.proxyUrl;
        this.env.http_proxy = this.current.proxyUrl;
        if (this.current.noProxy) {
          this.env.NO_PROXY = this.current.noProxy;
          this.env.no_proxy = this.current.noProxy;
        }
      }
    } else {
      for (const key of PROXY_ENV_KEYS) {
        if (this.initialEnv[key] !== undefined) this.env[key] = this.initialEnv[key];
        else delete this.env[key];
      }
    }
    this.onApplied?.(this.publicState());
  }

  save({ enabled = false, proxyUrl = '', noProxy = DEFAULT_NO_PROXY, mediaUseProxy = false } = {}) {
    const cleanNoProxy = normalizeNoProxy(noProxy, DEFAULT_NO_PROXY);
    const previousUrl = this.configured ? this.current.proxyUrl : this.effectiveEnvProxy();
    let cleanUrl = validateProxyUrl(restoreMaskedPassword(proxyUrl, previousUrl));
    if (enabled && !cleanUrl) {
      throw new Error('启用代理时必须填写有效的代理 URL。');
    }
    const next = {
      enabled: Boolean(enabled && cleanUrl),
      proxyUrl: cleanUrl,
      noProxy: cleanNoProxy,
      mediaUseProxy: Boolean(mediaUseProxy),
      updatedAt: new Date().toISOString()
    };
    const directory = path.dirname(this.file);
    this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.permissions.directory(directory);
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      this.fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      this.permissions.file(temporary);
      this.fs.renameSync(temporary, this.file);
      this.permissions.file(this.file);
    } finally {
      try { this.fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.configured = true;
    this.current = next;
    this.apply();
    return this.publicState();
  }

  reset() {
    try { this.fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.configured = false;
    this.current = this.#emptyConfig();
    this.apply();
    return this.publicState();
  }

  publicState() {
    const envProxy = this.initialEnv.HTTPS_PROXY || this.initialEnv.https_proxy
      || this.initialEnv.HTTP_PROXY || this.initialEnv.http_proxy || '';
    const envNoProxy = this.initialEnv.NO_PROXY || this.initialEnv.no_proxy || DEFAULT_NO_PROXY;
    const rawActive = this.effectiveEnvProxy();
    return {
      configured: this.configured,
      source: this.configured ? 'saved' : (envProxy ? 'environment' : 'none'),
      enabled: this.configured ? this.current.enabled : Boolean(envProxy),
      proxyUrl: redactProxyUrl(this.configured ? this.current.proxyUrl : envProxy),
      noProxy: this.configured ? this.current.noProxy : envNoProxy,
      mediaUseProxy: this.configured ? this.current.mediaUseProxy : false,
      hasPassword: hasProxyPassword(this.configured ? this.current.proxyUrl : envProxy),
      activeEffectiveProxy: redactProxyUrl(rawActive),
      updatedAt: this.configured ? this.current.updatedAt : ''
    };
  }

  async mediaFetch(url, options = {}) {
    const activeProxy = this.effectiveEnvProxy();
    const useForMedia = this.configured && this.current.enabled && this.current.mediaUseProxy && Boolean(activeProxy);
    if (!useForMedia) return globalThis.fetch(url, options);
    let parsedProxy;
    try { parsedProxy = new URL(activeProxy); } catch { return globalThis.fetch(url, options); }
    if (!['http:', 'https:'].includes(parsedProxy.protocol) || shouldBypassProxy(url, this.current.noProxy)) {
      return globalThis.fetch(url, options);
    }
    return fetchThroughHttpProxy(url, activeProxy, options);
  }
}

module.exports = {
  DEFAULT_NO_PROXY,
  PASSWORD_MASK,
  ProxyConfigManager,
  captureInitialProxyEnv,
  normalizeNoProxy,
  redactProxyUrl,
  shouldBypassProxy,
  validateProxyUrl
};
