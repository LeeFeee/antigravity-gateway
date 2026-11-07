'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { AccountPool } = require('../src/account-pool');
const { availableModels, refreshClientModelCatalogs, claudeConfigPath, codexCatalogPath, startupBanner } = require('../antigravity-gateway');

test('catalog artifacts include only managed API models despite old transport settings and old providers', async t => {
  const models = ['claude-sonnet-4-6', 'gemini-3.8-flash-high'];
  t.mock.method(AccountPool.prototype, 'hasManagedAccounts', () => true);
  t.mock.method(AccountPool.prototype, 'listModels', async () => models);
  for (const transport of ['agy', 'auto', 'direct']) {
    process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = transport;
    assert.deepEqual(await refreshClientModelCatalogs(), models);
    const claude = JSON.parse(fs.readFileSync(claudeConfigPath(), 'utf8'));
    const codex = JSON.parse(fs.readFileSync(codexCatalogPath(), 'utf8'));
    assert.deepEqual(claude.modelPicker.options.map(item => item.model).sort(), [...models].sort());
    assert.deepEqual(codex.models.map(item => item.slug).sort(), [...models].sort());
    assert.doesNotMatch(startupBanner({ models }), /Robin|Windows WebChannel|CLI stream-json/);
  }
});

test('an empty account pool clears old catalog results without searching another credential source', async t => {
  t.mock.method(AccountPool.prototype, 'hasManagedAccounts', () => false);
  t.mock.method(AccountPool.prototype, 'listModels', async () => assert.fail('empty account pool has no model source'));
  assert.deepEqual(await availableModels(true), []);
  await refreshClientModelCatalogs();
  assert.deepEqual(JSON.parse(fs.readFileSync(codexCatalogPath(), 'utf8')).data, []);
});
