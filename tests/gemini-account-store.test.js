'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('../src/account-store');
const { GeminiAccountStore } = require('../src/gemini-account-store');

function stores(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-gemini-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, agy: new AccountStore({ configDir: root }), gemini: new GeminiAccountStore({ configDir: root }) };
}
const identity = { subjectId: 'test-google-subject', email: 'fixture@example.invalid', accessToken: 'test-access', refreshToken: 'test-refresh' };

test('same Google identity remains isolated between original and Gemini pools', t => {
  const { agy, gemini } = stores(t);
  const existing = agy.save(identity), added = gemini.save(identity, { newGrant: true });
  assert.notEqual(existing.id, added.id);
  assert.equal(agy.list()[0].providerType, 'cloudcode');
  assert.equal(gemini.list()[0].providerType, 'gemini');
  assert.notEqual(agy.directory, gemini.directory);
  gemini.delete(added.id);
  assert.equal(agy.list().length, 1);
  assert.equal(gemini.list().length, 0);
});

test('Gemini storage cannot load legacy pools or accept foreign account types', t => {
  const { root, gemini } = stores(t);
  for (const directory of ['robin-accounts', 'gemini-win-accounts']) {
    fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, directory, 'legacy.json'), JSON.stringify({ ...identity, providerType: 'robin', accountType: 'gemini-app' }));
  }
  assert.deepEqual(gemini.list(), []);
  assert.throws(() => gemini.save({ ...identity, providerType: 'robin' }), /其他上游/);
  assert.throws(() => gemini.save({ ...identity, authMethod: 'gemini-windows-session' }), /OAuth/);
  assert.throws(() => gemini.save({ ...identity, subjectId: '' }), /身份/);
});

test('late Gemini refresh cannot overwrite reauthorization or recreate a deleted account', t => {
  const { gemini } = stores(t);
  const first = gemini.save(identity, { newGrant: true });
  const refreshed = gemini.save({ ...first, accessToken: 'next-access' }, { expectedGrant: first.grantGeneration });
  assert.equal(refreshed.grantGeneration, first.grantGeneration);
  const reauthorized = gemini.save({ ...refreshed, refreshToken: 'new-grant' }, { newGrant: true });
  assert.notEqual(reauthorized.grantGeneration, first.grantGeneration);
  assert.equal(gemini.save({ ...first, accessToken: 'late-access' }, { expectedGrant: first.grantGeneration }), null);
  assert.equal(gemini.list()[0].refreshToken, 'new-grant');
  gemini.delete(reauthorized.id);
  assert.equal(gemini.save(reauthorized, { expectedGrant: reauthorized.grantGeneration }), null);
  assert.deepEqual(gemini.list(), []);
});

test('a different verified Google subject cannot inherit an existing Gemini account by email', t => {
  const { gemini } = stores(t);
  const original = gemini.save(identity, { newGrant: true });
  assert.throws(() => gemini.save({ ...identity, subjectId: 'different-google-subject' }, { newGrant: true }), /不同的 Google 身份/);
  assert.equal(gemini.list()[0].id, original.id);
  assert.equal(gemini.list()[0].grantGeneration, original.grantGeneration);
});
