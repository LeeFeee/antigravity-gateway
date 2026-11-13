#!/usr/bin/env node
'use strict';

// Captured Claude auxiliary Messages request -> real createServer -> pool ->
// provider -> original native transport. Preparation is offline; --run requires
// an explicitly frozen source SHA and permits exactly one helper generation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '..');
const isolation = require('./verify-real-client-gateway');
const processHelpers = require('./verify-client-gateway');
const { prepareServerSearchForward } = require('../src/server-search-protocol');
const { searchRequest } = require('../src/antigravity-server-search');
const { anthropicResponse } = require('../src/protocol');
const SOURCE_FIXTURE = 'tests/fixtures/claude-sdk-search-helper-2.1.322.json';
const QUERY = 'site:example.com Example Domain';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function capturedRequest() {
  const bytes = fs.readFileSync(path.join(ROOT, SOURCE_FIXTURE)), fixture = JSON.parse(bytes);
  const index = fixture.captures.findIndex(item => item.body?.tools?.some(tool => tool.type === 'web_search_20250305'));
  if (index < 0) throw new Error('Captured Claude auxiliary request is missing');
  const capture = fixture.captures[index], body = structuredClone(capture.body);
  if (body.max_tokens !== 32000 || body.stream !== true || body.messages.length !== 1
      || body.messages[0].content.length !== 1 || body.tools.length !== 1) throw new Error('Captured request contract changed');
  delete body.tools[0].allowed_domains; delete body.tools[0].blocked_domains;
  body.messages[0].content[0].text = `Perform a web search for the query: ${QUERY}`;
  const prepared = prepareServerSearchForward(body);
  if (prepared.skipSearch || prepared.blockedByBudget || prepared.query !== QUERY || prepared.generationConfig.maxOutputTokens !== 32000) {
    throw new Error('Prepared captured request differs from the approved one-search contract');
  }
  return { sourceFixture: SOURCE_FIXTURE, sourceFixtureSha256: sha(bytes), captureIndex: index,
    modifications: ['remove nonempty strict domain filter', 'replace only the user query with the fixed public query'],
    request: { method: 'POST', path: capture.path, headers: capture.headers, body },
    prepared: { query: prepared.query, contents: prepared.contents, instructions: prepared.instructions,
      generationConfig: prepared.generationConfig, identityMetadata: prepared.identityMetadata } };
}

function createGuard({ nativeFetch, expected, selected, record, signal }) {
  let count = 0, stopped = false;
  return { get generationCount() { return count; }, async fetch(receiver, url, options = {}) {
    if (stopped) throw Object.assign(new Error('Probe stopped after HTTP 429'), { code: 'probe_stopped_after_429', status: 429 });
    const parsed = new URL(url), method = options.method || 'GET';
    const cloud = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'].includes(parsed.origin);
    const generation = parsed.origin === 'https://daily-cloudcode-pa.googleapis.com' && parsed.pathname === '/v1internal:generateContent';
    const metadata = cloud && ['/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels',
      '/v1internal:retrieveUserQuotaSummary', '/v1internal:fetchUserInfo'].includes(parsed.pathname);
    const oauth = parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token';
    const userinfo = parsed.origin === 'https://www.googleapis.com' && parsed.pathname === '/oauth2/v2/userinfo';
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !(generation || metadata || oauth || userinfo)
      || ((generation || metadata || oauth) && method !== 'POST') || (userinfo && method !== 'GET')) throw new Error('Probe endpoint denied before dispatch');
    let body;
    if (generation) {
      if (count >= 1) throw new Error('Second physical generation denied before dispatch');
      body = JSON.parse(options.body);
      const wanted = searchRequest({ ...expected, project: body.project, model: selected.model });
      if (!selected.declaredModels?.includes(selected.model) || JSON.stringify(body) !== JSON.stringify(wanted)) {
        throw new Error('Generation differs from captured request conversion or catalog helper');
      }
      count++;
    }
    const id = crypto.randomUUID(), purpose = generation ? 'helper-generation' : oauth ? 'credential-refresh' : userinfo ? 'identity-metadata' : 'eligibility-metadata';
    record({ type: 'native-request', id, endpoint: parsed.origin + parsed.pathname, method, purpose,
      headers: Object.fromEntries(new Headers(options.headers)), ...(generation ? { body, expectedEnvelopeMatched: true } : {}) });
    try {
      const response = await nativeFetch.call(receiver, url, { ...options, signal: options.signal && signal ? AbortSignal.any([options.signal, signal]) : signal || options.signal });
      if (response.status === 429) stopped = true;
      record({ type: 'native-response', id, status: response.status, purpose, binary: receiver.child?.spawnfile || null });
      if (generation || (metadata && parsed.pathname.endsWith(':fetchAvailableModels') && response.ok)) {
        const text = await response.clone().text(); let json;
        try { json = JSON.parse(text); } catch {}
        record(generation ? { type: 'generation-body', id, status: response.status, byteLength: Buffer.byteLength(text), rawBodySha256: sha(text),
          ...(json === undefined ? { nonJsonBody: text } : { body: json }) }
          : { type: 'catalog', id, webSearchModelIds: json?.webSearchModelIds });
      }
      return response;
    } catch (error) { record({ type: 'native-error', id, code: error.code, message: error.message }); throw error; }
  } };
}

function parseSse(text) {
  const events = [];
  for (const frame of String(text).replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = frame.split('\n'), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    events.push({ event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() || '', data: JSON.parse(data) });
  }
  return events;
}
function assembleMessage(events) {
  let message; const argumentsByIndex = new Map();
  for (const { data } of events) {
    if (data.type === 'message_start') message = { ...data.message, content: [...data.message.content] };
    else if (data.type === 'content_block_start' && message) message.content[data.index] = structuredClone(data.content_block);
    else if (data.type === 'content_block_delta' && message) {
      const block = message.content[data.index], delta = data.delta;
      if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text;
      else if (delta.type === 'input_json_delta') argumentsByIndex.set(data.index, (argumentsByIndex.get(data.index) || '') + delta.partial_json);
      else if (delta.type === 'citations_delta') (block.citations ||= []).push(delta.citation);
    } else if (data.type === 'content_block_stop' && argumentsByIndex.has(data.index)) {
      message.content[data.index].input = JSON.parse(argumentsByIndex.get(data.index));
    } else if (data.type === 'message_delta' && message) {
      Object.assign(message, data.delta); message.usage = { ...message.usage, ...data.usage };
    }
  }
  return message;
}
function completeSse(events) {
  let started = false, stopped = false, ended = false, nextIndex = 0;
  const open = new Set();
  for (const { event, data } of events) {
    if (!data || stopped || (event && event !== data.type)) return false;
    if (data.type === 'ping') continue;
    if (data.type === 'message_start') {
      if (started || !Array.isArray(data.message?.content) || data.message.content.length) return false;
      started = true; continue;
    }
    if (!started) return false;
    if (data.type === 'content_block_start') {
      if (ended || data.index !== nextIndex++ || !data.content_block) return false;
      open.add(data.index);
    } else if (data.type === 'content_block_delta') {
      if (ended || !open.has(data.index)) return false;
    } else if (data.type === 'content_block_stop') {
      if (!open.delete(data.index)) return false;
    } else if (data.type === 'message_delta') {
      if (open.size || ended || !data.delta?.stop_reason) return false;
      ended = true;
    } else if (data.type === 'message_stop') {
      if (open.size || !ended) return false;
      stopped = true;
    } else return false;
  }
  return started && stopped && ended && nextIndex > 0;
}
function assess(http, trace) {
  const requests = trace.filter(item => item.type === 'native-request'), generations = requests.filter(item => item.purpose === 'helper-generation');
  const raw = trace.find(item => item.type === 'generation-body'), root = raw?.body?.response || raw?.body;
  const candidate = root?.candidates?.[0], selected = trace.find(item => item.type === 'account-selected');
  const events = http.events || []; let message, assemblyError;
  try { message = assembleMessage(events); } catch (error) { assemblyError = error.message; }
  const text = (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
  const upstreamText = (candidate?.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  const sources = (candidate?.groundingMetadata?.groundingChunks || []).filter(chunk => chunk.web).map(chunk => ({ url: chunk.web.uri, title: chunk.web.title || '' }));
  const results = (message?.content || []).filter(block => block.type === 'web_search_tool_result').flatMap(block => Array.isArray(block.content) ? block.content : []);
  const calls = (message?.content || []).filter(block => block.type === 'server_tool_use');
  const receipts = (message?.content || []).filter(block => block.type === 'web_search_tool_result');
  const nativeUsage = root?.usageMetadata || {};
  const expectedUsage = anthropicResponse(selected?.model || '', { text: '', toolCalls: [], usage: {
    input_tokens: nativeUsage.promptTokenCount, output_tokens: nativeUsage.candidatesTokenCount,
    thinking_tokens: nativeUsage.thoughtsTokenCount, cache_read_tokens: nativeUsage.cachedContentTokenCount
  } }).usage;
  const checks = {
    http200: http.status === 200, actualNative200: raw?.status === 200 && generations.length === 1,
    nativeBinaryObserved: trace.some(item => item.type === 'native-response' && item.purpose === 'helper-generation' && /agy-transport-/.test(item.binary || '')),
    originalBudget32000: generations[0]?.body?.request?.generationConfig?.maxOutputTokens === 32000,
    selectedCatalogHelper: selected?.declaredModels?.includes(selected.model) === true,
    actualModelDisplayed: Boolean(selected?.model) && message?.model === selected.model && http.headers?.['x-antigravity-model'] === selected.model,
    helperSseHeaders: /^text\/event-stream(?:;|$)/i.test(http.headers?.['content-type'] || '') && Boolean(selected?.model) && http.headers?.['x-antigravity-model'] === selected.model,
    completeSse: !assemblyError && completeSse(events),
    protocolNormalEnd: candidate?.finishReason === 'STOP' && message?.stop_reason === 'end_turn' && events.at(-1)?.data?.type === 'message_stop' && !events.some(item => item.data.type === 'error'),
    oneLogicalSearch: calls.length === 1 && message?.usage?.server_tool_use?.web_search_requests === 1,
    correctCallResult: calls.length === 1 && receipts.length === 1 && receipts[0].tool_use_id === calls[0].id,
    rawSummaryPreserved: Boolean(upstreamText) && text === upstreamText,
    rawLinksPreserved: sources.length > 0 && JSON.stringify(results.map(({ url, title }) => ({ url, title }))) === JSON.stringify(sources),
    noFabricatedCitations: !JSON.stringify(message?.content || []).includes('cited_text') && !events.some(item => item.data.delta?.type === 'citations_delta'),
    usageMatches: Object.entries(expectedUsage).every(([key, value]) => message?.usage?.[key] === value),
    exactIdentityAndEnvelope: generations[0]?.expectedEnvelopeMatched === true,
    noMainModelOrOtherGeneration: requests.filter(item => item.purpose === 'helper-generation').length === 1
  };
  return { passed: Object.values(checks).every(Boolean), checks, message, expectedUsage, actualModel: selected?.model, ...(assemblyError ? { assemblyError } : {}) };
}
function stateSnapshot(directory) {
  return Object.fromEntries(isolation.STATE_FILES.map(name => {
    const file = path.join(directory, name); if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('State snapshot must be an ordinary file');
    return [name, sha(fs.readFileSync(file))];
  }));
}

async function worker(configFile) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (isolation.sourceSnapshot().sha256 !== config.expectedSource) throw new Error('Worker source differs from frozen runtime');
  const secrets = [config.apiKey], pools = new Set(), transports = new Set(), selected = {};
  function collect() {
    for (const name of fs.readdirSync(path.join(config.configDir, 'accounts')).filter(name => name.endsWith('.json'))) {
      const account = JSON.parse(fs.readFileSync(path.join(config.configDir, 'accounts', name), 'utf8'));
      for (const key of ['id', 'email', 'subjectId', 'projectId', 'accessToken', 'refreshToken', 'clientId', 'clientSecret']) {
        if (typeof account[key] === 'string' && account[key].length >= 4 && !secrets.includes(account[key])) secrets.push(account[key]);
      }
    }
  }
  const record = value => { collect(); fs.appendFileSync(config.traceFile, JSON.stringify(isolation.scrub(value, secrets.sort((a, b) => b.length - a.length), config.root)) + '\n', { mode: 0o600 }); };
  // No Node fetch or HTTP client may browse source URLs. Google calls must pass
  // through the unchanged native transport and its exact endpoint/body guard.
  globalThis.fetch = async () => { throw new Error('Probe denies Node fetch and webpage retrieval'); };
  for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) {
    require(name)[method] = () => { throw new Error('Probe denies Node outbound HTTP and webpage retrieval'); };
  }
  const native = require('../src/agy-native-transport'), nativeFetch = native.AgyNativeTransport.prototype.fetch;
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/bin/manifest.json'), 'utf8'));
  const binaryPath = native.resolveNativeBinary({ cacheDir: path.join(config.configDir, 'native'), binaryPath: '' });
  const platform = `${process.platform}-${process.arch}`, binarySha256 = sha(fs.readFileSync(binaryPath));
  if (binarySha256 !== manifest.platforms[platform]?.sha256) throw new Error('Native binary does not match manifest');
  record({ type: 'native-manifest', sourceSha256: manifest.sourceSha256, platform, binarySha256 });
  const guard = createGuard({ nativeFetch, expected: config.captured.prepared, selected, record, signal: AbortSignal.timeout(90000) });
  native.AgyNativeTransport.prototype.fetch = function(url, options) { transports.add(this); return guard.fetch(this, url, options); };
  const { AccountPool } = require('../src/account-pool'), original = AccountPool.prototype.searchWeb;
  AccountPool.prototype.searchWeb = async function(request, options = {}) {
    pools.add(this); const pool = this; record({ type: 'pool-search-entered', request });
    return original.call(this, request, { ...options, onAccountSelected(event) {
      const entry = pool.entries.get(event.accountId);
      if (!entry || !pool.isEntryEligible(entry, event.model, new Set(), Date.now(), 'web-search')) throw new Error('Selected account is not eligible');
      Object.assign(selected, { model: event.model, declaredModels: entry.provider.webSearchModelCatalog() });
      record({ type: 'account-selected', ...selected, attempt: event.attempt, enabled: entry.account.enabled !== false,
        healthState: entry.healthState, quotaProtected: pool.quotaManager.isQuotaProtected(event.accountId, event.model),
        cooldownActive: entry.cooldownUntil > Date.now(), modelCooldownActive: (entry.modelCooldowns.get(event.model) || 0) > Date.now() });
      options.onAccountSelected?.(event);
    } });
  };
  const gateway = require('../antigravity-gateway'), server = gateway.createServer();
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      await new Promise(resolve => server.close(resolve)); await server.drainTransactions();
      for (const pool of pools) { pool.quotaManager.stop(); await pool.quotaManager.drain(); pool.usageStore.stop(); pool.stop(); }
      const children = [...transports].map(item => item.child).filter(Boolean); native.closeNativeTransport();
      await Promise.all(children.map(async child => { if (child.exitCode === null && !child.signalCode) await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(2000)]); }));
      record({ type: 'worker-cleanup', nativeStopped: children.every(child => child.exitCode !== null || Boolean(child.signalCode)),
        generationCount: guard.generationCount, poolUsage: [...pools].map(pool => pool.usageStore.state.lifetime) });
    })();
    await stopping; process.exit(0);
  }
  process.once('SIGTERM', () => { void stop().catch(() => process.exit(2)); });
  process.once('SIGINT', () => { void stop().catch(() => process.exit(2)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  record({ type: 'worker-ready', entry: 'real gateway.createServer', source: isolation.sourceSnapshot(), identity: config.captured.prepared.identityMetadata });
  console.log(`PROBE_READY:${server.address().port}`);
}

async function main({ run = false, out = path.join(ROOT, 'tests/fixtures/gateway-server-search-20261107'),
  expectedSource = '', sourceConfig = path.join(os.homedir(), '.antigravity-gateway') } = {}) {
  process.umask(0o077);
  const captured = capturedRequest(), beforeSource = isolation.sourceSnapshot(), file = path.join(out, run ? 'real-result.json' : 'prepared.json');
  if (fs.existsSync(file)) throw new Error('Existing evidence is never overwritten');
  const report = { evidence: 'captured-claude-request-replay-real-http-gateway-native-helper', actualCliExecuted: false,
    officialCliDynamicCapture: false, startedAt: new Date().toISOString(), sourceBefore: beforeSource,
    scriptSha256: sha(fs.readFileSync(__filename)), captured, physicalGenerationLimit: 1,
    boundaries: 'one HTTP request; no main-model invocation, webpage fetch, retry, fallback generation or lower-budget substitute' };
  if (!run) { report.preparedOnly = true; isolation.privateWrite(file, report); return report; }
  if (!expectedSource || beforeSource.sha256 !== expectedSource) throw new Error('Execution requires the explicitly frozen source SHA');
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('Seatbelt isolation is required');
  const root = fs.mkdtempSync('/private/tmp/agw-search-http-'); fs.chmodSync(root, 0o700);
  const configDir = path.join(root, 'config'), traceFile = path.join(root, 'trace.jsonl'), apiKey = 'probe-' + crypto.randomBytes(24).toString('hex');
  let child, copied; const secrets = [apiKey];
  try {
    report.originalStateBefore = stateSnapshot(sourceConfig);
    copied = isolation.copyManagedState(sourceConfig, configDir); secrets.push(...copied.secrets);
    report.originalAccountsBefore = copied.before; report.copiedState = copied.summary;
    report.privateDirectoryMode = (fs.statSync(root).mode & 0o777).toString(8);
    report.privateAccountModes = fs.readdirSync(path.join(configDir, 'accounts')).map(name => (fs.statSync(path.join(configDir, 'accounts', name)).mode & 0o777).toString(8));
    const home = path.join(root, 'home'), tmp = path.join(root, 'tmp'); fs.mkdirSync(home); fs.mkdirSync(tmp);
    const configFile = path.join(root, 'worker.json'), sandbox = path.join(root, 'worker.sb');
    isolation.privateWrite(configFile, { root, configDir, traceFile, apiKey, captured, expectedSource });
    isolation.privateWrite(sandbox, isolation.gatewaySandbox(root, sourceConfig));
    child = processHelpers.launch('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, __filename, '--worker', configFile], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, USER: 'probe', LOGNAME: 'probe', TERM: 'dumb', NO_COLOR: '1',
        ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir, ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1', ANTIGRAVITY_GATEWAY_API_KEY: apiKey,
        ANTIGRAVITY_GATEWAY_TIMEOUT_MS: '90000' } });
    let match;
    for (let i = 0; i < 120 && !child.closed; i++) { match = child.stdout.match(/PROBE_READY:(\d+)/); if (match) break; await delay(100); }
    if (!match) throw new Error('Isolated createServer did not become ready');
    const headers = { ...captured.request.headers, 'x-api-key': apiKey };
    for (const name of ['host', 'connection', 'content-length', 'authorization', 'accept-encoding']) delete headers[name];
    report.clientRequest = { method: 'POST', path: captured.request.path, headers, body: captured.request.body };
    const response = await fetch(`http://127.0.0.1:${Number(match[1])}${captured.request.path}`, {
      method: 'POST', headers, body: JSON.stringify(captured.request.body), signal: AbortSignal.timeout(90000) });
    const rawSse = await response.text(); let events = [];
    try { events = parseSse(rawSse); } catch (error) { report.sseParseError = error.message; }
    report.http = { status: response.status, headers: Object.fromEntries(response.headers), rawSse, events };
  } catch (error) { report.failure = { code: error.code || 'http_probe_failed', message: error.message }; }
  finally {
    if (child && !child.closed) {
      try { child.child.kill('SIGTERM'); } catch {}
      await Promise.race([child.done, delay(15000)]);
      if (!child.closed) await processHelpers.stop(child);
    }
    try {
      for (const name of fs.readdirSync(path.join(configDir, 'accounts')).filter(name => name.endsWith('.json'))) {
        const account = JSON.parse(fs.readFileSync(path.join(configDir, 'accounts', name), 'utf8'));
        for (const key of ['id', 'email', 'subjectId', 'projectId', 'accessToken', 'refreshToken', 'clientId', 'clientSecret']) if (typeof account[key] === 'string' && account[key].length >= 4) secrets.push(account[key]);
      }
    } catch {}
    report.trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    report.workerOutcome = child ? await child.done : null; report.workerStdout = child?.stdout; report.workerStderr = child?.stderr;
    report.assessment = assess(report.http || {}, report.trace);
    report.nativeStopped = report.trace.find(item => item.type === 'worker-cleanup')?.nativeStopped === true;
    report.originalAccountsAfter = isolation.accountSnapshot(sourceConfig);
    report.originalAccountsUnchanged = report.originalAccountsBefore?.digest === report.originalAccountsAfter.digest;
    report.originalStateAfter = stateSnapshot(sourceConfig);
    report.originalStateUnchanged = JSON.stringify(report.originalStateBefore) === JSON.stringify(report.originalStateAfter);
    report.sourceAfter = isolation.sourceSnapshot(); report.sourceUnchanged = beforeSource.sha256 === report.sourceAfter.sha256;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.temporaryCredentialsRemoved = !fs.existsSync(root);
    report.completedAt = new Date().toISOString();
    report.passed = report.assessment.passed && report.originalAccountsUnchanged && report.originalStateUnchanged
      && report.sourceUnchanged && report.nativeStopped && report.temporaryCredentialsRemoved && report.workerOutcome?.code === 0 && !report.failure;
    isolation.privateWrite(file, isolation.scrub(report, [...new Set(secrets)].sort((a, b) => b.length - a.length), root));
    console.log(JSON.stringify({ file, passed: report.passed, httpStatus: report.http?.status, actualModel: report.assessment.actualModel,
      generationCount: report.trace.filter(item => item.type === 'native-request' && item.purpose === 'helper-generation').length,
      originalAccountsUnchanged: report.originalAccountsUnchanged, originalStateUnchanged: report.originalStateUnchanged,
      sourceUnchanged: report.sourceUnchanged, nativeStopped: report.nativeStopped, temporaryCredentialsRemoved: report.temporaryCredentialsRemoved }));
  }
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const task = value('--worker') ? worker(value('--worker')) : main({ run: args.includes('--run'), out: value('--out'), expectedSource: value('--expected-source') });
  task.then(report => { if (args.includes('--run') && !report?.passed) process.exitCode = 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { capturedRequest, createGuard, parseSse, assembleMessage, assess, main };
