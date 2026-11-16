'use strict';

const { importCockpitToolsAccounts, previewCockpitToolsImport } = require('./cockpit-tools-import');

const PROXY_ROUTE = '/dashboard/proxy';
const COCKPIT_SCAN_ROUTE = '/dashboard/accounts/cockpit-tools/scan';
const COCKPIT_IMPORT_ROUTE = '/dashboard/accounts/cockpit-tools/import';

async function readDashboardJsonBody(req, limit = 16 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw Object.assign(new Error('请求必须使用 JSON 格式。'), { status: 415, code: 'invalid_content_type' });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大。'), { status: 413, code: 'payload_too_large' });
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求体不是有效 JSON。'), { status: 400, code: 'invalid_json' }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象。'), { status: 400, code: 'invalid_json_object' });
  }
  return parsed;
}

/**
 * Handle Dashboard proxy configuration and Cockpit Tools one-click import routes.
 */
async function handleDashboardTools(req, res, route, requestUrl, {
  auth,
  proxyManager,
  accountStore,
  accountPool,
  quotaManager,
  onAccountsChanged,
  sendJson
}) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

  if (route === PROXY_ROUTE) {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { csrfToken: auth.csrfToken, ...proxyManager.publicState() }, headers);
        return true;
      }
      auth.checkCsrf(req.headers['x-dashboard-csrf']);
      if (req.method === 'POST') {
        const body = await readDashboardJsonBody(req);
        try {
          const state = proxyManager.save({
            enabled: body.enabled,
            proxyUrl: body.proxyUrl ?? body.httpsProxy ?? body.httpProxy ?? '',
            noProxy: body.noProxy,
            mediaUseProxy: body.mediaUseProxy
          });
          sendJson(res, 200, { csrfToken: auth.csrfToken, ...state }, headers);
        } catch (error) {
          sendJson(res, 400, { error: { type: 'invalid_proxy_config', message: error.message || '代理配置无效。' } }, headers);
        }
        return true;
      }
      if (req.method === 'DELETE') {
        const state = proxyManager.reset();
        sendJson(res, 200, { csrfToken: auth.csrfToken, ...state }, headers);
        return true;
      }
      sendJson(res, 405, { error: { type: 'method_not_allowed', message: '代理设置请求方法不受支持。' } }, headers);
    } catch (error) {
      sendJson(res, Number(error?.status) || 500, {
        error: { type: error?.code || 'dashboard_proxy_failed', message: error?.status ? error.message : '代理配置处理失败。' }
      }, headers);
    }
    return true;
  }

  if (route === COCKPIT_SCAN_ROUTE) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { type: 'method_not_allowed', message: '请使用 GET 扫描 Cockpit 账号。' } }, headers);
      return true;
    }
    try {
      const dataDir = String(requestUrl?.searchParams?.get('dataDir') || '').trim();
      const preview = previewCockpitToolsImport({ store: accountStore, dataDir });
      sendJson(res, 200, { csrfToken: auth.csrfToken, ...preview }, headers);
    } catch (error) {
      sendJson(res, Number(error?.status) || 500, {
        error: { type: error?.code || 'cockpit_scan_failed', message: error?.message || '扫描 Cockpit Tools 账号失败。' }
      }, headers);
    }
    return true;
  }

  if (route === COCKPIT_IMPORT_ROUTE) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { type: 'method_not_allowed', message: '请使用 POST 导入 Cockpit 账号。' } }, headers);
      return true;
    }
    try {
      auth.checkCsrf(req.headers['x-dashboard-csrf']);
      const body = await readDashboardJsonBody(req);
      const result = importCockpitToolsAccounts({
        store: accountStore,
        pool: accountPool,
        quotaManager,
        dataDir: String(body.dataDir || '').trim(),
        overwrite: body.overwrite === true,
        onImported: onAccountsChanged
      });
      sendJson(res, 200, { csrfToken: auth.csrfToken, ...result }, headers);
    } catch (error) {
      sendJson(res, Number(error?.status) || 500, {
        error: { type: error?.code || 'cockpit_import_failed', message: error?.status ? error.message : (error?.message || '导入 Cockpit Tools 账号失败。') }
      }, headers);
    }
    return true;
  }

  return false;
}

module.exports = {
  COCKPIT_IMPORT_ROUTE,
  COCKPIT_SCAN_ROUTE,
  PROXY_ROUTE,
  handleDashboardTools
};
