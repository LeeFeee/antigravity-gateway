#!/usr/bin/env node
'use strict';

// Real npm install/upgrade/rollback, exclusively in a disposable prefix.
// Runtime probes use synthetic data and cannot reach the network or keychain.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const inside = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
const MODEL = 'gemini-3.8-flash-high';
const OWNER = 'synthetic-upgrade-account';
const SESSION = 'synthetic-upgrade-session';
const PREFIX = [{ role: 'user', parts: [{ text: 'Synthetic upgrade history.' }] }];
const ANSWER = { role: 'model', parts: [{ text: 'Synthetic recorded answer.', thoughtSignature: 'synthetic-server-signature' }] };

function runtimeGuard(configDir, denyLegacy, reportFile) {
  const accesses = [], violations = [];
  const legacy = ['robin-accounts', 'gemini-win-accounts'].map(name => path.join(configDir, name));
  const protectedRoots = ['.antigravity-gateway', '.antigravity', '.config/antigravity', '.config/agy',
    'Library/Application Support/Antigravity'].map(name => path.join(os.homedir(), name));
  const originalWrite = fs.writeFileSync.bind(fs);
  const fail = message => { violations.push(message); throw new Error(message); };
  const inspect = (method, value) => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return;
    const file = value instanceof URL ? require('node:url').fileURLToPath(value) : path.resolve(String(value));
    if (protectedRoots.some(root => inside(file, root)) && !inside(file, configDir)) fail(`Blocked real credential/data access: ${method}`);
    if (legacy.some(root => inside(file, root))) {
      accesses.push({ method, path: path.relative(configDir, file) });
      if (denyLegacy) fail(`New runtime scanned retired directory: ${method}`);
    }
  };
  for (const name of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'accessSync', 'existsSync',
    'openSync', 'writeFileSync', 'mkdirSync', 'chmodSync', 'unlinkSync', 'rmSync', 'renameSync']) {
    const original = fs[name].bind(fs);
    fs[name] = (...args) => { inspect(name, args[0]); if (name === 'renameSync') inspect(name, args[1]); return original(...args); };
  }
  for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'writeFile', 'mkdir', 'chmod', 'unlink', 'rm', 'rename']) {
    for (const target of [fs, fs.promises]) {
      const original = target[name].bind(target);
      target[name] = (...args) => { inspect(name, args[0]); if (name === 'rename') inspect(name, args[1]); return original(...args); };
    }
  }
  globalThis.fetch = () => fail('Blocked runtime fetch');
  for (const module of ['node:http', 'node:https']) {
    const target = require(module);
    target.request = target.get = () => fail('Blocked runtime HTTP');
  }
  const net = require('node:net');
  net.connect = net.createConnection = net.Socket.prototype.connect = () => fail('Blocked runtime socket');
  net.Server.prototype.listen = () => fail('Blocked runtime listen');
  const child = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[name] = () => fail('Blocked runtime subprocess/keychain/service action');
  process.on('exit', () => originalWrite(reportFile, `${JSON.stringify({ accesses, violations }, null, 2)}\n`));
  return { accesses, violations };
}

function environment(root) {
  // Keep the real HOME untouched; explicitly redirect every data/auth/npm path.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ANTIGRAVITY_|npm_config_|NPM_CONFIG_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|SSL_CERT_FILE$|SSL_CERT_DIR$)/.test(key)) delete env[key];
  return Object.assign(env, {
    ANTIGRAVITY_GATEWAY_CONFIG_DIR: path.join(root, 'config'),
    ANTIGRAVITY_LOCAL_AUTH_FILE: path.join(root, 'absent-local-auth.json'),
    ANTIGRAVITY_AUTH_FILE: path.join(root, 'absent-direct-auth.json'),
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: path.join(root, 'empty.npmrc'),
    npm_config_globalconfig: path.join(root, 'empty-global.npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false',
    TMPDIR: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp')
  });
}

function inventory(root) {
  const files = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[relative] = sha(fs.readFileSync(file));
      else if (entry.isSymbolicLink()) files[relative] = `symlink:${fs.readlinkSync(file)}`;
    }
  }
  visit(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function run(command, args, { cwd, env, log, timeout = 180_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Timed out: ${command}`)); }, timeout);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); fs.writeFileSync(log, `${stdout}${stderr}`);
      if (code !== 0) reject(new Error(`${path.basename(command)} exited ${code}; inspect ${log}`));
      else resolve({ stdout, stderr });
    });
  });
}

function loadModules(install) {
  const load = name => require(path.join(install, 'src', name));
  return { ...load('account-store'), ...load('account-pool'), ...load('account-scheduling'),
    ...load('quota-manager'), ...load('usage-store'), ...load('multimedia'), ...load('agy-session-state'), service: load('service-manager') };
}

function instances(m, configDir, now) {
  const store = new m.AccountStore({ configDir });
  const pool = new m.AccountPool({ store, now: () => now,
    providerFactory: account => ({ localAuth: { account }, stop() {} }) });
  const quota = new m.QuotaManager({ configDir, accountPool: pool, now: () => now });
  pool.quotaManager = quota;
  return { store, pool, quota, usage: new m.UsageStore({ configDir, now: () => now }),
    media: new m.MediaStore({ directory: path.join(configDir, 'media') }),
    session: new m.AgySessionStore({ directory: path.join(configDir, 'state', 'agy-sessions'), now: () => now }) };
}

function serviceContract(m, install, root) {
  const ctx = m.service.context({ homeDir: path.join(root, 'synthetic-user'), configDir: path.join(root, 'config'),
    gatewayFile: path.join(install, 'antigravity-gateway.js'), runnerFile: path.join(install, 'src/service-runner.js'), env: {}, platform: 'darwin' });
  return { label: m.service.launchAgentLabel(ctx.name), plist: m.service.launchAgentBody(ctx),
    configurationFile: ctx.configurationFile, logsDir: ctx.logsDir };
}

async function seed(install, root) {
  const m = loadModules(install), configDir = path.join(root, 'config'), at = Date.now();
  const store = new m.AccountStore({ configDir });
  for (const [name, weight, enabled] of [['active', 7, true], ['second', 3, true], ['disabled', 9, false],
    ['unhealthy', 2, true], ['five-hour', 4, true], ['weekly', 5, true], ['removed', 1, true]]) {
    store.save({ id: `synthetic-${name}`, subjectId: `synthetic-subject-${name}`, email: `${name}@example.invalid`,
      accessToken: `synthetic-access-${name}`, refreshToken: `synthetic-refresh-${name}`, projectId: 'synthetic-project',
      expiresAt: '2099-01-01T00:00:00.000Z', enabled, weight, source: 'upgrade-rehearsal' });
  }
  const x = instances(m, configDir, at);
  x.pool.bindSession('synthetic-affinity', 'synthetic-active');
  x.pool.markAccountIssue(x.pool.entries.get('synthetic-unhealthy'), { status: 401, message: 'Synthetic authentication failure' });
  x.pool.removeAccount('synthetic-removed');
  for (const [name, five, weekly] of [['active', .8, .7], ['five-hour', .09, .7], ['weekly', .8, .04]]) {
    const snapshot = { observedAt: new Date(at - 3_600_000).toISOString(), groups: [{ id: 'gemini', displayName: 'Gemini',
      buckets: [{ window: '5h', remainingFraction: five, resetTime: new Date(at - 1000).toISOString() },
        { window: 'weekly', remainingFraction: weekly, resetTime: new Date(at - 1000).toISOString() }] }] };
    snapshot.geminiQuotaProtection = m.geminiQuotaProtection(snapshot, null, snapshot.observedAt);
    x.quota.snapshots[`synthetic-${name}`] = snapshot;
  }
  x.quota.save();
  x.usage.recordClientRequest(); x.usage.recordClientRequest();
  x.usage.recordUpstream({ model: MODEL, accountId: 'synthetic-active', usage: {
    input_tokens: 123, output_tokens: 45, thinking_tokens: 67, cache_read_tokens: 89, total_tokens: 235 } });
  x.usage.recordUpstream({ model: MODEL, accountId: 'synthetic-second', success: false }); x.usage.save();
  const media = [];
  for (const purpose of ['assistants', 'generated']) {
    const buffer = Buffer.from(`synthetic-${purpose}-media-bytes`);
    const item = x.media.save(buffer, { mediaType: 'image/png', filename: `${purpose}.png`, purpose, scope: 'synthetic-scope' });
    media.push({ id: item.id, purpose, sha256: sha(buffer), scope: item.scope });
  }
  let session;
  await x.session.transact(OWNER, SESSION, null, (state, checkpoint) => {
    m.recordResponse(state, PREFIX, MODEL, ANSWER, at); state.requestIndex = 8; checkpoint();
    session = { cascadeId: state.cascadeId, trajectoryId: state.trajectoryId, requestIndex: state.requestIndex };
  });
  for (const name of ['robin-accounts', 'gemini-win-accounts']) {
    fs.mkdirSync(path.join(configDir, name), { recursive: true });
    fs.writeFileSync(path.join(configDir, name, 'synthetic-broken.json'), '{deliberately invalid synthetic credential');
    write(path.join(configDir, name, 'synthetic-valid.json'), { id: `retired-${name}`, accessToken: 'synthetic-retired-token', enabled: true });
  }
  const service = serviceContract(m, install, root);
  write(path.join(configDir, 'antigravity-gateway-service.json'), { environment: {
    ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir, ANTIGRAVITY_GATEWAY_PORT: '9897',
    ANTIGRAVITY_GATEWAY_API_KEY: 'synthetic-api-key', ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1' } });
  write(path.join(configDir, 'claude-models.json'), { synthetic: true, model: MODEL });
  write(path.join(configDir, 'codex-models.json'), { synthetic: true, models: [MODEL] });
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'logs', 'synthetic.log'), 'Synthetic historical log.\n');
  const expected = { at, accounts: store.list().map(({ id, enabled, weight, subjectId }) => ({ id, enabled, weight, subjectId })),
    usage: { lifetime: x.usage.state.lifetime, byAccount: x.usage.state.byAccount, byModel: x.usage.state.byModel },
    media, session, service, files: inventory(configDir) };
  write(path.join(root, 'expected.json'), expected);
  return { seededBy: json(path.join(install, 'package.json')).version, accountCount: expected.accounts.length, mediaCount: media.length };
}

async function verify(install, root, stage) {
  const expected = json(path.join(root, 'expected.json')), m = loadModules(install), configDir = path.join(root, 'config');
  const x = instances(m, configDir, expected.at + 3_600_000), checks = [];
  const check = (name, fn) => { fn(); checks.push(name); };
  check('account IDs, disabled flag, weights and subjects', () => assert.deepEqual(x.store.list().map(({ id, enabled, weight, subjectId }) => ({ id, enabled, weight, subjectId })), expected.accounts));
  check('deleted account stays absent with removal marker', () => {
    assert.equal(x.pool.entries.has('synthetic-removed'), false);
    assert.equal(x.pool.isRemovedIdentity({ subjectId: 'synthetic-subject-removed', email: 'removed@example.invalid' }), true);
  });
  check('same-account reuse does not extend fixed affinity window', () => {
    x.pool.bindSession('synthetic-affinity', 'synthetic-active');
    assert.equal(x.pool.sessions.get('synthetic-affinity').at, expected.at);
    assert.equal(m.SESSION_TTL_MS, 18_000_000);
    assert.equal(m.affinityActive(x.pool.sessions.get('synthetic-affinity'), expected.at + m.SESSION_TTL_MS), true);
    assert.equal(m.affinityActive(x.pool.sessions.get('synthetic-affinity'), expected.at + m.SESSION_TTL_MS + 1), false);
  });
  check('health quarantine survives unchanged credential fingerprint', () => assert.equal(x.pool.entries.get('synthetic-unhealthy').healthState, 'authentication_error'));
  check('both quota windows survive stale snapshots and passed reset timestamps', () => {
    assert.equal(x.quota.protection('synthetic-five-hour').fiveHour.protected, true);
    assert.equal(x.quota.protection('synthetic-weekly').weekly.protected, true);
    assert.equal(x.quota.isQuotaProtected('synthetic-five-hour', MODEL), true);
    assert.equal(x.quota.isQuotaProtected('synthetic-weekly', MODEL), true);
    assert.equal(x.quota.isQuotaProtected('synthetic-active', MODEL), false);
  });
  check('candidates exclude disabled, unhealthy, protected and retired accounts', () => assert.deepEqual(x.pool.eligible(MODEL).map(e => e.account.id).sort(), ['synthetic-active', 'synthetic-second']));
  check('lifetime, account and model usage counters', () => assert.deepEqual({ lifetime: x.usage.state.lifetime, byAccount: x.usage.state.byAccount, byModel: x.usage.state.byModel }, expected.usage));
  check('uploaded and generated media bytes and access scopes', () => {
    for (const item of expected.media) {
      assert.equal(sha(x.media.get(item.id, { scope: item.scope }).buffer), item.sha256);
      assert.equal(x.media.get(item.id, { scope: 'wrong-scope' }), null);
    }
  });
  await x.session.transact(OWNER, SESSION, null, (state, checkpoint) => {
    check('session IDs, request index and exact signed response recovery', () => {
      assert.deepEqual({ cascadeId: state.cascadeId, trajectoryId: state.trajectoryId, requestIndex: state.requestIndex }, expected.session);
      const visible = { role: 'model', parts: [{ text: ANSWER.parts[0].text }] };
      assert.deepEqual(m.restoreHistory(state, [...PREFIX, visible], MODEL)[1], ANSWER);
    });
    if (stage === 'upgrade') { state.receiptTransforms ||= {}; checkpoint(); }
  });
  check('service identity, prefix-based executable and configuration paths', () => assert.deepEqual(serviceContract(m, install, root), expected.service));
  const source = fs.readFileSync(path.join(install, 'antigravity-gateway.js'), 'utf8');
  check('default port and config directory rules', () => {
    assert.match(source, /ANTIGRAVITY_GATEWAY_PORT\s*\|\|\s*9897/);
    assert.match(source, /ANTIGRAVITY_GATEWAY_CONFIG_DIR\s*\|\|\s*path\.join\(os\.homedir\(\),\s*['"]\.antigravity-gateway['"]\)/);
  });
  return { stage, checks, passed: checks.length };
}

async function main() {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
  if (args[0] === '--guard') return runtimeGuard(process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR,
    process.env.UPGRADE_DENY_LEGACY === '1', process.env.UPGRADE_GUARD_REPORT);
  if (args[0] === '--worker') {
    const [, mode, install, root] = args;
    const result = mode === 'seed' ? await seed(install, root) : await verify(install, root, mode);
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  if (args.includes('--help') || !option('--old-install')) {
    console.log('Usage: node scripts/verify-upgrade.js --old-install /absolute/old/installation [--worktree /absolute/source] [--output /new/evidence/directory]');
    if (!args.includes('--help')) process.exitCode = 1;
    return;
  }
  const oldInstall = path.resolve(option('--old-install')), worktree = path.resolve(option('--worktree') || path.join(__dirname, '..'));
  const root = option('--output') ? path.resolve(option('--output')) : fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-upgrade-'));
  assert(!inside(root, oldInstall) && !inside(root, worktree), 'Evidence must be outside both package trees');
  assert(!fs.existsSync(root) || fs.readdirSync(root).length === 0, 'Use a fresh, empty evidence directory');
  for (const name of ['tmp', 'logs', 'packs/old', 'packs/new', 'config']) fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const name of ['empty.npmrc', 'empty-global.npmrc']) fs.writeFileSync(path.join(root, name), '');
  const env = environment(root), prefix = path.join(root, 'npm-prefix'), install = path.join(prefix, 'lib/node_modules/antigravity-gateway');
  const oldBefore = inventory(oldInstall), startedAt = new Date().toISOString();
  const summary = { schemaVersion: 1, startedAt, node: process.version, platform: `${process.platform}/${process.arch}`,
    worktree, evidenceDirectory: root, oldInstall, prefix, configDirectory: env.ANTIGRAVITY_GATEWAY_CONFIG_DIR,
    commandFlags: ['--global', '--foreground-scripts', '--allow-scripts=antigravity-gateway'],
    packages: {}, stages: [], serviceExecution: 'configuration rendering only; no service was started or restarted',
    runtimeNetwork: false, formalAccountDataRead: false };
  const command = (name, command, args, cwd = root, commandEnv = env) => run(command, args, { cwd, env: commandEnv, log: path.join(root, 'logs', `${name}.log`) });
  try {
    summary.npm = (await command('npm-version', 'npm', ['--version'])).stdout.trim();
    for (const [label, directory] of [['old', oldInstall], ['new', worktree]]) {
      const before = inventory(directory), packDir = path.join(root, 'packs', label);
      const packed = JSON.parse((await command(`pack-${label}`, 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], directory)).stdout)[0];
      const archive = path.join(packDir, packed.filename);
      summary.packages[label] = { name: packed.name, version: packed.version, archive, sha256: sha(fs.readFileSync(archive)),
        packedAt: new Date().toISOString(), packedFiles: packed.files.map(item => item.path), bytes: packed.size,
        sourceInventorySha256: sha(JSON.stringify(before)), sourceChangedDuringPack: sha(JSON.stringify(before)) !== sha(JSON.stringify(inventory(directory))) };
      assert.equal(packed.name, 'antigravity-gateway');
      assert(summary.packages[label].packedFiles.some(file => file.startsWith('native/bin/') && !file.endsWith('.json')), `${label} must include native binaries`);
    }
    const removed = summary.packages.old.packedFiles.filter(file => file.startsWith('src/') && !summary.packages.new.packedFiles.includes(file));
    assert(removed.includes('src/robin-provider.js') && removed.includes('src/gemini-windows-provider.js') && removed.includes('src/agy-worker.js'));
    summary.removedRuntimeFiles = removed;
    const guard = path.join(root, 'runtime-guard.cjs');
    fs.writeFileSync(guard, `const fs = require('node:fs'), os = require('node:os'), path = require('node:path');\nconst inside = ${inside.toString()};\n(${runtimeGuard.toString()})(process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR, process.env.UPGRADE_DENY_LEGACY === '1', process.env.UPGRADE_GUARD_REPORT);\n`);
    for (const [stage, label] of [['old', 'old'], ['upgrade', 'new'], ['rollback', 'old']]) {
      console.log(`Running isolated ${stage} npm installation...`);
      const log = await command(`install-${stage}`, 'npm', ['install', '--global', '--foreground-scripts', '--allow-scripts=antigravity-gateway', '--prefix', prefix, summary.packages[label].archive]);
      assert.match(`${log.stdout}${log.stderr}`, /Environment ready:/, 'postinstall must execute');
      assert.equal(json(path.join(install, 'package.json')).name, 'antigravity-gateway');
      assert.equal(json(path.join(install, 'package.json')).bin['antigravity-gateway'], 'antigravity-gateway.js');
      const bin = path.join(prefix, 'bin', 'antigravity-gateway');
      assert.equal(fs.realpathSync(bin), path.join(install, 'antigravity-gateway.js'));
      for (const file of removed) assert.equal(fs.existsSync(path.join(install, file)), stage !== 'upgrade', `${stage}: ${file}`);
      const probeEnv = { ...env, NODE_OPTIONS: `--require=${JSON.stringify(guard)}`, UPGRADE_DENY_LEGACY: stage === 'upgrade' ? '1' : '0' };
      const versionGuard = path.join(root, `guard-${stage}-version.json`);
      const version = await command(`version-${stage}`, bin, ['--version'], root, { ...probeEnv, UPGRADE_GUARD_REPORT: versionGuard });
      assert.equal(version.stdout.trim(), summary.packages[label].version);
      const versionAudit = json(versionGuard); assert.deepEqual(versionAudit.violations, []);
      if (stage === 'upgrade') assert.deepEqual(versionAudit.accesses, []);
      if (stage === 'old') {
        const seedGuard = path.join(root, 'guard-seed.json');
        await command('seed', process.execPath, [__filename, '--worker', 'seed', install, root], root, { ...probeEnv, UPGRADE_GUARD_REPORT: seedGuard });
        assert.deepEqual(json(seedGuard).violations, []);
      }
      const workerGuard = path.join(root, `guard-${stage}-verify.json`);
      const result = await command(`verify-${stage}`, process.execPath, [__filename, '--worker', stage, install, root], root,
        { ...probeEnv, UPGRADE_GUARD_REPORT: workerGuard });
      const audit = json(workerGuard); assert.deepEqual(audit.violations, []);
      if (stage === 'upgrade') assert.deepEqual(audit.accesses, []);
      // Integrity verification belongs to this harness, outside the audited
      // package runtime, so new runtime reads of retired files remain forbidden.
      for (const [relative, hash] of Object.entries(json(path.join(root, 'expected.json')).files)) {
        if (relative.startsWith(`state${path.sep}agy-sessions${path.sep}`)) continue;
        assert.equal(sha(fs.readFileSync(path.join(env.ANTIGRAVITY_GATEWAY_CONFIG_DIR, relative))), hash, relative);
      }
      summary.stages.push({ ...JSON.parse(result.stdout), postinstallExecuted: true, version: version.stdout.trim(),
        binRelativePath: path.relative(prefix, bin), retiredRuntimePathsPresent: stage !== 'upgrade',
        versionLegacyAccessCount: versionAudit.accesses.length, moduleLegacyAccessCount: audit.accesses.length,
        persistentFilesByteIdentical: true });
      write(path.join(root, 'summary.json'), summary);
    }
    assert.deepEqual(inventory(oldInstall), oldBefore, 'Formal old installation must stay unchanged');
    summary.oldInstallationUnchanged = true;
    summary.status = 'passed'; summary.completedAt = new Date().toISOString();
    write(path.join(root, 'summary.json'), summary);
    console.log(`Passed. Evidence: ${path.join(root, 'summary.json')}`);
  } catch (error) {
    summary.status = 'failed'; summary.failure = error.message; summary.completedAt = new Date().toISOString();
    write(path.join(root, 'summary.json'), summary); throw error;
  }
}

module.exports = { runtimeGuard };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
