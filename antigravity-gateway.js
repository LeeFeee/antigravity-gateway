#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { AgyError, AgyWorker, getVersion, listModels, resolveAgyCommand } = require('./src/agy-worker');
const { DirectAntigravityProvider, DirectProviderError } = require('./src/direct-provider');
const { version: GATEWAY_VERSION } = require('./package.json');
const {
  GatewayError,
  anthropicResponse,
  buildPrompt,
  chatResponse,
  finalizeModelResult,
  normalizeAnthropic,
  normalizeChat,
  normalizeResponses,
  responsesResponse
} = require('./src/protocol');

const RUNTIME_USER = typeof process.getuid === 'function'
  ? String(process.getuid())
  : os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_');
const RUNTIME = path.resolve(
  process.env.ANTIGRAVITY_GATEWAY_RUNTIME_DIR
    || path.join(os.tmpdir(), `antigravity-gateway-${RUNTIME_USER}`)
);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['-h', '--help', '-help'].includes(arg)) result.help = true;
    else if (['-v', '--version'].includes(arg)) result.version = true;
    else if (['-p', '--port'].includes(arg)) result.port = argv[++index];
    else if (['-H', '--host'].includes(arg)) result.host = argv[++index];
    else if (arg === '--agy-path') result.agyPath = argv[++index];
    else if (['-m', '--model'].includes(arg)) result.model = argv[++index];
    else if (require.main === module) throw new Error(`未知选项: ${arg}`);
  }
  return result;
}

const CLI_ARGS = parseArgs(process.argv.slice(2));
const HOST = CLI_ARGS.host || process.env.ANTIGRAVITY_GATEWAY_HOST || '127.0.0.1';
const PORT = Number(CLI_ARGS.port || process.env.ANTIGRAVITY_GATEWAY_PORT || 9897);
const AGY_PATH = resolveAgyCommand(CLI_ARGS.agyPath || process.env.ANTIGRAVITY_CLI_PATH);
const AGY_PREFIX_ARGS = (() => {
  try {
    const value = JSON.parse(process.env.ANTIGRAVITY_CLI_PREFIX_ARGS || '[]');
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
  } catch { return []; }
})();
const DEFAULT_MODEL = CLI_ARGS.model || process.env.ANTIGRAVITY_DEFAULT_MODEL || 'gemini-3.7-flash-high';
const FAST_MODEL = String(process.env.ANTIGRAVITY_FAST_MODEL || '').trim();
const API_KEY = process.env.ANTIGRAVITY_GATEWAY_API_KEY || '';
const REQUEST_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_BODY_LIMIT || 8 * 1024 * 1024);
const REQUEST_TIMEOUT = Number(process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS || 300000);
const CONTEXT_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_CONTEXT_LIMIT || 2 * 1024 * 1024);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY || 4));
const MAX_QUEUE = Math.max(0, Number(process.env.ANTIGRAVITY_GATEWAY_MAX_QUEUE || 32));
const MODEL_CACHE_MS = 60000;
const TRANSPORT = String(process.env.ANTIGRAVITY_GATEWAY_TRANSPORT || 'direct').trim().toLowerCase();
const DIRECT_PROVIDER = new DirectAntigravityProvider();
const DIRECT_ALLOW_ANY_MODEL = process.env.ANTIGRAVITY_DIRECT_ALLOW_ANY_MODEL !== '0';

const responseStore = new Map();
const activeWorkers = new Set();
let modelCache = { at: 0, models: [], error: null };
let versionCache = null;

class Semaphore {
  constructor(limit, maxQueue) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.waiters = [];
  }

  acquire(signal) {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new GatewayError('网关并发队列已满。', { code: 'gateway_busy', status: 429 }));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new GatewayError('客户端已取消排队请求。', { code: 'request_aborted', status: 499 }));
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release() {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.active = Math.max(0, this.active - 1);
      return;
    }
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve(() => this.release());
  }
}

const requestSlots = new Semaphore(MAX_CONCURRENCY, MAX_QUEUE);

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
}

function configuredAliases() {
  try {
    const value = JSON.parse(process.env.ANTIGRAVITY_MODEL_ALIASES || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function usesDirectTransport() {
  if (TRANSPORT === 'direct') return true;
  if (TRANSPORT === 'agy') return false;
  return DIRECT_PROVIDER.isConfigured();
}

function directAuthDescription() {
  if (DIRECT_PROVIDER.localAuth?.isConfigured?.()) return 'macOS Keychain / local session（仅内存读取）';
  if (DIRECT_PROVIDER.isConfigured()) return 'explicit OAuth env/auth file (manual fallback)';
  return 'unavailable';
}

async function availableModels(force = false) {
  if (!force && Date.now() - modelCache.at < MODEL_CACHE_MS && modelCache.models.length) return modelCache.models;
  try {
    const models = usesDirectTransport()
      ? await DIRECT_PROVIDER.listModels()
      : await listModels({ agyPath: AGY_PATH, prefixArgs: AGY_PREFIX_ARGS });
    if (!models.length) throw new GatewayError('`agy models` 没有返回可识别的模型 ID。', { code: 'empty_model_catalog', status: 503 });
    modelCache = { at: Date.now(), models, error: null };
  } catch (error) {
    modelCache = { at: Date.now(), models: modelCache.models, error };
    if (!modelCache.models.length) throw error;
  }
  return modelCache.models;
}

function isClientAlias(model) {
  return /^(claude|gpt|codex|o[134](?:-|$))/i.test(model || '');
}

function preferredFastModel(models) {
  if (FAST_MODEL) return FAST_MODEL;
  const priorities = [
    /^gemini-3\.7-flash-low$/i,
    /^gemini-3\.6-flash-low$/i,
    /^gemini-3\.5-flash-(?:extra-)?low$/i,
    /flash-lite/i,
    /-flash-low$/i,
    /-low$/i,
    /-flash$/i
  ];
  for (const pattern of priorities) {
    const match = models.find((model) => pattern.test(model));
    if (match) return match;
  }
  return DEFAULT_MODEL;
}

async function resolveModel(requested, { preferFast = false } = {}) {
  const models = await availableModels();
  const aliases = configuredAliases();
  const original = requested || DEFAULT_MODEL;
  const explicitAlias = aliases[original];
  let chosen = explicitAlias || original;
  if (!explicitAlias && (preferFast || /^claude-haiku(?:-|$)/i.test(original))) {
    chosen = preferredFastModel(models);
  }
  if (isClientAlias(chosen)) chosen = aliases[chosen] || DEFAULT_MODEL;
  if (!models.includes(chosen)) {
    if (usesDirectTransport() && DIRECT_ALLOW_ANY_MODEL && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(chosen)) return chosen;
    if (chosen === DEFAULT_MODEL && models.length) {
      chosen = models.find((model) => model.startsWith('gemini-') && /high$/.test(model))
        || models.find((model) => model.startsWith('gemini-'))
        || models[0];
    } else {
      throw new GatewayError(`Antigravity 当前账号没有模型: ${chosen}`, { code: 'model_not_found', status: 400 });
    }
  }
  return chosen;
}

function codexModelInfo(slug, priority) {
  return {
    slug,
    display_name: slug,
    description: 'Model provided through the local Antigravity Gateway.',
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    input_modalities: ['text'],
    supports_image_detail_original: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    tool_mode: 'direct',
    multi_agent_version: 'v1',
    use_responses_lite: false,
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    auto_review_model_override: null,
    context_window: 200000,
    max_context_window: 200000,
    auto_compact_token_limit: null,
    comp_hash: `antigravity-gateway-${GATEWAY_VERSION}`,
    base_instructions: 'Follow the client instructions and use only client-provided tools when needed.',
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Faster responses' },
      { effort: 'medium', description: 'Balanced reasoning' },
      { effort: 'high', description: 'Deeper reasoning' }
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    minimal_client_version: '0.0.0',
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority,
    model_messages: null,
    experimental_supported_tools: [],
    available_in_plans: [],
    supports_search_tool: false,
    default_service_tier: null,
    service_tiers: [],
    additional_speed_tiers: [],
    supports_reasoning_summaries: false
  };
}

function printHelp() {
  console.log(`Antigravity Gateway ${GATEWAY_VERSION}

用法:
  antigravity-gateway [选项]

选项:
  -h, --help, -help       显示帮助
  -v, --version           显示版本
  -p, --port <number>     监听端口，默认 9897
  -H, --host <address>    监听地址，默认 127.0.0.1
  --agy-path <path>       agy 可执行文件路径
  -m, --model <id>        默认 Antigravity 模型

传输模式:
  ANTIGRAVITY_GATEWAY_TRANSPORT=auto|direct|agy
  默认 direct：从 macOS Keychain 或本地会话文件读取登录态并直连 Cloud Code。
  auto/agy 仅为显式兼容选项；手动凭据兜底可用 ANTIGRAVITY_AUTH_FILE。

接口:
  GET  /
  GET  /v1/models
  POST /v1/messages
  POST /v1/messages/count_tokens
  POST /v1/responses
  POST /v1/chat/completions`);
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    ...headers
  });
  res.end(data);
}

function sendSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', isLoopbackHost(HOST) ? '*' : (process.env.ANTIGRAVITY_GATEWAY_CORS_ORIGIN || 'null'));
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function clientScope(req) {
  const material = [
    req.headers['x-session-id'] || '',
    req.headers.authorization || req.headers['x-api-key'] || '',
    req.socket?.remoteAddress || ''
  ].join('\0');
  return crypto.createHash('sha256').update(material).digest('hex');
}

function authorized(req) {
  if (!API_KEY) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = String(bearer || req.headers['x-api-key'] || '');
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(API_KEY);
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > REQUEST_LIMIT) throw new GatewayError('请求体过大。', { code: 'request_too_large', status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new GatewayError('请求体不是有效 JSON。', { code: 'invalid_json', status: 400 });
  }
}

function errorBody(error, protocol) {
  const message = error.message || 'Gateway error';
  const code = error.code || 'gateway_error';
  if (protocol === 'anthropic') return { type: 'error', error: { type: code, message } };
  return { error: { message, type: code, code } };
}

function mapAgyError(error) {
  if (error instanceof GatewayError || error instanceof AgyError || error instanceof DirectProviderError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /request aborted/i.test(String(error?.message || ''))) {
    return new GatewayError('客户端已取消请求。', { code: 'request_aborted', status: 499 });
  }
  return new GatewayError('Antigravity Gateway 内部错误。', {
    code: 'internal_error',
    status: 500,
    details: String(error?.stack || error?.message || error || 'unknown error')
  });
}

function cleanupResponseStore() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, state] of responseStore) if (state.at < cutoff) responseStore.delete(id);
  while (responseStore.size > 1000) responseStore.delete(responseStore.keys().next().value);
}

async function runTurn(normalized, model, signal, { sessionId, onDelta } = {}) {
  const release = await requestSlots.acquire(signal);
  if (usesDirectTransport()) {
    try {
      let raw = await DIRECT_PROVIDER.send(normalized, model, { signal, sessionId, onDelta });
      try {
        return finalizeModelResult(normalized, raw);
      } catch (error) {
        if (error.code === 'invalid_auto_mode_classifier_output') {
          raw = await DIRECT_PROVIDER.send(normalized, model, { signal, sessionId, repairInstruction: 'Return only the XML verdict required by the client contract. No prose or Markdown.' });
          return finalizeModelResult(normalized, raw);
        }
        if (error.code === 'invalid_structured_output') {
          raw = await DIRECT_PROVIDER.send(normalized, model, { signal, sessionId, repairInstruction: `Return only one valid JSON value conforming to this schema: ${JSON.stringify(normalized.structuredSchema)}` });
          return finalizeModelResult(normalized, raw);
        }
        throw error;
      }
    } finally {
      release();
    }
  }
  const prompt = buildPrompt(normalized);
  if (Buffer.byteLength(prompt) > CONTEXT_LIMIT) {
    release();
    throw new GatewayError('规范化后的上下文超过网关安全上限。', { code: 'context_too_large', status: 413 });
  }
  const workerId = crypto.randomUUID();
  const workDir = path.join(RUNTIME, 'workspaces', workerId);
  // agy requires a log path. Keep it inside the per-request directory so the
  // gateway can remove it with the isolated workspace after the turn.
  const logFile = path.join(workDir, 'agy.log');
  const worker = new AgyWorker({
    agyPath: AGY_PATH,
    prefixArgs: AGY_PREFIX_ARGS,
    model,
    cwd: workDir,
    logFile,
    timeoutMs: REQUEST_TIMEOUT
  });
  activeWorkers.add(worker);
  try {
    let raw = await worker.send(prompt, { signal, onDelta });
    try {
      return finalizeModelResult(normalized, raw);
    } catch (error) {
      if (error.code === 'invalid_auto_mode_classifier_output') {
        raw = await worker.send('AUTO_MODE_XML_REPAIR: Return only the XML verdict required by the original system contract. No prose or Markdown.', { signal, onDelta });
        return finalizeModelResult(normalized, raw);
      }
      if (error.code === 'invalid_structured_output') {
        raw = await worker.send(`STRUCTURED_OUTPUT_REPAIR: Return only one valid JSON value conforming to this schema: ${JSON.stringify(normalized.structuredSchema)}`, { signal, onDelta });
        return finalizeModelResult(normalized, raw);
      }
      throw error;
    }
  } finally {
    await worker.close();
    activeWorkers.delete(worker);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* owned temporary directory */ }
    release();
  }
}

function beginSse(res) {
  if (!res.headersSent) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
  }
  res.write(': antigravity-gateway keep-alive\n\n');
  const timer = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function textStreamingAllowed(normalized) {
  return Boolean(normalized.stream)
    && normalized.tools.length === 0
    && !normalized.structuredSchema
    && !normalized.autoMode;
}

function createAnthropicTextEmitter(res, model) {
  const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  let started = false;
  let blockStarted = false;
  let emittedText = '';
  const start = () => {
    if (started) return;
    started = true;
    sendSse(res, 'message_start', { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    } });
  };
  const emitText = (text) => {
    text = String(text || '');
    if (!text) return;
    start();
    if (!blockStarted) {
      blockStarted = true;
      sendSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    }
    emittedText += text;
    sendSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  };
  return {
    onDelta: (text) => emitText(text),
    finish: (body) => {
      start();
      const finalText = body.content?.find((block) => block.type === 'text')?.text || '';
      if (finalText && !emittedText) emitText(finalText);
      else if (finalText.startsWith(emittedText)) emitText(finalText.slice(emittedText.length));
      if (blockStarted) sendSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sendSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: body.stop_reason, stop_sequence: null }, usage: { output_tokens: body.usage.output_tokens || 0 } });
      sendSse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    }
  };
}

function createChatTextEmitter(res, model) {
  const id = `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  let started = false;
  let emittedText = '';
  const start = () => {
    if (started) return;
    started = true;
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  };
  return {
    onDelta: (text) => {
      text = String(text || '');
      if (!text) return;
      start();
      emittedText += text;
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    },
    finish: (body) => {
      start();
      const finalText = body.choices?.[0]?.message?.content || '';
      if (finalText && !emittedText) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }] })}\n\n`);
      } else if (finalText.startsWith(emittedText) && finalText.length > emittedText.length) {
        const remainder = finalText.slice(emittedText.length);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }] })}\n\n`);
      }
      const finishReason = body.choices?.[0]?.finish_reason || 'stop';
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
}

function emitAnthropicStream(res, body) {
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const start = { ...body, content: [], stop_reason: null, stop_sequence: null };
  sendSse(res, 'message_start', { type: 'message_start', message: start });
  body.content.forEach((block, index) => {
    const empty = block.type === 'text'
      ? { type: 'text', text: '' }
      : block.type === 'thinking'
        ? { type: 'thinking', thinking: '' }
        : { ...block, input: {} };
    sendSse(res, 'content_block_start', { type: 'content_block_start', index, content_block: empty });
    if (block.type === 'text') {
      sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      if (block.thinking) sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      if (block.signature) sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else {
      sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    sendSse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sendSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: body.stop_reason, stop_sequence: null }, usage: { output_tokens: body.usage.output_tokens } });
  sendSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function emitChatStream(res, body) {
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const choice = body.choices[0];
  const first = { role: 'assistant' };
  if (choice.message.content) first.content = choice.message.content;
  if (choice.message.tool_calls) first.tool_calls = choice.message.tool_calls.map((call, index) => ({ index, ...call }));
  res.write(`data: ${JSON.stringify({ id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model, choices: [{ index: 0, delta: first, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function emitResponsesStream(res, body) {
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let sequence = 0;
  sendSse(res, null, { type: 'response.created', sequence_number: sequence++, response: { ...body, status: 'in_progress', output: [] } });
  body.output.forEach((item, outputIndex) => {
    sendSse(res, null, { type: 'response.output_item.added', sequence_number: sequence++, output_index: outputIndex, item: { ...item, status: 'in_progress', content: item.content ? [] : undefined } });
    if (item.type === 'message') {
      const part = item.content[0];
      sendSse(res, null, { type: 'response.content_part.added', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      sendSse(res, null, { type: 'response.output_text.delta', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text });
      sendSse(res, null, { type: 'response.output_text.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text });
      sendSse(res, null, { type: 'response.content_part.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, part });
    } else if (item.type === 'function_call') {
      sendSse(res, null, { type: 'response.function_call_arguments.delta', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, delta: item.arguments });
      sendSse(res, null, { type: 'response.function_call_arguments.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, arguments: item.arguments });
    }
    sendSse(res, null, { type: 'response.output_item.done', sequence_number: sequence++, output_index: outputIndex, item });
  });
  sendSse(res, null, { type: 'response.completed', sequence_number: sequence++, response: body });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleAnthropic(payload, req, res, signal) {
  const normalized = normalizeAnthropic(payload);
  const model = await resolveModel(normalized.model, { preferFast: normalized.autoMode });
  const requestClass = normalized.autoMode
    ? 'auto-mode'
    : /^claude-haiku(?:-|$)/i.test(normalized.model || '') ? 'helper-agent' : 'main';
  console.log(`[Antigravity Gateway] /v1/messages model=${model} requested=${normalized.model || '-'} class=${requestClass} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} maxOut=${normalized.generationConfig?.maxOutputTokens || '-'} stream=${normalized.stream}`);
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  const liveEmitter = textStreamingAllowed(normalized) ? createAnthropicTextEmitter(res, normalized.model || model) : null;
  let result;
  try { result = await runTurn(normalized, model, signal, { sessionId: clientScope(req), onDelta: liveEmitter?.onDelta }); } finally { stopHeartbeat?.(); }
  const body = anthropicResponse(normalized.model || model, result);
  if (liveEmitter) liveEmitter.finish(body);
  else if (normalized.stream) emitAnthropicStream(res, body); else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

async function handleChat(payload, req, res, signal) {
  const normalized = normalizeChat(payload);
  const model = await resolveModel(normalized.model);
  console.log(`[Antigravity Gateway] /v1/chat/completions model=${model} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} stream=${normalized.stream}`);
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  const liveEmitter = textStreamingAllowed(normalized) ? createChatTextEmitter(res, normalized.model || model) : null;
  let result;
  try { result = await runTurn(normalized, model, signal, { sessionId: clientScope(req), onDelta: liveEmitter?.onDelta }); } finally { stopHeartbeat?.(); }
  const body = chatResponse(normalized.model || model, result);
  if (liveEmitter) liveEmitter.finish(body);
  else if (normalized.stream) emitChatStream(res, body); else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

async function handleResponses(payload, req, res, signal) {
  cleanupResponseStore();
  const previous = payload.previous_response_id ? responseStore.get(payload.previous_response_id) : null;
  if (payload.previous_response_id && !previous) {
    throw new GatewayError(`找不到 previous_response_id: ${payload.previous_response_id}`, { code: 'previous_response_not_found', status: 400 });
  }
  const scope = clientScope(req);
  if (previous && previous.scope !== scope) {
    throw new GatewayError('previous_response_id 不属于当前客户端会话。', { code: 'previous_response_not_found', status: 400 });
  }
  if (previous) previous.at = Date.now();
  const normalized = normalizeResponses(payload, previous);
  const model = await resolveModel(normalized.model);
  console.log(`[Antigravity Gateway] /v1/responses model=${model} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} stream=${normalized.stream}`);
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  let result;
  try { result = await runTurn(normalized, model, signal, { sessionId: scope }); } finally { stopHeartbeat?.(); }
  const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
  const body = responsesResponse(normalized.model || model, result, responseId);
  responseStore.set(responseId, {
    at: Date.now(),
    scope,
    system: normalized.system,
    messages: [...normalized.messages, {
      role: 'assistant',
      text: result.text || '',
      parts: [
        ...(result.text ? [{ type: 'text', text: result.text }] : []),
        ...result.toolCalls.map((call) => ({
          type: 'tool_call',
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
        }))
      ]
    }]
  });
  if (normalized.stream) emitResponsesStream(res, body); else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

async function requestHandler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const route = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`).pathname.replace(/\/$/, '') || '/';
  if (!authorized(req)) { sendJson(res, 401, errorBody(new GatewayError('API key 无效。', { code: 'authentication_error', status: 401 }), route.includes('messages') ? 'anthropic' : 'openai')); return; }
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let protocol = route === '/v1/messages' || route === '/v1/messages/count_tokens' ? 'anthropic' : 'openai';
  try {
    if (req.method === 'GET' && route === '/') {
      const models = await availableModels();
      if (!versionCache) versionCache = await getVersion({ agyPath: AGY_PATH, prefixArgs: AGY_PREFIX_ARGS }).catch(() => 'unknown');
      sendJson(res, 200, {
        name: 'antigravity-gateway', version: GATEWAY_VERSION, status: 'ok',
        listen: `http://${HOST}:${PORT}`, agy: { path: AGY_PATH, version: versionCache },
        transport: usesDirectTransport() ? 'direct' : 'agy',
        auth: usesDirectTransport() ? directAuthDescription() : 'official-agy-keyring-session',
        default_model: await resolveModel(DEFAULT_MODEL),
        fast_model: await resolveModel('claude-haiku-internal', { preferFast: true }),
        models: models.length,
        capabilities: { anthropic_messages: true, openai_responses: true, chat_completions: true, tools_experimental: true, direct_upstream_sse: usesDirectTransport(), local_agy_session_bridge: Boolean(DIRECT_PROVIDER.localAuth?.isConfigured?.()), credentials_read_by_gateway: usesDirectTransport() }
      });
      return;
    }
    if (req.method === 'GET' && route === '/v1/models') {
      const models = await availableModels(true);
      sendJson(res, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'antigravity', display_name: id })),
        models: models.map((id, index) => codexModelInfo(id, index)),
        default_model: await resolveModel(DEFAULT_MODEL),
        fast_model: await resolveModel('claude-haiku-internal', { preferFast: true })
      });
      return;
    }
    if (req.method === 'POST' && route === '/v1/messages/count_tokens') {
      const payload = await readJson(req);
      const text = JSON.stringify(payload.system || '') + JSON.stringify(payload.messages || []) + JSON.stringify(payload.tools || []);
      sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) }, { 'x-token-count-estimated': 'true' });
      return;
    }
    const payload = await readJson(req);
    if (req.method === 'POST' && route === '/v1/messages') return await handleAnthropic(payload, req, res, controller.signal);
    if (req.method === 'POST' && route === '/v1/responses') return await handleResponses(payload, req, res, controller.signal);
    if (req.method === 'POST' && route === '/v1/chat/completions') return await handleChat(payload, req, res, controller.signal);
    throw new GatewayError(`接口不存在: ${route}`, { code: 'not_found', status: 404 });
  } catch (rawError) {
    const error = mapAgyError(rawError);
    // Claude Code may cancel an in-flight classifier/tool request as soon as a
    // newer branch wins. That is normal client control flow, not a gateway
    // failure, and the socket is already gone so no error body can be sent.
    if (controller.signal.aborted || res.destroyed) {
      if (process.env.ANTIGRAVITY_GATEWAY_DEBUG === '1') {
        console.warn(`[Antigravity Gateway] 请求已由客户端取消 (${error.code || 'request_aborted'})`);
      }
      return;
    }
    const diagnostic = process.env.ANTIGRAVITY_GATEWAY_DEBUG === '1' && error.details ? ` (${error.details})` : '';
    console.error(`[Antigravity Gateway Error] ${error.message}${diagnostic}`);
    if (!res.headersSent) sendJson(res, error.status || 500, errorBody(error, protocol));
    else {
      if (protocol === 'anthropic') sendSse(res, 'error', errorBody(error, protocol));
      else sendSse(res, null, { type: route === '/v1/responses' ? 'response.failed' : 'error', error: errorBody(error, protocol).error });
      res.end();
    }
  }
}

function createServer() {
  return http.createServer(requestHandler);
}

if (require.main === module) {
  if (CLI_ARGS.help) { printHelp(); return; }
  if (CLI_ARGS.version) { console.log(GATEWAY_VERSION); return; }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error('[Antigravity Gateway Error] 端口必须是 1-65535 的整数。');
    process.exitCode = 1;
    return;
  }
  if (!isLoopbackHost(HOST) && !API_KEY) {
    console.error('[Antigravity Gateway Error] 非本机监听必须设置 ANTIGRAVITY_GATEWAY_API_KEY。');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  const server = createServer();
  server.requestTimeout = REQUEST_TIMEOUT + 10000;
  server.headersTimeout = 30000;
  server.listen(PORT, HOST, async () => {
    let modelInfo = '待首次请求检测';
    let agyVersion = 'unknown';
    try {
      const models = await availableModels(true);
      modelInfo = `${models.length} 个模型，默认 ${await resolveModel(DEFAULT_MODEL)}，辅助 ${await resolveModel('claude-haiku-internal', { preferFast: true })}`;
      if (!usesDirectTransport()) agyVersion = await getVersion({ agyPath: AGY_PATH, prefixArgs: AGY_PREFIX_ARGS });
      versionCache = agyVersion;
    } catch (error) {
      modelInfo = `检测失败：${error.message}`;
    }
    console.log('=================================================================');
    console.log(' 🚀 Antigravity Gateway 已启动');
    console.log('-----------------------------------------------------------------');
    console.log(` 网关版本: v${GATEWAY_VERSION}`);
    console.log(` 监听地址: http://${HOST}:${PORT}`);
    console.log(` 传输模式: ${usesDirectTransport() ? '✅ 原生 Cloud Code 直连（跳过 agy 包装）' : 'agy CLI stream-json'}`);
    console.log(` Antigravity CLI: ${AGY_PATH} (${agyVersion})`);
    console.log(` 模型配置: ${modelInfo}`);
    console.log(` 登录方式: ${usesDirectTransport() ? directAuthDescription() : '官方 agy 系统 Keyring（网关不读取令牌）'}`);
    console.log(' 客户端接口: Claude Code / Codex CLI / OpenAI Chat Completions');
    console.log(' 工具桥: 实验性结构化投影；工具由客户端执行');
    console.log('=================================================================');
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`[Antigravity Gateway Error] ${HOST}:${PORT} 已被占用，请关闭旧进程或设置 ANTIGRAVITY_GATEWAY_PORT。`);
    else console.error(`[Antigravity Gateway Error] ${error.message}`);
    process.exitCode = 1;
  });
  const shutdown = async () => {
    server.close();
    await Promise.allSettled([...activeWorkers].map((worker) => worker.close()));
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}

module.exports = {
  availableModels,
  createServer,
  emitAnthropicStream,
  emitChatStream,
  emitResponsesStream,
  resolveModel,
  runTurn
};
