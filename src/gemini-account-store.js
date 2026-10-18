'use strict';

const { AccountStore } = require('./account-store');

const isWindowsAccount = account => account?.authMethod === 'gemini-windows-session';

// One existing Gemini scheduler, two independent credential directories. The
// account's saved authorization type selects transport, never the host OS.
class GeminiAccountStore {
  constructor({ configDir } = {}) {
    this.oauth = new AccountStore({ configDir, directoryName: 'robin-accounts' });
    this.windows = new AccountStore({ configDir, directoryName: 'gemini-win-accounts' });
    this.directory = this.oauth.directory; // Keep the 1.5.1 scheduler state path.
  }

  list() {
    return [
      ...this.oauth.list().filter(account => !isWindowsAccount(account)),
      ...this.windows.list().filter(isWindowsAccount)
    ];
  }

  save(account) {
    return (isWindowsAccount(account) ? this.windows : this.oauth).save(account);
  }

  update(id, updates) {
    const account = this.list().find(item => item.id === id);
    if (!account) throw new Error(`找不到 Gemini 账号: ${id}`);
    // An ordinary health/cookie update cannot change the credential's channel.
    return this.save({ ...account, ...updates, id, createdAt: account.createdAt, authMethod: account.authMethod });
  }

  delete(id) {
    const account = this.list().find(item => item.id === id);
    return account ? (isWindowsAccount(account) ? this.windows : this.oauth).delete(id) : null;
  }
}

module.exports = { GeminiAccountStore, isWindowsAccount };
