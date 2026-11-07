#!/usr/bin/env node
'use strict';

// Installed, signed Codex -> full gateway HTTP -> synthetic Google endpoint.
// No real account, global configuration, Google request, or HOME override.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const probe = require('./probe-codex-requests');
const { launch, stop, write, unusedPort, preloadSource } = require('./verify-client-gateway');
const ROOT = path.resolve(__dirname, '..');
const FAKE_ACCESS = 'codex-synthetic-access-token';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SCENARIOS = ['text', 'read', 'patch', 'error', 'image', 'image-input', 'compact', 'namespace-error', 'parallel'];

function sourceSnapshot() {
  const files = ['antigravity-gateway.js', ...fs.readdirSync(path.join(ROOT, 'src')).filter(n => n.endsWith('.js')).map(n => 'src/' + n)].sort();
  return { files: files.length, sha256: sha(files.map(name => name + '\0' + sha(fs.readFileSync(path.join(ROOT, name)))).join('\n')) };
}
function installationSnapshot() { const bytes = fs.readFileSync(probe.INSTALLATION_FILE); return { sha256: sha(bytes), mtimeMs: fs.statSync(probe.INSTALLATION_FILE).mtimeMs }; }
function functions(body) { return (body.request?.tools || []).flatMap(t => t.functionDeclarations || []); }
function results(body) { return (body.request?.contents || []).flatMap(c => c.parts || []).filter(p => p.functionResponse).map(p => p.functionResponse); }
function textParts(body) { return (body.request?.contents || []).flatMap(c => c.parts || []).map(p => p.text || '').join('\n'); }
function selectCall(body, scenario, work) {
  const candidates = functions(body).filter(tool => {
    const p = tool.parameters?.properties || {};
    return scenario === 'namespace-error' ? Object.hasOwn(p, 'target') && /Close an agent and any open descendants/.test(tool.description)
      : scenario === 'patch' ? Object.hasOwn(p, 'input') && /apply_patch/.test(tool.description)
      : scenario === 'image' ? Object.hasOwn(p, 'path') && /View a local image/.test(tool.description)
      : Object.hasOwn(p, 'cmd') && /Runs a command/.test(tool.description);
  });
  if (candidates.length !== 1) throw new Error(`Expected one ${scenario} declaration, got ${candidates.length}`);
  const declaration = candidates[0];
  const args = scenario === 'namespace-error' ? { target: '00000000-0000-0000-0000-000000000001' }
    : scenario === 'patch' ? { input: '*** Begin Patch\n*** Add File: codex-written.txt\n+CODEX_PATCH_DISK_MARKER\n*** End Patch\n' }
    : scenario === 'image' ? { path: path.join(work, 'probe-image.png') }
    : { cmd: `/bin/cat ${scenario === 'error' ? 'missing-fixture.txt' : 'probe-input.txt'}`, workdir: work, login: false, max_output_tokens: 256, yield_time_ms: 1000 };
  args.toolSummary = 'Execute the explicitly allowed synthetic local fixture action';
  return { id: `codex_mock_${scenario}`, name: declaration.name, args };
}
function googleEvent(parts, inputTokens = 128) {
  return { response: { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: 12, totalTokenCount: inputTokens + 12 }, modelVersion: probe.MODEL } };
}
function gatewayPolicy(root, upstreamPort, gatewayPort) {
  return `(version 1)(allow default)
(deny file-read* (subpath ${JSON.stringify(os.homedir())}))
(allow file-read-metadata (subpath ${JSON.stringify(os.homedir())}))
(allow file-read* (subpath ${JSON.stringify(ROOT)}) (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(path.resolve(path.dirname(process.execPath), '..'))}))
(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
(deny network*)(allow network-outbound (remote ip "localhost:${upstreamPort}"))
(allow network-inbound (local ip "localhost:*"))(allow network-bind (local ip "localhost:*"))`;
}
function assistantTexts(trace) {
  return trace.flatMap(t => t.responseBody.split('\n').filter(l => l.startsWith('data: ')).flatMap(l => {
    try { const e = JSON.parse(l.slice(6)); return e.type === 'response.output_text.done' ? [e.text] : []; } catch { return []; }
  }));
}
function completeResponseStream(text) {
  const frames = text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(Boolean);
  const events = frames.filter(x => x !== '[DONE]').map(x => { try { return JSON.parse(x); } catch { return null; } });
  return events.length > 0 && events.every(Boolean) && events.at(-1).type === 'response.completed' && events.at(-1).response?.status === 'completed';
}
function assess(scenario, record) {
  const generations = record.upstream.filter(x => x.path.includes(':streamGenerateContent'));
  const responses = record.clientHTTP.filter(x => /^\/v1\/responses(?:\?|$)/.test(x.path));
  const returned = generations.flatMap(x => results(x.body));
  const checks = {
    clientExit0: record.outcome.code === 0 && !record.outcome.timedOut,
    completeGatewayHTTP: responses.length > 0 && responses.every(x => x.status === 200 && completeResponseStream(x.responseBody)),
    catalogActuallyApplied: responses.some(x => x.body.input?.[0]?.content?.[0]?.text === 'Follow the client instructions and use only client-provided tools when needed.'),
    userProjectRulePreserved: generations.some(x => textParts(x.body).includes('PROBE_USER_RULE')),
    namespaceDeclaredByRealClient: responses.some(x => x.body.tools?.some(t => t.type === 'namespace' && t.name === 'multi_agent_v1')),
    finalAssistantTextDelivered: assistantTexts(responses).includes(probe.MARKER) && record.stdout.includes(probe.MARKER),
    upstreamEnvelope: generations.length > 0 && generations.every(x => x.body.userAgent === 'antigravity' && x.body.requestType === 'agent'),
    fixedModelThinking: generations.every(x => x.body.model === probe.MODEL && x.body.request.generationConfig?.thinkingConfig?.thinkingLevel === 'LOW'),
    boundedGenerations: generations.length <= 5,
    sourceUnchanged: record.sourceBefore.sha256 === record.sourceAfter.sha256,
    installationContentsUnchanged: record.installationBefore.sha256 === record.installationAfter.sha256,
    isolatedStateRemoved: record.temporaryDirectoryRemoved,
    noFixtureError: !record.error && !record.upstreamErrors.length
  };
  if (['read', 'compact'].includes(scenario)) checks.clientReadReturned = returned.some(x => JSON.stringify(x).includes('CODEX_LOCAL_FILE_MARKER'));
  if (scenario === 'patch') checks.clientPatchWroteFile = record.disk.written === 'CODEX_PATCH_DISK_MARKER\n' && returned.length > 0;
  if (scenario === 'error') checks.clientErrorReturned = returned.some(x => /No such file|does not exist/.test(JSON.stringify(x)));
  if (scenario === 'namespace-error') checks.namespaceDispatched = responses.some(x => x.responseBody.includes('"namespace":"multi_agent_v1"') && x.responseBody.includes('"name":"close_agent"')) && returned.some(x => /not found|not exist|invalid agent|Unknown agent/i.test(JSON.stringify(x)));
  if (scenario === 'parallel') checks.bothParallelResultsReturned = returned.some(x => JSON.stringify(x).includes('CODEX_LOCAL_FILE_MARKER')) && returned.some(x => JSON.stringify(x).includes('CODEX_SECOND_FILE_MARKER')) && new Set(returned.map(x => x.id)).size >= 2;
  if (scenario === 'image') checks.clientImageReturned = generations.some(x => JSON.stringify(x.body.request.contents).includes('inlineData')) && returned.length > 0;
  if (scenario === 'image-input') checks.clientImageInput = generations.some(x => JSON.stringify(x.body.request.contents).includes('inlineData'));
  if (scenario === 'compact') {
    checks.realCompressionRequest = responses.some(x => !x.body.tools.length && JSON.stringify(x.body.input).includes('CONTEXT CHECKPOINT COMPACTION'));
    checks.resumedFromSummary = responses.some(x => x.body.tools.length && JSON.stringify(x.body.input).includes('Another language model started to solve this problem'));
  }
  return { passed: Object.values(checks).every(Boolean), checks, generations: generations.length, responses: responses.length };
}

async function run(scenario, { output, timeoutMs = 45000 } = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error('Unsupported local scenario');
  if (fs.existsSync(output)) throw new Error('Existing evidence must not be overwritten');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-')));
  const sourceBefore = sourceSnapshot(), installationBefore = installationSnapshot();
  const privateValues = [fs.readFileSync(probe.INSTALLATION_FILE, 'utf8').trim(), FAKE_ACCESS];
  const upstream = [], upstreamErrors = [], trace = path.join(root, 'http.jsonl');
  let gateway, client, settings, outcome = {}, error, disk = {}, generationCount = 0;
  const google = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const capture = { path: req.url, headers: req.headers, body }; upstream.push(capture);
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith(':fetchAvailableModels')) return res.end(JSON.stringify({ models: { [probe.MODEL]: {
        displayName: 'Synthetic image-capable Flash Low', maxTokens: 1048576, maxOutputTokens: 65536, supportsImages: true,
        supportsThinking: true, thinkingLevel: 1, supportedMimeTypes: { 'image/png': true } } } }));
      if (req.url.endsWith(':loadCodeAssist')) return res.end(JSON.stringify({ cloudaicompanionProject: 'synthetic-project', currentTier: { id: 'synthetic' } }));
      if (req.url.endsWith(':retrieveUserQuotaSummary')) return res.end('{"groups":[]}');
      if (!req.url.includes(':streamGenerateContent')) throw new Error(`Unexpected synthetic RPC ${req.url}`);
      if (++generationCount > 5) throw new Error('Synthetic generation budget exceeded');
      res.setHeader('content-type', 'text/event-stream');
      if (generationCount === 1 && ['read', 'error', 'patch', 'image', 'compact', 'namespace-error', 'parallel'].includes(scenario)) {
        const call = selectCall(body, scenario, settings.work); capture.issuedToolCall = call;
        const parts = [{ functionCall: call, thoughtSignature: 'synthetic-codex-signature-not-provider-issued' }];
        if (scenario === 'parallel') {
          const second = structuredClone(call); second.id += '_second'; second.args.cmd = '/bin/cat probe-second.txt';
          capture.issuedSecondToolCall = second; parts.push({ functionCall: second, thoughtSignature: 'synthetic-codex-second-signature-not-provider-issued' });
        }
        res.end('data: ' + JSON.stringify(googleEvent(parts, scenario === 'compact' ? 2000 : 128)) + '\n\n');
      } else res.end('data: ' + JSON.stringify(googleEvent([{ text: probe.MARKER }])) + '\n\n');
    } catch (e) { upstreamErrors.push(e.message); if (!res.headersSent) res.statusCode = 400; res.end(JSON.stringify({ error: { code: 400, message: e.message } })); }
  });
  await new Promise(resolve => google.listen(0, '127.0.0.1', resolve));
  const upstreamPort = google.address().port, gatewayPort = await unusedPort();
  let clientHTTP = [], gatewayStdout = '', gatewayStderr = '', stdout = '', stderr = '';
  try {
    settings = probe.configure(root, `http://127.0.0.1:${gatewayPort}`, { catalog: true,
      configOverrides: scenario === 'compact' ? { model_auto_compact_token_limit: 512 } : {},
      prompt: `Controlled ${scenario} integration. Use only the specified temporary fixture action. Reply exactly ${probe.MARKER} when complete.` });
    if (scenario === 'parallel') fs.writeFileSync(path.join(settings.work, 'probe-second.txt'), 'CODEX_SECOND_FILE_MARKER\n');
    if (['image', 'image-input'].includes(scenario)) {
      fs.copyFileSync(path.join(ROOT, 'tests/fixtures/gateway-media-inputs/image-fixture.png'), path.join(settings.work, 'probe-image.png'));
      if (scenario === 'image-input') settings.args.splice(settings.args.length - 1, 0, '--image', path.join(settings.work, 'probe-image.png'), '--');
    }
    const configDir = path.join(root, 'gateway-data'), preload = path.join(root, 'preload.js'), policy = path.join(root, 'gateway.sb');
    write(path.join(configDir, 'accounts/synthetic.json'), { id: 'synthetic-account', email: 'synthetic@example.invalid',
      subjectId: 'synthetic-identity', accessToken: FAKE_ACCESS, expiresAt: new Date(Date.now() + 86400000).toISOString(),
      projectId: 'synthetic-project', providerType: 'cloudcode', accountType: 'antigravity', enabled: true, weight: 1,
      capabilities: [probe.MODEL], authMethod: 'oauth' });
    write(preload, preloadSource(upstreamPort, trace)); write(policy, gatewayPolicy(root, upstreamPort, gatewayPort));
    gateway = launch('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, '--require', preload, path.join(ROOT, 'antigravity-gateway.js')],
      { cwd: settings.work, env: { ...settings.env, ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir, ANTIGRAVITY_GATEWAY_PORT: String(gatewayPort),
        ANTIGRAVITY_GATEWAY_API_KEY: probe.FAKE_KEY, ANTIGRAVITY_DIRECT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        ANTIGRAVITY_DIRECT_MAX_RETRIES: '0', ANTIGRAVITY_GATEWAY_TIMEOUT_MS: '30000', ANTIGRAVITY_CLI_PATH: path.join(root, 'absent-agy') } });
    let ready = false;
    for (let i = 0; i < 100 && !gateway.closed; i++) {
      try { const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: { authorization: `Bearer ${probe.FAKE_KEY}` }, signal: AbortSignal.timeout(500) });
        const body = await response.json(); if (body.models?.some(m => m.slug === probe.MODEL && m.input_modalities.includes('image'))) { ready = true; break; }
      } catch {} await delay(50);
    }
    if (!ready) throw new Error('Synthetic gateway image-capable catalog not ready: ' + gateway.stderr.slice(-500));
    client = launch('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...settings.args], { cwd: settings.work, env: settings.env });
    let timer;
    try { outcome = await Promise.race([client.done, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  } catch (e) { error = e.message; }
  finally {
    try {
      await stop(client); await stop(gateway); google.closeAllConnections(); await new Promise(resolve => google.close(resolve));
      if (fs.existsSync(trace)) clientHTTP = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      disk = { written: settings && fs.existsSync(path.join(settings.work, 'codex-written.txt')) ? fs.readFileSync(path.join(settings.work, 'codex-written.txt'), 'utf8') : null };
      stdout = client?.stdout || ''; stderr = client?.stderr || ''; gatewayStdout = gateway?.stdout || ''; gatewayStderr = gateway?.stderr || '';
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const record = { scenario, version: execFileSync(probe.BINARY, ['--version'], { encoding: 'utf8' }).trim(), recordedAt: new Date().toISOString(),
    evidence: 'actual-codex-cli-real-gateway-synthetic-google', realModelValidated: false, nativeTLSValidated: false,
    isolation: 'Unchanged HOME/CODEX_HOME; original signed CLI; external Seatbelt; temporary state; synthetic accounts; only loopback; installation_id existing-file RW metadata exception',
    injection: 'Only nativeCloudCodeFetch replaced with loopback-restricted fetch; real HTTP/protocol/AccountPool/Direct/session/tool converter',
    command: settings && [settings.command, ...settings.args], outcome, error, disk, sourceBefore, sourceAfter: sourceSnapshot(),
    installationBefore, installationAfter: installationSnapshot(), temporaryDirectoryRemoved: !fs.existsSync(root),
    clientHTTP, upstream, upstreamErrors, stdout, stderr, gatewayStdout, gatewayStderr };
  record.assessment = assess(scenario, record);
  const clean = probe.sanitize(record, root, gatewayPort, '', privateValues);
  write(output, clean); console.log(JSON.stringify({ output, assessment: clean.assessment, error })); return clean;
}
async function main() {
  const argv = process.argv.slice(2), arg = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
  const scenario = arg('--scenario', 'text'), output = path.resolve(arg('--out', `tests/fixtures/codex-gateway-0.164.0-20261107/${scenario}.json`));
  if (!(await run(scenario, { output })).assessment.passed) process.exitCode = 1;
}
module.exports = { run, assess, selectCall, completeResponseStream, sourceSnapshot, installationSnapshot, SCENARIOS };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
