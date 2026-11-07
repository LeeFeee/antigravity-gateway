#!/usr/bin/env node
'use strict';

// One bounded capability probe, never a production server-tool implementation.
// Account selection and protection are the real pool's; only disposable copies
// may be updated. The final generation calls unchanged native Go exactly once.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { AccountStore } = require('../src/account-store');
const { AccountPool } = require('../src/account-pool');
const { QuotaManager } = require('../src/quota-manager');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');
const { AgySessionStore } = require('../src/agy-session-state');
const { AgyNativeTransport, resolveNativeBinary } = require('../src/agy-native-transport');
const { cliUserAgent } = require('../src/agy-request-profile');
const { resolveModelConfiguration } = require('../src/antigravity-model-config');
const { accountSnapshot, copyManagedState, sourceSnapshot, scrub, privateWrite, STATE_FILES } = require('./verify-real-client-gateway');
const ROOT = path.resolve(__dirname, '..');
const MODEL = 'claude-sonnet-4-6';
const BATCH_MODELS = [MODEL, 'gemini-3.8-flash-low'];
const LATEST_QUERY = 'site:github.com/google-gemini/gemini-cli/releases What is the latest published Google Gemini CLI release version as of 2026-11-07? Search the current releases page and cite its source.';
const ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent';
const EXPECTED_NATIVE_SOURCE = '47e34ff9c729c93109f673028e3e2435e7960b373e60b369dab9fa7e1be5f5dc';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function stateSnapshot(configDir) {
  return Object.fromEntries(STATE_FILES.map(name => {
    const file = path.join(configDir, name);
    if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid original state file');
    return [name, sha(fs.readFileSync(file))];
  }));
}
function structure(value) {
  if (Array.isArray(value)) return value.map(structure);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structure(item)]));
  return value === null ? 'null' : typeof value;
}
function collectSecrets(store) {
  return store.list().flatMap(account => ['id','email','subjectId','projectId','accessToken','refreshToken','clientId','clientSecret']
    .map(key => account[key]).filter(value => typeof value === 'string' && value.length >= 4));
}
function buildRequest(project, { model = MODEL, latestRelease = false } = {}) {
  if(!BATCH_MODELS.includes(model))throw new Error('Model outside explicitly approved probe set');
  const fixture = require('../tests/fixtures/official-request-types-20261107/web-search-v2.json');
  const official = fixture.requests.find(item => item.body?.requestType === 'web_search');
  if (!official || official.url !== ENDPOINT) throw new Error('Official synchronous web_search envelope missing');
  const body = structuredClone(official.body);
  body.project = project; body.model = model;
  body.request.contents[0].parts = [{ text: latestRelease ? LATEST_QUERY : 'site:example.com Example Domain' }];
  body.request.tools[0].googleSearch.includedDomains = [latestRelease ? 'github.com' : 'example.com'];
  body.request.generationConfig = { candidateCount: 1, maxOutputTokens: 2048,
    thinkingConfig: resolveModelConfiguration(model).thinkingConfig };
  return body;
}
async function run({ source = path.join(os.homedir(), '.antigravity-gateway'), out, execute = false, model = MODEL, latestRelease = false } = {}) {
  process.umask(0o077);
  if(!BATCH_MODELS.includes(model))throw new Error('Model outside explicitly approved probe set');
  if (!out || fs.existsSync(out)) throw new Error('Choose a new report file; existing evidence is never overwritten');
  const root = fs.mkdtempSync('/private/tmp/agw-sonnet-search-');
  fs.chmodSync(root, 0o700);
  const configDir = path.join(root, 'config');
  let transport, store, quota, snapshot, generationCount = 0, secrets = [], report;
  const signal = AbortSignal.timeout(90000);
  try {
    report = { evidence: latestRelease ? 'single-explicit-model-native-search-latest-release-capability' : 'single-explicit-sonnet-native-google-search-capability', startedAt: new Date().toISOString(),
      productionEnabled: false, model, source: sourceSnapshot(), observations: [],
      requestedGenerationLimit: 1, retryPolicy: 'no generation retry or account fallback',
      scope: 'acceptance of same-model native search only; not proof of named tool_choice or max_uses equivalence',
      wireBoundary: 'original native Go transport after synchronous generateContent Content-Length fix; streaming generation remains chunked; this probe does not independently capture TLS packets' };
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT,'native/bin/manifest.json'),'utf8'));
    if(manifest.sourceSha256!==EXPECTED_NATIVE_SOURCE)throw new Error('Native source manifest differs from approved probe snapshot');
    report.nativeManifest={sourceSha256:manifest.sourceSha256,platform:`${process.platform}-${process.arch}`,
      binarySha256:manifest.platforms[`${process.platform}-${process.arch}`]?.sha256};
    report.originalStateBefore = stateSnapshot(source);
    snapshot = copyManagedState(source, configDir); secrets.push(...snapshot.secrets);
    report.originalAccountsBefore = snapshot.before;
    report.copiedState = snapshot.summary;
    store = new AccountStore({ configDir });
    report.privateDirectoryMode = (fs.statSync(root).mode & 0o777).toString(8);
    report.privateAccountModes = fs.readdirSync(store.directory).map(name => (fs.statSync(path.join(store.directory,name)).mode & 0o777).toString(8));
    if (!execute) { report.preparedOnly = true; return report; }
    fs.mkdirSync(path.join(root,'home')); fs.mkdirSync(path.join(root,'tmp'));
    const binaryPath = resolveNativeBinary({ cacheDir: path.join(configDir,'native'), binaryPath: '' });
    if(sha(fs.readFileSync(binaryPath))!==report.nativeManifest.binarySha256)throw new Error('Resolved binary does not match approved manifest');
    transport = new AgyNativeTransport({ binaryPath, env: { PATH: '/usr/bin:/bin', HOME: path.join(root,'home'), TMPDIR: path.join(root,'tmp'), ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir } });
    const guardedFetch = async (url, options = {}) => {
      if(report.stopAfter429)throw Object.assign(new Error('Probe stopped after first observed HTTP 429'),{status:429,code:'probe_stopped_after_429'});
      const parsed = new URL(url);
      const generation = parsed.pathname === '/v1internal:generateContent';
      const metadata = /^(daily-)?cloudcode-pa\.googleapis\.com$/.test(parsed.hostname)
        && ['/v1internal:loadCodeAssist','/v1internal:fetchAvailableModels','/v1internal:retrieveUserQuotaSummary','/v1internal:fetchUserInfo'].includes(parsed.pathname);
      const oauth = parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/token';
      if (parsed.protocol !== 'https:' || parsed.port || parsed.search || !(metadata || oauth || (generation && String(url) === ENDPOINT))) throw new Error('Probe endpoint denied');
      if (generation && ++generationCount > 1) throw new Error('Second generation denied before native transport');
      const observation = { endpoint: parsed.origin + parsed.pathname, method: options.method || 'GET', purpose: generation ? 'single-generation' : oauth ? 'credential-refresh' : 'eligibility-metadata', transport: 'original-AgyNativeTransport.fetch' };
      report.observations.push(observation);
      const response = await transport.fetch(url, { ...options, signal: options.signal ? AbortSignal.any([signal,options.signal]) : signal });
      observation.status = response.status;
      if(response.status===429)report.stopAfter429=true;
      return response;
    };
    const pool = new AccountPool({ store, fetchImpl: guardedFetch, providerFactory: account => new DirectAntigravityProvider({
      fetchImpl: guardedFetch, maxRetries: 0, baseUrl: 'https://daily-cloudcode-pa.googleapis.com', userAgent: cliUserAgent(),
      localAuth: new ManagedAccountAuthProvider({ account, store, fetchImpl: guardedFetch }),
      sessionStore: new AgySessionStore({ directory: path.join(configDir,'state/agy-sessions') })
    }) });
    quota = new QuotaManager({ configDir, accountPool: pool }); pool.quotaManager = quota;
    await pool.ensureModelCatalogs(signal);
    if(report.stopAfter429)throw Object.assign(new Error('Probe stopped after eligibility returned HTTP 429'),{status:429,code:'probe_stopped_after_429'});
    report.eligibleAccountCount = pool.eligible(model).length;
    const entry = pool.selectAccount(model, 'single-native-search-probe', new Set());
    if (!entry) throw pool.noAccountError(model);
    await quota.drain();
    if(report.stopAfter429)throw Object.assign(new Error('Probe stopped after quota returned HTTP 429'),{status:429,code:'probe_stopped_after_429'});
    if (!pool.isEntryEligible(entry, model)) throw pool.noAccountError(model);
    if (!(entry.supportedModels instanceof Set) || !entry.supportedModels.has(model)) throw new Error('Selected account lacks the explicit model in its verified live catalog');
    report.selection = { enabled: entry.account.enabled !== false, healthState: entry.healthState,
      quotaProtected: quota.isQuotaProtected(entry.account.id, model), cooldownActive: entry.cooldownUntil > Date.now(),
      modelCooldownActive: (entry.modelCooldowns.get(model) || 0) > Date.now(), liveCatalogContainsExplicitModel: true,
      mechanism: 'unmodified AccountPool.ensureModelCatalogs/selectAccount/isEntryEligible with copied QuotaManager state' };
    const accessToken = await entry.provider.access(signal);
    const project = await entry.provider.project(signal, accessToken);
    secrets.push(...collectSecrets(store), accessToken, project);
    const body = buildRequest(project,{model,latestRelease}), headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': cliUserAgent() };
    report.request = { endpoint: ENDPOINT, method: 'POST', headers, body };
    const response = await guardedFetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { value = null; }
    report.response = { status: response.status, bodyStructure: structure(value) };
    if (!response.ok) report.response.error = value?.error || value || text;
    else {
      const candidates = value?.response?.candidates || value?.candidates || [];
      report.response.candidates = candidates.map(candidate => ({ finishReason: candidate.finishReason,
        text: (candidate.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part=>part.text).join(''),
        groundingMetadata: candidate.groundingMetadata || null }));
      report.response.groundingObserved = candidates.some(candidate => candidate.groundingMetadata?.groundingChunks?.length || candidate.groundingMetadata?.webSearchQueries?.length);
      report.response.usageMetadata = value?.response?.usageMetadata || value?.usageMetadata;
      report.response.modelVersion = value?.response?.modelVersion || value?.modelVersion;
    }
    report.nativeBinarySha256 = sha(fs.readFileSync(binaryPath));
  } catch (error) {
    report ||= { evidence:'single-explicit-sonnet-native-google-search-capability', observations:[] };
    report.failure = { code:error.code || 'probe_failed', status:error.status, message:error.message, details:error.details };
  } finally {
    try { quota?.stop(); await quota?.drain(); } catch {}
    try { if (store) secrets.push(...collectSecrets(store)); } catch {}
    try {
      const child=transport?.child; transport?.close();
      if(child && child.exitCode===null && !child.signalCode) await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(2000)]);
      if(child && child.exitCode===null && !child.signalCode){child.kill('SIGKILL');await delay(100);}
      report.nativeStopped=!child || child.exitCode!==null || Boolean(child.signalCode);
    } catch { report.nativeStopped=false; }
    try {
      report.originalAccountsAfter=accountSnapshot(source);
      report.originalAccountsUnchanged=report.originalAccountsBefore?.digest===report.originalAccountsAfter.digest;
      report.originalStateAfter=stateSnapshot(source);
      report.originalStateUnchanged=JSON.stringify(report.originalStateBefore)===JSON.stringify(report.originalStateAfter);
      report.sourceUnchanged=report.source?.sha256===sourceSnapshot().sha256;
    } catch { report.snapshotVerificationFailed=true; }
    try { fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});report.temporaryCredentialsRemoved=!fs.existsSync(root); }
    catch { report.temporaryCredentialsRemoved=false; }
    report.generationCount=generationCount;
    report.completedAt=new Date().toISOString();
    const clean=scrub(report,[...new Set(secrets)].sort((a,b)=>b.length-a.length),root);
    privateWrite(out,clean);
    console.log(JSON.stringify({file:out,generationCount,status:clean.response?.status,error:clean.response?.error,failure:clean.failure,
      groundingObserved:clean.response?.groundingObserved,originalAccountsUnchanged:clean.originalAccountsUnchanged,originalStateUnchanged:clean.originalStateUnchanged,
      sourceUnchanged:clean.sourceUnchanged,temporaryCredentialsRemoved:clean.temporaryCredentialsRemoved,nativeStopped:clean.nativeStopped}));
  }
  return report;
}
async function runLatestBatch({outDir,execute=false}={}){
  if(!outDir)throw new Error('A new batch output directory is required');
  const targets=BATCH_MODELS.map((model,index)=>({model,file:path.join(outDir,index===0?'sonnet-latest-release.json':'gemini-low-latest-release.json')}));
  const summaryFile=path.join(outDir,'summary.json');
  if([summaryFile,...targets.map(target=>target.file)].some(file=>fs.existsSync(file)))throw new Error('Batch evidence already exists; refusing automatic additional generation');
  const summary={evidence:'explicit-two-model-native-search-capability-batch',startedAt:new Date().toISOString(),
    productionModelFallback:false,generationLimit:2,execute,query:LATEST_QUERY,domain:'github.com',results:[],generationCount:0};
  for(const target of targets){
    await run({out:target.file,execute,model:target.model,latestRelease:true});
    const report=JSON.parse(fs.readFileSync(target.file,'utf8'));
    summary.generationCount+=report.generationCount;
    summary.results.push({model:target.model,file:path.basename(target.file),generationCount:report.generationCount,status:report.response?.status,
      groundingObserved:report.response?.groundingObserved,failure:report.failure,source:report.source,sourceUnchanged:report.sourceUnchanged,
      originalAccountsUnchanged:report.originalAccountsUnchanged,originalStateUnchanged:report.originalStateUnchanged,temporaryCredentialsRemoved:report.temporaryCredentialsRemoved,nativeStopped:report.nativeStopped});
    if(report.stopAfter429||report.response?.status===429||report.failure?.status===429){summary.stoppedAfter429=true;break;}
    if(report.failure||!report.originalAccountsUnchanged||!report.originalStateUnchanged||!report.temporaryCredentialsRemoved||!report.nativeStopped){summary.stoppedAfterFailure=true;break;}
  }
  summary.completedAt=new Date().toISOString();privateWrite(summaryFile,summary);
  console.log(JSON.stringify({file:summaryFile,generationCount:summary.generationCount,stoppedAfter429:Boolean(summary.stoppedAfter429),results:summary.results.map(r=>({model:r.model,status:r.status,groundingObserved:r.groundingObserved,failure:r.failure}))}));
  return summary;
}
if(require.main===module){
  const args=process.argv.slice(2),at=args.indexOf('--out'),batch=args.indexOf('--batch');
  if(batch>=0&&args[batch+1]!=='latest-release')throw new Error('Unknown bounded batch');
  const task=batch>=0?runLatestBatch({outDir:path.resolve(at<0?'tests/fixtures/client-web-tools-20261107/latest-release-batch':args[at+1]),execute:args.includes('--run')})
    :run({out:path.resolve(at<0?'tests/fixtures/client-web-tools-20261107/sonnet-native-search-real.json':args[at+1]),execute:args.includes('--run')});
  task
    .catch(()=>{console.error('Sonnet native search probe failed before dispatch/report; no credential printed');process.exitCode=1;});
}
module.exports={buildRequest,run,runLatestBatch};
