'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ProxyAgent } = require('undici');

function invalid(message, status = 400) { return Object.assign(new Error(message), { status, code: 'proxy_management_error' }); }
function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('代理地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) {
    throw invalid('代理地址须为 HTTP/HTTPS URL，不支持路径、查询参数或片段。');
  }
  return url.href;
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw invalid('代理 ID 无效。');
  return value;
}

class ProxyManager {
  constructor({ configDir, fetchImpl = globalThis.fetch, agentFactory = (url) => new ProxyAgent(url) } = {}) {
    this.file = path.join(configDir, 'proxies.json');
    this.fetchImpl = fetchImpl;
    this.agentFactory = agentFactory;
    this.agents = new Map();
    this.checks = new Map();
    this.active = new Map();
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw invalid('无法读取代理配置；为防止绕过绑定，拒绝启动。', 500);
      this.state = { version: 1, proxies: [], bindings: {} };
    }
    if (this.state.version !== 1 || !Array.isArray(this.state.proxies) || !this.state.bindings || typeof this.state.bindings !== 'object' || Array.isArray(this.state.bindings)) throw invalid('代理配置格式错误。', 500);
    const ids = new Set();
    for (const proxy of this.state.proxies) {
      id(proxy.id); endpoint(proxy.url);
      if (ids.has(proxy.id)) throw invalid('代理 ID 重复。', 500);
      ids.add(proxy.id);
    }
    // Dangling bindings are retained and fail closed when used.
  }

  save(next) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
    this.state = next;
  }

  snapshot() {
    return {
      proxies: this.state.proxies.map((proxy) => {
        const url = new URL(proxy.url);
        return { id: proxy.id, name: proxy.name, endpoint: `${url.protocol}//${url.host}`, authenticated: Boolean(url.username || url.password),
          activeRequests: this.active.get(proxy.id) || 0, health: this.checks.get(proxy.id) || null };
      }),
      bindings: { ...this.state.bindings }
    };
  }

  upsert(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('代理配置须为 JSON 对象。');
    const proxyId = id(value.id || crypto.randomUUID());
    const old = this.state.proxies.find((p) => p.id === proxyId);
    if (this.active.get(proxyId)) throw invalid('代理仍有请求在途，请稍后重试。', 409);
    const proxy = { id: proxyId, name: String(value.name || old?.name || proxyId).trim().slice(0, 120), url: value.url ? endpoint(value.url) : old?.url };
    if (!proxy.url) throw invalid('请填写代理地址。');
    this.save({ ...this.state, proxies: [...this.state.proxies.filter((p) => p.id !== proxyId), proxy] });
    this.checks.delete(proxyId);
    if (old?.url !== proxy.url) this.retire(old?.url);
    return this.snapshot();
  }

  remove(proxyId) {
    const proxy = this.state.proxies.find((p) => p.id === proxyId);
    if (!proxy) throw invalid('代理不存在。', 404);
    if (Object.values(this.state.bindings).includes(proxyId) || this.active.get(proxyId)) throw invalid('代理仍被账号绑定或正在使用。', 409);
    this.save({ ...this.state, proxies: this.state.proxies.filter((p) => p.id !== proxyId) });
    this.checks.delete(proxyId); this.retire(proxy.url);
    return this.snapshot();
  }

  bind(accountId, proxyId) {
    if (typeof accountId !== 'string' || !accountId || ['__proto__', 'constructor', 'prototype'].includes(accountId)) throw invalid('账号 ID 无效。');
    const previous = this.state.bindings[accountId];
    if (this.active.get(previous)) throw invalid('账号代理仍有请求在途，请稍后重试。', 409);
    if (proxyId !== null && !this.state.proxies.some((p) => p.id === proxyId)) throw invalid('代理不存在。', 404);
    const bindings = { ...this.state.bindings };
    if (proxyId === null) delete bindings[accountId]; else bindings[accountId] = proxyId;
    this.save({ ...this.state, bindings });
    return this.snapshot();
  }

  retire(url) {
    if (!url || this.state.proxies.some((p) => p.url === url)) return;
    const agent = this.agents.get(url); this.agents.delete(url);
    if (agent) Promise.resolve(agent.close()).catch(() => {});
  }

  async via(proxy, input, init = {}, fetchImpl = this.fetchImpl) {
    let agent = this.agents.get(proxy.url);
    if (!agent) { agent = this.agentFactory(proxy.url); this.agents.set(proxy.url, agent); }
    this.active.set(proxy.id, (this.active.get(proxy.id) || 0) + 1);
    let released = false;
    const release = () => { if (!released) { released = true; this.active.set(proxy.id, Math.max(0, (this.active.get(proxy.id) || 1) - 1)); } };
    try {
      const response = await fetchImpl(input, { ...init, dispatcher: agent });
      // Keep the binding busy until the streaming body finishes, not just headers.
      if (!response.body) { release(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try { const { done, value } = await reader.read(); if (done) { release(); controller.close(); } else controller.enqueue(value); }
          catch (error) { release(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } }
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { release(); throw error; }
  }

  accountFetch(accountId, fetchImpl = this.fetchImpl) {
    return (input, init) => {
      const proxyId = this.state.bindings[accountId];
      if (!Object.hasOwn(this.state.bindings, accountId)) return fetchImpl(input, init);
      const proxy = this.state.proxies.find((p) => p.id === proxyId);
      if (!proxy) return Promise.reject(invalid('账号绑定代理不可用；未回落默认代理或直连。', 503));
      return this.via(proxy, input, init, fetchImpl);
    };
  }

  async check(proxyId) {
    const proxy = this.state.proxies.find((p) => p.id === proxyId);
    if (!proxy) throw invalid('代理不存在。', 404);
    const start = Date.now();
    let result;
    try {
      const response = await this.via(proxy, 'https://www.gstatic.com/generate_204', { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      await response.body?.cancel();
      result = { ok: response.status === 204, status: response.status, checkedAt: new Date().toISOString(), latencyMs: Date.now() - start };
    } catch { result = { ok: false, checkedAt: new Date().toISOString(), latencyMs: Date.now() - start, error: '代理连通性检测失败（网络或超时）。' }; }
    if (this.state.proxies.find((p) => p.id === proxyId)?.url === proxy.url) this.checks.set(proxyId, result);
    return result;
  }

  async close() { await Promise.allSettled([...this.agents.values()].map((agent) => agent.close())); this.agents.clear(); }
}

module.exports = { ProxyManager };
