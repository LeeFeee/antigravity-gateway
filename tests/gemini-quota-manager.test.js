'use strict';

// Local lifecycle/namespace regression checks; these do not replace live
// Google quota observations or real installed-client routing acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { GeminiQuotaManager } = require('../src/gemini-quota-manager');
const { dashboardData } = require('../src/dashboard');

function fixture(t) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-quota-lifecycle-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(configDir, 'state'));
  const original = '{"old-antigravity":{"available":true}}\n';
  fs.writeFileSync(path.join(configDir, 'state', 'quota.json'), original);
  let now = 1800000000000, quota = snapshot(0.6), failure = null;
  const observations = [];
  const provider = { getQuota: async () => { if (failure) throw failure; return quota; } };
  const accountPool = { providerType: 'gemini', entries: new Map([['gemini-account-test', {
    account: { id: 'gemini-account-test', enabled: true }, provider
  }]]), isAccountHealthy: () => true, observeAccountFailure: (...args) => observations.push(args) };
  const manager = new GeminiQuotaManager({ configDir, accountPool, now: () => now });
  return { manager, accountPool, provider, observations, configDir, original,
    advance: ms => { now += ms; }, quota: value => { quota = value; }, fail: value => { failure = value; } };
}
function snapshot(remaining) {
  return { providerType: 'gemini', source: 'GetUsageInfo', userTier: 3, modelSpecific: false, groups: [{ id: 'gemini-gxu',
    available: remaining == null ? null : remaining > 0, buckets: [{ id: 'gemini-gxu-5h', window: '5h',
      remainingFraction: remaining, available: remaining == null ? null : remaining > 0 }] }] };
}

test('Gemini quota uses separate persistence and retains reserves across unknown/stale data', async t => {
  const f = fixture(t);
  f.quota(snapshot(0.04));
  await f.manager.refreshAccount('gemini-account-test');
  assert.equal(f.manager.isQuotaProtected('gemini-account-test', 'gemini-4-argon-low-g'), true);
  f.advance(31 * 60000);
  assert.equal(f.manager.getSchedulingSnapshot('gemini-account-test'), null);
  f.quota(snapshot(null));
  await f.manager.refreshAccount('gemini-account-test', { force: true });
  assert.equal(f.manager.get('gemini-account-test').available, null);
  assert.equal(f.manager.protection('gemini-account-test').protected, true);
  assert.equal(fs.readFileSync(path.join(f.configDir, 'state', 'quota.json'), 'utf8'), f.original);
  const restored = new GeminiQuotaManager({ configDir: f.configDir, accountPool: f.accountPool });
  assert.equal(restored.protection('gemini-account-test').protected, true);
  f.quota(snapshot(0.8));
  await f.manager.refreshAccount('gemini-account-test', { force: true });
  assert.equal(f.manager.protection('gemini-account-test').protected, false);
});

test('optional quota denial preserves freshness and does not quarantine inference', async t => {
  const f = fixture(t);
  await f.manager.refreshAccount('gemini-account-test');
  const before = f.manager.peek('gemini-account-test');
  f.advance(31 * 60000);
  f.fail(Object.assign(new Error('private upstream body'), { status: 403 }));
  await assert.rejects(f.manager.refreshAccount('gemini-account-test', { force: true }));
  const after = f.manager.peek('gemini-account-test');
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(after.stale, true);
  assert.equal(f.observations.length, 0);
  assert.doesNotMatch(JSON.stringify(after), /private upstream body/);
  f.fail(Object.assign(new Error('expired grant'), { status: 401 }));
  await assert.rejects(f.manager.refreshAccount('gemini-account-test', { force: true }));
  assert.equal(f.observations.length, 1);
});

test('late quota response cannot resurrect deleted or replaced account state', async t => {
  for (const replace of [false, true]) {
    const f = fixture(t);
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    f.provider.getQuota = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.manager.refreshAccount('gemini-account-test');
    await ready;
    f.accountPool.entries.delete('gemini-account-test');
    if (replace) f.accountPool.entries.set('gemini-account-test', { account: { id: 'gemini-account-test' }, provider: {} });
    release(snapshot(0.7));
    assert.equal(await pending, null);
    assert.equal(f.manager.peek('gemini-account-test'), null);
  }
});

test('dashboard merges isolated pools without reporting unknown Gemini tokens as measured zero', () => {
  const data = dashboardData({
    usageStore: { summary: () => ({ lifetime: {}, byAccount: { a: { upstreamCalls: 2 }, g: { upstreamCalls: 4 } } }) },
    accountPool: { status: () => [{ id: 'a', providerType: 'cloudcode' }] },
    quotaManager: { peek: () => ({ source: 'agy' }) },
    upstreamPools: [{ accountPool: { status: () => [{ id: 'g', providerType: 'gemini' }] },
      quotaManager: { peek: () => ({ source: 'GetUsageInfo' }) } }]
  });
  assert.deepEqual(data.accounts.map(a => [a.id, a.tokenUsageKnown, a.quota.source]), [['a', true, 'agy'], ['g', false, 'GetUsageInfo']]);
  assert.equal(data.usage.lifetime.upstreamCalls, 6);
  assert.deepEqual(data.tokenUsageMetadata.unmeteredAccountIds, ['g']);
});
