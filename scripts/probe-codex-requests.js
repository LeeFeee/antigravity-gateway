#!/usr/bin/env node
'use strict';

// Installed Codex -> one loopback synthetic provider. Never overrides HOME or
// CODEX_HOME, and never permits model/provider traffic outside the local server.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SOURCE_HOME = os.homedir();
const INSTALLATION_FILE = path.join(process.env.CODEX_HOME || path.join(SOURCE_HOME, '.codex'), 'installation_id');
const INSTALL = path.resolve(path.dirname(process.execPath), '../lib/node_modules/@openai/codex');
const BINARY = path.join(INSTALL, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
const FAKE_KEY = 'sk-codex-loopback-fixture-only';
const MARKER = 'CODEX_CAPTURE_OK';
const MODEL = 'gemini-3.8-flash-low';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function sanitize(value, root, port, key = '', privateValues = []) {
  if (/authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie/i.test(key)) return '<FAKE_CREDENTIAL>';
  if (/^(?:x[-_])?(?:installation|device|machine)[-_]?id$/i.test(key)) return '<REDACTED_INSTALLATION_METADATA>';
  if (typeof value === 'string') {
    for (const item of privateValues) if (item) value = value.split(item).join('<REDACTED_INSTALLATION_METADATA>');
    return value.split(FAKE_KEY).join('<FAKE_CREDENTIAL>').split(root).join('/tmp/codex-probe')
      .split(SOURCE_HOME).join('/home/probe').split(`127.0.0.1:${port}`).join('127.0.0.1:PROBE_PORT');
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, root, port, '', privateValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, root, port, name, privateValues)]));
  return value;
}

function configure(root, base, { catalog = false, prompt, model = MODEL, apiKey = FAKE_KEY, ignoreRules = true, configOverrides = {}, extraArgs = [] } = {}) {
  const work = path.join(root, 'work');
  for (const name of ['work', 'db', 'logs', 'tmp']) fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(work, 'probe-input.txt'), 'CODEX_LOCAL_FILE_MARKER\nsecond controlled line\n');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'User project rule: preserve PROBE_USER_RULE exactly. Work only on the explicitly named local fixture.\n');
  const config = { model_provider: 'local-probe', model, web_search: 'disabled', cli_auth_credentials_store: 'ephemeral',
    sqlite_home: path.join(root, 'db'), log_dir: path.join(root, 'logs'),
    'model_providers.local-probe.name': 'Isolated protocol probe', 'model_providers.local-probe.base_url': `${base}/v1`,
    'model_providers.local-probe.env_key': 'CODEX_PROBE_FAKE_KEY', 'model_providers.local-probe.wire_api': 'responses',
    'model_providers.local-probe.requires_openai_auth': false, 'model_providers.local-probe.supports_websockets': false,
    'model_providers.local-probe.request_max_retries': 0, 'model_providers.local-probe.stream_max_retries': 0,
    'analytics.enabled': false, 'history.persistence': 'none', 'shell_environment_policy.inherit': 'none' };
  if (catalog) config['model_providers.local-probe.model_catalog_url'] = `${base}/v1/models`;
  Object.assign(config, configOverrides);
  const args = ['--no-daemon', 'exec', '--ignore-user-config', ...(ignoreRules ? ['--ignore-rules'] : []), '--ephemeral', '--skip-git-repo-check',
    '--json', '--color', 'never', '--sandbox', 'danger-full-access', '--cd', work];
  for (const [name, value] of Object.entries(config)) args.push('-c', `${name}=${JSON.stringify(value)}`);
  args.push('-c', 'approval_policy="never"', ...extraArgs, prompt || `This is a controlled local protocol probe. Reply exactly ${MARKER}. Do not use tools.`);
  const port = Number(new URL(base).port), sandbox = path.join(root, 'sandbox.sb');
  const installRoot = path.resolve(INSTALL, '../..');
  fs.writeFileSync(sandbox, `(version 1)(allow default)
(deny file-read* (subpath ${JSON.stringify(SOURCE_HOME)}))
(allow file-read-metadata (subpath ${JSON.stringify(SOURCE_HOME)}))
(allow file-read-data (literal ${JSON.stringify(SOURCE_HOME)}) (literal ${JSON.stringify(path.join(SOURCE_HOME, '.codex'))}))
(allow file-read* (literal ${JSON.stringify(INSTALLATION_FILE)}) (literal ${JSON.stringify(path.join(SOURCE_HOME, '.CFUserTextEncoding'))}) (subpath ${JSON.stringify(root)}))
(allow file-read* (subpath ${JSON.stringify(installRoot)}))
(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
(allow file-write-data (literal ${JSON.stringify(INSTALLATION_FILE)}))
(deny network*)(allow network-outbound (remote ip "localhost:${port}"))
(allow network* (local unix-socket (subpath ${JSON.stringify(root)})) (remote unix-socket (subpath ${JSON.stringify(root)})))\n`);
  // Preserve any existing HOME/CODEX_HOME unchanged; never redirect either.
  const inheritedHome = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['HOME', 'CODEX_HOME'].includes(key)));
  const env = { ...inheritedHome, PATH: process.env.PATH, TMPDIR: path.join(root, 'tmp'), TERM: 'dumb', NO_COLOR: '1', CODEX_PROBE_FAKE_KEY: apiKey };
  return { command: BINARY, args, env, work, sandbox };
}

function isolatedGatewayCatalog(root, model = MODEL) {
  const configDir = path.join(root, 'catalog-gateway-data'), policy = path.join(root, 'catalog-sandbox.sb');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(policy, `(version 1)(allow default)(deny network*)
(deny file-read* (subpath ${JSON.stringify(SOURCE_HOME)}))
(allow file-read-metadata (subpath ${JSON.stringify(SOURCE_HOME)}))
(allow file-read* (subpath ${JSON.stringify(ROOT)}) (subpath ${JSON.stringify(path.resolve(INSTALL, '../..'))}) (literal ${JSON.stringify(process.execPath)}))
(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))\n`);
  const code = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'antigravity-gateway.js'))}).codexCatalogBody([${JSON.stringify(model)}])))`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ['HOME', 'CODEX_HOME'].includes(key))),
    PATH: process.env.PATH, TMPDIR: path.join(root, 'tmp'), ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir };
  return JSON.parse(execFileSync('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, '-e', code], { cwd: root, env, encoding: 'utf8', timeout: 10000 }));
}

function reply(res, body, index, { item: selectedItem, text = MARKER, inputTokens = 128 } = {}) {
  const item = selectedItem || { id: `msg_probe_${index}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: `resp_probe_${index}`, object: 'response', created_at: 1794000000, status: 'completed', model: body.model,
    output: [item], error: null, incomplete_details: null,
    usage: { input_tokens: inputTokens, output_tokens: 12, total_tokens: inputTokens + 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!body.stream) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(response)); }
  res.setHeader('content-type', 'text/event-stream'); let sequence = 0;
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  event('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } });
  const field = item.type === 'function_call' ? 'arguments' : item.type === 'custom_tool_call' ? 'input' : null;
  event('response.output_item.added', { output_index: 0, item: field ? { ...item, status: 'in_progress', [field]: '' } : { ...item, status: 'in_progress', content: [] } });
  if (field) {
    const kind = field === 'arguments' ? 'function_call_arguments' : 'custom_tool_call_input';
    event(`response.${kind}.delta`, { output_index: 0, item_id: item.id, delta: item[field] });
    event(`response.${kind}.done`, { output_index: 0, item_id: item.id, [field]: item[field] });
  } else {
    event('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const delta of [text.slice(0, 6), text.slice(6)]) event('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta });
    event('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
    event('response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
  }
  event('response.output_item.done', { output_index: 0, item }); event('response.completed', { response }); res.end();
}

function scenarioCall(scenario, body, work) {
  const name = scenario === 'patch' ? 'apply_patch' : scenario === 'image' ? 'view_image' : 'exec_command';
  if (!body.tools.some(tool => tool.name === name)) throw new Error(`CLI did not declare required tool ${name}`);
  if (name === 'apply_patch') return { id: 'fc_probe_patch', type: 'custom_tool_call', call_id: 'call_probe_patch', name, status: 'completed',
    input: '*** Begin Patch\n*** Add File: codex-written.txt\n+CODEX_PATCH_DISK_MARKER\n*** End Patch\n' };
  const args = name === 'view_image' ? { path: path.join(work, 'probe-image.png') } : {
    cmd: `/bin/cat ${scenario === 'error' ? 'missing-fixture.txt' : 'probe-input.txt'}`, workdir: work,
    login: false, max_output_tokens: 256, yield_time_ms: 1000 };
  return { id: `fc_probe_${scenario}`, type: 'function_call', call_id: `call_probe_${scenario}`, name, status: 'completed', arguments: JSON.stringify(args) };
}

async function run({ output, catalog = false, catalogBody = null, timeoutMs = 45000, scenario = 'text', ignoreRules = true } = {}) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('macOS Seatbelt is required');
  if (fs.existsSync(output)) throw new Error('Refusing to overwrite an existing evidence file');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-'))), captures = [], errors = [];
  const version = execFileSync(BINARY, ['--version'], { encoding: 'utf8' }).trim();
  const installationBytes = fs.readFileSync(INSTALLATION_FILE), privateValues = [installationBytes.toString('utf8').trim()];
  const installationBefore = { sha256: sha(installationBytes), mtimeMs: fs.statSync(INSTALLATION_FILE).mtimeMs };
  let child, result, stdout = '', stderr = '', settings, responses = 0, disk = {}, issuedCall;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes);
      else if (req.headers['content-encoding'] === 'deflate') bytes = zlib.inflateSync(bytes);
      else if (req.headers['content-encoding']) throw new Error(`Unimplemented capture encoding ${req.headers['content-encoding']}`);
      const body = bytes.length ? JSON.parse(bytes) : null;
      captures.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (req.url.startsWith('/v1/responses') && req.method === 'POST') {
        if (++responses > 5) throw new Error('Bounded probe maximum of five synthetic Responses requests exceeded');
        if (responses === 1 && ['read', 'error', 'patch', 'image', 'compact'].includes(scenario)) {
          issuedCall = scenarioCall(scenario, body, settings.work);
          return reply(res, body, responses, { item: issuedCall, ...(scenario === 'compact' ? { inputTokens: 2000 } : {}) });
        }
        return reply(res, body, responses);
      }
      if (req.url.startsWith('/v1/models')) {
        if (!catalogBody) throw new Error('Catalog capture requires an explicitly isolated gateway catalog fixture');
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(catalogBody));
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'Only controlled local endpoints exist' } }));
    } catch (error) { errors.push(error.message); res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  server.on('upgrade', (req, socket) => { captures.push({ method: 'UPGRADE', path: req.url, headers: req.headers }); socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  try {
    if (catalog && !catalogBody) catalogBody = isolatedGatewayCatalog(root);
    settings = configure(root, `http://127.0.0.1:${port}`, { catalog, ignoreRules,
      ...(scenario === 'compact' ? { configOverrides: { model_auto_compact_token_limit: 512 } } : {}),
      prompt: scenario === 'text' ? undefined : `Controlled ${scenario} test. Use the requested local tool only, then reply ${MARKER}. Do not access any other file or network.` });
    if (['image', 'image-input'].includes(scenario)) {
      fs.copyFileSync(path.join(ROOT, 'tests/fixtures/gateway-media-inputs/image-fixture.png'), path.join(settings.work, 'probe-image.png'));
      if (scenario === 'image-input') settings.args.splice(settings.args.length - 1, 0, '--image', path.join(settings.work, 'probe-image.png'), '--');
    }
    child = spawn('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...settings.args], { cwd: settings.work, env: settings.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    result = await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true }); }, timeoutMs);
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      child.on('error', error => { clearTimeout(timer); resolve({ error: error.message }); });
    });
  } finally {
    if (settings) disk = { input: fs.readFileSync(path.join(settings.work, 'probe-input.txt'), 'utf8'),
      written: fs.existsSync(path.join(settings.work, 'codex-written.txt')) ? fs.readFileSync(path.join(settings.work, 'codex-written.txt'), 'utf8') : null };
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
  const installationAfter = { sha256: sha(fs.readFileSync(INSTALLATION_FILE)), mtimeMs: fs.statSync(INSTALLATION_FILE).mtimeMs };
  const installationIdContentUnchanged = installationBefore.sha256 === installationAfter.sha256;
  const inputs = captures.filter(c => c.path.startsWith('/v1/responses')).flatMap(c => c.body?.input || []);
  const toolResults = inputs.filter(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
  const scenarioChecks = { finalTextDelivered: stdout.includes(MARKER) };
  if (issuedCall) scenarioChecks.toolResultReturned = toolResults.some(item => item.call_id === issuedCall.call_id);
  if (['read', 'compact'].includes(scenario)) scenarioChecks.fixtureRead = toolResults.some(item => JSON.stringify(item).includes('CODEX_LOCAL_FILE_MARKER'));
  if (scenario === 'error') scenarioChecks.realMissingFileError = toolResults.some(item => /No such file|does not exist/.test(JSON.stringify(item)));
  if (scenario === 'patch') scenarioChecks.diskContentsMatch = disk.written === 'CODEX_PATCH_DISK_MARKER\n';
  if (scenario === 'image') scenarioChecks.toolImageReturned = toolResults.some(item => Array.isArray(item.output) && item.output.some(part => part.type === 'input_image'));
  if (scenario === 'image-input') scenarioChecks.imageInputCaptured = inputs.some(item => item.content?.some(part => part.type === 'input_image'));
  if (scenario === 'compact') {
    scenarioChecks.compressionCaptured = captures.some(c => c.body?.tools?.length === 0 && JSON.stringify(c.body.input).includes('CONTEXT CHECKPOINT COMPACTION'));
    scenarioChecks.summaryContinuationCaptured = inputs.some(item => item.content?.some(part => part.text?.startsWith('Another language model started to solve this problem')));
  }
  const evidence = sanitize({ version, binarySha256: sha(fs.readFileSync(BINARY)), recordedAt: new Date().toISOString(),
    evidence: 'actual-codex-cli-loopback-capture', realModelValidated: false, scenario, scenarioChecks, ignoreRules, catalogRequested: catalog, catalogBody, issuedCall, disk,
    isolation: 'ephemeral; ignore-user-config/rules; HOME and CODEX_HOME unchanged; Seatbelt auth/config deny, only installation_id metadata RW exception, one loopback endpoint, other writes temporary only',
    installationBefore, installationAfter, installationIdContentUnchanged,
    command: settings && [settings.command, ...settings.args], captures, result, stdout, stderr, errors,
    temporaryDirectoryRemoved: !fs.existsSync(root), passed: result?.code === 0 && Object.values(scenarioChecks).every(Boolean) && captures.some(c => c.path.startsWith('/v1/responses')) && !errors.length && installationIdContentUnchanged }, root, port, '', privateValues);
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ output, passed: evidence.passed, requests: captures.length, result, errors })); return evidence;
}

async function main() {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const output = path.resolve(option('--out', 'tests/fixtures/codex-0.164.0-20261107/text.json'));
  const evidence = await run({ output, catalog: args.includes('--catalog'), scenario: option('--scenario', 'text'), ignoreRules: !args.includes('--read-project-rules') }); if (!evidence.passed) process.exitCode = 1;
}
module.exports = { configure, sanitize, reply, run, scenarioCall, isolatedGatewayCatalog, BINARY, INSTALLATION_FILE, FAKE_KEY, MARKER, MODEL };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
