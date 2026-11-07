#!/usr/bin/env node
'use strict';

// Actual installed clients -> actual gateway -> synthetic Google Antigravity API.
// Only nativeCloudCodeFetch is substituted. Direct request/response conversion,
// managed accounts, session state, tool mapping and HTTP handlers remain real.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '..');
const SOURCE_HOME = os.homedir();
const NODE_BIN = path.dirname(process.execPath);
const MODULES = path.resolve(NODE_BIN, '../lib/node_modules');
const FAKE_KEY = 'sk-gateway-local-fixture-not-a-real-key';
const FAKE_ACCESS = 'gateway-local-fixture-access-token';
const MODEL = 'gemini-3.8-flash-high';
const MARKER = 'PROBE_FIXTURE_LINE_1';
const COMPLETION = 'LOCAL_GATEWAY_VERIFIED';
let SCENARIO = 'text', HERMES_REPO = path.join(SOURCE_HOME, '.hermes/hermes-agent'), PROMPT = '';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function sanitize(value, root, ports = [], key = '') {
  if (/^(authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|set-cookie)$/i.test(key)) return '<SYNTHETIC_CREDENTIAL>';
  if (typeof value === 'string') {
    let text = value.split(FAKE_KEY).join('<SYNTHETIC_CREDENTIAL>').split(FAKE_ACCESS).join('<SYNTHETIC_CREDENTIAL>')
      .split(root).join('/tmp/client-gateway-verify').split(SOURCE_HOME).join('/home/probe');
    for (const [port, name] of ports) text = text.replaceAll(`127.0.0.1:${port}`, `127.0.0.1:${name}`);
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, root, ports));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, root, ports, name)]));
  return value;
}
function version(agent) {
  if (agent === 'hermes') {
    const stamp = JSON.parse(fs.readFileSync(path.join(HERMES_REPO, 'install-stamp.json'), 'utf8'));
    return { version: stamp.displayVersion, commit: stamp.commit };
  }
  const name = { claude: '@anthropic-ai/claude-code', pi: '@earendil-works/pi-coding-agent', dsh: '@deepseek-ai/dsh' }[agent];
  return { version: JSON.parse(fs.readFileSync(path.join(MODULES, name, 'package.json'), 'utf8')).version };
}

// Client configuration and dependency isolation below mirror the independently
// captured scripts/probe-agent-requests.js baseline. No normal client config is read.
function pngFixture() {
  const crc = data => {
    let value = 0xffffffff;
    for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}


function mirrorHermesDependencies(home) {
  const key = crypto.createHash('sha256').update(fs.realpathSync(HERMES_REPO)).digest('hex').slice(0, 16);
  const sourceState = path.join(path.dirname(HERMES_REPO), 'installs', key);
  const facts = JSON.parse(fs.readFileSync(path.join(sourceState, 'facts.json'), 'utf8'));
  const original = facts.packages.venv.environment;
  const targetState = path.join(home, '.hermes/installs', key);
  const target = path.join(targetState, 'environments/probe');
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(original, { withFileTypes: true })) {
    const source = path.join(original, entry.name), dest = path.join(target, entry.name);
    if (entry.name === '.leases') continue;
    if (entry.name === 'pyvenv.cfg') fs.copyFileSync(source, dest);
    else if (entry.name === 'bin') {
      fs.mkdirSync(dest);
      for (const name of fs.readdirSync(source)) fs.symlinkSync(fs.realpathSync(path.join(source, name)), path.join(dest, name));
    } else fs.symlinkSync(source, dest);
  }
  facts.packages.venv.environment = target;
  write(path.join(targetState, 'facts.json'), facts);
  const inputs = path.join(sourceState, 'inputs');
  if (fs.existsSync(inputs)) fs.cpSync(inputs, path.join(targetState, 'inputs'), { recursive: true });
  return path.join(targetState, 'facts.json');
}

function configure(agent, root, base, { model = MODEL, prompt = PROMPT, apiKey = FAKE_KEY, scenario = SCENARIO } = {}) {
  const home = path.join(root, 'home'), work = path.join(root, 'work');
  for (const dir of [home, work, path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  write(path.join(work, 'probe-input.txt'), 'PROBE_FIXTURE_LINE_1\nPROBE_FIXTURE_LINE_2\n');
  write(path.join(work, 'probe-second.txt'), 'PROBE_SECOND_FILE_LINE_1\nPROBE_SECOND_FILE_LINE_2\n');
  const imagePath = path.join(work, 'probe-image.png');
  fs.writeFileSync(imagePath, pngFixture());
  const env = { PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: path.join(root, 'tmp'),
    USER: 'probe', LOGNAME: 'probe', SHELL: '/bin/sh', TERM: 'dumb', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: base, OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: `${base}/v1`,
    PROBE_API_KEY: apiKey, CI: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
    HERMES_HOME: path.join(home, '.hermes'), HERMES_DISABLE_LAZY_INSTALLS: '1', DSH_HOME: path.join(home, '.dsh') };
  let command, args, stdin;
  if (agent === 'claude') {
    command = path.join(NODE_BIN, 'claude');
    args = ['-p', prompt, '--model', model, '--permission-mode', 'dontAsk', '--allowedTools', 'Read,ToolSearch',
      '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--setting-sources', ''];
    if (scenario === 'thinking') args.push('--effort', 'high');
    if (scenario === 'image-input') {
      args = args.filter(arg => arg !== prompt);
      args.push('--input-format', 'stream-json');
      stdin = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngFixture().toString('base64') } }] } }) + '\n';
    }
    write(path.join(home, '.claude.json'), { hasCompletedOnboarding: true, autoUpdates: false });
  } else if (agent === 'pi') {
    command = path.join(NODE_BIN, 'pi');
    write(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), { providers: { 'local-probe': { baseUrl: `${base}/v1`, api: 'openai-responses', apiKey: apiKey,
      models: [{ id: model, name: 'Local protocol probe', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }] } } });
    args = ['-p', prompt, '--provider', 'local-probe', '--model', model, '--mode', 'json', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--offline'];
    if (scenario === 'thinking') args.push('--thinking', 'high');
    if (scenario === 'image-input') args.push(`@${imagePath}`);
  } else if (agent === 'hermes') {
    env.__HERMES_ACTIVATED = mirrorHermesDependencies(home);
    command = path.join(SOURCE_HOME, '.local/bin/hermes');
    write(path.join(env.HERMES_HOME, 'config.yaml'), `model:\n  provider: local-probe\n  default: ${model}\n${scenario === 'image' ? '  supports_vision: true\n' : ''}providers:\n  local-probe:\n    base_url: ${base}/v1\n    api_key: ${apiKey}\n    transport: codex_responses\n    default_model: ${model}\nagent:\n  max_turns: 3\n  run_budget_seconds: 60\n${scenario === 'image' ? '  image_input_mode: native\n' : ''}`);
    if (scenario !== 'identity') write(path.join(env.HERMES_HOME, 'SOUL.md'), 'PROBE_USER_SOUL: You are a fixture assistant. Preserve this user-authored identity.\n');
    command = path.join(SOURCE_HOME, '.local/bin/hermes');
    args = ['chat', '-q', prompt, '--oneshot', '--provider', 'local-probe', '--model', model, '--format', 'stream-json', '--max-turns', '3'];
    if (scenario === 'thinking') args.push('--reasoning', 'high');
    if (scenario === 'image-input') args.push('--image', imagePath);
  } else if (agent === 'dsh') {
    if (scenario === 'image-input') throw new Error('dsh headless CLI has no image attachment flag; use image scenario with its real read_image tool');
    command = path.join(NODE_BIN, 'dsh');
    const patch = path.join(root, 'dsh-probe.yml');
    write(patch, `- id: agent-default-model\n  config:\n    provider: local-probe\n    model: ${model}\n    reasoningEffort: high\n- id: llm-pi-ai\n  config:\n    providers:\n      local-probe:\n        displayName: Local protocol probe\n        apiKeyEnv: PROBE_API_KEY\n        api: openai-responses\n        baseURL: ${base}/v1\n        models:\n          - id: ${model}\n            name: Local protocol probe\n            contextWindow: 200000\n            maxTokens: 8192\n${scenario === 'image' ? '            input: [text, image]\n' : ''}            reasoningEfforts:\n              high: high\n`);
    args = ['--profile', 'headless', '--patch', patch, '--json', prompt];
  } else throw new Error(`Unknown agent: ${agent}`);
  const sandbox = path.join(root, 'sandbox.sb');
  write(sandbox, `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(path.join(SOURCE_HOME, '.antigravity-gateway'))}) (subpath ${JSON.stringify(path.join(SOURCE_HOME, '.claude'))}) (subpath ${JSON.stringify(path.join(SOURCE_HOME, '.pi/agent'))}) (subpath ${JSON.stringify(path.join(SOURCE_HOME, '.dsh'))}) (literal ${JSON.stringify(path.join(SOURCE_HOME, '.hermes/config.yaml'))}) (literal ${JSON.stringify(path.join(SOURCE_HOME, '.hermes/.env'))}))(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-bind (local ip "localhost:*"))(allow network* (local unix-socket (subpath ${JSON.stringify(root)})) (remote unix-socket (subpath ${JSON.stringify(root)})))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`);
  return { command, args, env, work, sandbox, stdin };
}


function declarations(body) { return (body.request?.tools || []).flatMap(tool => tool.functionDeclarations || []); }
function functionResults(body) { return (body.request?.contents || []).flatMap(content => content.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse); }
function isReaderName(name, agent) {
  const originals = { claude: 'Read', hermes: 'read_file', pi: 'read', dsh: 'read' };
  return name === originals[agent] || /^(?:view_file|read_file|read_file_content)$/.test(name)
    || /(?:^|__)read(?:_file)?$/.test(name);
}
function readToolCall(body, agent, file) {
  const candidates = declarations(body).filter(tool => isReaderName(tool.name, agent));
  if (candidates.length !== 1) throw new Error(`Expected one verified file reader, found: ${candidates.map(tool => tool.name).join(', ')}`);
  const tool = candidates[0], schema = tool.parameters || {}, properties = schema.properties || {}, args = {};
  const pathName = ['Path', 'AbsolutePath', 'absolute_path', 'file_path', 'path', 'FilePath'].find(name => Object.hasOwn(properties, name));
  if (!pathName) throw new Error(`Reader ${tool.name} has no captured file-path parameter`);
  args[pathName] = file;
  for (const name of schema.required || []) {
    if (Object.hasOwn(args, name)) continue;
    if (name === 'toolAction') args[name] = 'Read isolated local verification file';
    else if (name === 'toolSummary') args[name] = 'Read the synthetic fixture without modifying it';
    else if (['StartLine', 'start_line'].includes(name)) args[name] = 1;
    else if (['EndLine', 'end_line'].includes(name)) args[name] = 2;
    else throw new Error(`Unverified required reader argument: ${name}`);
  }
  return { id: `verify_read_${agent}`, name: tool.name, args };
}
function googleEvent(parts, finish = false) {
  return { response: { candidates: [{ content: { role: 'model', parts }, ...(finish ? { finishReason: 'STOP' } : {}) }],
    ...(finish ? { usageMetadata: { promptTokenCount: 128, candidatesTokenCount: 12, totalTokenCount: 140 } } : {}), modelVersion: MODEL } };
}

function createSyntheticTurnPlanner(agent, scenario, file) {
  let issuedCall = null;
  return body => {
    const text = kind => ({ kind, events: [googleEvent([{ text: 'LOCAL_GATEWAY_' }]), googleEvent([{ text: 'VERIFIED' }], true)] });
    if (scenario !== 'read') return text('text');
    const results = functionResults(body);
    const calls = (body.request?.contents || []).flatMap(content => content.parts || [])
      .filter(part => part.functionCall).map(part => part.functionCall);
    // The gateway also injects generate_image into tool-less title requests.
    // Only an actual reader declaration or structured reader roundtrip belongs
    // to this read scenario; background requests must not advance its state.
    const mainTurn = declarations(body).some(tool => isReaderName(tool.name, agent))
      || [...calls, ...results].some(call => isReaderName(call.name, agent));
    if (!mainTurn) return text('auxiliary');
    if (!issuedCall) {
      issuedCall = readToolCall(body, agent, file);
      return { kind: 'read-call', issuedToolCall: issuedCall,
        events: [googleEvent([{ functionCall: issuedCall, thoughtSignature: 'synthetic-read-signature' }], true)] };
    }
    if (!results.some(result => result.id === issuedCall.id && result.name === issuedCall.name
      && JSON.stringify(result).includes(MARKER))) throw new Error('Client did not return the temporary file contents for the issued read');
    return text('read-result');
  };
}
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function unusedPort() { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
function launch(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const state = { child, stdout: '', stderr: '', closed: false };
  child.stdout.on('data', chunk => { state.stdout += chunk; }); child.stderr.on('data', chunk => { state.stderr += chunk; });
  state.done = new Promise(resolve => {
    child.once('error', error => { state.closed = true; resolve({ code: null, error: error.message }); });
    child.once('close', (code, signal) => { state.closed = true; resolve({ code, signal }); });
  });
  child.stdin.end();
  return state;
}
async function stop(processState) {
  if (!processState || processState.closed) return;
  try { process.kill(-processState.child.pid, 'SIGTERM'); } catch {}
  await Promise.race([processState.done, delay(2000)]);
  if (!processState.closed) { try { process.kill(-processState.child.pid, 'SIGKILL'); } catch {} await processState.done; }
}
function cleanupHermes(settings) {
  if (!settings) return;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(settings.env.HERMES_HOME, 'gateway.pid'), 'utf8'));
    if (record.hermes_home !== settings.env.HERMES_HOME || record.kind !== 'hermes-gateway' || !Number.isInteger(record.pid) || record.pid < 2) return;
    const command = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (command.includes('hermes') && command.includes('gateway')) process.kill(record.pid, 'SIGTERM');
  } catch {}
}
function preloadSource(upstreamPort, traceFile) {
  return `'use strict';
const fs = require('node:fs'), http = require('node:http');
const origin = ${JSON.stringify(`http://127.0.0.1:${upstreamPort}`)}, originalFetch = globalThis.fetch;
const guardedFetch = (url, options) => {
  if (new URL(String(url)).origin !== origin) throw new Error('Verification denies non-fixture upstream: ' + url);
  return originalFetch(url, options);
};
globalThis.fetch = guardedFetch;
require(${JSON.stringify(path.join(ROOT, 'src/agy-native-transport.js'))}).nativeCloudCodeFetch = guardedFetch;
const createServer = http.createServer;
http.createServer = function (handler) {
  return createServer.call(this, (req, res) => {
    const input = [], output = [];
    const emit = req.emit;
    req.emit = function (event, ...args) { if (event === 'data') input.push(Buffer.from(args[0])); return emit.call(this, event, ...args); };
    const write = res.write, end = res.end;
    res.write = function (chunk, ...args) { if (chunk) output.push(Buffer.from(chunk)); return write.call(this, chunk, ...args); };
    res.end = function (chunk, ...args) { if (chunk) output.push(Buffer.from(chunk)); return end.call(this, chunk, ...args); };
    res.on('finish', () => {
      let body = Buffer.concat(input).toString('utf8'); try { body = JSON.parse(body); } catch {}
      fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ method:req.method, path:req.url, headers:req.headers,
        body, status:res.statusCode, responseHeaders:res.getHeaders(), responseBody:Buffer.concat(output).toString('utf8') }) + '\\n');
    });
    return handler(req, res);
  });
};
`;
}
function assessEvidence(agent, scenario, upstream, client, outcome) {
  const generations = upstream.filter(item => item.path.includes(':streamGenerateContent'));
  const requests = client.filter(item => /^\/v1\/(messages|responses)(?:\?|$)/.test(item.path));
  const expectedName = { claude: 'Read', hermes: 'read_file', pi: 'read', dsh: 'read' }[agent];
  const answers = requests.filter(item => item.status === 200).map(item => item.responseBody).join('\n');
  const calledNames = [...answers.matchAll(/"(?:name)"\s*:\s*"([^"\\]+)"/g)].map(match => match[1]);
  const results = generations.flatMap(item => functionResults(item.body));
  const checks = {
    clientExitedSuccessfully: outcome.code === 0 && !outcome.timedOut && !outcome.clientReportedError,
    realGatewayHTTP: requests.length > 0 && requests.every(item => item.status === 200),
    nativeGenerationEnvelope: generations.length > 0 && generations.every(item => item.body.requestType === 'agent'
      && item.body.userAgent === 'antigravity' && typeof item.body.project === 'string' && item.body.request?.contents?.length > 0),
    fixedModelThinking: generations.every(item => item.body.model === MODEL && item.body.request?.generationConfig?.thinkingConfig?.thinkingLevel === 'HIGH'),
    apiUserAgent: generations.every(item => /^antigravity\/cli\/1\.5\.2 /.test(item.headers['user-agent'] || '')),
    finalTextDelivered: answers.includes(COMPLETION) || answers.includes('LOCAL_GATEWAY_') && answers.includes('VERIFIED')
  };
  if (scenario === 'read') {
    const issued = generations.flatMap((item, index) => item.issuedToolCall ? [{ call: item.issuedToolCall, index }] : []);
    checks.originalClientToolName = calledNames.includes(expectedName);
    checks.actualLocalReadReturned = results.some(result => JSON.stringify(result).includes(MARKER));
    checks.toolResultUsesDeclaredNativeName = results.some(result => generations.some(item => declarations(item.body).some(tool => tool.name === result.name)));
    checks.declaredReaderWasIssued = issued.some(({ call, index }) => declarations(generations[index].body)
      .some(tool => tool.name === call.name && isReaderName(tool.name, agent)));
    checks.toolRoundtripGeneratedAgain = issued.some(({ call, index }) => generations.slice(index + 1)
      .some(item => functionResults(item.body).some(result => result.id === call.id && result.name === call.name
        && JSON.stringify(result).includes(MARKER))));
  }
  return { passed: Object.values(checks).every(Boolean), checks, generationCount: generations.length,
    clientRequests: requests.length, issuedNativeNames: [...new Set(generations.flatMap(item => item.issuedToolCall ? [item.issuedToolCall.name] : []))], calledClientNames: [...new Set(calledNames)], nativeResultNames: [...new Set(results.map(result => result.name))] };
}

async function run(agent, scenario, options) {
  SCENARIO = scenario;
  PROMPT = scenario === 'read' ? `Read probe-input.txt using the file-reading tool, then reply exactly ${COMPLETION}. Do not run commands or change files.`
    : `This is an isolated synthetic protocol verification. Reply exactly ${COMPLETION}. Do not use tools.`;
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', `agw-chain-${agent}-`)));
  const upstream = [], upstreamErrors = [], traceFile = path.join(root, 'client-http.jsonl');
  let settings, gateway, client, outcome = {}, assessment;
  const planTurn = createSyntheticTurnPlanner(agent, scenario, path.join(root, 'work', 'probe-input.txt'));
  const google = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const recorded = { method: req.method, path: req.url, headers: req.headers, body };
      upstream.push(recorded);
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith(':fetchAvailableModels')) return res.end(JSON.stringify({ models: { [MODEL]: {
        displayName: 'Synthetic Flash High', maxTokens: 1048576, maxOutputTokens: 65536, supportsImages: true,
        supportsThinking: true, thinkingLevel: 3, supportsVideo: true, supportedMimeTypes: { 'video/mp4': true, 'image/png': true }
      } }, imageGenerationModelIds: ['gemini-3.1-flash-image'] }));
      if (req.url.endsWith(':loadCodeAssist')) return res.end(JSON.stringify({ cloudaicompanionProject: 'synthetic-project', currentTier: { id: 'synthetic' } }));
      if (req.url.endsWith(':retrieveUserQuotaSummary')) return res.end(JSON.stringify({ groups: [] }));
      if (!req.url.startsWith('/v1internal:streamGenerateContent')) { res.statusCode = 404; return res.end('{"error":{"message":"unexpected fixture RPC"}}'); }
      if (upstream.filter(item => item.path.includes(':streamGenerateContent')).length > 8) throw new Error('Synthetic inference limit exceeded');
      res.setHeader('content-type', 'text/event-stream');
      const turn = planTurn(body);
      recorded.syntheticTurn = turn.kind;
      if (turn.issuedToolCall) recorded.issuedToolCall = turn.issuedToolCall;
      for (const event of turn.events) res.write('data: ' + JSON.stringify(event) + '\n\n');
      res.end();
    } catch (error) {
      upstreamErrors.push(error.message); if (!res.headersSent) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); }
      res.end(JSON.stringify({ error: { code: 400, message: error.message } }));
    }
  });
  const upstreamPort = await listen(google), gatewayPort = await unusedPort();
  try {
    settings = configure(agent, root, `http://127.0.0.1:${gatewayPort}`);
    const configDir = path.join(root, 'gateway-data'), preload = path.join(root, 'gateway-preload.js');
    write(path.join(configDir, 'accounts/synthetic.json'), { id: 'synthetic-account', email: 'synthetic@example.invalid',
      subjectId: 'synthetic-identity', accessToken: FAKE_ACCESS, expiresAt: new Date(Date.now() + 86400000).toISOString(),
      projectId: 'synthetic-project', providerType: 'cloudcode', accountType: 'antigravity', enabled: true, weight: 1,
      capabilities: [MODEL], authMethod: 'oauth' });
    write(preload, preloadSource(upstreamPort, traceFile));
    const gatewayEnv = { ...settings.env, ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir,
      ANTIGRAVITY_GATEWAY_PORT: String(gatewayPort), ANTIGRAVITY_GATEWAY_API_KEY: FAKE_KEY,
      ANTIGRAVITY_DIRECT_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ANTIGRAVITY_DIRECT_MAX_RETRIES: '0',
      ANTIGRAVITY_GATEWAY_TIMEOUT_MS: '45000', ANTIGRAVITY_CLI_PATH: path.join(root, 'nonexistent-agy') };
    gateway = launch('/usr/bin/sandbox-exec', ['-f', settings.sandbox, process.execPath, '--require', preload, path.join(ROOT, 'antigravity-gateway.js')], { cwd: settings.work, env: gatewayEnv });
    let ready = false;
    for (let index = 0; index < 200 && !gateway.closed; index++) {
      try {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: { authorization: `Bearer ${FAKE_KEY}` }, signal: AbortSignal.timeout(500) });
        const body = await response.json(); if (body.data?.some(model => model.id === MODEL)) { ready = true; break; }
      } catch {}
      await delay(50);
    }
    if (!ready) throw new Error('Isolated gateway did not become ready: ' + gateway.stderr.slice(-1200));
    client = launch('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...settings.args], { cwd: settings.work, env: settings.env });
    let timeout;
    try { outcome = await Promise.race([client.done, new Promise(resolve => { timeout = setTimeout(() => resolve({ code: null, timedOut: true }), options.timeoutMs); })]); }
    finally { clearTimeout(timeout); }
    if (outcome.timedOut) await stop(client);
    outcome.clientReportedError = /"stopReason":"error"|"is_error":true|"type":"error"|OpenAI Responses stream ended before/.test(client.stdout);
  } catch (error) { outcome.error = error.message; }
  finally {
    await stop(client); if (agent === 'hermes') cleanupHermes(settings); await stop(gateway);
    google.closeAllConnections(); await new Promise(resolve => google.close(resolve));
  }
  const clientHTTP = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  assessment = assessEvidence(agent, scenario, upstream, clientHTTP, outcome);
  if (upstreamErrors.length || outcome.error) assessment.passed = false;
  const record = sanitize({ agent, ...version(agent), scenario, recordedAt: new Date().toISOString(),
    evidence: 'actual-cli-real-gateway-synthetic-google-upstream', realModelValidated: false, tlsValidated: false,
    isolation: 'fresh HOME/config/workdir; synthetic accounts only; Seatbelt denies external network and production account reads; writes limited to temporary root',
    gatewaySource: 'working-tree source', injection: 'nativeCloudCodeFetch = loopback-restricted Node fetch; no AccountPool or Direct handler substitution',
    command: settings && [settings.command, ...settings.args], outcome, assessment, upstreamErrors,
    clientHTTP, upstream, stdout: client?.stdout || '', stderr: client?.stderr || '',
    gatewayStdout: gateway?.stdout || '', gatewayStderr: gateway?.stderr || '' }, root, [[upstreamPort, 'UPSTREAM_PORT'], [gatewayPort, 'GATEWAY_PORT']]);
  write(path.join(options.output, `${agent}-${scenario}.json`), record);
  console.log(JSON.stringify({ agent, scenario, root, ...assessment, outcome, upstreamErrors }));
  return record;
}
async function main() {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('This verifier requires macOS Seatbelt isolation');
  const argv = process.argv.slice(2), option = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  const agents = option('--agents', 'claude,hermes,pi,dsh').split(','), scenarios = option('--scenarios', 'text,read').split(',');
  if (agents.some(agent => !['claude', 'hermes', 'pi', 'dsh'].includes(agent)) || scenarios.some(value => !['text', 'read'].includes(value))) throw new Error('Unsupported agent or scenario');
  HERMES_REPO = option('--hermes-repo', HERMES_REPO);
  const options = { output: path.resolve(option('--out', 'tests/fixtures/client-gateway-20261107')), timeoutMs: Number(option('--timeout', '90')) * 1000 };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000) throw new Error('Timeout must be 1-300 seconds');
  const results = [];
  for (const agent of agents) for (const scenario of scenarios) results.push(await run(agent, scenario, options));
  write(path.join(options.output, 'summary.json'), results.map(({ agent, version, scenario, assessment, outcome }) => ({ agent, version, scenario, assessment, outcome })));
  if (results.some(result => !result.assessment.passed)) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { declarations, functionResults, readToolCall, createSyntheticTurnPlanner, assessEvidence, sanitize,
  version, configure, launch, stop, cleanupHermes, write, unusedPort, preloadSource, googleEvent };
