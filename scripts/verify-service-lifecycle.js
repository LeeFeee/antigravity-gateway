#!/usr/bin/env node
'use strict';

// Actual macOS launchctl lifecycle, restricted to a fresh random test label.
// No accounts, external model calls, production service mutation or global install.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { manageService, context, launchAgentLabel } = require('../src/service-manager');

const ROOT = path.resolve(__dirname, '..');
const PRODUCTION_LABEL = 'io.github.leefeee.antigravity-gateway';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const privateWrite = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};

function command(file, args, { env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { env, encoding: 'utf8', timeout: 15000 }, (error, stdout, stderr) => {
    const result = { code: error?.code || 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
    if (error && !allowFailure) reject(new Error(`${path.basename(file)} ${args[0]} failed: ${result.stderr.trim() || result.code}`));
    else resolve(result);
  }));
}

function assertOwnedCommand(file, args, { domain, target, plist }) {
  assert.equal(file, '/bin/launchctl');
  assert.notEqual(target, `${domain}/${PRODUCTION_LABEL}`);
  const accepted = (args[0] === 'print' && args.length === 2 && args[1] === target)
    || (['bootstrap', 'bootout'].includes(args[0]) && args.length === 3 && args[1] === domain && args[2] === plist)
    || (args[0] === 'bootout' && args.length === 2 && args[1] === target)
    || (args[0] === 'kickstart' && args.length === 3 && args[1] === '-k' && args[2] === target);
  assert.ok(accepted, 'Only the owned test service target/plist may be passed to launchctl');
}

function hashFile(file) {
  try {
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Service evidence accepts ordinary files only');
    return sha(fs.readFileSync(file));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function serviceState(target, env) {
  const result = await command('/bin/launchctl', ['print', target], { env, allowFailure: true });
  return { present: result.code === 0,
    state: /^\s*state = (.+)$/m.exec(result.stdout)?.[1] || null,
    pid: Number(/^\s*pid = (\d+)$/m.exec(result.stdout)?.[1]) || null };
}

async function children(pid, env) {
  if (!pid) return [];
  const result = await command('/usr/bin/pgrep', ['-P', String(pid)], { env, allowFailure: true });
  return result.stdout.trim().split(/\s+/).map(Number).filter(value => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b);
}

async function productionSnapshot(domain, env) {
  const home = os.homedir(), state = await serviceState(`${domain}/${PRODUCTION_LABEL}`, env);
  return { ...state, children: await children(state.pid, env),
    plistSha256: hashFile(path.join(home, 'Library/LaunchAgents', `${PRODUCTION_LABEL}.plist`)),
    configurationSha256: hashFile(path.join(home, '.antigravity-gateway/antigravity-gateway-service.json')) };
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = open => { if (settled) return; settled = true; socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(false));
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function eventually(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function main() {
  process.umask(0o077);
  assert.equal(process.platform, 'darwin', 'This lifecycle evidence requires macOS launchctl');
  const outputAt = process.argv.indexOf('--out');
  const output = path.resolve(outputAt < 0 ? 'tests/fixtures/service-lifecycle-20261107.json' : process.argv[outputAt + 1]);
  const domain = `gui/${process.getuid()}`;
  const root = fs.mkdtempSync('/private/tmp/agw-service-');
  const homeDir = path.join(root, 'home'), configDir = path.join(root, 'config'), tmp = path.join(root, 'tmp');
  for (const directory of [homeDir, configDir, tmp, path.join(configDir, 'accounts')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `antigravity-gateway-verify-${crypto.randomBytes(8).toString('hex')}`;
  const label = launchAgentLabel(name), target = `${domain}/${label}`;
  const plist = path.join(homeDir, 'Library/LaunchAgents', `${label}.plist`);
  const port = await unusedPort();
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: homeDir, TMPDIR: tmp,
    ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir, ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1', ANTIGRAVITY_GATEWAY_PORT: String(port),
    ANTIGRAVITY_GATEWAY_SERVICE_NAME: name, ANTIGRAVITY_CLI_PATH: path.join(root, 'absent-agy') };
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`,
    label, port, productionLabel: PRODUCTION_LABEL, accounts: 0, realModelRequests: false, actions: [], checks: {}, evidence: 'actual-macos-launchctl-isolated-service-lifecycle' };
  report.sourceHashes = Object.fromEntries(['antigravity-gateway.js', 'src/service-manager.js', 'src/service-runner.js'].map(file => [file, hashFile(path.join(ROOT, file))]));
  const execute = async (file, args, options) => {
    assertOwnedCommand(file, args, { domain, target, plist });
    const result = await command(file, args, options);
    report.actions.push({ command: args[0], arguments: args.slice(1).map(value => value.replace(root, '[TEMP_ROOT]')), code: result.code });
    return result;
  };
  const options = { name, homeDir, configDir, gatewayFile: path.join(ROOT, 'antigravity-gateway.js'),
    runnerFile: path.join(ROOT, 'src/service-runner.js'), nodeFile: process.execPath, env, execute };
  const ctx = context(options);
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    if (response.status !== 200) return false;
    assert.equal(body.name, 'antigravity-gateway'); assert.equal(body.status, 'ok');
    assert.equal(body.listen, `http://127.0.0.1:${port}`);
    assert.equal(body.account_pool.managed_accounts, 0);
    assert.equal(body.usage.file, path.join(configDir, 'usage/usage-state.json'));
    assert.equal(body.codex_model_catalog, path.join(configDir, 'codex-models.json'));
    return { status: response.status, body: { name: body.name, status: body.status, version: body.version,
      listen: body.listen, managedAccounts: 0, usageFile: body.usage.file.replace(root, '[TEMP_ROOT]'),
      codexModelCatalog: body.codex_model_catalog.replace(root, '[TEMP_ROOT]') } };
  };
  let failure;
  try {
    const gui = await command('/bin/launchctl', ['print', domain], { env, allowFailure: true });
    assert.equal(gui.code, 0, 'Current GUI launchctl domain must exist before service mutation');
    report.checks.guiDomainPresent = true;
    report.productionBefore = await productionSnapshot(domain, env);
    assert.equal((await serviceState(target, env)).present, false, 'Random service label must not pre-exist');
    assert.equal(fs.existsSync(plist), false);
    report.start = await manageService('start', options);
    report.initialHealth = await eventually(health, 'test service health');
    report.initialService = await serviceState(target, env);
    report.initialService.children = await children(report.initialService.pid, env);
    assert.ok(report.initialService.pid && report.initialService.children.length === 1);
    report.status = await manageService('status', options);
    assert.match(report.status, /已配置/); assert.match(report.status, /运行中/);
    const configHash = hashFile(ctx.configurationFile), plistHash = hashFile(plist);
    const config = JSON.parse(fs.readFileSync(ctx.configurationFile, 'utf8'));
    assert.equal(config.environment.HOME, homeDir);
    assert.equal(config.environment.ANTIGRAVITY_GATEWAY_CONFIG_DIR, configDir);
    assert.equal(config.environment.ANTIGRAVITY_GATEWAY_PORT, String(port));
    report.checks.temporaryConfigurationUsed = true;
    report.restart = await manageService('restart', options);
    report.restartedService = await eventually(async () => {
      const state = await serviceState(target, env);
      return state.pid && state.pid !== report.initialService.pid ? state : false;
    }, 'new runner PID');
    report.restartedHealth = await eventually(health, 'restarted service health');
    report.restartedService = await serviceState(target, env);
    report.restartedService.children = await children(report.restartedService.pid, env);
    assert.equal(report.restartedService.children.length, 1);
    assert.notEqual(report.restartedService.children[0], report.initialService.children[0]);
    await eventually(() => !processExists(report.initialService.pid) && report.initialService.children.every(pid => !processExists(pid)), 'old runner and gateway exit');
    assert.equal(hashFile(ctx.configurationFile), configHash); assert.equal(hashFile(plist), plistHash);
    report.checks.restartChangedRunnerAndGatewayPids = true;
    report.checks.restartRetiredPreviousProcesses = true;
    report.checks.restartPreservedConfiguration = true;
    report.stop = await manageService('stop', options);
    await eventually(async () => !(await serviceState(target, env)).present && !(await portOpen(port)), 'stopped target and closed port');
    await eventually(() => !processExists(report.restartedService.pid) && report.restartedService.children.every(pid => !processExists(pid)), 'stopped runner and gateway exit');
    report.checks.stoppedProcessesExited = true;
    assert.equal(fs.existsSync(plist), true); assert.equal(fs.existsSync(ctx.configurationFile), true);
    report.stoppedStatus = await manageService('status', options);
    assert.match(report.stoppedStatus, /已配置/); assert.match(report.stoppedStatus, /未运行/);
    report.checks.stopPreservedConfiguration = true;
    report.uninstall = await manageService('uninstall', options);
    assert.equal(fs.existsSync(plist), false); assert.equal(fs.existsSync(ctx.configurationFile), false);
    report.uninstalledStatus = await manageService('status', options);
    assert.match(report.uninstalledStatus, /未配置/); assert.match(report.uninstalledStatus, /未运行/);
    report.checks.uninstallRemovedConfiguration = true;
  } catch (error) { failure = error; report.failure = error.message.replaceAll(root, '[TEMP_ROOT]'); }
  finally {
    try {
      await manageService('uninstall', options);
      if ((await serviceState(target, env)).present) await execute('/bin/launchctl', ['bootout', target], { env });
      await eventually(async () => !(await serviceState(target, env)).present && !(await portOpen(port)), 'final cleanup');
      report.checks.finalTargetAbsent = true; report.checks.finalPortClosed = true;
    } catch (error) { report.cleanupFailure = error.message.replaceAll(root, '[TEMP_ROOT]'); failure ||= error; }
    try {
      report.productionAfter = await productionSnapshot(domain, env);
      assert.deepEqual(report.productionAfter, report.productionBefore, 'Production service PID, child PID, plist and config must not change');
      report.checks.productionServiceUnchanged = true;
    } catch (error) { report.productionCheckFailure = error.message.replaceAll(root, '[TEMP_ROOT]'); failure ||= error; }
    try {
      if (fs.existsSync(ctx.stderrFile)) report.testServiceStderr = fs.readFileSync(ctx.stderrFile, 'utf8').replaceAll(root, '[TEMP_ROOT]').replaceAll(os.homedir(), '[USER_HOME]').slice(-8000);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      report.checks.temporaryRootRemoved = !fs.existsSync(root);
    } catch (error) { report.fileCleanupFailure = error.message; failure ||= error; }
    report.passed = !failure && Object.values(report.checks).every(Boolean);
    report.sourceUnchanged = Object.entries(report.sourceHashes).every(([file, hash]) => hashFile(path.join(ROOT, file)) === hash);
    if (!report.sourceUnchanged) { failure ||= new Error('Gateway/service source changed during the lifecycle verification'); report.passed = false; }
    report.completedAt = new Date().toISOString();
    privateWrite(output, report);
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, report: output }));
}

module.exports = { assertOwnedCommand, serviceState, productionSnapshot, portOpen };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
