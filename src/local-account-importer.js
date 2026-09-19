'use strict';

const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json';

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function sameIdentity(account, { subjectId, email }) {
  if (subjectId && account.subjectId && account.subjectId === subjectId) return true;
  return Boolean(email && account.email && account.email.toLowerCase() === email.toLowerCase());
}

class LocalAccountImporter {
  constructor({ provider, store, accountPool, fetchImpl } = {}) {
    this.provider = provider;
    this.store = store;
    this.accountPool = accountPool;
    this.fetchImpl = fetchImpl || provider?.fetchImpl || globalThis.fetch;
  }

  async importIfNew({ signal = AbortSignal.timeout(30_000) } = {}) {
    // This adapter only reads through the existing local agy provider. It does
    // not change how Keychain, Credential Manager, Secret Service, or official
    // session files are discovered and refreshed.
    if (!this.provider?.localAuth?.isConfigured?.()) return { status: 'missing' };
    const accessToken = await this.provider.access(signal);
    const response = await this.fetchImpl(USERINFO_ENDPOINT, {
      signal,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    let user = {};
    try { user = JSON.parse(await response.text() || '{}'); }
    catch { throw new Error('本地 agy 账号信息响应不是有效 JSON。'); }
    if (!response.ok) throw new Error(`本地 agy 账号信息读取失败：HTTP ${response.status}`);
    const identity = { subjectId: firstString(user.id, user.sub), email: firstString(user.email) };
    if (!identity.email) throw new Error('本地 agy 登录态没有返回账号邮箱。');

    const existing = this.store.list().find((account) => sameIdentity(account, identity));
    if (existing) return { status: 'existing', account: existing };

    const projectId = await this.provider.project(signal, accessToken);
    if (!projectId) throw new Error('本地 agy 登录态没有可用的 Antigravity project ID。');
    const local = this.provider.localAuth.last || {};
    const refreshToken = firstString(this.provider.refreshToken, local.refreshToken);
    if (!refreshToken) throw new Error('本地 agy 登录态没有可持久使用的 refresh token，未加入账号池。');
    const expiry = local.expiry instanceof Date && !Number.isNaN(local.expiry.valueOf())
      ? local.expiry.toISOString()
      : '';
    const saved = this.store.save({
      ...identity,
      accessToken,
      refreshToken,
      projectId,
      expiresAt: expiry,
      authMethod: local.authMethod || 'consumer',
      source: 'local-agy-import',
      enabled: true,
      weight: 1
    });
    this.accountPool.reload();
    return { status: 'imported', account: saved };
  }
}

module.exports = { LocalAccountImporter, sameIdentity };
