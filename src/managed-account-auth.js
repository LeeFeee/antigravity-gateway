'use strict';

const { LocalAgyAuthProvider } = require('./local-agy-auth');

function authRecord(account) {
  return {
    accessToken: account.accessToken || '',
    refreshToken: account.refreshToken || '',
    expiry: account.expiresAt ? new Date(account.expiresAt) : null,
    projectId: account.projectId || '',
    authMethod: account.authMethod || 'consumer',
    sourcePath: `managed-account:${account.id}`
  };
}

class ManagedAccountAuthProvider {
  constructor({ account, store, fetchImpl = globalThis.fetch, agyPath = '' }) {
    this.account = account;
    this.store = store;
    this.provider = new LocalAgyAuthProvider({
      fetchImpl,
      agyPath,
      clientCredentials: account.clientId && account.clientSecret
        ? [{ clientId: account.clientId, clientSecret: account.clientSecret }]
        : [],
      useKeychain: false,
      authFile: '__managed_account__'
    });
    this.provider.paths = [];
    this.provider.last = authRecord(account);
  }

  isConfigured() { return true; }

  load() { return this.provider.last; }

  async get(signal, options) {
    const before = this.provider.last;
    const record = await this.provider.get(signal, options);
    if (record !== before || record.accessToken !== this.account.accessToken || record.refreshToken !== this.account.refreshToken) {
      this.account = this.store.save({
        ...this.account,
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        expiresAt: record.expiry instanceof Date ? record.expiry.toISOString() : '',
        projectId: record.projectId || this.account.projectId,
        clientId: this.account.clientId,
        clientSecret: this.account.clientSecret,
        authMethod: record.authMethod || this.account.authMethod
      });
    }
    return record;
  }
}

module.exports = { ManagedAccountAuthProvider };
