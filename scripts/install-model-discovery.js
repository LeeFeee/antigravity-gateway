#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');

function cliPackage(command, expected) {
  const bin = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, command)).find(file => fs.existsSync(file));
  if (!bin) throw new Error(`未安装 ${command}`);
  let dir = path.dirname(fs.realpathSync(bin));
  while (path.dirname(dir) !== dir) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).name === expected) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`无法定位 ${command} 安装目录`);
}

function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('node scripts/install-model-discovery.js [--pi-provider antigravity] [--dsh-provider antigravity-gateway] [--dsh-profiles web,headless]'); return;
  }
  const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const dshDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const piProvider = value('--pi-provider', 'antigravity');
  const dshProvider = value('--dsh-provider', 'antigravity-gateway');
  const dshPackage = cliPackage('dsh', '@deepseek-ai/dsh');
  cliPackage('pi', '@earendil-works/pi-coding-agent');
  const yaml = createRequire(path.join(dshPackage, 'package.json'))('yaml');
  const piConfig = JSON.parse(fs.readFileSync(path.join(piDir, 'models.json'))).providers?.[piProvider];
  if (!piConfig?.baseUrl || !piConfig.api) throw new Error('Pi 必须先配置好原有网关连接');
  const dshTarget = path.join(dshDir, 'integrations', 'antigravity-model-discovery');
  const plugin = path.join(dshTarget, 'dsh.mjs');
  const changes = value('--dsh-profiles', 'web,headless').split(',').map(profile => {
    if (!/^[\w-]+$/.test(profile)) throw new Error('无效的 dsh profile');
    const file = path.join(dshDir, 'profiles', profile, 'cordis.patch.yml');
    const original = fs.readFileSync(file, 'utf8');
    const doc = yaml.parseDocument(original);
    if (doc.errors.length) throw new Error(`dsh ${profile} 配置无效`);
    const before = doc.toJS();
    const index = before.findIndex(row => row.id === 'llm-pi-ai');
    const existing = before.flatMap(row => row.insert || []).find(row => row.id === 'antigravity-dynamic-models');
    const row = existing || before[index];
    if (!row?.config?.providers?.[dshProvider]?.baseURL) throw new Error(`dsh ${profile} 缺少原有网关连接`);
    if (row.name && row.name !== '@deepseek-ai/dsh-llm-pi-ai' && row.name !== plugin) throw new Error(`dsh ${profile} 已使用其他适配插件`);
    if (!existing) {
      // In Cordis patches name is an identity assertion, not a replace operation.
      // Preserve the old entry for uninstall and activate a normal plugin entry.
      doc.setIn([index, 'disabled'], true);
      doc.add({ insert: [{ id: 'antigravity-dynamic-models', name: plugin, config: structuredClone(row.config) }] });
    }
    const after = doc.toJS();
    const active = after.flatMap(row => row.insert || []).find(row => row.id === 'antigravity-dynamic-models');
    if (!isDeepStrictEqual(row.config, active.config)) throw new Error('安装器拒绝修改原有连接配置');
    return { file, original, content: doc.toString() };
  });
  const source = path.join(__dirname, '..', 'integrations', 'model-discovery');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dshDir, 'backups', `model-discovery-${stamp}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const piTarget = path.join(piDir, 'extensions', 'antigravity-model-discovery');
  for (const [target, client] of [[piTarget, 'pi'], [dshTarget, 'dsh']]) {
    if (fs.existsSync(target)) fs.cpSync(target, path.join(backup, `${client}-integration`), { recursive: true });
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, 'catalog.cjs'), path.join(target, 'catalog.cjs'));
    fs.copyFileSync(path.join(source, client === 'pi' ? 'pi.ts' : 'dsh.mjs'), path.join(target, client === 'pi' ? 'index.ts' : 'dsh.mjs'));
    fs.writeFileSync(path.join(target, 'options.json'), JSON.stringify({ piProvider, dshProvider, dshPackage }, null, 2), { mode: 0o600 });
  }
  for (const change of changes) {
    fs.writeFileSync(path.join(backup, `${path.basename(path.dirname(change.file))}-cordis.patch.yml`), change.original, { mode: 0o600 });
    const tmp = `${change.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, change.content, { mode: fs.statSync(change.file).mode & 0o777 });
    fs.renameSync(tmp, change.file);
  }
  console.log(`已安装 Pi 扩展和 dsh 插件；原有连接、凭据引用、默认模型与静态清单均保留。备份：${backup}`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { cliPackage };
