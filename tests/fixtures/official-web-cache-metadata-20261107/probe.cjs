#!/usr/bin/env node
'use strict';

// Bounded real metadata verification derived from the official 1.5.2 protobuf
// definitions and static client call sites. This is NOT an official CLI capture.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '../../..');
const { AccountStore } = require(path.join(ROOT, 'src/account-store'));
const { AccountPool } = require(path.join(ROOT, 'src/account-pool'));
const { QuotaManager } = require(path.join(ROOT, 'src/quota-manager'));
const { DirectAntigravityProvider } = require(path.join(ROOT, 'src/direct-provider'));
const { ManagedAccountAuthProvider } = require(path.join(ROOT, 'src/managed-account-auth'));
const { AgySessionStore } = require(path.join(ROOT, 'src/agy-session-state'));
const { AgyNativeTransport, resolveNativeBinary } = require(path.join(ROOT, 'src/agy-native-transport'));
const { cliUserAgent } = require(path.join(ROOT, 'src/agy-request-profile'));
const { accountSnapshot, copyManagedState, sourceSnapshot, scrub, privateWrite, STATE_FILES } = require(path.join(ROOT, 'scripts/verify-real-client-gateway'));
const ORIGIN = 'https://daily-cloudcode-pa.googleapis.com';
const REWRITE = ORIGIN + '/v1internal:rewriteUri';
const CACHE = ORIGIN + '/v1internal:fetchFromTrawlerCache';
const ELIGIBILITY_MODEL = 'gemini-3.8-flash-low';
const TARGET = 'https://note.com/fair_godwit407/n/nc4fbc66c256f';
const EXPECTED_URI_SHA = 'c060845363b652e0b6acb3ad6f8a437610c759ecd7267202f87373fec49c4725';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixedSource() {
  const file = path.join(ROOT, 'tests/fixtures/client-web-tools-20261107/latest-release-batch/grounding-source-redirects.json');
  const bytes = fs.readFileSync(file), prior = JSON.parse(bytes);
  const selected = prior.observations.find(item => item.chunkIndex === 1);
  if (sha(selected.sourceUri) !== EXPECTED_URI_SHA || selected.effectiveUrl !== TARGET || !selected.reachedEffectiveUrl) {
    throw new Error('Existing fixed grounding source differs from the approved public URL');
  }
  return { originalUri: selected.sourceUri, targetUrl: TARGET, fixture: path.relative(ROOT, file), fixtureSha256: sha(bytes), chunkIndex: 1 };
}

function stateSnapshot(directory) {
  return Object.fromEntries(STATE_FILES.map(name => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('State snapshot requires ordinary files');
    return [name, sha(fs.readFileSync(file))];
  }));
}

function structure(value) {
  if (Array.isArray(value)) return value.map(structure);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structure(item)]));
  return value === null ? 'null' : typeof value;
}

function createGuard(transport, fixed, report, signal) {
  let count = 0, rewritten = false;
  return {
    get count() { return count; },
    confirmRewrite(value) {
      if (count !== 1 || value !== fixed.targetUrl) throw new Error('Rewrite did not confirm the one approved public target');
      rewritten = true;
    },
    async fetch(url, options = {}) {
      const expected = count === 0 ? REWRITE : count === 1 && rewritten ? CACHE : null;
      const expectedBody = count === 0 ? { originalUri: fixed.originalUri } : { url: fixed.targetUrl, liveFetch: false };
      if (url !== expected || options.method !== 'POST' || options.body !== JSON.stringify(expectedBody)) {
        throw new Error('Denied: only the fixed rewrite followed by cache-only read is authorized');
      }
      count++;
      const observation = { endpoint: url, method: 'POST', body: expectedBody,
        transport: 'unmodified AgyNativeTransport.fetch', dispatch: count };
      report.observations.push(observation);
      const response = await transport.fetch(url, { ...options, signal });
      observation.status = response.status;
      return response;
    }
  };
}

async function readResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Metadata response exceeds the bounded evidence size');
  let value = null;
  try { value = JSON.parse(text); } catch {}
  return { text, value };
}

async function run({ out, execute = false, expectedSource = '', source = path.join(os.homedir(), '.antigravity-gateway') }) {
  process.umask(0o077);
  if (!out || fs.existsSync(out)) throw new Error('Use a new evidence path; existing evidence is never overwritten');
  const fixed = fixedSource();
  const report = { evidence: 'static-client-derived-real-google-metadata-verification',
    officialCliDynamicCapture: false, startedAt: new Date().toISOString(), source: sourceSnapshot(),
    scriptSha256: sha(fs.readFileSync(__filename)), approvedSource: fixed, observations: [],
    businessRpcLimit: 2, modelGenerationCount: 0, authenticationRefreshAllowed: false,
    retryPolicy: 'no retry, host fallback, account fallback, alternative URL, or liveFetch',
    wireBoundary: 'unchanged native transport and CLI UA; no independent packet capture' };
  if (expectedSource && report.source.sha256 !== expectedSource) throw new Error('Runtime source is outside the frozen snapshot');
  if (!execute) {
    report.preparedOnly = true;
    privateWrite(out, report);
    return report;
  }
  const root = fs.mkdtempSync('/private/tmp/agw-web-cache-metadata-');
  fs.chmodSync(root, 0o700);
  const configDir = path.join(root, 'config');
  let transport, guard, quota, store, secrets = [];
  const signal = AbortSignal.timeout(55000);
  try {
    report.originalStateBefore = stateSnapshot(source);
    const copy = copyManagedState(source, configDir);
    secrets = copy.secrets;
    report.originalAccountsBefore = copy.before;
    report.copiedState = copy.summary;
    store = new AccountStore({ configDir });
    report.privateDirectoryMode = (fs.statSync(root).mode & 0o777).toString(8);
    report.privateAccountModes = fs.readdirSync(store.directory).map(name => (fs.statSync(path.join(store.directory, name)).mode & 0o777).toString(8));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/bin/manifest.json'), 'utf8'));
    const binaryPath = resolveNativeBinary({ cacheDir: path.join(configDir, 'native'), binaryPath: '' });
    report.nativeManifest = { sourceSha256: manifest.sourceSha256, platform: `${process.platform}-${process.arch}`,
      binarySha256: sha(fs.readFileSync(binaryPath)) };
    if (report.nativeManifest.binarySha256 !== manifest.platforms[report.nativeManifest.platform]?.sha256) throw new Error('Native manifest verification failed');
    fs.mkdirSync(path.join(root, 'home')); fs.mkdirSync(path.join(root, 'tmp'));
    transport = new AgyNativeTransport({ binaryPath, env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir } });
    guard = createGuard(transport, fixed, report, signal);
    const guardedFetch = (url, options) => guard.fetch(url, options);
    const pool = new AccountPool({ store, fetchImpl: guardedFetch, providerFactory: account => new DirectAntigravityProvider({
      fetchImpl: guardedFetch, maxRetries: 0, baseUrl: ORIGIN, userAgent: cliUserAgent(),
      localAuth: new ManagedAccountAuthProvider({ account, store, fetchImpl: guardedFetch }),
      sessionStore: new AgySessionStore({ directory: path.join(configDir, 'state/agy-sessions') })
    }) });
    quota = new QuotaManager({ configDir, accountPool: pool });
    // Preserve original eligibility/ranking methods and copied protection data.
    // Expose only reads so account selection cannot enqueue unrelated metadata.
    pool.quotaManager = Object.fromEntries(['get', 'getSchedulingSnapshot', 'isQuotaProtected'].map(name => [name, quota[name].bind(quota)]));
    const excluded = new Set([...pool.entries.values()].filter(entry => !entry.account.accessToken
      || !(Date.parse(entry.account.expiresAt) > Date.now() + 120000)).map(entry => entry.account.id));
    report.selection = { eligibilityModel: ELIGIBILITY_MODEL, noModelRequest: true,
      mechanism: 'unmodified AccountPool eligibility and weighted selection with read-only copied QuotaManager data; no model catalog request',
      eligibleWithValidToken: pool.eligible(ELIGIBILITY_MODEL, excluded).length, excludedExpiredOrMissingToken: excluded.size };
    const entry = pool.selectAccount(ELIGIBILITY_MODEL, 'bounded-web-cache-metadata', excluded);
    if (!entry || !pool.isEntryEligible(entry, ELIGIBILITY_MODEL, excluded)) throw new Error('No eligible account has a valid token; no refresh is authorized');
    Object.assign(report.selection, { healthState: entry.healthState, enabled: entry.account.enabled !== false,
      quotaProtected: quota.isQuotaProtected(entry.account.id, ELIGIBILITY_MODEL),
      cooldownActive: entry.cooldownUntil > Date.now(), modelCooldownActive: (entry.modelCooldowns.get(ELIGIBILITY_MODEL) || 0) > Date.now() });
    const token = await entry.provider.access(signal);
    secrets.push(token);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': cliUserAgent() };
    report.requestHeaders = headers;
    const rewrite = await guardedFetch(REWRITE, { method: 'POST', headers, body: JSON.stringify({ originalUri: fixed.originalUri }) });
    const first = await readResponse(rewrite);
    report.rewrite = { status: rewrite.status, structure: structure(first.value), body: first.value || first.text };
    if (!rewrite.ok) { report.stoppedBecause = 'rewrite_http_failure'; return report; }
    if (first.value?.redirectUri !== fixed.targetUrl) { report.stoppedBecause = 'rewrite_did_not_confirm_approved_target'; return report; }
    guard.confirmRewrite(first.value.redirectUri);
    const cache = await guardedFetch(CACHE, { method: 'POST', headers, body: JSON.stringify({ url: fixed.targetUrl, liveFetch: false }) });
    const second = await readResponse(cache), content = second.value?.content;
    report.cache = { status: cache.status, structure: structure(second.value),
      ...(cache.ok ? { contentPresent: typeof content === 'string' && content.length > 0,
        contentBytes: typeof content === 'string' ? Buffer.byteLength(content) : 0,
        contentSha256: typeof content === 'string' ? sha(content) : null,
        contentExcerpt: typeof content === 'string' ? content.slice(0, 1600) : '', excerptTruncated: typeof content === 'string' && content.length > 1600 }
        : { error: second.value || second.text }) };
    report.stoppedBecause = !cache.ok ? 'cache_http_failure' : !content ? 'cache_empty' : 'bounded_probe_completed';
  } catch (error) {
    report.failure = { code: error.code || 'probe_failed', message: error.message };
  } finally {
    quota?.stop();
    try {
      const child = transport?.child; transport?.close();
      if (child && child.exitCode === null && !child.signalCode) await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(2000)]);
      if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await delay(100); }
      report.nativeStopped = !child || child.exitCode !== null || Boolean(child.signalCode);
    } catch { report.nativeStopped = false; }
    try {
      report.originalAccountsAfter = accountSnapshot(source);
      report.originalAccountsUnchanged = report.originalAccountsBefore?.digest === report.originalAccountsAfter.digest;
      report.originalStateAfter = stateSnapshot(source);
      report.originalStateUnchanged = JSON.stringify(report.originalStateBefore) === JSON.stringify(report.originalStateAfter);
      report.sourceAfter = sourceSnapshot(); report.sourceUnchanged = report.source.sha256 === report.sourceAfter.sha256;
    } catch { report.snapshotVerificationFailed = true; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.temporaryCredentialsRemoved = !fs.existsSync(root); }
    catch { report.temporaryCredentialsRemoved = false; }
    report.businessRpcCount = guard?.count || 0;
    report.completedAt = new Date().toISOString();
    const clean = scrub(report, [...new Set(secrets)].sort((a, b) => b.length - a.length), root);
    privateWrite(out, clean);
    console.log(JSON.stringify({ file: out, businessRpcCount: clean.businessRpcCount, rewriteStatus: clean.rewrite?.status,
      cacheStatus: clean.cache?.status, contentPresent: clean.cache?.contentPresent, stoppedBecause: clean.stoppedBecause,
      failure: clean.failure, originalAccountsUnchanged: clean.originalAccountsUnchanged, originalStateUnchanged: clean.originalStateUnchanged,
      sourceUnchanged: clean.sourceUnchanged, temporaryCredentialsRemoved: clean.temporaryCredentialsRemoved, nativeStopped: clean.nativeStopped }));
  }
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2), at = args.indexOf('--out'), expected = args.indexOf('--expected-source');
  run({ out: path.resolve(at < 0 ? path.join(__dirname, args.includes('--run') ? 'real-result.json' : 'prepared.json') : args[at + 1]),
    execute: args.includes('--run'), expectedSource: expected < 0 ? '' : args[expected + 1] })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { fixedSource, createGuard, run, REWRITE, CACHE };
