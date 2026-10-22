'use strict';

// 所有数据均为测试夹具；模拟 HTTP 断开后仍在完成清理的上游事务。
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { DirectAntigravityProvider } = require('../../src/direct-provider');
const { QuotaManager } = require('../../src/quota-manager');
const { RobinAccountPool } = require('../../src/robin-account-pool');
const { LocalAccountImporter } = require('../../src/local-account-importer');
const { AccountPool } = require('../../src/account-pool');
const reload = AccountPool.prototype.reload;
AccountPool.prototype.reload = function (...args) {
  fs.writeFileSync(path.join(process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR, `pool-initialized-${process.pid}`), '1');
  return reload.apply(this, args);
};
globalThis.fetch = async () => { throw new Error('生命周期测试禁止访问外部上游'); };
QuotaManager.prototype.start = () => {};
RobinAccountPool.prototype.start = () => {};
LocalAccountImporter.prototype.importIfNew = async () => ({ status: 'none' });
DirectAntigravityProvider.prototype.isConfigured = () => true;
DirectAntigravityProvider.prototype.listModels = async () => ['gemini-test-high'];
DirectAntigravityProvider.prototype.send = async function () {
  const root = process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR;
  fs.writeFileSync(path.join(root, 'transaction-started'), '1');
  while (!fs.existsSync(path.join(root, 'release-transaction'))) await delay(10);
  fs.writeFileSync(path.join(root, 'transaction-finished'), '1');
  return { text: 'OK', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } };
};
