#!/usr/bin/env node
'use strict';

// Actual installed Claude -> full isolated gateway -> loopback-only synthetic
// Google service. This is not a real Google search or native TLS verification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const helpers = require('./verify-client-gateway');
const { clientSandbox, sourceSnapshot } = require('./verify-real-client-gateway');
const { normalizeAnthropic } = require('../src/protocol');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');
const ROOT = path.resolve(__dirname, '..');
const MAIN = 'claude-sonnet-4-6', HELPER = 'gemini-3.5-flash-lite';
const KEY = 'sk-gateway-local-fixture-not-a-real-key';
const QUERY = 'CONTROLLED_CLAUDE_WEB_SEARCH_QUERY_20261107';
const SUMMARY = 'SYNTHETIC_UPSTREAM_SEARCH_SUMMARY: preserve these exact upstream words and return the source link to the agent.';
const SOURCE = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/CONTROLLED_FIXTURE_REFERENCE';
const COMPLETION = 'CLAUDE_SEARCH_GATEWAY_COMPLETE';

function readTrace(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function preload(upstreamPort, traceFile) {
  // Observe request ingress before its upstream response, so the mock can use
  // the actual current declarations when issuing a reversible client tool call.
  return helpers.preloadSource(upstreamPort, traceFile).replace(
    'return emit.call(this, event, ...args);',
    `if(event==='end') {let body=Buffer.concat(input).toString('utf8');try{body=JSON.parse(body)}catch{};fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({kind:'ingress',method:req.method,path:req.url,headers:req.headers,body})+'\\n');} return emit.call(this,event,...args);`);
}
function parseMessage(raw, streamed) {
  if (!streamed) return JSON.parse(raw);
  const wire = raw.replaceAll('\r\n', '\n');
  assert.ok(wire.endsWith('\n\n'), 'SSE must end with a complete event delimiter');
  let message, startCount = 0, deltaCount = 0, stopCount = 0, lastEvent;
  const open = new Set();
  for (const frame of wire.split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    const event = JSON.parse(data);
    if (event.type === 'error') throw new Error(`Gateway SSE error: ${JSON.stringify(event.error)}`);
    assert.equal(stopCount, 0, 'No SSE data event may follow message_stop');
    if (event.type === 'ping') continue;
    lastEvent = event.type;
    if (event.type === 'message_start') { assert.equal(++startCount, 1); message = structuredClone(event.message); }
    else assert.ok(message, 'SSE content cannot precede message_start');
    if (event.type === 'content_block_start') {
      assert.equal(event.index, message.content.length); assert.equal(deltaCount, 0);
      open.add(event.index); message.content[event.index] = structuredClone(event.content_block);
    }
    if (event.type === 'content_block_delta') {
      assert.ok(open.has(event.index), 'SSE delta requires an open content block');
      const block = message.content[event.index];
      if (event.delta.type === 'text_delta') block.text += event.delta.text;
      else if (event.delta.type === 'input_json_delta') block._input = (block._input || '') + event.delta.partial_json;
      else if (event.delta.type === 'citations_delta') (block.citations ||= []).push(event.delta.citation);
      else assert.fail(`Unexpected search SSE delta: ${event.delta.type}`);
    }
    if (event.type === 'content_block_stop') {
      assert.ok(open.delete(event.index), 'SSE stop requires an open content block');
      const block = message.content[event.index];
      if (block._input) { block.input = JSON.parse(block._input); delete block._input; }
    }
    if (event.type === 'message_delta') {
      assert.equal(open.size, 0); assert.equal(++deltaCount, 1);
      Object.assign(message, event.delta); message.usage = { ...message.usage, ...event.usage };
    }
    if (event.type === 'message_stop') { assert.equal(deltaCount, 1); assert.equal(open.size, 0); stopCount++; }
    assert.ok(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(event.type));
  }
  assert.equal(startCount, 1); assert.equal(stopCount, 1, 'SSE must contain message_stop');
  assert.equal(lastEvent, 'message_stop'); assert.ok(message.stop_reason, 'Completed SSE must carry a stop reason');
  return message;
}
function searchBody(stream = false, overrides = {}) {
  return { model: MAIN, max_tokens: 4096, stream, messages: [{ role: 'user', content: 'Synthetic HTTP search fixture only.' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    tool_choice: { type: 'tool', name: 'web_search' }, ...overrides };
}
function assertSearchMessage(message) {
  assert.equal(message.model, HELPER);
  const call = message.content.find(block => block.type === 'server_tool_use');
  const result = message.content.find(block => block.type === 'web_search_tool_result');
  assert.equal(call.name, 'web_search'); assert.equal(result.tool_use_id, call.id);
  assert.equal(result.content.length, 1); assert.equal(result.content[0].url, SOURCE);
  assert.match(result.content[0].encrypted_content, /^agyws1\.r\./);
  assert.ok(message.content.every(block => !block.citations?.length));
  assert.equal(message.content.filter(block => block.type === 'text').map(block => block.text).join(''), SUMMARY);
  assert.equal(message.usage.server_tool_use.web_search_requests, 1);
  return { call, result };
}

async function run({ runCli = true, outFile, timeoutMs = 60000 } = {}) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('macOS Seatbelt is required for this isolation harness.');
  if (outFile && fs.existsSync(outFile)) throw new Error('Refusing to overwrite an existing verification report; choose a new --out path.');
  const sourceBefore = sourceSnapshot();
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'agw-search-http-'))); fs.chmodSync(root, 0o700);
  const traceFile = path.join(root, 'http.jsonl'), upstream = [], errors = [], scenarios = [];
  let gateway, client, google, settings, gatewayPort, upstreamPort, cliOutcome, failure;
  let cliActive = false, discoveryIssued = false, searchIssued = false;
  const generations = () => upstream.filter(entry => /:(?:streamGenerateContent|generateContent)/.test(entry.path));
  const searches = () => generations().filter(entry => entry.body.requestType === 'web_search');
  const latestRequest = () => readTrace(traceFile).filter(entry => entry.kind === 'ingress' && /^\/v1\/messages(?:\?|$)/.test(entry.path)).at(-1)?.body;
  try {
    google = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const record = { method: req.method, path: req.url, headers: req.headers, body }; upstream.push(record);
        res.setHeader('content-type', 'application/json');
        if (req.url.endsWith(':fetchAvailableModels')) return res.end(JSON.stringify({ models: { [MAIN]: {
          displayName: 'Controlled Sonnet', maxTokens: 200000, maxOutputTokens: 64000, supportsThinking: true, thinkingBudget: 1024
        } }, webSearchModelIds: [HELPER] }));
        if (req.url.endsWith(':loadCodeAssist')) return res.end(JSON.stringify({ cloudaicompanionProject: 'synthetic-project', currentTier: { id: 'synthetic' } }));
        if (req.url.endsWith(':retrieveUserQuotaSummary')) return res.end('{"groups":[]}');
        if (generations().length > 16) throw new Error('Bounded fixture generation limit exceeded');
        if (body.requestType === 'web_search') {
          assert.equal(req.url, '/v1internal:generateContent'); assert.equal(body.model, HELPER);
          assert.equal(body.request.generationConfig.thinkingConfig, undefined);
          assert.equal(body.request.toolConfig, undefined);
          const response = { response: { modelVersion: HELPER, candidates: [{ finishReason: 'STOP',
            content: { role: 'model', parts: [{ text: SUMMARY }] }, groundingMetadata: {
              webSearchQueries: [QUERY], groundingChunks: [{ web: { uri: SOURCE, title: 'Controlled Google source reference' } }],
              groundingSupports: [{ segment: { startIndex: 0, endIndex: SUMMARY.length, text: SUMMARY }, groundingChunkIndices: [0] }]
            } }], usageMetadata: { promptTokenCount: 91, candidatesTokenCount: 29, totalTokenCount: 120 } } };
          record.syntheticResponse = response; return res.end(JSON.stringify(response));
        }
        if (!req.url.startsWith('/v1internal:streamGenerateContent')) throw new Error(`Unexpected fixture RPC ${req.url}`);
        assert.equal(body.model, MAIN);
        let call;
        if (cliActive && !searchIssued) {
          const inbound = latestRequest(); assert.ok(inbound, 'actual CLI HTTP declarations must be captured');
          const normalized = normalizeAnthropic(inbound), cleaned = sanitizeClientIdentity(normalized);
          const adapter = prepareAntigravityTools(cleaned.normalized, { sourceTools: normalized.tools, clientIdentity: cleaned.metadata.profile });
          const names = normalized.tools.map(tool => tool.name);
          let name, args;
          if (names.includes('WebSearch')) { name = 'WebSearch'; args = { query: QUERY }; searchIssued = true; }
          else if (names.includes('ToolSearch') && !discoveryIssued) { name = 'ToolSearch'; args = { query: 'select:WebSearch', max_results: 1 }; discoveryIssued = true; }
          else throw new Error(`CLI has no expected declared search tool: ${names.join(',')}`);
          const mapped = adapter.toProvider({ id: `controlled_${name}`, name, arguments: args });
          assert.ok(helpers.declarations(body).some(tool => tool.name === mapped.name));
          call = { id: mapped.id, name: mapped.name, args: mapped.arguments }; record.issuedToolCall = call;
        }
        res.setHeader('content-type', 'text/event-stream');
        const value = { response: { modelVersion: MAIN, candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: call
          ? [{ functionCall: call, thoughtSignature: `controlled-signature-${call.id}` }] : [{ text: COMPLETION }] } }],
          usageMetadata: { promptTokenCount: 128, candidatesTokenCount: 12, totalTokenCount: 140 } } };
        res.end(`data: ${JSON.stringify(value)}\n\n`);
      } catch (error) {
        errors.push(error.message); if (!res.headersSent) { res.statusCode = 500; res.setHeader('content-type', 'application/json'); }
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise((resolve, reject) => { google.once('error', reject); google.listen(0, '127.0.0.1', resolve); }); upstreamPort = google.address().port;
    gatewayPort = await helpers.unusedPort();
    settings = helpers.configure('claude', root, `http://127.0.0.1:${gatewayPort}`, { model: MAIN, apiKey: KEY,
      prompt: `Synthetic local audit. Use WebSearch once for ${QUERY}, without domain filters; then reply ${COMPLETION}. Do not use other tools.` });
    settings.args[settings.args.indexOf('--allowedTools') + 1] = 'WebSearch,ToolSearch';
    settings.args[settings.args.indexOf('--max-turns') + 1] = '5'; settings.args.push('--tools', 'WebSearch,ToolSearch');
    settings.env.CLAUDE_CODE_TMPDIR = path.join(root, 'tmp');
    const gatewaySandbox = path.join(root, 'gateway.sb'); fs.copyFileSync(settings.sandbox, gatewaySandbox);
    helpers.write(settings.sandbox, clientSandbox(settings, root, path.join(os.homedir(), '.antigravity-gateway'), gatewayPort));
    const configDir = path.join(root, 'gateway-data'), injected = path.join(root, 'preload.js');
    helpers.write(path.join(configDir, 'accounts/synthetic.json'), { id: 'synthetic-search-account', email: 'synthetic@example.invalid',
      subjectId: 'synthetic-subject', accessToken: 'gateway-local-fixture-access-token', expiresAt: new Date(Date.now() + 86400000).toISOString(),
      projectId: 'synthetic-project', providerType: 'cloudcode', accountType: 'antigravity', enabled: true, weight: 1,
      capabilities: [MAIN], authMethod: 'oauth' });
    helpers.write(injected, preload(upstreamPort, traceFile));
    gateway = helpers.launch('/usr/bin/sandbox-exec', ['-f', gatewaySandbox, process.execPath, '--require', injected, path.join(ROOT, 'antigravity-gateway.js')],
      { cwd: settings.work, env: { ...settings.env, ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir, ANTIGRAVITY_GATEWAY_PORT: String(gatewayPort),
        ANTIGRAVITY_GATEWAY_API_KEY: KEY, ANTIGRAVITY_DIRECT_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ANTIGRAVITY_DIRECT_MAX_RETRIES: '0',
        ANTIGRAVITY_GATEWAY_TIMEOUT_MS: '15000', ANTIGRAVITY_CLI_PATH: path.join(root, 'nonexistent-agy') } });
    const base = `http://127.0.0.1:${gatewayPort}`, auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
    let ready = false;
    for (let index = 0; index < 150 && !gateway.closed; index++) {
      try { const response = await fetch(`${base}/v1/models`, { headers: auth, signal: AbortSignal.timeout(500) });
        const body = await response.json(); if (body.data?.some(model => model.id === MAIN)) { ready = true; break; } } catch {}
      await delay(50);
    }
    assert.ok(ready, `Isolated gateway did not start: ${gateway.stderr.slice(-1500)}`);
    const post = async (name, body, headers = auth) => {
      const before = generations().length, searchBefore = searches().length, upstreamBefore = upstream.length;
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(18000) });
      const raw = await response.text();
      const record = { name, status: response.status, request: body, responseHeaders: Object.fromEntries(response.headers), responseBody: raw,
        generationCount: generations().length - before, searchCount: searches().length - searchBefore,
        upstreamRequestCount: upstream.length - upstreamBefore };
      scenarios.push(record); return record;
    };
    const nonstream = await post('search-nonstream', searchBody());
    assert.equal(nonstream.status, 200); assert.equal(nonstream.generationCount, 1); assert.equal(nonstream.searchCount, 1);
    assert.equal(nonstream.responseHeaders['x-antigravity-model'], HELPER);
    const saved = parseMessage(nonstream.responseBody, false); assertSearchMessage(saved);
    const streamed = await post('search-stream', searchBody(true));
    assert.equal(streamed.status, 200); assert.equal(streamed.generationCount, 1); assertSearchMessage(parseMessage(streamed.responseBody, true));
    assert.equal(streamed.responseHeaders['x-antigravity-model'], HELPER);
    const tui = structuredClone(require('../tests/fixtures/claude-tui-search-helper-2.1.322.json'));
    const tuiResult = await post('tui-helper-auto-stream', tui);
    assert.equal(tuiResult.status, 200); assert.equal(tuiResult.generationCount, 1); assert.equal(tuiResult.searchCount, 1);
    assertSearchMessage(parseMessage(tuiResult.responseBody, true));
    assert.equal(tuiResult.responseHeaders['x-antigravity-model'], HELPER);
    const tuiWire = searches().at(-1).body;
    assert.equal(tuiWire.request.generationConfig.maxOutputTokens, tui.max_tokens);
    assert.deepEqual(tuiWire.request.contents, [{ role: 'user', parts: [{ text: tui.messages[0].content[0].text }] }]);
    assert.equal(tuiWire.request.systemInstruction.parts.length, 2);
    assert.equal(tuiWire.request.systemInstruction.parts[1].text, tui.system[2].text.replace('another Claude model', 'another model'));
    assert.doesNotMatch(JSON.stringify(tuiWire), /clientSystemProvenance|billing-header|official CLI/);
    const unknownTui = structuredClone(tui); unknownTui.system[0].text = unknownTui.system[0].text.replace('2.1.322', '99.0.0');
    for (const [name, body] of [['tui-unknown-template', unknownTui], ['ordinary-auto-rejection', searchBody(false, { tool_choice: { type: 'auto' } })]]) {
      const rejected = await post(name, body);
      assert.equal(rejected.status, 400); assert.equal(rejected.generationCount, 0);
      assert.equal(JSON.parse(rejected.responseBody).error.type, 'unsupported_server_search_tool_choice');
    }
    const history = { model: MAIN, max_tokens: 4096, messages: [...searchBody().messages, { role: 'assistant', content: saved.content }, { role: 'user', content: 'Preserve the prior search history and answer.' }] };
    const historyResult = await post('history-replay', history);
    assert.equal(historyResult.status, 200); assert.equal(historyResult.searchCount, 0); assert.equal(historyResult.generationCount, 1);
    const historyWire = generations().at(-1).body.request.contents;
    assert.ok(JSON.stringify(historyWire).includes(SOURCE)); assert.ok(JSON.stringify(historyWire).includes('metadata_only'));
    assert.ok(historyWire.every(content => content.parts.every(part => !part.functionCall && !part.functionResponse && !part.thoughtSignature)));
    const changed = structuredClone(history); changed.messages[1].content.find(block => block.type === 'web_search_tool_result').content[0].title = 'Tampered title';
    const tampered = await post('receipt-tamper', changed); assert.equal(tampered.status, 400); assert.equal(tampered.generationCount, 0);
    const otherScope = await post('receipt-other-scope', history, { 'x-api-key': KEY, 'content-type': 'application/json' });
    assert.equal(otherScope.status, 400); assert.equal(otherScope.generationCount, 0);
    for (const stream of [false, true]) {
      const zero = await post(`zero-budget-${stream ? 'stream' : 'nonstream'}`, searchBody(stream, { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 0 }] }));
      assert.equal(zero.status, 200); assert.equal(zero.generationCount, 0);
      const message = parseMessage(zero.responseBody, stream);
      assert.equal(message.content.find(block => block.type === 'web_search_tool_result').content.error_code, 'max_uses_exceeded');
      assert.equal(message.usage.server_tool_use.web_search_requests, 0);
    }
    const restricted = await post('domain-filter-rejection', searchBody(false, { tools: [{ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['example.com'] }] }));
    assert.equal(restricted.status, 400); assert.equal(restricted.generationCount, 0);
    assert.equal(JSON.parse(restricted.responseBody).error.type, 'unsupported_server_search_domain_filter');
    assert.match(JSON.parse(restricted.responseBody).error.message, /严格域名过滤/);
    for (const scenario of scenarios.filter(item => item.generationCount === 0)) {
      assert.equal(scenario.upstreamRequestCount, 0, `${scenario.name} must not make even a metadata/authentication upstream request`);
    }
    if (runCli) {
      cliActive = true; const before = searches().length;
      client = helpers.launch('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...settings.args], { cwd: settings.work, env: settings.env });
      let timer;
      try { cliOutcome = await Promise.race([client.done, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); })]); }
      finally { clearTimeout(timer); await helpers.stop(client); }
      assert.equal(cliOutcome.code, 0, client.stderr.slice(-2000)); assert.equal(cliOutcome.timedOut, undefined);
      assert.equal(searches().length - before, 1, 'one actual WebSearch auxiliary call must make one physical helper request');
      // A manual HTTP response can finish appending its trace after fetch has
      // resolved in this process. Attribute by the observed CLI UA, not a racy
      // starting array length which could swallow an earlier expected 400.
      const claudeUserAgentPrefix = `claude-cli/${helpers.version('claude').version} `;
      const cliHttp = readTrace(traceFile).filter(entry => entry.kind !== 'ingress' && /^\/v1\/messages(?:\?|$)/.test(entry.path)
        && entry.headers?.['user-agent']?.startsWith(claudeUserAgentPrefix));
      assert.ok(cliHttp.length > 1); assert.ok(cliHttp.every(entry => entry.status === 200));
      const captures = cliHttp.filter(entry => entry.body?.tools?.some(tool => tool.type === 'web_search_20250305'));
      assert.equal(captures.length, 1);
      const helper = captures[0]; assert.equal(helper.status, 200);
      assert.equal(helper.responseHeaders['x-antigravity-model'], HELPER);
      assertSearchMessage(parseMessage(helper.responseBody, helper.body.stream));
      const events = client.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const results = events.filter(event => event.type === 'result'); assert.ok(results.length);
      assert.equal(results.at(-1).is_error, false); assert.ok(results.at(-1).result.includes(COMPLETION));
      const outerResults = readTrace(traceFile).filter(entry => entry.kind === 'ingress' && entry.body?.messages)
        .flatMap(entry => entry.body.messages).flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result' && block.tool_use_id === 'controlled_WebSearch');
      assert.ok(outerResults.some(result => !result.is_error && JSON.stringify(result.content).includes(SOURCE) && JSON.stringify(result.content).includes(SUMMARY)));
      cliOutcome = { ...cliOutcome, acceptedHelperModel: HELPER, helperRequests: 1, gatewayMessageRequests: cliHttp.length,
        allGatewayMessages200: true, outerToolResultReturned: true, citationsRequired: false };
    }
    assert.deepEqual(errors, []);
  } catch (error) { failure = { message: error.message, stack: error.stack }; }
  finally {
    await helpers.stop(client); await helpers.stop(gateway);
    if (google) { google.closeAllConnections(); await new Promise(resolve => google.close(resolve)); }
  }
  let evidence;
  try { evidence = helpers.sanitize({ evidence: 'actual-claude-complete-gateway-loopback-search', realGoogleValidated: false, nativeTLSValidated: false,
    version: runCli ? helpers.version('claude') : null, recordedAt: new Date().toISOString(), passed: !failure,
    isolation: 'fresh HOME; synthetic account only; client loopback-only Seatbelt; gateway transport restricted to one local fake Google origin; no page fetching',
    sourceBefore, sourceAfter: sourceSnapshot(), scenarios, cliOutcome, upstream, gatewayTrace: readTrace(traceFile),
    stdout: client?.stdout || '', stderr: client?.stderr || '', gatewayStderr: gateway?.stderr || '', failure,
    gatewayStopped: gateway?.closed === true, clientStopped: !client || client.closed === true, fakeGoogleStopped: !google?.listening
  }, root, [[gatewayPort, 'GATEWAY_PORT'], [upstreamPort, 'UPSTREAM_PORT']]); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  evidence.temporaryDirectoryRemoved = !fs.existsSync(root);
  evidence.sourceUnchanged = evidence.sourceBefore.sha256 === evidence.sourceAfter.sha256;
  finalizeEvidence(evidence);
  if (outFile) helpers.write(outFile, evidence);
  return evidence;
}

function finalizeEvidence(evidence) {
  evidence.completionChecks = { assertionsPassed: !evidence.failure, sourceUnchanged: evidence.sourceUnchanged === true,
    temporaryDirectoryRemoved: evidence.temporaryDirectoryRemoved === true, gatewayStopped: evidence.gatewayStopped === true,
    clientStopped: evidence.clientStopped === true, fakeGoogleStopped: evidence.fakeGoogleStopped === true };
  evidence.passed = Object.values(evidence.completionChecks).every(Boolean);
  return evidence;
}

if (require.main === module) {
  const args = process.argv.slice(2), index = args.indexOf('--out');
  let outFile = path.resolve(index < 0 ? 'tests/fixtures/client-web-tools-20261107/claude-complete-gateway-search.json' : args[index + 1]);
  if (index < 0 && fs.existsSync(outFile)) {
    const base = outFile.slice(0, -5); let version = 2;
    while (fs.existsSync(`${base}-v${version}.json`)) version++;
    outFile = `${base}-v${version}.json`;
  }
  run({ runCli: !args.includes('--http-only'), outFile }).then(result => {
    console.log(JSON.stringify({ file: outFile, passed: result.passed, httpScenarios: result.scenarios.length,
      cliOutcome: result.cliOutcome, sourceUnchanged: result.sourceUnchanged, temporaryDirectoryRemoved: result.temporaryDirectoryRemoved,
      failure: result.failure?.message }));
    if (!result.passed) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run, parseMessage, searchBody, assertSearchMessage, finalizeEvidence };
