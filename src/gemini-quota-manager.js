'use strict';

const { QuotaManager } = require('./quota-manager');
const { geminiQuotaProtection } = require('./account-scheduling');

// Reuse the existing queue, affinity/ranking facts, refresh cadence and reserve
// policy. Only the source of quota facts and their persistence namespace differ.
// No Antigravity project/catalog/credit endpoint is used for Gemini accounts.
class GeminiQuotaManager extends QuotaManager {
  constructor(options = {}) {
    if (options.accountPool?.providerType !== 'gemini') throw new TypeError('Gemini quota requires its own account pool');
    super({ ...options, snapshotFile: 'gemini-quota.json' });
  }

  async refreshEntry(entry, _summaryOnly, provider) {
    const accountId = entry.account.id;
    const isCurrent = () => this.currentEntry(accountId)?.provider === provider
      && this.usableEntry(this.currentEntry(accountId));
    if (!isCurrent()) return null;
    try {
      const quota = await provider.getQuota(AbortSignal.timeout(30_000));
      if (!isCurrent()) return null;
      if (quota?.providerType !== 'gemini' || quota.source !== 'GetUsageInfo' || !Array.isArray(quota.groups)) {
        throw Object.assign(new Error('Gemini 额度响应来源或结构无效。'), { code: 'gemini_quota_invalid', status: 502 });
      }
      const now = this.now(), observedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + this.intervalMs).toISOString();
      const protection = geminiQuotaProtection(quota, this.protection(accountId), observedAt);
      const snapshot = {
        ...quota, accountId, observedAt, expiresAt, groupsObservedAt: observedAt, groupsExpiresAt: expiresAt,
        // GXU is shared usage. Never invent separate model balances or a plan
        // name from userTier, and preserve unknown windows as unknown.
        models: {}, modelSpecific: false,
        available: quota.groups.some(group => group.available === false) ? false
          : quota.groups.length && quota.groups.every(group => group.available === true) ? true : null,
        geminiQuotaProtection: protection
      };
      this.snapshots[accountId] = snapshot;
      this.protections.set(accountId, protection);
      if (!this.refreshing) this.save();
      return snapshot;
    } catch (error) {
      if (isCurrent()) {
        const previous = this.snapshots[accountId] || { accountId, providerType: 'gemini', source: 'GetUsageInfo',
          groups: [], models: {}, modelSpecific: false, available: null };
        // A failed query does not refresh old quota or release a known reserve.
        // The display gets a bounded diagnostic, never raw upstream payloads.
        this.snapshots[accountId] = { ...previous, lastRefreshFailedAt: new Date(this.now()).toISOString(),
          lastRefreshError: { code: 'gemini_quota_refresh_failed', status: Number(error?.status) || 502 } };
        // The inherited batch persists successful results only. Persist this
        // diagnostic here even when every account in the batch failed.
        this.save();
        // Optional quota permission errors are not proof that inference is
        // denied. Only an actual authentication failure quarantines here.
        if (Number(error?.status) === 401) this.accountPool.observeAccountFailure?.(this.currentEntry(accountId), error,
          { source: 'gemini_quota_refresh' });
      }
      throw error;
    }
  }
}

module.exports = { GeminiQuotaManager };
