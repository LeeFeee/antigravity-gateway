#!/usr/bin/env node
'use strict';

// User-driven dashboard OAuth acceptance controller. Preparation and startup do
// not initiate OAuth. Only the normal dashboard button starts its 5-minute flow.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { resolveAgyCommand } = require('../src/agy-installation');
const { resolveNativeBinary, nativeCloudCodeFetch, closeNativeTransport } = require('../src/agy-native-transport');
const { AccountStore } = require('../src/account-store');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');

const ROOT = path.resolve(__dirname, '..');
const KIND = 'antigravity-isolated-dashboard-oauth-v1';
const TEMP_BASE = process.platform === 'darwin' ? '/private/tmp' : fs.realpathSync(os.tmpdir());
const ALLOWED_RPC = new Set(['loadCodeAssist', 'fetchAvailableModels', 'retrieveUserQuotaSummary', 'fetchUserInfo', 'fetchAdminControls', 'listExperiments', 'onboardUser']);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}
function accountEvidence(account) {
  const fields = ['id', 'subjectId', 'email', 'accessToken', 'refreshToken', 'projectId', 'clientId', 'clientSecret'];
  return { fields: Object.fromEntries(fields.map(key => [key, typeof account?.[key] === 'string' && account[key].length > 0])),
    providerType: account?.providerType === 'cloudcode' ? 'cloudcode' : 'unexpected',
    expiresInFuture: Number.isFinite(Date.parse(account?.expiresAt)) && Date.parse(account.expiresAt) > Date.now(),
    enabled: account?.enabled === true };
}
function requestEvidence(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('oauth_probe_origin_denied');
  const rpc = /^\/v1internal:([A-Za-z]+)$/.exec(parsed.pathname)?.[1];
  const api = /^(daily-)?cloudcode-pa\.googleapis\.com$/.test(parsed.hostname);
  const oauth = parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/token';
  const userinfo = parsed.hostname === 'www.googleapis.com' && parsed.pathname === '/oauth2/v2/userinfo';
  const operation = api && /^\/v1internal\/operations\/[A-Za-z0-9._~-]+$/.test(parsed.pathname);
  if (!(oauth || userinfo || operation || (api && ALLOWED_RPC.has(rpc)))) throw new Error('oauth_probe_endpoint_denied');
  const headers = new Headers(options.headers);
  let body = options.body || {};
  if (body instanceof URLSearchParams) body = Object.fromEntries(body);
  else if (typeof body === 'string') {
    try { body = headers.get('content-type')?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body); }
    catch { body = {}; }
  }
  const known = new Set(['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'refresh_token', 'redirect_uri', 'project', 'metadata', 'tierId']);
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  return { method: ['GET', 'POST'].includes(options.method || 'GET') ? options.method || 'GET' : 'OTHER', host: parsed.hostname,
    path: operation ? '/v1internal/operations/[operation]' : parsed.pathname,
    configuredProfile: oauth || userinfo ? 'oauth-http2' : 'antigravity-http1',
    bodyFields: keys.filter(key => known.has(key)).sort(), unknownBodyFieldCount: keys.filter(key => !known.has(key)).length,
    grantType: ['authorization_code', 'refresh_token'].includes(body?.grant_type) ? body.grant_type : null,
    formEncoded: headers.get('content-type') === 'application/x-www-form-urlencoded',
    goOAuthUserAgent: headers.get('user-agent') === 'Go-http-client/2.0',
    cliUserAgent: /^antigravity\/cli\/1\.5\.2 /.test(headers.get('user-agent') || '') };
}
function observerSource(traceFile) {
  // Preserve the actual transport implementation; retain only an allowlisted
  // structural projection before any diagnostic bytes reach disk.
  return `'use strict';process.umask(0o077);const fs=require('node:fs');
const ALLOWED_RPC=new Set(${JSON.stringify([...ALLOWED_RPC])});
const requestEvidence=${requestEvidence.toString()};
const transport=require(${JSON.stringify(path.join(ROOT, 'src/agy-native-transport.js'))});
// The controller owns the only persisted diagnostic projection in this run.
// Suppress ordinary core diagnostic files; do not alter account persistence.
require(${JSON.stringify(path.join(ROOT, 'src/diagnostic-log.js'))}).DiagnosticLog.prototype.write=function(){};
const original=transport.AgyNativeTransport.prototype.fetch;
const write=value=>fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(value)+'\\n',{mode:0o600});
const dashboard=require(${JSON.stringify(path.join(ROOT, 'src/dashboard-account-auth.js'))});
const start=dashboard.DashboardAccountAuth.prototype.start;
dashboard.DashboardAccountAuth.prototype.start=async function(...args){
 const result=await start.apply(this,args);const job=this.job;
 if(job&&!job.__probeObserved){job.__probeObserved=true;write({event:'authorization',stage:'started'});
  void job.promise.then(()=>{write({event:'authorization',stage:['completed','cancelled','failed'].includes(job.status)?job.status:'unknown'});});}
 return result;
};
transport.AgyNativeTransport.prototype.fetch=async function(url,options={}){
 const request=requestEvidence(url,options); const id=require('node:crypto').randomUUID();
 write({event:'request',id,...request});
 try{const response=await original.call(this,url,options);write({event:'response',id,status:response.status});return response;}
 catch(error){write({event:'failure',id,category:error?.name==='AbortError'?'aborted':'transport_error'});throw error;}
};`;
}
function traces(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function sourceHash() {
  const files = ['antigravity-gateway.js', 'package.json', ...fs.readdirSync(path.join(ROOT, 'src')).filter(name => name.endsWith('.js')).map(name => `src/${name}`), 'native/bin/manifest.json'];
  return sha(files.sort().map(file => file + '\0' + sha(fs.readFileSync(path.join(ROOT, file)))).join('\n'));
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function version(binary, env) {
  return new Promise((resolve, reject) => execFile(binary, ['--version'], { env, timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
    if (error || !/\b1\.5\.2\b/.test(stdout)) reject(new Error('Official agy 1.5.2 must be installed before preparation'));
    else resolve('1.5.2');
  }));
}
async function prepare({ reportFile, agyPath, probeVersion = version, nativeResolver = resolveNativeBinary } = {}) {
  process.umask(0o077);
  const root = fs.mkdtempSync(path.join(TEMP_BASE, 'agw-oauth-live-'));
  try {
    for (const item of ['home', 'tmp', 'config/accounts']) fs.mkdirSync(path.join(root, item), { recursive: true, mode: 0o700 });
    const binary = fs.realpathSync(agyPath || resolveAgyCommand());
    const officialVersion = await probeVersion(binary, { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp') });
    nativeResolver({ cacheDir: path.join(root, 'config/native'), binaryPath: '' });
    const state = { kind: KIND, root, uid: process.getuid?.(), phase: 'prepared', createdAt: new Date().toISOString(),
      port: await unusedPort(), agyPath: binary, officialVersion, sourceHash: sourceHash(),
      reportFile: path.resolve(reportFile || path.join(TEMP_BASE, `agw-oauth-result-${crypto.randomBytes(8).toString('hex')}.json`)),
      credentialPolicy: 'Only this 0700 temporary config may briefly contain 0600 core account files; controller evidence contains structural metadata only.' };
    assert.ok(!state.reportFile.startsWith(root + path.sep), 'Report must survive deletion of the temporary credential directory');
    assert.ok(!fs.existsSync(state.reportFile), 'Choose a fresh report file');
    const file = path.join(root, 'control.json'); write(file, state);
    return { ...state, stateFile: file, dashboardUrl: `http://127.0.0.1:${state.port}/dashboard`, authorizationStarted: false };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
function loadState(file) {
  const resolved = path.resolve(file), state = json(resolved);
  assert.equal(state.kind, KIND);
  assert.equal(path.basename(state.root).startsWith('agw-oauth-live-'), true);
  assert.equal(path.dirname(state.root), TEMP_BASE);
  assert.equal(resolved, path.join(state.root, 'control.json'));
  assert.equal(fs.realpathSync(state.root), state.root);
  assert.equal(state.uid, process.getuid?.());
  assert.equal(fs.lstatSync(state.root).mode & 0o077, 0);
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
  assert.equal(fs.statSync(resolved).mode & 0o077, 0);
  assert.equal(Number.isInteger(state.port) && state.port > 0 && state.port < 65536, true);
  for (const directory of ['config', 'config/accounts', 'home', 'tmp']) assert.equal(fs.realpathSync(path.join(state.root, directory)), path.join(state.root, directory));
  return state;
}
function isolatedEnvironment(state) {
  return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: path.join(state.root, 'home'), TMPDIR: path.join(state.root, 'tmp'),
    ANTIGRAVITY_GATEWAY_CONFIG_DIR: path.join(state.root, 'config'), ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1',
    ANTIGRAVITY_GATEWAY_PORT: String(state.port), ANTIGRAVITY_CLI_PATH: state.agyPath };
}
async function stopGateway(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const done = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  await Promise.race([done, delay(10000)]);
  if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await done; }
}
async function portClosed(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}
async function refreshCopy(state, { AuthProvider = ManagedAccountAuthProvider, fetchImpl = nativeCloudCodeFetch, signal } = {}) {
  const original = new AccountStore({ configDir: path.join(state.root, 'config') });
  const accounts = original.list(); assert.equal(accounts.length, 1, 'oauth_probe_requires_one_account');
  const account = accounts[0], sourceBytes = JSON.stringify(account);
  const copyDir = path.join(state.root, 'refresh-copy');
  const copy = new AccountStore({ configDir: copyDir });
  const expired = copy.save({ ...account, expiresAt: '2020-01-01T00:00:00.000Z' });
  let attempts = 0;
  const observations = [];
  const auth = new AuthProvider({ account: expired, store: copy, fetchImpl: async (url, options) => {
    const request = requestEvidence(url, options);
    assert.equal(request.grantType, 'refresh_token');
    assert.equal(++attempts, 1, 'oauth_probe_refresh_retry_denied');
    const response = await fetchImpl(url, { ...options, signal: signal ? AbortSignal.any([signal, options.signal].filter(Boolean)) : options.signal });
    observations.push({ ...request, status: response.status });
    return response;
  } });
  try {
    const result = await auth.get(signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000));
    const saved = copy.list()[0];
    assert.equal(saved.id, account.id); assert.equal(saved.subjectId, account.subjectId);
    assert.equal(JSON.stringify(original.list()[0]), sourceBytes, 'oauth_probe_original_account_changed');
    assert.ok(result.accessToken && saved.accessToken && Date.parse(saved.expiresAt) > Date.now(), 'oauth_probe_refresh_incomplete');
    return { attempted: attempts === 1, passed: true, identityPreserved: true, originalAccountUnchanged: true,
      savedFields: accountEvidence(saved), accessTokenChanged: saved.accessToken !== account.accessToken, observations };
  } finally { auth.disable?.(); fs.rmSync(copyDir, { recursive: true, force: true }); }
}
async function worker(file) {
  process.umask(0o077);
  const state = loadState(file), root = state.root;
  assert.equal(state.phase, 'prepared');
  assert.equal(fs.readdirSync(path.join(root, 'config/accounts')).length, 0, 'Prepared account pool must remain empty');
  const apiKey = crypto.randomBytes(32).toString('hex');
  const traceFile = path.join(root, 'observations.jsonl'), preload = path.join(root, 'observe.cjs');
  fs.writeFileSync(preload, observerSource(traceFile), { mode: 0o600 });
  const report = { evidence: 'user-driven-dashboard-oauth-real-google', startedAt: new Date().toISOString(),
    automaticAuthorization: false, formalAccountsRead: false, sourceHash: state.sourceHash, phase: 'starting', passed: false,
    credentialPolicy: state.credentialPolicy, observations: [] };
  const checkpoint = phase => { state.phase = report.phase = phase; state.workerPid = process.pid; write(file, state); };
  let gateway, stopping = false;
  const controller = new AbortController();
  const requestStop = () => { stopping = true; controller.abort(new Error('oauth_probe_cancelled')); };
  const stopPoll = setInterval(() => { if (fs.existsSync(path.join(root, 'stop.request'))) requestStop(); }, 250);
  stopPoll.unref();
  process.once('SIGTERM', requestStop); process.once('SIGINT', requestStop);
  try {
    checkpoint('starting');
    const env = { ...isolatedEnvironment(state), ANTIGRAVITY_GATEWAY_API_KEY: apiKey };
    gateway = spawn(process.execPath, ['--require', preload, path.join(ROOT, 'antigravity-gateway.js')], { cwd: env.HOME, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Core stdout/stderr can contain identity metadata. Drain without saving it.
    gateway.stdout.on('data', () => {}); gateway.stderr.on('data', () => {});
    gateway.on('error', requestStop);
    state.gatewayPid = gateway.pid;
    const get = async route => {
      const response = await fetch(`http://127.0.0.1:${state.port}${route}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
      return { status: response.status, body: await response.json() };
    };
    for (let index = 0; index < 100; index++) {
      if (stopping || gateway.exitCode !== null) throw new Error('oauth_probe_gateway_start_failed');
      try { if ((await get('/api/hello')).status === 200) break; } catch {}
      if (index === 99) throw new Error('oauth_probe_gateway_start_timeout');
      await delay(100);
    }
    checkpoint('waiting_for_user');
    const deadline = Date.now() + 30 * 60_000;
    const store = new AccountStore({ configDir: path.join(root, 'config') });
    let account;
    while (Date.now() < deadline && !stopping && !fs.existsSync(path.join(root, 'stop.request'))) {
      if (gateway.exitCode !== null || gateway.signalCode) throw new Error('oauth_probe_gateway_exited');
      const accounts = store.list();
      if (accounts.length > 1) throw new Error('oauth_probe_requires_one_account');
      if (accounts.length === 1) { account = accounts[0]; break; }
      if (traces(traceFile).some(item => item.event === 'authorization' && item.stage === 'failed')) throw new Error('oauth_probe_authorization_failed');
      if (traces(traceFile).some(item => item.event === 'authorization' && item.stage === 'cancelled')) { requestStop(); break; }
      await delay(500);
    }
    if (!account) { checkpoint(stopping || fs.existsSync(path.join(root, 'stop.request')) ? 'cancelled' : 'waiting_expired'); return; }
    checkpoint('checking_catalog_and_quota');
    report.account = accountEvidence(account);
    assert.ok(Object.values(report.account.fields).every(Boolean) && report.account.expiresInFuture, 'oauth_probe_account_incomplete');
    for (const name of fs.readdirSync(store.directory)) if (name.endsWith('.json')) assert.equal(fs.statSync(path.join(store.directory, name)).mode & 0o077, 0);
    // One explicit catalog request. The dashboard already schedules the real
    // full quota query on successful save; observe that job rather than duplicate it.
    const catalog = await get('/v1/models');
    report.catalog = { status: catalog.status, modelCount: Array.isArray(catalog.body?.data) ? catalog.body.data.length : 0 };
    assert.equal(catalog.status, 200, 'oauth_probe_catalog_failed');
    assert.ok(report.catalog.modelCount > 0, 'oauth_probe_catalog_empty');
    for (let index = 0; index < 120; index++) {
      controller.signal.throwIfAborted();
      const trace = traces(traceFile), requests = trace.filter(item => item.event === 'request' && item.path === '/v1internal:retrieveUserQuotaSummary');
      const completed = requests.map(item => trace.find(event => event.event === 'response' && event.id === item.id)).filter(Boolean);
      let snapshot;
      try { snapshot = json(path.join(root, 'config/state/quota.json'))[account.id]; } catch {}
      if (completed.length && snapshot?.groupsObservedAt) {
        report.quota = { status: completed[0].status, requestsObserved: requests.length, triggeredBy: 'normal-dashboard-account-save',
          persisted: true, groupCount: Array.isArray(snapshot.groups) ? snapshot.groups.length : 0,
          modelQuotaCount: Object.keys(snapshot.models || {}).length };
        break;
      }
      await delay(500);
    }
    assert.equal(report.quota?.status, 200, 'oauth_probe_quota_failed');
    await stopGateway(gateway);
    checkpoint('checking_refresh_copy');
    // Stop the gateway first so no background refresh can race with the copy.
    // Set only this controller process to the temporary native extraction root.
    process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR = path.join(root, 'config');
    report.refresh = await refreshCopy(state, { signal: controller.signal });
    report.passed = true;
    checkpoint('completed');
  } catch (error) {
    // No arbitrary upstream exception, code, URL, body or identity enters evidence.
    const known = /^oauth_probe_[a-z_]+$/.test(error.message || '') ? error.message : 'oauth_probe_stage_failed';
    report.failure = { stage: report.phase, code: known };
    report.phase = stopping ? 'cancelled' : 'failed';
  } finally {
    clearInterval(stopPoll);
    process.removeListener('SIGTERM', requestStop); process.removeListener('SIGINT', requestStop);
    try { await stopGateway(gateway); } catch { report.passed = false; }
    finally { closeNativeTransport(); }
    report.gatewayStopped = !gateway || gateway.exitCode !== null || Boolean(gateway.signalCode);
    report.portClosed = await portClosed(state.port);
    if (!report.gatewayStopped || !report.portClosed) report.passed = false;
    try {
      report.observations = traces(traceFile);
      report.onboardingObserved = report.observations.some(item => item.path === '/v1internal:onboardUser');
      report.sourceUnchanged = sourceHash() === state.sourceHash;
      if (!report.sourceUnchanged) report.passed = false;
    } catch { report.passed = false; report.observationReadFailed = true; }
    report.completedAt = new Date().toISOString();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.temporaryCredentialsRemoved = !fs.existsSync(root); }
    catch { report.temporaryCredentialsRemoved = false; report.passed = false; }
    write(state.reportFile, report);
  }
}
async function start(file) {
  const state = loadState(file);
  assert.equal(state.phase, 'prepared', 'Only a fresh prepared controller can be started');
  assert.equal(state.sourceHash, sourceHash(), 'Source changed after preflight; prepare a fresh controller');
  const child = spawn(process.execPath, [__filename, '--worker', path.resolve(file)], { detached: true, stdio: 'ignore', env: isolatedEnvironment(state) });
  let startError = false;
  child.on('error', () => { startError = true; });
  child.unref();
  for (let index = 0; index < 150; index++) {
    if (startError) throw new Error('oauth_probe_worker_start_failed');
    if (!fs.existsSync(file)) return { reportFile: state.reportFile, status: json(state.reportFile).phase };
    const current = loadState(file);
    if (current.phase === 'waiting_for_user') return { status: current.phase, dashboardUrl: `http://127.0.0.1:${state.port}/dashboard`, stateFile: path.resolve(file), reportFile: state.reportFile, authorizationStarted: false };
    await delay(100);
  }
  throw new Error('Controller did not become ready; use status or stop with the same state file');
}
async function main() {
  const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const action = args[0] || 'preflight';
  if (action === '--worker') return worker(args[1]);
  if (action === 'status' && option('--report')) {
    console.log(JSON.stringify(json(path.resolve(option('--report'))), null, 2));
    return;
  }
  if (action === 'preflight') {
    const state = await prepare({ reportFile: option('--out'), agyPath: option('--agy-path') });
    console.log(JSON.stringify({ phase: state.phase, stateFile: state.stateFile, reportFile: state.reportFile, dashboardUrl: state.dashboardUrl,
      authorizationStarted: false, startCommand: `node scripts/verify-dashboard-oauth.js start --state ${state.stateFile}` }, null, 2));
  } else {
    const file = option('--state'); assert.ok(file, '--state is required');
    if (action === 'start') console.log(JSON.stringify(await start(file), null, 2));
    else if (action === 'status') {
      const state = loadState(file);
      console.log(JSON.stringify({ phase: state.phase, dashboardUrl: `http://127.0.0.1:${state.port}/dashboard`, reportFile: state.reportFile }, null, 2));
    } else if (action === 'stop') {
      const state = loadState(file);
      if (state.phase === 'prepared') { fs.rmSync(state.root, { recursive: true, force: true }); console.log('Prepared empty directory removed; authorization was never started.'); }
      else { write(path.join(state.root, 'stop.request'), { requested: true }); console.log(JSON.stringify({ stopRequested: true, reportFile: state.reportFile })); }
    } else throw new Error('Use preflight, start, status, or stop');
  }
}
module.exports = { prepare, loadState, accountEvidence, requestEvidence, observerSource, refreshCopy, isolatedEnvironment };
if (require.main === module) main().catch(() => { console.error('OAuth verification controller failed. No credential or upstream error payload is printed.'); process.exitCode = 1; });
