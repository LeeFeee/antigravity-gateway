#!/usr/bin/env node
'use strict';

// Actual installed Codex -> isolated gateway -> unchanged native Google TLS.
// Default / --dry-run never reads accounts or starts clients. --run is a
// separate, explicitly frozen experiment; failures are retained, never retried.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const isolation = require('./verify-real-client-gateway');
const processes = require('./verify-client-gateway');
const codex = require('./probe-codex-requests');
const ROOT = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const SCENARIOS = ['text', 'read', 'patch'];

function stateSnapshot(directory) {
  return Object.fromEntries(isolation.STATE_FILES.map(name => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('State must be an ordinary file');
    return [name, sha(fs.readFileSync(file))];
  }));
}
function readTrace(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function createGuard({ nativeFetch, control, record }) {
  const runs = new Map();
  let failed = false;
  return async function guardedFetch(url, options = {}) {
    const parsed = new URL(url), method = String(options.method || 'GET').toUpperCase();
    const cloud = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'].includes(parsed.origin);
    const generation = cloud && /^\/v1internal:(?:streamGenerateContent|generateContent)$/.test(parsed.pathname);
    const metadata = cloud && ['/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels',
      '/v1internal:retrieveUserQuotaSummary', '/v1internal:fetchUserInfo'].includes(parsed.pathname);
    const oauth = parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token';
    const userinfo = parsed.origin === 'https://www.googleapis.com' && parsed.pathname === '/oauth2/v2/userinfo';
    const deny = message => { record({ type: 'guard-denied', message }); throw new Error(message); };
    if (failed) return deny('Experiment stopped after the first native generation failure');
    if (parsed.username || parsed.password || parsed.port || parsed.hash
        || (parsed.search && !(generation && parsed.search === '?alt=sse'))
        || !(generation || metadata || oauth || userinfo)
        || ((generation || metadata || oauth) ? method !== 'POST' : method !== 'GET')) return deny('Native endpoint denied');
    let scope;
    if (generation) {
      scope = control();
      if (!scope || !SCENARIOS.includes(scope.scenario) || !scope.runId || scope.maxGenerations !== 4) return deny('No active bounded scenario');
      let body; try { body = JSON.parse(options.body); } catch { return deny('Invalid generation JSON'); }
      if (body.model !== scope.model || body.requestType !== 'agent') return deny('Unexpected generation model or request type');
      const run = runs.get(scope.runId) || { count: 0, model: scope.model, scenario: scope.scenario };
      if (run.model !== scope.model || run.scenario !== scope.scenario || run.count >= 4) return deny('Physical generation budget exceeded or scope changed');
      runs.set(scope.runId, run); run.count++;
      record({ type: 'generation-dispatch', scenario: scope.scenario, runId: scope.runId, physicalGeneration: run.count, model: body.model });
    } else record({ type: 'supporting-dispatch', purpose: oauth ? 'credential-refresh' : userinfo ? 'identity-metadata' : 'eligibility-metadata', endpoint: parsed.origin + parsed.pathname });
    try {
      const response = await nativeFetch.call(this, url, options);
      if (generation && !response.ok) { failed = true; record({ type: 'generation-failed', status: response.status, scenario: scope.scenario }); }
      return response;
    } catch (error) {
      if (generation) { failed = true; record({ type: 'generation-failed', scenario: scope.scenario, code: error.code }); }
      throw error;
    }
  };
}

function installGuard(config) {
  const append = value => fs.appendFileSync(config.traceFile, JSON.stringify(value) + '\n', { mode: 0o600 });
  const native = require('../src/agy-native-transport');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/bin/manifest.json')));
  const binaryPath = native.resolveNativeBinary({ cacheDir: path.join(config.configDir, 'native'), binaryPath: '' });
  const binarySha256 = sha(fs.readFileSync(binaryPath)), platform = `${process.platform}-${process.arch}`;
  if (manifest.platforms[platform]?.sha256 !== binarySha256) throw new Error('Native binary manifest mismatch');
  append({ type: 'native-manifest', platform, binarySha256, sourceSha256: manifest.sourceSha256 });
  const start = native.AgyNativeTransport.prototype.start, seen = new Set();
  native.AgyNativeTransport.prototype.start = async function(...args) {
    const promise = start.apply(this, args), child = this.child;
    if (child && !seen.has(child.pid)) {
      seen.add(child.pid); append({ type: 'native-started', pid: child.pid });
      child.once('exit', (code, signal) => append({ type: 'native-exited', pid: child.pid, code, signal }));
    }
    return promise;
  };
  native.AgyNativeTransport.prototype.fetch = createGuard({ nativeFetch: native.AgyNativeTransport.prototype.fetch,
    control: () => JSON.parse(fs.readFileSync(config.controlFile, 'utf8')), record: append });
  // Only the original native transport may leave this process. No pages,
  // Node fallback models, subprocess inference or local tool execution here.
  globalThis.fetch = async () => { throw new Error('Experiment denies Node outbound fetch'); };
  for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) {
    require(name)[method] = () => { throw new Error('Experiment denies Node outbound HTTP'); };
  }
}

function sseEvents(text) {
  const output = [];
  for (const frame of String(text).replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') output.push(JSON.parse(data));
  }
  return output;
}
function completeResponses(events) {
  if (!events.length || events[0].type !== 'response.created' || events.at(-1).type !== 'response.completed') return false;
  if (events.filter(event => event.type === 'response.created').length !== 1
      || events.filter(event => ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type)).length !== 1) return false;
  const added = new Map(), done = new Set(), values = new Map();
  const inputDone = new Set(), doneItems = new Map();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.sequence_number !== i) return false;
    if (event.type === 'response.output_item.added') {
      if (added.has(event.output_index)) return false;
      added.set(event.output_index, event.item);
      if (event.item.type === 'function_call' && event.item.arguments !== '') return false;
      if (event.item.type === 'custom_tool_call' && event.item.input !== '') return false;
    }
    if (/^response\.(function_call_arguments|custom_tool_call_input)\.delta$/.test(event.type)) {
      if (added.get(event.output_index)?.id !== event.item_id) return false;
      values.set(event.item_id, (values.get(event.item_id) || '') + event.delta);
    }
    if (/^response\.(function_call_arguments|custom_tool_call_input)\.done$/.test(event.type)) {
      if (added.get(event.output_index)?.id !== event.item_id || inputDone.has(event.item_id)
          || values.get(event.item_id) !== (event.arguments ?? event.input)) return false;
      inputDone.add(event.item_id);
    }
    if (event.type === 'response.output_item.done') {
      if (added.get(event.output_index)?.id !== event.item.id || done.has(event.output_index)) return false;
      if (['function_call', 'custom_tool_call'].includes(event.item.type)
          && (!inputDone.has(event.item.id) || values.get(event.item.id) !== (event.item.arguments ?? event.item.input))) return false;
      done.add(event.output_index);
      doneItems.set(event.output_index, event.item);
    }
  }
  const final = events.at(-1).response;
  return final?.status === 'completed' && !final.error && done.size === added.size
    && final.output?.length === done.size && final.output.every((item, index) => isDeepStrictEqual(item, doneItems.get(index)));
}
function nativeValues(trace) {
  return trace.filter(item => item.type === 'native-body').flatMap(item => {
    try { const data = JSON.parse(item.body); return Array.isArray(data) ? data : [data]; } catch {}
    try { return sseEvents(item.body); } catch { return []; }
  });
}
function assess(scenario, trace, outcome, marker, file) {
  const client = trace.filter(item => item.type === 'client-http' && /^\/v1\/responses(?:\?|$)/.test(item.path));
  const requests = trace.filter(item => item.type === 'native-request' && /:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(item.url));
  const ids = new Set(requests.map(item => item.id)), responses = trace.filter(item => item.type === 'native-response' && ids.has(item.id));
  let events = [], parseError = false;
  try { events = client.map(item => sseEvents(item.responseBody)); } catch { parseError = true; }
  const items = events.flatMap(stream => stream.at(-1)?.response?.output || []);
  const calls = items.filter(item => ['function_call', 'custom_tool_call'].includes(item.type));
  const outputs = client.flatMap(item => Array.isArray(item.body?.input) ? item.body.input : []).filter(item => /^(?:function|custom_tool)_call_output$/.test(item.type));
  const parts = requests.flatMap(item => item.body?.request?.contents || []).flatMap(content => content.parts || []);
  const receipts = parts.filter(part => part.functionResponse).map(part => part.functionResponse);
  const rawCalls = nativeValues(trace).flatMap(value => (value.response || value).candidates || []).flatMap(candidate => candidate.content?.parts || []).filter(part => part.functionCall);
  const cliEvents = String(outcome.stdout || '').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const executed = cliEvents.filter(event => event.type === 'item.completed').map(event => event.item);
  const visible = items.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
  const checks = {
    clientSucceeded: outcome.code === 0 && !outcome.timedOut && !outcome.error && !cliEvents.some(event => event.type === 'error' || event.type === 'turn.failed'),
    gatewayHTTP: client.length > 0 && client.every(item => item.status === 200),
    completeSSE: !parseError && events.length > 0 && events.every(completeResponses),
    physicalBudget: requests.length >= 1 && requests.length <= 4,
    originalNativeTLS: responses.length === requests.length && responses.every(item => item.status === 200 && /agy-transport-/.test(item.binary || '')),
    officialUA: requests.length > 0 && requests.every(item => /^antigravity\/cli\/1\.5\.2 /.test(item.headers?.['user-agent'] || '')),
    finalMarker: visible.includes(marker),
    noGuardFailure: !trace.some(item => ['guard-denied', 'generation-failed'].includes(item.type))
  };
  if (scenario === 'text') checks.noTools = calls.length === 0;
  else {
    const expected = scenario === 'read' ? /(?:^|\.)(?:exec_command|shell_command)$/ : /(?:^|\.)apply_patch$/;
    checks.clientToolObserved = calls.some(call => expected.test(call.name));
    checks.onlyExpectedTools = calls.every(call => /(?:^|\.)(?:exec_command|shell_command|write_stdin|apply_patch)$/.test(call.name));
    checks.originalCallIdsReturned = calls.length > 0 && calls.every(call => outputs.some(output => output.call_id === call.call_id));
    checks.followupGeneration = requests.length >= 2 && receipts.length > 0;
    checks.originalNativeCallsAndSignatures = rawCalls.length > 0 && rawCalls.every(raw => parts.some(part =>
      part.functionCall?.name === raw.functionCall.name && isDeepStrictEqual(part.functionCall.args, raw.functionCall.args)
      && (!raw.functionCall.id || part.functionCall.id === raw.functionCall.id)
      && (!raw.thoughtSignature || part.thoughtSignature === raw.thoughtSignature)));
    checks.nativeReceiptNamesAndIds = rawCalls.length > 0 && rawCalls.every(raw => receipts.some(receipt =>
      receipt.name === raw.functionCall.name && (!raw.functionCall.id || receipt.id === raw.functionCall.id)));
    if (scenario === 'read') {
      checks.randomFileResult = receipts.some(receipt => JSON.stringify(receipt.response).includes(marker));
      checks.clientExecutedRead = executed.some(item => item?.type === 'command_execution' && item.exit_code === 0 && String(item.aggregated_output).includes(marker));
      checks.fileUnchanged = file.beforeSha256 === file.afterSha256;
    } else {
      checks.clientExecutedPatch = executed.some(item => item?.type === 'file_change' && item.status === 'completed'
        && item.changes?.some(change => path.basename(change.path) === 'probe-patch.txt'));
      checks.exactPatchedFile = file.actual === file.expected && file.beforeSha256 !== file.afterSha256;
    }
  }
  return { passed: Object.values(checks).every(Boolean), checks, physicalGenerations: requests.length, clientRequests: client.length,
    returnedToolNames: [...new Set(calls.map(call => call.name))], nativeStatuses: responses.map(item => item.status) };
}

function configureScenario(root, base, model, scenario, apiKey) {
  const marker = `CODEX_REAL_${scenario.toUpperCase()}_${crypto.randomBytes(8).toString('hex')}`;
  const work = path.join(root, 'work'), filePath = path.join(work, scenario === 'patch' ? 'probe-patch.txt' : 'probe-input.txt');
  const expected = marker + '\n';
  const prompt = scenario === 'text' ? `Controlled connectivity test: reply exactly ${marker}. Use no tools.`
    : scenario === 'read' ? `Read only ${filePath} with exec_command (cat the file). Reply with its exact second line. Do not modify files, use other tools, search, delegate, or plan.`
    : `Use apply_patch to replace the one line BEFORE_PATCH in ${filePath} with ${marker}. Then reply exactly ${marker}. Do not read or modify other files, execute commands, search, delegate, or plan.`;
  const settings = codex.configure(root, base, { catalog: true, prompt, model, apiKey });
  settings.env.CODEX_PROBE_FAKE_KEY = apiKey;
  isolation.privateWrite(filePath, scenario === 'patch' ? 'BEFORE_PATCH\n' : `CONTROLLED_READ_FIXTURE\n${marker}\n`);
  return { settings, marker, filePath, expected, beforeSha256: sha(fs.readFileSync(filePath)) };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const option = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  const run = argv.includes('--run'), output = path.resolve(option('--out', 'tests/fixtures/real-codex-gateway-20261107'));
  if (run && argv.includes('--dry-run')) throw new Error('Choose either --run or --dry-run');
  const scenarios = option('--scenarios', 'text,read,patch').split(','), model = option('--model', 'gemini-3.8-flash-low');
  const timeoutMs = Number(option('--timeout', '150')) * 1000;
  if (!scenarios.length || new Set(scenarios).size !== scenarios.length || scenarios.some(name => !SCENARIOS.includes(name))) throw new Error('Unsupported or duplicate scenario');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Timeout must be 1–300 seconds');
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('macOS Seatbelt is required');
  const sourceBefore = isolation.sourceSnapshot(), expectedSource = option('--expected-source-sha', '');
  if (run && (!/^[a-f0-9]{64}$/.test(expectedSource) || expectedSource !== sourceBefore.sha256)) throw new Error('Explicit frozen --expected-source-sha must match current runtime');
  const reportPath = path.join(output, run ? 'summary.json' : 'prepared.json');
  if (fs.existsSync(reportPath) || (run && scenarios.some(name => fs.existsSync(path.join(output, `${name}.json`))))) throw new Error('Refusing to overwrite existing evidence');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-real-'))); fs.chmodSync(root, 0o700);
  const sourceConfig = path.resolve(option('--source-config', path.join(os.homedir(), '.antigravity-gateway')));
  const configDir = path.join(root, 'gateway-data'), traceFile = path.join(root, 'sanitized-trace.jsonl'), controlFile = path.join(root, 'scenario.json');
  const apiKey = `codex-local-verifier-${crypto.randomBytes(24).toString('hex')}`;
  let gateway, snapshot, formalStateBefore, formalStateAfter, formalAccountsAfter, formalSemanticAfter, installationBefore, installationAfter, installationValue;
  const results = [], prepared = [], source = { sha256: sha(fs.readFileSync(__filename)), codexProbeSha256: sha(fs.readFileSync(path.join(__dirname, 'probe-codex-requests.js'))) };
  let failure, trace = [], nativeStopped = true, gatewayStopped = true, port;
  const installationFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'installation_id');
  try {
    port = await processes.unusedPort();
    if (run) {
      const stat = fs.lstatSync(installationFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Existing installation_id must be a regular file');
      const bytes = fs.readFileSync(installationFile); installationValue = bytes.toString('utf8').trim();
      installationBefore = { sha256: sha(bytes), mtimeMs: stat.mtimeMs };
      formalStateBefore = stateSnapshot(sourceConfig);
      snapshot = isolation.copyManagedState(sourceConfig, configDir);
      if (!isDeepStrictEqual(formalStateBefore, stateSnapshot(sourceConfig))) throw new Error('Formal state changed during copying');
      snapshot.secrets.push(installationValue, apiKey);
      isolation.privateWrite(controlFile, null);
      let observer = isolation.observerSource(traceFile, configDir, root, apiKey);
      const declaration = `const secrets=[${JSON.stringify(apiKey)}];`;
      if (!observer.includes(declaration)) throw new Error('Observer secret declaration changed');
      observer = observer.replace(declaration, `const secrets=${JSON.stringify([apiKey, installationValue])};`);
      const preload = path.join(root, 'observe.js'), policy = path.join(root, 'gateway.sb');
      isolation.privateWrite(preload, observer + `\nrequire(${JSON.stringify(__filename)}).installGuard(${JSON.stringify({ traceFile, configDir, controlFile })});\n`);
      isolation.privateWrite(policy, isolation.gatewaySandbox(root, sourceConfig));
      const tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp);
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ['HOME', 'CODEX_HOME'].includes(key))),
        PATH: process.env.PATH, TMPDIR: tmp, TERM: 'dumb', NO_COLOR: '1', ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir,
        ANTIGRAVITY_GATEWAY_PORT: String(port), ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1', ANTIGRAVITY_GATEWAY_API_KEY: apiKey,
        ANTIGRAVITY_GATEWAY_TIMEOUT_MS: String(timeoutMs), ANTIGRAVITY_DEFAULT_MODEL: model };
      gateway = processes.launch('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, '--require', preload, path.join(ROOT, 'antigravity-gateway.js')], { cwd: root, env });
      let ready = false;
      for (let index = 0; index < 120 && !gateway.closed; index++) {
        try { const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1000) });
          const body = await response.json(); if (response.ok && body.data?.some(item => item.id === model)) { ready = true; break; } } catch {}
        await delay(250);
      }
      if (!ready) throw new Error('Requested model unavailable under preserved eligibility rules');
    }
    for (const scenario of scenarios) {
      const setup = configureScenario(path.join(root, `client-${scenario}`), `http://127.0.0.1:${port}`, model, scenario, apiKey);
      const { settings } = setup;
      isolation.privateWrite(settings.sandbox, fs.readFileSync(settings.sandbox, 'utf8')
        + `\n(allow file-read* (literal ${JSON.stringify(installationFile)}))\n(deny file-read* (subpath ${JSON.stringify(configDir)}) (subpath ${JSON.stringify(sourceConfig)}))\n`);
      prepared.push({ scenario, command: [settings.command, ...settings.args], policy: fs.readFileSync(settings.sandbox, 'utf8'), maxPhysicalGenerations: 4 });
      if (!run) continue;
      isolation.privateWrite(controlFile, { scenario, model, runId: crypto.randomUUID(), maxGenerations: 4 });
      const start = readTrace(traceFile).length;
      let client, outcome, timer;
      try {
        client = processes.launch('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...settings.args], { cwd: settings.work, env: settings.env });
        outcome = await Promise.race([client.done, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); })]);
      } finally { clearTimeout(timer); await processes.stop(client); }
      await delay(150);
      const scenarioTrace = readTrace(traceFile).slice(start), actual = fs.existsSync(setup.filePath) ? fs.readFileSync(setup.filePath, 'utf8') : null;
      outcome = { ...outcome, stdout: client?.stdout || '', stderr: client?.stderr || '' };
      const file = { path: setup.filePath, beforeSha256: setup.beforeSha256, afterSha256: actual === null ? null : sha(actual), actual, expected: setup.expected };
      const assessment = assess(scenario, scenarioTrace, outcome, setup.marker, file);
      const record = isolation.scrub({ evidence: 'actual-codex-cli-real-gateway-real-google-native-tls', scenario, recordedAt: new Date().toISOString(), model,
        sourceBefore, scriptSource: source, accountSnapshot: snapshot.summary, marker: setup.marker, file, outcome, assessment, trace: scenarioTrace }, snapshot.secrets, root);
      isolation.privateWrite(path.join(output, `${scenario}.json`), record); results.push(record);
      if (!assessment.passed) { failure = `Scenario ${scenario} failed; no further scenarios dispatched`; break; }
      if (sha(fs.readFileSync(installationFile)) !== installationBefore.sha256) { failure = 'Codex installation metadata changed; no further scenarios dispatched'; break; }
    }
  } catch (error) { failure = error.message; }
  finally {
    await processes.stop(gateway); gatewayStopped = !gateway || gateway.closed;
    trace = readTrace(traceFile);
    const pids = [...new Set(trace.filter(item => item.type === 'native-started').map(item => item.pid))];
    for (let index = 0; index < 20 && pids.some(alive); index++) await delay(100);
    nativeStopped = pids.every(pid => !alive(pid));
    try {
      if (run) {
        formalAccountsAfter = isolation.accountSnapshot(sourceConfig); formalStateAfter = stateSnapshot(sourceConfig);
        if (snapshot) {
          const after = isolation.copyManagedState(sourceConfig, path.join(root, 'formal-state-after'));
          formalSemanticAfter = after.summary; snapshot.secrets.push(...after.secrets);
          if (after.before.digest !== formalAccountsAfter.digest || !isDeepStrictEqual(formalStateAfter, stateSnapshot(sourceConfig))) {
            failure ||= 'Formal state changed during final semantic snapshot';
          }
        }
        installationAfter = { sha256: sha(fs.readFileSync(installationFile)), mtimeMs: fs.statSync(installationFile).mtimeMs };
      }
    } catch (error) { failure ||= `Final integrity check failed: ${error.message}`; }
    finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }
  const sourceAfter = isolation.sourceSnapshot(), temporaryCredentialsRemoved = !fs.existsSync(root);
  const report = isolation.scrub({ recordedAt: new Date().toISOString(), evidence: run ? 'actual-codex-cli-real-gateway-real-google-native-tls' : 'offline-preparation-only',
    run, accountDataRead: Boolean(snapshot), realRequestsSent: trace.some(item => item.type === 'native-request'), sourceBefore, sourceAfter,
    scriptSource: source, sourceUnchanged: sourceBefore.sha256 === sourceAfter.sha256,
    codexVersion: execFileSync(codex.BINARY, ['--version'], { encoding: 'utf8' }).trim(), codexBinarySha256: sha(fs.readFileSync(codex.BINARY)),
    accountSnapshot: snapshot?.summary, formalSemanticAfter, formalAccountsBefore: snapshot?.before, formalAccountsAfter,
    formalAccountsUnchanged: run ? snapshot?.before.digest === formalAccountsAfter?.digest : true,
    formalStateBefore, formalStateAfter, formalStateUnchanged: !run || isDeepStrictEqual(formalStateBefore, formalStateAfter),
    installationBefore, installationAfter, installationIdUnchanged: !run || installationBefore?.sha256 === installationAfter?.sha256,
    nativeStopped, gatewayStopped, temporaryCredentialsRemoved, prepared, failure,
    results: results.map(({ scenario, assessment }) => ({ scenario, assessment })),
    gatewayStdout: gateway?.stdout || '', gatewayStderr: gateway?.stderr || '', trace }, snapshot?.secrets || [apiKey], root);
  report.passed = !failure && report.sourceUnchanged && report.formalAccountsUnchanged && report.formalStateUnchanged
    && report.installationIdUnchanged && nativeStopped && gatewayStopped && temporaryCredentialsRemoved
    && (run ? results.length === scenarios.length && results.every(result => result.assessment.passed) : !report.accountDataRead && !report.realRequestsSent);
  isolation.privateWrite(reportPath, report);
  console.log(JSON.stringify({ output: reportPath, run, passed: report.passed, results: report.results, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
  return report;
}
module.exports = { createGuard, installGuard, assess, completeResponses, sseEvents, stateSnapshot, configureScenario, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
