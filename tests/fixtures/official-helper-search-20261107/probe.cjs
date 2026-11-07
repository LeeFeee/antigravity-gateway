#!/usr/bin/env node
'use strict';

// One real helper request through the new pool/provider APIs. This independently
// verifies gateway behavior; it is not an unmodified official CLI packet capture.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '../../..');
const { AccountStore } = require(path.join(ROOT, 'src/account-store'));
const { AccountPool } = require(path.join(ROOT, 'src/account-pool'));
const { QuotaManager } = require(path.join(ROOT, 'src/quota-manager'));
const { UsageStore } = require(path.join(ROOT, 'src/usage-store'));
const { DirectAntigravityProvider } = require(path.join(ROOT, 'src/direct-provider'));
const { ManagedAccountAuthProvider } = require(path.join(ROOT, 'src/managed-account-auth'));
const { AgySessionStore } = require(path.join(ROOT, 'src/agy-session-state'));
const { AgyNativeTransport, resolveNativeBinary } = require(path.join(ROOT, 'src/agy-native-transport'));
const { cliUserAgent } = require(path.join(ROOT, 'src/agy-request-profile'));
const { searchRequest } = require(path.join(ROOT, 'src/antigravity-server-search'));
const { accountSnapshot, copyManagedState, sourceSnapshot, scrub, privateWrite, STATE_FILES } = require(path.join(ROOT, 'scripts/verify-real-client-gateway'));
const ORIGIN = 'https://daily-cloudcode-pa.googleapis.com';
const ENDPOINT = ORIGIN + '/v1internal:generateContent';
const INPUT = Object.freeze({ query: 'site:example.com Example Domain', domain: 'example.com', maxOutputTokens: 2048 });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function stateSnapshot(directory) {
  return Object.fromEntries(STATE_FILES.map(name => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('State snapshot requires regular files');
    return [name, sha(fs.readFileSync(file))];
  }));
}
function collectSecrets(store) {
  return store.list().flatMap(account => ['id', 'email', 'subjectId', 'projectId', 'accessToken', 'refreshToken', 'clientId', 'clientSecret']
    .map(key => account[key]).filter(value => typeof value === 'string' && value.length >= 4));
}
function inspectSourceFields(body) {
  const candidates = (body?.response || body)?.candidates;
  return (Array.isArray(candidates) ? candidates : []).map(candidate => ({
    finishReason: candidate.finishReason,
    metadataKeys: Object.keys(candidate.groundingMetadata || {}),
    queries: candidate.groundingMetadata?.webSearchQueries,
    chunks: (candidate.groundingMetadata?.groundingChunks || []).map(chunk => ({
      keys: Object.keys(chunk), webKeys: Object.keys(chunk.web || {}),
      upstreamSourceTextPresent: typeof chunk.web?.text === 'string',
      upstreamSourceTextBytes: typeof chunk.web?.text === 'string' ? Buffer.byteLength(chunk.web.text) : 0
    }))
  }));
}

function createGuard(transport, report, selection, signal) {
  let count = 0;
  return {
    get generationCount() { return count; },
    async fetch(url, options = {}) {
      if (report.stopAfter429) throw Object.assign(new Error('Stopped after the first observed HTTP 429'), { code: 'probe_stopped_after_429', status: 429 });
      const parsed = new URL(url), method = options.method || 'GET';
      const generation = String(url) === ENDPOINT;
      const metadata = parsed.origin === ORIGIN && ['/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels',
        '/v1internal:retrieveUserQuotaSummary', '/v1internal:fetchUserInfo'].includes(parsed.pathname);
      const oauth = parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token';
      const userinfo = parsed.origin === 'https://www.googleapis.com' && parsed.pathname === '/oauth2/v2/userinfo';
      if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
        || !(generation || metadata || oauth || userinfo) || ((generation || metadata || oauth) && method !== 'POST')
        || (userinfo && method !== 'GET')) throw new Error('Endpoint or method outside bounded helper probe');
      let body;
      if (generation) {
        if (count >= 1) throw new Error('Second physical generation denied');
        body = JSON.parse(options.body);
        if (!selection.model || !selection.declaredModels?.includes(selection.model)
          || JSON.stringify(body) !== JSON.stringify(searchRequest({ ...INPUT, project: body.project, model: selection.model }))) {
          throw new Error('Generation differs from the fixed query and selected catalog helper');
        }
        count++;
        report.generationRequest = { endpoint: url, method, headers: options.headers, body };
      }
      const item = { endpoint: parsed.origin + parsed.pathname, method,
        purpose: generation ? 'single-helper-generation' : oauth ? 'credential-refresh' : userinfo ? 'identity-metadata' : 'eligibility-metadata',
        transport: 'unmodified AgyNativeTransport.fetch' };
      report.observations.push(item);
      const response = await transport.fetch(url, { ...options, signal: options.signal && signal ? AbortSignal.any([options.signal, signal]) : signal || options.signal });
      item.status = response.status;
      if (response.status === 429) report.stopAfter429 = true;
      if (generation) {
        const text = await response.clone().text();
        report.generationResponse = { status: response.status, byteLength: Buffer.byteLength(text), rawBodySha256: sha(text) };
        try { report.generationResponse.body = JSON.parse(text); }
        catch { report.generationResponse.nonJsonBody = text; }
        report.sourceFieldInspection = inspectSourceFields(report.generationResponse.body);
      } else if (parsed.pathname === '/v1internal:fetchAvailableModels' && response.ok) {
        try { item.webSearchModelIds = (await response.clone().json()).webSearchModelIds; } catch {}
      }
      return response;
    }
  };
}

async function run({ out, execute = false, expectedSource = '', source = path.join(os.homedir(), '.antigravity-gateway') }) {
  process.umask(0o077);
  if (!out || fs.existsSync(out)) throw new Error('Use a new evidence path; existing evidence is not overwritten');
  const report = { evidence: 'gateway-pool-catalog-selected-real-helper-search', officialCliDynamicCapture: false,
    startedAt: new Date().toISOString(), source: sourceSnapshot(), scriptSha256: sha(fs.readFileSync(__filename)),
    input: INPUT, physicalGenerationLimit: 1, observations: [],
    modelSelection: 'unmodified AccountPool.searchWeb chooses an eligible account and its actual webSearchModelIds; no main-model override',
    retryPolicy: 'no generation retry, account fallback, second trace request, alternative query or domain',
    rawResponseBoundary: 'complete generation JSON before provider parsing, recursively credential/account redacted before disk',
    transportBoundary: 'unmodified native Go transport and CLI UA; no independent TLS capture' };
  if (expectedSource && report.source.sha256 !== expectedSource) throw new Error('Runtime source differs from frozen snapshot');
  if (!execute) { report.preparedOnly = true; privateWrite(out, report); return report; }
  const root = fs.mkdtempSync('/private/tmp/agw-helper-search-'); fs.chmodSync(root, 0o700);
  const configDir = path.join(root, 'config'), selected = {};
  let transport, guard, quota, store, usage, secrets = [];
  const signal = AbortSignal.timeout(90000);
  try {
    report.originalStateBefore = stateSnapshot(source);
    const copy = copyManagedState(source, configDir); secrets.push(...copy.secrets);
    report.originalAccountsBefore = copy.before; report.copiedState = copy.summary;
    store = new AccountStore({ configDir }); usage = new UsageStore({ configDir });
    report.privateDirectoryMode = (fs.statSync(root).mode & 0o777).toString(8);
    report.privateAccountModes = fs.readdirSync(store.directory).map(name => (fs.statSync(path.join(store.directory, name)).mode & 0o777).toString(8));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/bin/manifest.json'), 'utf8'));
    const binaryPath = resolveNativeBinary({ cacheDir: path.join(configDir, 'native'), binaryPath: '' });
    report.nativeManifest = { sourceSha256: manifest.sourceSha256, platform: `${process.platform}-${process.arch}`, binarySha256: sha(fs.readFileSync(binaryPath)) };
    if (report.nativeManifest.binarySha256 !== manifest.platforms[report.nativeManifest.platform]?.sha256) throw new Error('Native manifest verification failed');
    fs.mkdirSync(path.join(root, 'home')); fs.mkdirSync(path.join(root, 'tmp'));
    transport = new AgyNativeTransport({ binaryPath, env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir } });
    guard = createGuard(transport, report, selected, signal);
    const guardedFetch = (url, options) => guard.fetch(url, options);
    const pool = new AccountPool({ store, usageStore: usage, fetchImpl: guardedFetch, providerFactory: account => new DirectAntigravityProvider({
      fetchImpl: guardedFetch, maxRetries: 0, baseUrl: ORIGIN, userAgent: cliUserAgent(),
      localAuth: new ManagedAccountAuthProvider({ account, store, fetchImpl: guardedFetch }),
      sessionStore: new AgySessionStore({ directory: path.join(configDir, 'state/agy-sessions') })
    }) });
    quota = new QuotaManager({ configDir, accountPool: pool }); pool.quotaManager = quota;
    const result = await pool.searchWeb(INPUT, { signal, sessionId: 'single-catalog-helper-probe', onAccountSelected: event => {
      const entry = pool.entries.get(event.accountId);
      if (!entry || !pool.isEntryEligible(entry, event.model, new Set(), Date.now(), 'web-search')) throw new Error('Selected helper account is ineligible');
      Object.assign(selected, { model: event.model, declaredModels: entry.provider.webSearchModelCatalog() });
      report.selection = { ...selected, enabled: entry.account.enabled !== false, healthState: entry.healthState,
        quotaProtected: quota.isQuotaProtected(entry.account.id, event.model), cooldownActive: entry.cooldownUntil > Date.now(),
        modelCooldownActive: (entry.modelCooldowns.get(event.model) || 0) > Date.now(), attempt: event.attempt };
    } });
    report.parsedResult = result;
  } catch (error) {
    report.failure = { code: error.code || 'probe_failed', status: error.status, message: error.message, details: error.details };
  } finally {
    try { quota?.stop(); await quota?.drain(); } catch {}
    try { if (store) secrets.push(...collectSecrets(store)); } catch {}
    try { usage?.stop(); report.usage = usage?.state?.lifetime; } catch {}
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
    report.physicalGenerationCount = guard?.generationCount || 0;
    report.requestCounts = Object.fromEntries([...new Set(report.observations.map(item => item.purpose))].map(purpose => [purpose, report.observations.filter(item => item.purpose === purpose).length]));
    report.completedAt = new Date().toISOString();
    const clean = scrub(report, [...new Set(secrets)].sort((a, b) => b.length - a.length), root);
    privateWrite(out, clean);
    console.log(JSON.stringify({ file: out, physicalGenerationCount: clean.physicalGenerationCount, model: clean.selection?.model,
      status: clean.generationResponse?.status, failure: clean.failure, requestCounts: clean.requestCounts,
      sourceFieldInspection: clean.sourceFieldInspection, originalAccountsUnchanged: clean.originalAccountsUnchanged,
      originalStateUnchanged: clean.originalStateUnchanged, sourceUnchanged: clean.sourceUnchanged,
      temporaryCredentialsRemoved: clean.temporaryCredentialsRemoved, nativeStopped: clean.nativeStopped }));
  }
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2), at = args.indexOf('--out'), expected = args.indexOf('--expected-source');
  run({ out: path.resolve(at < 0 ? path.join(__dirname, args.includes('--run') ? 'real-result.json' : 'prepared.json') : args[at + 1]),
    execute: args.includes('--run'), expectedSource: expected < 0 ? '' : args[expected + 1] })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createGuard, inspectSourceFields, run, INPUT, ENDPOINT };
