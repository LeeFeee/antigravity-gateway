'use strict';

const crypto = require('node:crypto');
const ROUTE = '/dashboard/accounts/antigravity/oauth';
const PENDING = new Set(['starting', 'waiting', 'processing']);

function fail(message, status = 400, code = 'account_authorization_invalid') {
  return Object.assign(new Error(message), { status, code });
}

// A dashboard adapter around the existing terminal OAuth flow. Credentials
// stay in the store; browser responses contain only progress and account identity.
class DashboardAccountAuth {
  constructor({ flow, store, pool, quotaManager, onAdded = () => {}, now = () => Date.now() }) {
    Object.assign(this, { flow, store, pool, quotaManager, onAdded, now });
    this.csrfToken = crypto.randomBytes(32).toString('hex');
    this.job = null;
    this.closed = false;
  }

  checkCsrf(value) {
    const actual = Buffer.from(String(value || ''));
    const expected = Buffer.from(this.csrfToken);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw fail('页面授权凭证已失效，请刷新面板后重试。', 403, 'dashboard_csrf_invalid');
    }
  }

  get(id) {
    const job = this.job;
    if (!job || job.id !== id || (!PENDING.has(job.status) && this.now() - job.finishedAt > 10 * 60_000)) {
      throw fail('这次授权已结束或网关已重启，请重新添加账号。', 404, 'account_authorization_missing');
    }
    return job;
  }

  snapshot(job) {
    return { id: job.id, status: job.status, expiresAt: job.expiresAt,
      ...(job.status === 'waiting' ? { url: job.url } : {}),
      ...(job.account ? { account: job.account } : {}), ...(job.message ? { message: job.message } : {}) };
  }

  async start(id = crypto.randomBytes(24).toString('hex')) {
    if (this.closed) throw fail('网关正在退出，请稍后重试。', 503, 'gateway_stopping');
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) throw fail('授权标识无效，请刷新面板。');
    if (this.job?.id === id) return this.snapshot(this.get(id));
    if ((this.job && PENDING.has(this.job.status)) || this.flow.active || this.flow.starting) {
      throw fail('已有 Antigravity 授权正在进行，请先完成或取消，再添加账号。', 409, 'account_authorization_busy');
    }
    const controller = new AbortController();
    const job = { id, status: 'starting', controller,
      expiresAt: new Date(this.now() + this.flow.timeoutMs).toISOString() };
    this.job = job;
    job.promise = Promise.resolve().then(() => this.flow.start({
      openBrowser: false, requireState: true, signal: controller.signal,
      onReady: ({ url }) => { job.url = url; job.status = 'waiting'; },
      onCode: () => { job.status = 'processing'; }
    })).then(account => {
      // Cancelling or shutting down during a token exchange must never save a late result.
      controller.signal.throwIfAborted();
      const saved = this.store.save(account);
      job.account = { id: saved.id, email: saved.email, providerType: 'cloudcode' };
      this.pool.reload();
      this.onAdded();
      job.status = 'completed';
      job.message = '账号已保存，已加入 Antigravity 账号池。';
      void Promise.resolve().then(() => this.quotaManager?.refreshAccount?.(saved.id,
        { force: true, summaryOnly: false })).catch(() => {});
    }).catch(error => {
      if (job.account) {
        job.status = 'completed';
        job.message = '账号已保存，请刷新面板查看账号池。';
        return;
      }
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      // Never echo token-exchange payloads or arbitrary upstream error strings.
      job.message = controller.signal.aborted ? '本次授权已取消，未保存账号。'
        : /无法从本地 agy 安装中发现 OAuth/.test(error.message) ? '网关所在设备缺少 agy OAuth 客户端配置，请先安装官方 agy 后重试。'
        : /授权已超时/.test(error.message) ? '授权已超时，未保存账号，请重新添加。'
        : '授权未完成，请重新添加，并确认该 Google 账号可以正常使用 Antigravity。';
    }).finally(() => { job.finishedAt = this.now(); job.url = ''; });
    return this.snapshot(job);
  }

  submit(id, callbackUrl) {
    const job = this.get(id);
    if (job.status !== 'waiting') throw fail('当前授权不再等待回调，请查看状态或重新添加。', 409);
    let url;
    try { url = new URL(callbackUrl); } catch { throw fail('请粘贴地址栏中的完整 localhost 回调 URL，而不是授权码。'); }
    const login = new URL(job.url);
    const redirect = new URL(login.searchParams.get('redirect_uri'));
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.port !== redirect.port || url.pathname !== redirect.pathname || url.username || url.password
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== login.searchParams.get('state')
      || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || url.searchParams.has('error')) {
      throw fail('回调 URL 与本次授权不匹配，请从本次 Google 登录完成后的地址栏重新复制完整链接。');
    }
    if (!this.flow.submit(url.href)) throw fail('授权已过期，请重新添加。', 409);
    job.status = 'processing';
    return this.snapshot(job);
  }

  async cancel(id) {
    const job = this.get(id);
    if (PENDING.has(job.status)) {
      job.controller.abort(new Error('Dashboard authorization cancelled'));
      await job.promise;
    }
    return this.snapshot(job);
  }

  async stop() {
    this.closed = true;
    if (this.job && PENDING.has(this.job.status)) await this.cancel(this.job.id);
  }
}

async function readAuthorizationBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw fail('授权请求必须使用 JSON。', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw fail('回调 URL 过长，请只粘贴地址栏链接。', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw fail('请求体不是有效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('请求体必须是 JSON 对象。');
  return value;
}

async function handleDashboardAccountAuth(req, res, route, auth, sendJson) {
  if (route !== ROUTE && !route.startsWith(ROUTE + '/')) return false;
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  try {
    if (route === ROUTE && req.method === 'GET') {
      sendJson(res, 200, { csrfToken: auth.csrfToken }, headers);
      return true;
    }
    auth.checkCsrf(req.headers['x-dashboard-csrf']);
    const match = route.slice(ROUTE.length).match(/^\/([a-f0-9]{48})(\/callback)?$/);
    if (route === ROUTE && req.method === 'POST') {
      const body = await readAuthorizationBody(req);
      sendJson(res, 202, await auth.start(body.id), headers);
    } else if (match && !match[2] && req.method === 'GET') {
      sendJson(res, 200, auth.snapshot(auth.get(match[1])), headers);
    } else if (match && !match[2] && req.method === 'DELETE') {
      sendJson(res, 200, await auth.cancel(match[1]), headers);
    } else if (match?.[2] && req.method === 'POST') {
      const body = await readAuthorizationBody(req);
      sendJson(res, 202, auth.submit(match[1], body.callbackUrl), headers);
    } else throw fail('授权请求方法或路径不受支持。', 405);
  } catch (error) {
    sendJson(res, error.status || 500, { error: { type: error.code || 'account_authorization_failed',
      message: error.status ? error.message : '账号授权请求失败，请刷新面板后重试。' } }, headers);
  }
  return true;
}

module.exports = { DashboardAccountAuth, handleDashboardAccountAuth, ROUTE };
