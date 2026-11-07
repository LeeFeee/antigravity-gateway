#!/usr/bin/env node
'use strict';

// A single refresh of a disposable copy of an existing managed account. This
// does not validate a new Google authorization or create a new Google account.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { AccountStore, normalizeAccount } = require('../src/account-store');
const { AgyNativeTransport, resolveNativeBinary } = require('../src/agy-native-transport');
const { refreshCopy, requestEvidence, accountEvidence } = require('./verify-dashboard-oauth');

const ROOT = path.resolve(__dirname, '..');
const AUTH_SOURCES = ['src/account-store.js', 'src/managed-account-auth.js', 'src/local-agy-auth.js', 'src/oauth-flow.js',
  'src/agy-request-profile.js', 'src/agy-native-transport.js', 'native/main.go', 'native/bin/manifest.json',
  'scripts/verify-dashboard-oauth.js', 'scripts/verify-managed-oauth-refresh.js'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function sourceSnapshot() {
  const files = Object.fromEntries(AUTH_SOURCES.map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]));
  return { sha256: hash(JSON.stringify(files)), files };
}
function directorySnapshot(directory) {
  const entries = fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, 'oauth_refresh_source_entry_invalid');
    const bytes = fs.readFileSync(file);
    return { name, bytes, digest: hash(bytes) };
  });
  return { entries, public: { fileCount: entries.length,
    sha256: hash(entries.map(item => `${hash(item.name)}\0${item.digest}`).join('\n')) } };
}
function selectedAccount(entries) {
  const eligible = entries.filter(item => item.name.endsWith('.json')).flatMap(item => {
    try {
      const account = normalizeAccount(JSON.parse(item.bytes.toString('utf8')));
      return account && account.providerType === 'cloudcode' && account.enabled !== false
        && account.refreshToken && account.clientId && account.clientSecret ? [account] : [];
    } catch { return []; }
  });
  eligible.sort((a, b) => (Date.parse(b.expiresAt) || 0) - (Date.parse(a.expiresAt) || 0));
  assert.ok(eligible.length, 'oauth_refresh_eligible_account_missing');
  return eligible[0];
}
async function verify({ sourceDir = path.join(os.homedir(), '.antigravity-gateway/accounts'), reportFile,
  transportFactory = options => new AgyNativeTransport(options), binaryResolver = resolveNativeBinary } = {}) {
  process.umask(0o077);
  const base = process.platform === 'darwin' ? '/private/tmp' : fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'agw-refresh-only-'));
  const out = path.resolve(reportFile || path.join(base, `agw-managed-refresh-result-${crypto.randomBytes(8).toString('hex')}.json`));
  assert.ok(!out.startsWith(root + path.sep) && !fs.existsSync(out), 'oauth_refresh_report_path_invalid');
  let transport;
  const report = { evidence: 'existing-managed-account-refresh-copy-real-google', startedAt: new Date().toISOString(),
    passed: false, newGoogleAuthorizationVerified: false, originalAgyCredentialsRead: false, generationRequests: 0,
    sourceDirectory: '~/.antigravity-gateway/accounts', observations: [], source: sourceSnapshot() };
  try {
    const original = directorySnapshot(sourceDir);
    report.originalBefore = original.public;
    const account = selectedAccount(original.entries);
    for (const directory of ['config/accounts', 'home', 'tmp']) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
    const store = new AccountStore({ configDir: path.join(root, 'config') });
    store.save(account);
    report.account = accountEvidence(account);
    report.privateRootMode = (fs.statSync(root).mode & 0o777).toString(8);
    report.privateAccountModes = fs.readdirSync(store.directory).map(name => (fs.statSync(path.join(store.directory, name)).mode & 0o777).toString(8));
    const binaryPath = binaryResolver({ cacheDir: path.join(root, 'config/native'), binaryPath: '' });
    transport = transportFactory({ binaryPath, env: { HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
      PATH: '/usr/bin:/bin', ANTIGRAVITY_GATEWAY_CONFIG_DIR: path.join(root, 'config') } });
    report.refresh = await refreshCopy({ root }, { fetchImpl: async (url, options) => {
      const request = requestEvidence(url, options);
      assert.equal(request.host, 'oauth2.googleapis.com'); assert.equal(request.path, '/token');
      assert.equal(request.grantType, 'refresh_token'); assert.equal(report.observations.length, 0, 'oauth_refresh_second_request_denied');
      const observation = { ...request };
      report.observations.push(observation);
      const response = await transport.fetch(url, options);
      observation.status = response.status;
      return response;
    } });
    report.passed = report.refresh.passed === true && report.observations.length === 1 && report.observations[0].status === 200;
  } catch (error) {
    report.failure = { code: /^oauth_refresh_[a-z_]+$/.test(error.message || '') ? error.message : 'oauth_refresh_failed' };
  } finally {
    try {
      const child = transport?.child;
      transport?.close();
      if (child && child.exitCode === null && !child.signalCode) {
        await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(2000)]);
        if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await delay(100); }
      }
      report.nativeStopped = !child || child.exitCode !== null || Boolean(child.signalCode);
    } catch { report.nativeStopped = false; }
    try {
      report.originalAfter = directorySnapshot(sourceDir).public;
      report.originalBytesUnchanged = report.originalBefore?.sha256 === report.originalAfter.sha256;
      report.authSourceUnchanged = report.source.sha256 === sourceSnapshot().sha256;
    } catch { report.originalBytesUnchanged = false; report.authSourceUnchanged = false; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.temporaryCredentialsRemoved = !fs.existsSync(root); }
    catch { report.temporaryCredentialsRemoved = false; }
    report.passed &&= report.nativeStopped && report.originalBytesUnchanged && report.authSourceUnchanged && report.temporaryCredentialsRemoved;
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return { reportFile: out, passed: report.passed, report };
}

module.exports = { verify, directorySnapshot, selectedAccount, sourceSnapshot };
if (require.main === module) {
  const index = process.argv.indexOf('--out');
  verify({ reportFile: index < 0 ? undefined : process.argv[index + 1] }).then(result => {
    console.log(JSON.stringify({ reportFile: result.reportFile, passed: result.passed, newGoogleAuthorizationVerified: false }));
    if (!result.passed) process.exitCode = 1;
  }).catch(() => { console.error('Managed OAuth refresh verification failed; no credential or upstream payload is printed.'); process.exitCode = 1; });
}
