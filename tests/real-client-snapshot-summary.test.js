'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { copyManagedState, accountSnapshot, STATE_FILES } = require('../scripts/verify-real-client-gateway');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-summary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'private-project-config'), target = path.join(root, 'copy');
  fs.mkdirSync(path.join(source, 'accounts'), { recursive: true }); fs.mkdirSync(path.join(source, 'state'));
  const observedAt = '2026-11-07T00:00:00.000Z', health = {}, quota = {};
  // Deliberately create out of order: anonymous labels follow filename order.
  for (const index of [3, 1, 4, 2]) {
    const id = `private-owner-${index}`;
    fs.writeFileSync(path.join(source, 'accounts', `${index}-private@example.invalid.json`), JSON.stringify({
      id, email: `private${index}@example.invalid`, accessToken: `private-access-${index}`, refreshToken: `private-refresh-${index}`,
      enabled: index !== 3, updatedAt: `2026-11-07T00:0${index}:00.000Z`, expiresAt: '2026-11-08T00:00:00.000Z'
    }));
    if (index > 1) health[id] = { state: ['authentication_error', 'verification_required', 'access_denied'][index - 2],
      accountFingerprint: `private-persisted-fingerprint-${index}`, since: '2026-11-06T00:00:00.000Z' };
    quota[id] = { observedAt, groupsObservedAt: observedAt, modelsExpiresAt: '2026-11-07T00:05:00.000Z',
      models: { 'gemini-3.1-flash-image': { remainingFraction: index === 4 ? false : (index - 1) / 10,
        available: index > 1, resetTime: '2026-11-07T03:00:00.000Z' }, 'claude-sonnet-4-6': { remainingFraction: 1 } },
      geminiQuotaProtection: { protected: true, fastRefresh: false, fiveHour: { protected: false, remainingFraction: 0.5, observedAt },
        weekly: { protected: true, remainingFraction: 0.04, observedAt } } };
  }
  fs.writeFileSync(path.join(source, STATE_FILES[0]), JSON.stringify({ health, affinities: {} }));
  fs.writeFileSync(path.join(source, STATE_FILES[1]), JSON.stringify(quota));
  return { source, target, root };
}

test('四账号复制摘要匿名显示持久健康、账号更新时间和额度，不修改任何原始副本字节', t => {
  const { source, target } = fixture(t), before = accountSnapshot(source);
  const result = copyManagedState(source, target), summary = result.summary;
  assert.deepEqual(accountSnapshot(source), before);
  assert.equal(summary.accounts, 4); assert.equal(summary.disabledAccounts, 1); assert.equal(summary.persistedHealthRecordCount, 3);
  assert.deepEqual(summary.accountStates.map(row => row.anonymousAccount), ['account-1', 'account-2', 'account-3', 'account-4']);
  assert.deepEqual(summary.accountStates.map(row => row.persistedHealthState), ['none', 'authentication_error', 'verification_required', 'access_denied']);
  assert.deepEqual(summary.accountStates.map(row => row.enabled), [true, true, false, true]);
  const row = summary.accountStates[1];
  assert.equal(row.accountUpdatedAt, '2026-11-07T00:02:00.000Z');
  assert.equal(row.persistedHealthSince, '2026-11-06T00:00:00.000Z');
  assert.equal(row.persistedHealthFingerprintPresent, true);
  // Newer account metadata must not be interpreted as proof of live recovery.
  assert.equal(row.persistedHealthState, 'authentication_error');
  assert.match(summary.evidence, /no live health or quota probe/);
  assert.match(summary.evidence, /not proof of credential refresh/);
  assert.equal(row.quotaObservedAt, '2026-11-07T00:00:00.000Z');
  assert.equal(row.quotaModelsExpiresAt, '2026-11-07T00:05:00.000Z');
  assert.equal(row.imageQuota.length, 1); assert.equal(row.imageQuota[0].remainingFraction, 0.1);
  assert.equal(summary.accountStates[0].imageQuota[0].remainingFraction, 0);
  assert.equal(summary.accountStates[3].imageQuota[0].remainingFraction, null, 'boolean is not a measured quota fraction');
  assert.equal(row.persistedGeminiProtection.protected, true);
  assert.equal(row.persistedGeminiProtection.weekly.remainingFraction, 0.04);
  assert.ok(Date.parse(summary.copyCompletedAt) >= Date.parse(summary.observedAt));
  assert.equal(summary.sourceConfig.defaultManagedDirectory, false);
  assert.equal(summary.sourceConfig.location, '<REDACTED_VALUE>'); assert.match(summary.sourceConfig.pathSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(summary), /private-owner|private-access|private-refresh|private-persisted|private-project|example\.invalid/);
  for (const name of fs.readdirSync(path.join(source, 'accounts')).map(name => `accounts/${name}`).concat(STATE_FILES)) {
    assert.deepEqual(fs.readFileSync(path.join(target, name)), fs.readFileSync(path.join(source, name)));
    assert.equal(fs.statSync(path.join(target, name)).mode & 0o777, 0o600);
  }
});

test('后续复制明确记录health已清空，保留旧摘要且不复用旧健康或据此声称实时可用', t => {
  const { source, target, root } = fixture(t), first = copyManagedState(source, target);
  fs.writeFileSync(path.join(source, STATE_FILES[0]), JSON.stringify({ health: {}, affinities: {} }));
  const secondTarget = path.join(root, 'fresh-copy'), second = copyManagedState(source, secondTarget);
  assert.equal(first.summary.persistedHealthRecordCount, 3);
  assert.equal(second.summary.persistedHealthRecordCount, 0);
  assert.ok(second.summary.accountStates.every(row => row.persistedHealthState === 'none' && row.persistedHealthFingerprintPresent === false));
  assert.ok(second.summary.accountStates.every(row => !Object.hasOwn(row, 'healthy') && !Object.hasOwn(row, 'available')));
  assert.equal(second.summary.sourceConfig.pathSha256, first.summary.sourceConfig.pathSha256);
  assert.notEqual(second.summary.stateFiles[0].sha256, first.summary.stateFiles[0].sha256);
  assert.equal(second.summary.stateFiles[1].sha256, first.summary.stateFiles[1].sha256);
  assert.deepEqual(second.before, first.before, 'health changes alone do not change credential file digests');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(target, STATE_FILES[0]))).health).length, 3);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(secondTarget, STATE_FILES[0]))).health).length, 0);
});
