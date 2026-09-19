'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccountStore } = require('../src/account-store');
const { LocalAccountImporter } = require('../src/local-account-importer');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-local-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  const state = {
    accessToken: 'local-access-1',
    refreshToken: 'local-refresh-1',
    subjectId: 'google-subject-1',
    email: 'local@example.com',
    projectId: 'project-1'
  };
  let reloads = 0;
  const provider = {
    refreshToken: '',
    localAuth: {
      isConfigured: () => true,
      last: null
    },
    access: async () => {
      provider.refreshToken = state.refreshToken;
      provider.localAuth.last = {
        refreshToken: state.refreshToken,
        expiry: new Date('2030-01-01T00:00:00.000Z'),
        authMethod: 'consumer'
      };
      return state.accessToken;
    },
    project: async () => state.projectId
  };
  const importer = new LocalAccountImporter({
    provider,
    store,
    accountPool: { reload: () => { reloads += 1; } },
    fetchImpl: async () => new Response(JSON.stringify({ id: state.subjectId, email: state.email }), { status: 200 })
  });
  return { importer, provider, reloads: () => reloads, state, store };
}

test('local agy account is imported once and an existing pool credential is not overwritten', async (t) => {
  const value = fixture(t);
  const first = await value.importer.importIfNew();
  assert.equal(first.status, 'imported');
  assert.equal(value.store.list().length, 1);
  assert.equal(value.store.list()[0].source, 'local-agy-import');
  assert.equal(value.store.list()[0].refreshToken, 'local-refresh-1');
  assert.equal(value.reloads(), 1);

  value.state.accessToken = 'local-access-newer';
  value.state.refreshToken = 'local-refresh-newer';
  const second = await value.importer.importIfNew();
  assert.equal(second.status, 'existing');
  assert.equal(value.store.list().length, 1);
  assert.equal(value.store.list()[0].accessToken, 'local-access-1');
  assert.equal(value.store.list()[0].refreshToken, 'local-refresh-1');
  assert.equal(value.reloads(), 1);
});

test('a different local agy identity is added as a new pool account', async (t) => {
  const value = fixture(t);
  await value.importer.importIfNew();
  value.state.subjectId = 'google-subject-2';
  value.state.email = 'second@example.com';
  value.state.accessToken = 'local-access-2';
  value.state.refreshToken = 'local-refresh-2';
  value.state.projectId = 'project-2';
  const second = await value.importer.importIfNew();
  assert.equal(second.status, 'imported');
  assert.equal(value.store.list().length, 2);
  assert.equal(value.reloads(), 2);
  assert.deepEqual(new Set(value.store.list().map((account) => account.email)), new Set(['local@example.com', 'second@example.com']));
});

test('local account detection stays inactive when the official agy login is unavailable', async (t) => {
  const value = fixture(t);
  value.provider.localAuth.isConfigured = () => false;
  const result = await value.importer.importIfNew();
  assert.deepEqual(result, { status: 'missing' });
  assert.equal(value.store.list().length, 0);
  assert.equal(value.reloads(), 0);
});

test('a local session without a refresh token is not persisted as a dead pool account', async (t) => {
  const value = fixture(t);
  value.state.refreshToken = '';
  await assert.rejects(value.importer.importIfNew(), /没有可持久使用的 refresh token/);
  assert.equal(value.store.list().length, 0);
  assert.equal(value.reloads(), 0);
});
