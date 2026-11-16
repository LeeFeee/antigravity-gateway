'use strict';

const crypto = require('node:crypto');
const { AccountStore } = require('./account-store');

const PROVIDER = 'gemini';
const AUTH_METHOD = 'gemini-oauth';

function geminiAccountId(value) {
  const subject = typeof value?.subjectId === 'string' ? value.subjectId.trim() : '';
  const email = typeof value?.email === 'string' ? value.email.trim().toLowerCase() : '';
  if (!subject || !email) throw new TypeError('Gemini 账号缺少经 Google 验证的身份信息。');
  return `gemini-account-${crypto.createHash('sha256').update(`gemini:${subject}`).digest('hex').slice(0, 24)}`;
}

class GeminiAccountStore extends AccountStore {
  constructor(options) {
    super({ ...options, directoryName: 'gemini-accounts' });
  }

  list() {
    // Only the new directory is read. Legacy Robin/Windows directories are
    // neither scanned nor migrated into this provider's OAuth account pool.
    return super.list().filter(account => account.providerType === PROVIDER
      && account.accountType === 'gemini-app' && account.authMethod === AUTH_METHOD
      && /^gemini-account-[a-f0-9]{24}$/.test(account.id));
  }

  save(value, options) {
    if (value?.providerType && value.providerType !== PROVIDER) throw new TypeError('不能将其他上游的凭据保存到 Gemini 账号池。');
    if (value?.authMethod && value.authMethod !== AUTH_METHOD) throw new TypeError('Gemini 账号必须通过看板 OAuth 流程添加。');
    const id = geminiAccountId(value);
    if (value.id && value.id !== id) throw new TypeError('Gemini 账号标识与已验证身份不一致。');
    const email = value.email.trim().toLowerCase();
    if (this.list().some(account => account.email.toLowerCase() === email && account.subjectId !== value.subjectId.trim())) {
      throw new TypeError('Gemini 同邮箱记录对应不同的 Google 身份，不能合并授权。');
    }
    return super.save({ ...value, id, providerType: PROVIDER, accountType: 'gemini-app', authMethod: AUTH_METHOD, projectId: '' }, options);
  }
}

module.exports = { GeminiAccountStore, geminiAccountId, PROVIDER, AUTH_METHOD };
