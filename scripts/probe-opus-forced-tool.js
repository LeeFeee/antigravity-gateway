#!/usr/bin/env node
'use strict';

// Offline by default. --run requires a reviewed runtime SHA and permits one
// physical Opus generation. This is a capability diagnostic, not a gateway
// route: it builds a normal AUTO request, then changes only toolConfig to ANY.
// No client tool executes and no follow-up generation is permitted.
const assert = require('node:assert/strict');
const { withClaude322Billing } = require('../tests/helpers/claude-capture');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const isolation = require('./verify-real-client-gateway');
const processes = require('./verify-client-gateway');
const ROOT = path.resolve(__dirname, '..');
const MODEL = 'claude-opus-4-6-thinking';
const ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const SOURCE_FIXTURE = 'tests/fixtures/agent-requests-20261107/claude-first.json';
const PROMPT = 'Call the read tool exactly once for /tmp/opus-forced-tool-probe.txt, StartLine 1 and EndLine 1. Return the tool call only. This is a capability diagnostic; the receiving harness will not execute the tool.';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function stateSnapshot(directory) {
  return Object.fromEntries(isolation.STATE_FILES.map(name => {
    const file = path.join(directory, name); if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Protection state must be an ordinary file');
    return [name, sha(fs.readFileSync(file))];
  }));
}

function buildDiagnostic(project = 'synthetic-project', modelInfo) {
  const { normalizeAnthropic } = require('../src/protocol');
  const { buildDirectRequest } = require('../src/direct-provider');
  const sourceBytes = fs.readFileSync(path.join(ROOT, SOURCE_FIXTURE));
  const fixture = JSON.parse(sourceBytes);
  const captured = fixture.captures.find(item => item.body?.tools?.some(tool => tool.name === 'Read'))?.body;
  assert(captured, 'Captured versioned Claude Read declaration is required');
  const payload = { model: MODEL, stream: true, max_tokens: 2048, system: structuredClone(withClaude322Billing(captured).system),
    messages: [{ role: 'user', content: PROMPT }], tools: [structuredClone(captured.tools.find(tool => tool.name === 'Read'))] };
  const normalized = normalizeAnthropic(payload), native = { modelInfo };
  const baseline = buildDirectRequest(normalized, MODEL, project, 'opus-forced-tool-diagnostic', '', null, native);
  const declarations = baseline.request.tools.flatMap(tool => tool.functionDeclarations || []);
  const tool = declarations.find(item => item.name === 'read_file');
  assert(tool, 'Captured tool contract must produce its known native read_file view');
  assert.deepEqual(tool.parameters.required, ['Path', 'StartLine', 'EndLine']);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['EndLine', 'Path', 'StartLine']);
  const official = require('../tests/fixtures/antigravity-1.5.2-file-tools.json').tools.find(item => item.name === 'read_file');
  for (const [key, property] of Object.entries(tool.parameters.properties)) {
    assert.equal(property.type, official.parameters.properties[key].type, `Official ${key} type must be preserved`);
  }
  assert.deepEqual(baseline.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
  assert.equal(baseline.request.generationConfig.maxOutputTokens, 2048);
  assert.equal(baseline.model, MODEL);
  assert.equal(baseline.request.toolConfig, undefined);
  const body = structuredClone(baseline);
  body.request.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } };
  const restored = structuredClone(body); delete restored.request.toolConfig;
  assert.deepEqual(restored, baseline, 'Only request.toolConfig may change after the standard builder');
  let localProtection;
  try {
    buildDirectRequest({ ...normalized, toolChoice: { type: 'tool', name: 'Read' } }, MODEL, project,
      'opus-forced-tool-local-protection', '', null, { modelInfo });
    localProtection = { rejected: false };
  } catch (error) {
    if (error.code !== 'model_capability_conflict') throw error;
    localProtection = { rejected: true, code: error.code, status: error.status };
  }
  return { sourceFixture: SOURCE_FIXTURE, sourceFixtureSha256: sha(sourceBytes), payload, baseline, body,
    localProtection, changedFields: ['request.toolConfig'], tool, adapter: native.toolAdapter };
}

function createGuard({ nativeFetch, record = () => {}, signal, frozenSourceCheck = () => {} }) {
  let expected, generationCount = 0, stopped = false;
  return {
    get generationCount() { return generationCount; },
    get stopped() { return stopped; },
    arm(body, token) { assert(!expected && !generationCount && !stopped, 'Diagnostic may be armed only once'); expected = { body: JSON.stringify(body), token }; },
    async fetch(receiver, url, options = {}) {
      signal?.throwIfAborted(); options.signal?.throwIfAborted();
      assert(!stopped, 'Diagnostic already stopped; no retry is allowed');
      const parsed = new URL(url), method = options.method || 'GET';
      const cloud = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'].includes(parsed.origin);
      const metadata = cloud && !parsed.search && ['/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels',
        '/v1internal:retrieveUserQuotaSummary', '/v1internal:fetchUserInfo'].includes(parsed.pathname);
      const oauth = parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token' && !parsed.search;
      const generation = String(url) === ENDPOINT;
      assert(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port
        && method === 'POST' && (metadata || oauth || generation), 'Diagnostic endpoint or method denied');
      if (generation) {
        assert(expected && generationCount === 0, 'Only one armed physical generation is permitted');
        frozenSourceCheck();
        assert.equal(options.body, expected.body, 'Generation must equal the reviewed diagnostic body');
        const headers = new Headers(options.headers);
        assert.equal(headers.get('authorization'), `Bearer ${expected.token}`, 'Selected account cannot change');
        assert.equal(headers.get('content-type'), 'application/json');
        assert.equal(headers.get('user-agent'), require('../src/agy-request-profile').cliUserAgent());
        generationCount++;
      }
      const id = crypto.randomUUID(), purpose = generation ? 'single-diagnostic-generation' : oauth ? 'credential-refresh' : 'eligibility-metadata';
      record({ type: 'native-request', id, purpose, url: String(url), method,
        ...(generation ? { body: JSON.parse(options.body), generationCount } : {}), transport: 'original-AgyNativeTransport.fetch' });
      try {
        const combined = options.signal && signal ? AbortSignal.any([options.signal, signal]) : options.signal || signal;
        const response = await nativeFetch.call(receiver, url, { ...options, signal: combined });
        record({ type: 'native-response', id, purpose, status: response.status, binary: receiver.child?.spawnfile || null });
        if (generation || response.status === 429) stopped = true;
        return response;
      } catch (error) {
        if (generation) stopped = true;
        record({ type: 'native-error', id, purpose, code: error.code, message: error.message }); throw error;
      }
    }
  };
}

function assessResponse(status, text, adapter) {
  const values = [], parseErrors = [];
  if (String(text).trim().startsWith('data:') || String(text).includes('\ndata:')) {
    for (const line of String(text).split(/\r?\n/).filter(line => line.startsWith('data:'))) {
      const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
      try { values.push(JSON.parse(data)); } catch { parseErrors.push('invalid SSE JSON'); }
    }
  } else { try { values.push(JSON.parse(text)); } catch { parseErrors.push('invalid JSON response'); } }
  const roots = values.flatMap(value => Array.isArray(value) ? value : [value]).map(value => value?.response || value);
  const candidates = roots.flatMap(value => value?.candidates || []), calls = candidates.flatMap(candidate => candidate.content?.parts || [])
    .filter(part => part.functionCall).map(part => part.functionCall);
  const validatedCalls = calls.map(call => {
    try {
      assert.equal(call.name, 'read_file');
      const projected = adapter.toClient({ id: call.id || 'diagnostic_missing_id', name: call.name, arguments: call.args });
      assert.equal(projected.name, 'Read');
      return { name: call.name, arguments: call.args, valid: true, clientName: projected.name, executed: false };
    } catch (error) { return { name: call.name, valid: false, error: error.code || error.message, executed: false }; }
  });
  const upstreamError = roots.find(value => value?.error)?.error;
  const errorText = typeof upstreamError === 'string' ? upstreamError : upstreamError?.message || '';
  const rejectsCombination = status === 400 && /thinking may not be enabled when tool_choice forces tool use/i.test(errorText);
  const acceptedToolCall = status === 200 && !parseErrors.length && !upstreamError && validatedCalls.some(call => call.valid);
  return { status, conclusion: rejectsCombination ? 'upstream_rejects_fixed_thinking_with_forced_tool'
    : acceptedToolCall ? 'upstream_accepts_fixed_thinking_with_validated_tool_call' : 'inconclusive',
  rejectsCombination, acceptedToolCall, requiresProductionGuardReview: acceptedToolCall,
  finishReasons: [...new Set(candidates.map(candidate => candidate.finishReason).filter(Boolean))], validatedCalls,
  parseErrors, upstreamError, usageMetadata: roots.map(value => value?.usageMetadata).filter(Boolean),
  rawBodySha256: sha(text), rawBodyBytes: Buffer.byteLength(text), toolExecutions: 0 };
}

function collectSecrets(directory) {
  const secrets = [];
  for (const name of fs.readdirSync(path.join(directory, 'accounts')).filter(name => name.endsWith('.json'))) {
    const account = JSON.parse(fs.readFileSync(path.join(directory, 'accounts', name), 'utf8'));
    for (const key of ['id', 'email', 'subjectId', 'projectId', 'accessToken', 'refreshToken', 'clientId', 'clientSecret']) {
      if (typeof account[key] === 'string' && account[key].length >= 4) secrets.push(account[key]);
    }
  }
  return secrets;
}

async function worker(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const frozenSourceCheck = () => assert.equal(isolation.sourceSnapshot().sha256, config.expectedSource, 'Runtime source changed');
  frozenSourceCheck();
  const record = value => {
    const clean = isolation.scrub(value, collectSecrets(config.configDir).sort((a, b) => b.length - a.length), config.root);
    fs.appendFileSync(config.traceFile, JSON.stringify(clean) + '\n', { mode: 0o600 });
  };
  globalThis.fetch = async () => { throw new Error('Diagnostic denies Node outbound fetch'); };
  for (const module of ['node:http', 'node:https']) for (const method of ['request', 'get']) {
    require(module)[method] = () => { throw new Error('Diagnostic denies Node outbound HTTP'); };
  }
  const { AgyNativeTransport, resolveNativeBinary } = require('../src/agy-native-transport');
  const { AccountStore } = require('../src/account-store');
  const { AccountPool } = require('../src/account-pool');
  const { QuotaManager } = require('../src/quota-manager');
  const { cliUserAgent } = require('../src/agy-request-profile');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/bin/manifest.json'), 'utf8'));
  const binaryPath = resolveNativeBinary({ cacheDir: path.join(config.configDir, 'native'), binaryPath: '' });
  const binarySha256 = sha(fs.readFileSync(binaryPath)), platform = `${process.platform}-${process.arch}`;
  assert.equal(binarySha256, manifest.platforms[platform]?.sha256, 'Original native binary must match manifest');
  const transport = new AgyNativeTransport({ binaryPath });
  const signal = AbortSignal.timeout(90000);
  const guard = createGuard({ nativeFetch: transport.fetch, record, signal, frozenSourceCheck });
  const fetchImpl = (url, options) => guard.fetch(transport, url, options);
  const store = new AccountStore({ configDir: config.configDir });
  const pool = new AccountPool({ store, fetchImpl });
  const quota = new QuotaManager({ configDir: config.configDir, accountPool: pool }); pool.quotaManager = quota;
  record({ type: 'native-manifest', platform, binarySha256, sourceSha256: manifest.sourceSha256 });
  try {
    await pool.ensureModelCatalogs(signal);
    assert(!guard.stopped, 'Eligibility encountered 429; no generation is allowed');
    const entry = pool.selectAccount(MODEL, '', new Set(), { allowSticky: false });
    if (!entry) throw pool.noAccountError(MODEL);
    await quota.drain();
    assert(!guard.stopped, 'Quota refresh encountered 429; no generation is allowed');
    assert(pool.isEntryEligible(entry, MODEL), 'Selected account is not eligible after quota refresh');
    assert(entry.supportedModels instanceof Set && entry.supportedModels.has(MODEL), 'Actual account catalog must contain exact Opus model');
    record({ type: 'selection', model: MODEL, liveCatalogContainsExplicitModel: true, enabled: entry.account.enabled !== false,
      quotaProtected: quota.isQuotaProtected(entry.account.id, MODEL), cooldownActive: entry.cooldownUntil > Date.now(),
      modelCooldownActive: (entry.modelCooldowns.get(MODEL) || 0) > Date.now(),
      mechanism: 'unchanged AccountPool catalog/selectAccount/isEntryEligible and copied quota/health state; no account fallback' });
    const token = await entry.provider.access(signal), project = await entry.provider.project(signal, token);
    const diagnostic = buildDiagnostic(project, entry.provider.modelInfo(MODEL));
    record({ type: 'diagnostic-request', model: MODEL, sourceFixture: diagnostic.sourceFixture,
      sourceFixtureSha256: diagnostic.sourceFixtureSha256, baseline: diagnostic.baseline,
      body: diagnostic.body, changedFields: diagnostic.changedFields, localProtection: diagnostic.localProtection,
      explanation: 'Normal production builder AUTO baseline; only request.toolConfig is added after building. Production compatibility protection is unchanged.' });
    guard.arm(diagnostic.body, token);
    const response = await fetchImpl(ENDPOINT, { method: 'POST', signal, body: JSON.stringify(diagnostic.body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': cliUserAgent() } });
    const text = await response.text();
    record({ type: 'diagnostic-result', assessment: assessResponse(response.status, text, diagnostic.adapter),
      rawResponse: text, noToolExecution: true });
  } catch (error) { record({ type: 'worker-failure', code: error.code || 'diagnostic_failed', status: error.status, message: error.message }); }
  finally {
    quota.stop(); await quota.drain(); pool.stop();
    const child = transport.child; transport.close();
    if (child && child.exitCode === null && !child.signalCode) await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(2000)]);
    if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await delay(100); }
    record({ type: 'worker-cleanup', generationCount: guard.generationCount, nativeStopped: !child || child.exitCode !== null || Boolean(child.signalCode),
      sourceUnchanged: isolation.sourceSnapshot().sha256 === config.expectedSource, toolExecutions: 0 });
  }
}

async function main({ run = false, expectedSource = '', sourceConfig = path.join(os.homedir(), '.antigravity-gateway'), out } = {}) {
  process.umask(0o077);
  assert(out, 'An explicit independent evidence directory is required');
  out = path.resolve(out);
  const reportFile = path.join(out, run ? 'real-result.json' : 'prepared.json');
  assert(!fs.existsSync(reportFile), 'Existing evidence must never be overwritten');
  const sourceBefore = isolation.sourceSnapshot(), diagnostic = buildDiagnostic();
  const report = { evidence: 'single-opus-fixed-thinking-forced-native-tool-capability-diagnostic', startedAt: new Date().toISOString(),
    model: MODEL, endpoint: ENDPOINT, physicalGenerationLimit: 1, toolExecutionLimit: 0, sourceBefore,
    scriptSha256: sha(fs.readFileSync(__filename)), preparedOnly: !run,
    boundaries: 'Not a normal HTTP gateway request. Standard builder AUTO baseline with only request.toolConfig changed to ANY/read_file. No generation retry, model/account fallback, tool execution or follow-up. Production compatibility guard remains unchanged.',
    sourceFixture: diagnostic.sourceFixture, sourceFixtureSha256: diagnostic.sourceFixtureSha256,
    baseline: diagnostic.baseline, diagnostic: diagnostic.body, changedFields: diagnostic.changedFields, localProtection: diagnostic.localProtection };
  if (!run) { report.accountDataRead = false; report.realRequestsSent = false; isolation.privateWrite(reportFile, report); return report; }
  assert(/^[a-f0-9]{64}$/.test(expectedSource) && sourceBefore.sha256 === expectedSource, 'Execution requires reviewed frozen source SHA');
  assert(process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec'), 'Seatbelt isolation is required');
  const root = fs.mkdtempSync('/private/tmp/agw-opus-force-'); fs.chmodSync(root, 0o700);
  const configDir = path.join(root, 'config'), traceFile = path.join(root, 'trace.jsonl'), secrets = [];
  let child, copied;
  try {
    report.originalStateBefore = stateSnapshot(sourceConfig);
    copied = isolation.copyManagedState(sourceConfig, configDir); secrets.push(...copied.secrets);
    report.originalAccountsBefore = copied.before; report.copiedState = copied.summary; report.accountDataRead = true;
    report.privateDirectoryMode = (fs.statSync(root).mode & 0o777).toString(8);
    report.privateAccountModes = fs.readdirSync(path.join(configDir, 'accounts')).map(name => (fs.statSync(path.join(configDir, 'accounts', name)).mode & 0o777).toString(8));
    const home = path.join(root, 'home'), tmp = path.join(root, 'tmp'); fs.mkdirSync(home); fs.mkdirSync(tmp);
    const configFile = path.join(root, 'worker.json'), sandbox = path.join(root, 'worker.sb');
    isolation.privateWrite(configFile, { root, configDir, traceFile, expectedSource });
    isolation.privateWrite(sandbox, isolation.gatewaySandbox(root, sourceConfig));
    child = processes.launch('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, __filename, '--worker', configFile], {
      cwd: home, env: { PATH: process.env.PATH, TMPDIR: tmp, USER: 'probe', LOGNAME: 'probe', TERM: 'dumb', NO_COLOR: '1',
        ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir } });
    await Promise.race([child.done, delay(105000, undefined, { ref: false }).then(() => { throw new Error('Owned diagnostic worker deadline exceeded'); })]);
  } catch (error) { report.failure = { code: error.code || 'diagnostic_failed', message: error.message }; }
  finally {
    try {
      await processes.stop(child);
      try { secrets.push(...collectSecrets(configDir)); } catch {}
      report.trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      report.workerOutcome = child ? await child.done : null; report.workerStdout = child?.stdout; report.workerStderr = child?.stderr;
      const cleanup = report.trace.find(item => item.type === 'worker-cleanup');
      report.assessment = report.trace.find(item => item.type === 'diagnostic-result')?.assessment;
      report.generationCount = report.trace.filter(item => item.type === 'native-request' && item.purpose === 'single-diagnostic-generation').length;
      report.realRequestsSent = report.trace.some(item => item.type === 'native-request');
      report.generationLimitRespected = report.generationCount <= 1;
      report.nativeStopped = cleanup?.nativeStopped === true; report.ownedWorkerStopped = !child || child.closed === true;
      report.originalAccountsAfter = isolation.accountSnapshot(sourceConfig);
      report.originalAccountsUnchanged = copied?.before.digest === report.originalAccountsAfter.digest;
      report.originalStateAfter = stateSnapshot(sourceConfig);
      report.originalStateUnchanged = JSON.stringify(report.originalStateBefore) === JSON.stringify(report.originalStateAfter);
      report.sourceAfter = isolation.sourceSnapshot(); report.sourceUnchanged = sourceBefore.sha256 === report.sourceAfter.sha256;
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      report.temporaryCredentialsRemoved = !fs.existsSync(root); report.completedAt = new Date().toISOString();
      report.validEvidence = Boolean(report.generationCount === 1 && report.assessment?.conclusion !== 'inconclusive'
        && report.assessment && report.originalAccountsUnchanged && report.originalStateUnchanged && report.sourceUnchanged
        && report.nativeStopped && report.ownedWorkerStopped && report.temporaryCredentialsRemoved && !report.failure
        && !report.trace?.some(item => item.type === 'worker-failure'));
      isolation.privateWrite(reportFile, isolation.scrub(report, [...new Set(secrets)].sort((a, b) => b.length - a.length), root));
    }
  }
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const task = value('--worker') ? worker(value('--worker')) : main({ run: args.includes('--run'), expectedSource: value('--expected-source'),
    sourceConfig: value('--source-config'), out: value('--out') });
  task.then(report => {
    if (!report) return;
    console.log(JSON.stringify({ preparedOnly: report.preparedOnly, accountDataRead: report.accountDataRead,
      realRequestsSent: report.realRequestsSent, generationCount: report.generationCount, validEvidence: report.validEvidence,
      conclusion: report.assessment?.conclusion, sourceUnchanged: report.sourceUnchanged, temporaryCredentialsRemoved: report.temporaryCredentialsRemoved }));
    if (args.includes('--run') && !report.validEvidence) process.exitCode = 1;
  }).catch(() => { console.error('Opus diagnostic preparation/worker failed; no credential output.'); process.exitCode = 1; });
}
module.exports = { MODEL, ENDPOINT, buildDiagnostic, createGuard, assessResponse, main };
