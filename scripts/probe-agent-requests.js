#!/usr/bin/env node
'use strict';

// Capture installed clients against a synthetic loopback provider. No real model,
// credential store, or user workspace is used. macOS Seatbelt is mandatory here.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const AGENTS = option('--agents', 'claude,pi,hermes,dsh').split(',');
const SCENARIO = option('--scenario', 'first');
const OUTPUT = path.resolve(option('--out', 'tests/fixtures/agent-requests-20261107'));
const TIMEOUT = Number(option('--timeout', '90')) * 1000;
const SOURCE_HOME = os.homedir();
const NODE_BIN = path.dirname(process.execPath);
const MODULES = path.resolve(NODE_BIN, '../lib/node_modules');
const HERMES_REPO = option('--hermes-repo', path.join(SOURCE_HOME, '.hermes/hermes-agent'));
const FAKE_KEY = 'sk-local-capture-fixture-not-a-real-key';
const MODEL = 'gemini-3.8-flash-high';
const PROMPT = ({
  read: 'Read the local probe-input.txt test fixture with the file-reading tool, then reply LOCAL_CAPTURE_OK. Do not run commands or change files.',
  'read-error': 'Try to read the nonexistent local probe-missing.txt fixture. Report the read failure without creating or changing any file.',
  'parallel-read': 'Read probe-input.txt and probe-second.txt using two file-reading calls in one response. Do not run commands or change files.',
  image: 'Inspect the generated local probe-image.png fixture using the file-reading tool if needed, then reply LOCAL_CAPTURE_OK. Do not run commands or change files.',
  'image-input': 'Inspect this generated test image and reply LOCAL_CAPTURE_OK. Do not use tools.',
})[SCENARIO] || 'This is a synthetic local protocol probe. Reply exactly LOCAL_CAPTURE_OK. Do not use tools.';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

function safeText(value, root, port) {
  return String(value).split(FAKE_KEY).join('<FAKE_API_KEY>')
    .split(root).join('/tmp/agent-probe')
    .split(SOURCE_HOME).join('/home/probe')
    .replaceAll(`127.0.0.1:${port}`, '127.0.0.1:PROBE_PORT');
}

function clean(value, root, port, key = '') {
  if (/^(authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|set-cookie)$/i.test(key)) return '<FAKE_API_KEY>';
  if (typeof value === 'string') return safeText(value, root, port);
  if (Array.isArray(value)) return value.map(item => clean(item, root, port));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, root, port, name)]));
  return value;
}

function responsesReply(body, call) {
  const calls = Array.isArray(call) ? call : call ? [call] : [];
  const output = calls.length ? calls.map((item, index) => ({ type: 'function_call', id: `fc_probe_${index + 1}`, call_id: `call_probe_${index + 1}`, name: item.name,
    arguments: JSON.stringify(item.arguments), status: 'completed' })) : [{ type: 'message', id: 'msg_probe_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'LOCAL_CAPTURE_OK', annotations: [] }] }];
  return { id: 'resp_probe_1', object: 'response', created_at: 1794000000, status: 'completed', model: body.model,
    output, error: null, incomplete_details: null,
    usage: { input_tokens: 128, output_tokens: 12, total_tokens: 140, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}

function sendResponses(res, body, call) {
  const reply = responsesReply(body, call);
  if (!body.stream) return res.end(JSON.stringify(reply));
  let sequence = 0;
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  event('response.created', { response: { ...reply, status: 'in_progress', output: [], usage: null } });
  event('response.in_progress', { response: { ...reply, status: 'in_progress', output: [], usage: null } });
  for (const [index, item] of reply.output.entries()) {
    event('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(call ? { arguments: '' } : { content: [] }) } });
    if (call) {
      for (const delta of item.arguments.match(/.{1,19}/gs) || []) event('response.function_call_arguments.delta', { output_index: index, item_id: item.id, delta });
      event('response.function_call_arguments.done', { output_index: index, item_id: item.id, arguments: item.arguments });
    } else {
      event('response.content_part.added', { output_index: index, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (const delta of ['LOCAL_', 'CAPTURE_', 'OK']) event('response.output_text.delta', { output_index: index, item_id: item.id, content_index: 0, delta });
      event('response.output_text.done', { output_index: index, item_id: item.id, content_index: 0, text: 'LOCAL_CAPTURE_OK' });
      event('response.content_part.done', { output_index: index, item_id: item.id, content_index: 0, part: item.content[0] });
    }
    event('response.output_item.done', { output_index: index, item });
  }
  event('response.completed', { response: reply });
  res.end();
}

function sendMessages(res, body, call) {
  const calls = Array.isArray(call) ? call : call ? [call] : [];
  const content = calls.length ? calls.map((item, index) => ({ type: 'tool_use', id: `toolu_probe_${index + 1}`, name: item.name, input: item.arguments }))
    : [{ type: 'text', text: 'LOCAL_CAPTURE_OK' }];
  const reply = { id: 'msg_probe_1', type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 128, output_tokens: 12 } };
  if (!body.stream) return res.end(JSON.stringify(reply));
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...reply, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 1 } } });
  for (const [index, block] of content.entries()) {
    event('content_block_start', { index, content_block: call ? { ...block, input: {} } : { type: 'text', text: '' } });
    for (const chunk of (call ? JSON.stringify(block.input).match(/.{1,19}/gs) : ['LOCAL_', 'CAPTURE_', 'OK']) || []) {
      event('content_block_delta', { index, delta: call ? { type: 'input_json_delta', partial_json: chunk } : { type: 'text_delta', text: chunk } });
    }
    event('content_block_stop', { index });
  }
  event('message_delta', { delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: 12 } });
  event('message_stop', {});
  res.end();
}

function readCall(agent, body, work, filename = 'probe-input.txt') {
  const tools = body.tools || [];
  const file = path.join(work, filename);
  // Only these verified local reading operations can ever be returned. No model
  // or external input controls tool selection or arguments in this harness.
  const candidates = { claude: ['Read', { file_path: file }], pi: ['read', { path: file }],
    hermes: filename.endsWith('.png') ? ['vision_analyze', { image_url: file, question: 'Inspect the four generated test pixels.' }] : ['read_file', { path: file }],
    dsh: [filename.endsWith('.png') ? 'read_image' : 'read', { file_path: file }] };
  const [name, args] = candidates[agent];
  return tools.some(tool => (tool.name || tool.function?.name) === name) ? { name, arguments: args } : null;
}

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

function discoveryCall(agent, body) {
  if (agent !== 'claude' || !body.tools?.some(tool => tool.name === 'ToolSearch')) return null;
  const text = body.messages.flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const section = text.match(/Use ToolSearch with query[^\n]*\n([\s\S]*?)<\/system-reminder>/);
  const names = (section?.[1] || '').split('\n').map(line => line.trim()).filter(line => /^[A-Za-z][A-Za-z0-9_]*$/.test(line));
  return names.length ? { name: 'ToolSearch', arguments: { query: `select:${names.join(',')}`, max_results: names.length } } : null;
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

function configure(agent, root, base) {
  const home = path.join(root, 'home'), work = path.join(root, 'work');
  for (const dir of [home, work, path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  write(path.join(work, 'probe-input.txt'), 'PROBE_FIXTURE_LINE_1\nPROBE_FIXTURE_LINE_2\n');
  write(path.join(work, 'probe-second.txt'), 'PROBE_SECOND_FILE_LINE_1\nPROBE_SECOND_FILE_LINE_2\n');
  const imagePath = path.join(work, 'probe-image.png');
  fs.writeFileSync(imagePath, pngFixture());
  const env = { PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: path.join(root, 'tmp'),
    USER: 'probe', LOGNAME: 'probe', SHELL: '/bin/sh', TERM: 'dumb', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: base, OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: `${base}/v1`,
    PROBE_API_KEY: FAKE_KEY, CI: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
    HERMES_HOME: path.join(home, '.hermes'), HERMES_DISABLE_LAZY_INSTALLS: '1', DSH_HOME: path.join(home, '.dsh') };
  let command, args, stdin;
  if (agent === 'claude') {
    command = path.join(NODE_BIN, 'claude');
    args = ['-p', PROMPT, '--model', 'claude-sonnet-4-6', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,ToolSearch',
      '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--setting-sources', ''];
    if (SCENARIO === 'thinking') args.push('--effort', 'high');
    if (SCENARIO === 'image-input') {
      args = args.filter(arg => arg !== PROMPT);
      args.push('--input-format', 'stream-json');
      stdin = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngFixture().toString('base64') } }] } }) + '\n';
    }
    write(path.join(home, '.claude.json'), { hasCompletedOnboarding: true, autoUpdates: false });
  } else if (agent === 'pi') {
    command = path.join(NODE_BIN, 'pi');
    write(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), { providers: { 'local-probe': { baseUrl: `${base}/v1`, api: 'openai-responses', apiKey: FAKE_KEY,
      models: [{ id: MODEL, name: 'Local protocol probe', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }] } } });
    args = ['-p', PROMPT, '--provider', 'local-probe', '--model', MODEL, '--mode', 'json', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--offline'];
    if (SCENARIO === 'thinking') args.push('--thinking', 'high');
    if (SCENARIO === 'image-input') args.push(`@${imagePath}`);
  } else if (agent === 'hermes') {
    env.__HERMES_ACTIVATED = mirrorHermesDependencies(home);
    command = path.join(SOURCE_HOME, '.local/bin/hermes');
    write(path.join(env.HERMES_HOME, 'config.yaml'), `model:\n  provider: local-probe\n  default: ${MODEL}\n${SCENARIO === 'image' ? '  supports_vision: true\n' : ''}providers:\n  local-probe:\n    base_url: ${base}/v1\n    api_key: ${FAKE_KEY}\n    transport: codex_responses\n    default_model: ${MODEL}\nagent:\n  max_turns: 3\n  run_budget_seconds: 60\n${SCENARIO === 'image' ? '  image_input_mode: native\n' : ''}`);
    if (SCENARIO !== 'identity') write(path.join(env.HERMES_HOME, 'SOUL.md'), 'PROBE_USER_SOUL: You are a fixture assistant. Preserve this user-authored identity.\n');
    command = path.join(SOURCE_HOME, '.local/bin/hermes');
    args = ['chat', '-q', PROMPT, '--oneshot', '--provider', 'local-probe', '--model', MODEL, '--format', 'stream-json', '--max-turns', '3'];
    if (SCENARIO === 'thinking') args.push('--reasoning', 'high');
    if (SCENARIO === 'image-input') args.push('--image', imagePath);
  } else if (agent === 'dsh') {
    if (SCENARIO === 'image-input') throw new Error('dsh headless CLI has no image attachment flag; use image scenario with its real read_image tool');
    command = path.join(NODE_BIN, 'dsh');
    const patch = path.join(root, 'dsh-probe.yml');
    write(patch, `- id: agent-default-model\n  config:\n    provider: local-probe\n    model: ${MODEL}\n    reasoningEffort: high\n- id: llm-pi-ai\n  config:\n    providers:\n      local-probe:\n        displayName: Local protocol probe\n        apiKeyEnv: PROBE_API_KEY\n        api: openai-responses\n        baseURL: ${base}/v1\n        models:\n          - id: ${MODEL}\n            name: Local protocol probe\n            contextWindow: 200000\n            maxTokens: 8192\n${SCENARIO === 'image' ? '            input: [text, image]\n' : ''}            reasoningEfforts:\n              high: high\n`);
    args = ['--profile', 'headless', '--patch', patch, '--json', PROMPT];
  } else throw new Error(`Unknown agent: ${agent}`);
  const sandbox = path.join(root, 'sandbox.sb');
  write(sandbox, `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-bind (local ip "localhost:*"))(allow network* (local unix-socket (subpath ${JSON.stringify(root)})) (remote unix-socket (subpath ${JSON.stringify(root)})))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`);
  return { command, args, env, work, sandbox, stdin };
}

function version(agent) {
  if (agent === 'hermes') {
    const stamp = JSON.parse(fs.readFileSync(path.join(HERMES_REPO, 'install-stamp.json'), 'utf8'));
    return { version: stamp.displayVersion, commit: stamp.commit };
  }
  const pkg = { claude: '@anthropic-ai/claude-code', pi: '@earendil-works/pi-coding-agent', dsh: '@deepseek-ai/dsh' }[agent];
  return { version: JSON.parse(fs.readFileSync(path.join(MODULES, pkg, 'package.json'), 'utf8')).version };
}

async function run(agent) {
  // Unix control sockets have a short path limit on macOS. A short, private
  // /tmp root prevents Hermes from relocating its socket outside this root.
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', `agw-${agent}-probe-`)));
  const captures = [];
  let generationCount = 0, didCall = false, settings, stage = 'initial';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body; try { body = JSON.parse(raw); } catch { body = raw; }
    captures.push({ stage, method: req.method, path: req.url, headers: req.headers, body });
    res.setHeader('content-type', body?.stream ? 'text/event-stream' : 'application/json');
    if (req.url.includes('/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'local-probe' }] }));
    if (req.url.includes('/count_tokens')) return res.end(JSON.stringify({ input_tokens: 128 }));
    if (req.url.includes('/messages') || req.url.includes('/responses')) {
      generationCount++;
      let call = null;
      if (!didCall && ['read', 'read-error', 'parallel-read', 'image', 'tool-search'].includes(SCENARIO)) {
        if (SCENARIO === 'tool-search') call = discoveryCall(agent, body);
        else if (SCENARIO === 'parallel-read') {
          const first = readCall(agent, body, settings.work), second = readCall(agent, body, settings.work, 'probe-second.txt');
          if (first && second) call = [first, second];
        } else call = readCall(agent, body, settings.work,
          SCENARIO === 'image' ? 'probe-image.png' : SCENARIO === 'read-error' ? 'probe-missing.txt' : 'probe-input.txt');
        didCall = Boolean(call);
      }
      if (generationCount > 12) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'Probe request limit', type: 'probe_limit' } })); }
      return req.url.includes('/messages') ? sendMessages(res, body, call) : sendResponses(res, body, call);
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'Only synthetic inference endpoints exist in this capture server' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let stdout = '', stderr = '', timedOut = false, result;
  const runs = [];
  async function invoke(args) {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...args],
      { cwd: settings.work, env: settings.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin.end(settings.stdin || '');
    let output = '';
    child.stdout.on('data', chunk => { stdout += chunk; output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let hardStop;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      hardStop = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
    }, TIMEOUT);
    const outcome = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
    clearTimeout(timer); clearTimeout(hardStop);
    runs.push({ stage, args, ...outcome });
    return { ...outcome, output };
  }
  try {
    settings = configure(agent, root, `http://127.0.0.1:${port}`);
    const initial = await invoke(settings.args);
    result = { code: initial.code, signal: initial.signal };
    if (SCENARIO === 'resume' && initial.code === 0) {
      const rows = initial.output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const row = rows.find(row => row.session_id || row.sessionId || (row.type === 'session' && row.id));
      const session = row && (row.session_id || row.sessionId || row.id);
      if (!session) throw new Error('The initial client run did not emit a resumable session ID');
      stage = 'resumed-process';
      const args = settings.args.map(arg => arg === PROMPT ? 'Continue the synthetic local probe. Reply LOCAL_CAPTURE_OK again without using tools.' : arg);
      args.push(agent === 'pi' ? '--session' : agent === 'dsh' ? '--session-id' : '--resume', session);
      const resumed = await invoke(args);
      result = { code: resumed.code, signal: resumed.signal };
    }
  } catch (error) { result = { error: error.message }; }
  finally {
    // Hermes starts an isolated idle-exit daemon. Its own pid file binds the
    // daemon to this newly created HOME; never look up a user's normal service.
    if (agent === 'hermes' && settings) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(settings.env.HERMES_HOME, 'gateway.pid'), 'utf8'));
        if (record.hermes_home === settings.env.HERMES_HOME && record.kind === 'hermes-gateway' && Number.isInteger(record.pid) && record.pid > 1) {
          const command = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          if (command.includes('hermes') && command.includes('gateway')) process.kill(record.pid, 'SIGTERM');
        }
      } catch {}
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  const fixture = clean({ agent, ...version(agent), scenario: SCENARIO, recordedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
    evidence: 'actual-client-loopback-capture', upstream: 'synthetic-local-provider-only', realModelValidated: false,
    isolation: 'fresh HOME/config/workdir; macOS Seatbelt denies non-loopback network and writes outside temporary root',
    command: settings && [settings.command, ...settings.args], runs, syntheticResponse: { textDeltaChunks: 3, toolArgumentChunkSize: 19 },
    outcome: { ...result, timedOut, generationCount, returnedReadTool: ['read', 'read-error', 'parallel-read', 'image'].includes(SCENARIO) && didCall,
      returnedDiscoveryTool: SCENARIO === 'tool-search' && didCall },
    captures, stdout, stderr }, root, port);
  write(path.join(OUTPUT, `${agent}-${SCENARIO}.json`), fixture);
  console.log(JSON.stringify({ agent, scenario: SCENARIO, root, captures: captures.length, ...fixture.outcome }));
  return result.code === 0 && generationCount > 0 && !timedOut && (!['read', 'read-error', 'parallel-read', 'tool-search'].includes(SCENARIO) || didCall);
}

async function main() {
  if (argv.includes('--help')) {
    console.log('用法：node scripts/probe-agent-requests.js [--agents claude,pi,hermes,dsh] [--scenario first|read|read-error|parallel-read|image|image-input|thinking|resume|identity|tool-search] [--out 目录] [--timeout 秒]\n仅限 macOS：临时 HOME + Seatbelt，本机假模型捕获，不访问供应商。tool-search 仅供 Claude 使用；dsh 通过 image 的 read_image 工具接收图片。');
    return;
  }
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('This probe requires macOS Seatbelt isolation; refusing an unrestricted run.');
  if (!['first', 'read', 'read-error', 'parallel-read', 'image', 'image-input', 'thinking', 'resume', 'identity', 'tool-search'].includes(SCENARIO)) throw new Error('Unknown scenario; see --help');
  if (AGENTS.some(agent => !['claude', 'pi', 'hermes', 'dsh'].includes(agent))) throw new Error('Unknown agent name');
  if (!Number.isFinite(TIMEOUT) || TIMEOUT < 1000) throw new Error('Invalid timeout');
  for (const agent of AGENTS) if (!await run(agent)) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
