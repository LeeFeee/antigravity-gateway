#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { AgyError, AgyWorker, getVersion, listModels, resolveAgyCommand } = require('./src/agy-worker');
const { AccountPool } = require('./src/account-pool');
const { AccountStore } = require('./src/account-store');
const { DirectAntigravityProvider, DirectProviderError } = require('./src/direct-provider');
const { checkDashboard, dashboardData, dashboardHtml, openBrowser } = require('./src/dashboard');
const { LocalAccountImporter } = require('./src/local-account-importer');
const { OAuthFlow } = require('./src/oauth-flow');
const { QuotaManager } = require('./src/quota-manager');
const { manageService } = require('./src/service-manager');
const { TerminalConsole } = require('./src/terminal-console');
const { UsageStore } = require('./src/usage-store');
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
const CONFIG_DIR = path.resolve(
  process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR
    || path.join(os.homedir(), '.antigravity-gateway')
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
    else if (arg === '--codex-catalog-path') result.codexCatalogPath = true;
    else if (arg === '--claude-config-path') result.claudeConfigPath = true;
    else if (arg === '--claude-config') result.claudeConfig = true;
    else if (arg === '--models') result.models = true;
    else if (arg === 'stats') result.stats = true;
    else if (arg === 'service') {
      result.serviceRequested = true;
      result.serviceAction = argv[++index] || '';
    }
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
const DEFAULT_MODEL = CLI_ARGS.model || process.env.ANTIGRAVITY_DEFAULT_MODEL || 'gemini-3.8-flash-high';
const FAST_MODEL = String(process.env.ANTIGRAVITY_FAST_MODEL || '').trim();
const API_KEY = process.env.ANTIGRAVITY_GATEWAY_API_KEY || '';
// These are transport/memory guards measured in bytes, not model context
// windows measured in tokens. Keep them comfortably above Gemini 3.8 Flash's
// 1,048,576-token input window and let Cloud Code perform the authoritative
// token accounting.
const REQUEST_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_BODY_LIMIT || 64 * 1024 * 1024);
const REQUEST_TIMEOUT = Number(process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS || 300000);
const PROMPT_BYTE_LIMIT = Number(
  process.env.ANTIGRAVITY_GATEWAY_PROMPT_BYTE_LIMIT
  || process.env.ANTIGRAVITY_GATEWAY_CONTEXT_LIMIT
  || 64 * 1024 * 1024
);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY || 4));
const MAX_QUEUE = Math.max(0, Number(process.env.ANTIGRAVITY_GATEWAY_MAX_QUEUE || 32));
const MODEL_CACHE_MS = 60000;
const TRANSPORT = String(process.env.ANTIGRAVITY_GATEWAY_TRANSPORT || 'direct').trim().toLowerCase();
const DIRECT_PROVIDER = new DirectAntigravityProvider();
DIRECT_PROVIDER.localAuth.agyPath = AGY_PATH;
const ACCOUNT_STORE = new AccountStore({ configDir: CONFIG_DIR });
const USAGE_STORE = new UsageStore({ configDir: CONFIG_DIR });
const ACCOUNT_POOL = new AccountPool({
  store: ACCOUNT_STORE,
  fallbackProvider: DIRECT_PROVIDER,
  usageStore: USAGE_STORE,
  agyPath: AGY_PATH
});
const QUOTA_MANAGER = new QuotaManager({ configDir: CONFIG_DIR, accountPool: ACCOUNT_POOL });
ACCOUNT_POOL.quotaManager = QUOTA_MANAGER;
const OAUTH_FLOW = new OAuthFlow({ agyPath: AGY_PATH });
const LOCAL_ACCOUNT_IMPORTER = new LocalAccountImporter({
  provider: DIRECT_PROVIDER,
  store: ACCOUNT_STORE,
  accountPool: ACCOUNT_POOL
});
let TERMINAL = null;

function gatewayLog(message) { return TERMINAL ? TERMINAL.log(message) : console.log(message); }
function gatewayWarn(message) { return TERMINAL ? TERMINAL.log(message, 'warn') : console.warn(message); }
function gatewayError(message) { return TERMINAL ? TERMINAL.log(message, 'error') : console.error(message); }

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
    if (signal?.aborted) return Promise.reject(signal.reason || new GatewayError('请求已取消。', { code: 'request_aborted', status: 499 }));
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
// Admit uploads before allocating/normalizing complete request bodies.
const uploadSlots = new Semaphore(MAX_CONCURRENCY, MAX_QUEUE);

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function dashboardUrl() {
  const host = isLoopbackHost(HOST) ? (HOST === '::1' ? '[::1]' : HOST) : '127.0.0.1';
  return `http://${host}:${PORT}/dashboard`;
}

function configuredAliases() {
  try {
    const value = JSON.parse(process.env.ANTIGRAVITY_MODEL_ALIASES || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([source, target]) => source && typeof target === 'string' && target.trim()));
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
  if (ACCOUNT_POOL.hasManagedAccounts()) return `gateway account pool（${ACCOUNT_POOL.status().length} 个本地账号）`;
  const secureStore = process.platform === 'darwin'
    ? 'macOS Keychain / '
    : process.platform === 'linux'
      ? 'Linux Secret Service / '
      : process.platform === 'win32'
        ? 'Windows Credential Manager / '
        : '';
  if (DIRECT_PROVIDER.localAuth?.isConfigured?.()) return `${secureStore}local agy session（只读；刷新结果仅保存在内存）`;
  if (DIRECT_PROVIDER.isConfigured()) return 'explicit OAuth env/auth file (manual fallback)';
  return 'unavailable';
}

async function availableModels(force = false) {
  if (!force && Date.now() - modelCache.at < MODEL_CACHE_MS && modelCache.models.length) return modelCache.models;
  try {
    const models = usesDirectTransport()
      ? await ACCOUNT_POOL.listModels(undefined, { force: true })
      : await listModels({ agyPath: AGY_PATH, prefixArgs: AGY_PREFIX_ARGS });
    if (!models.length) throw new GatewayError('`agy models` 没有返回可识别的模型 ID。', { code: 'empty_model_catalog', status: 503 });
    modelCache = { at: Date.now(), models, error: null };
  } catch (error) {
    modelCache = { at: Date.now(), models: modelCache.models, error };
    if (!modelCache.models.length) throw error;
  }
  return modelCache.models;
}

function preferredFastModel(models) {
  if (FAST_MODEL) return FAST_MODEL;
  const priorities = [
    /^gemini-3\.8-flash-low$/i,
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
  const aliases = configuredAliases();
  const original = requested || DEFAULT_MODEL;
  // Normal requests preserve the exact client model ID. Aliases are opt-in,
  // exact mappings only. Auto Mode classifiers are the sole requests allowed
  // to use the independent low-latency route.
  if (!preferFast) {
    return Object.prototype.hasOwnProperty.call(aliases, original) ? aliases[original] : original;
  }
  try {
    return preferredFastModel(await availableModels());
  } catch {
    // Model discovery is advisory. Even an Auto Mode classifier must still be
    // allowed to reach the upstream service when the local catalog is stale or
    // temporarily unavailable.
    return FAST_MODEL || DEFAULT_MODEL;
  }
}

async function upstreamModelDiagnostic(error, model) {
  if (!['direct_upstream_error', 'agy_upstream_error'].includes(error?.code)) return error;

  const detail = String(error.details || '').trim();
  if (error.code === 'agy_upstream_error' && detail && !String(error.message || '').includes(detail)) {
    error.message = `Antigravity 上游请求失败：${detail}`;
  } else {
    error.message = String(error.message || 'Antigravity 上游请求失败。')
      .replace(/^Antigravity 直连请求失败/, 'Antigravity 上游请求失败');
  }

  let models;
  try {
    models = await availableModels();
  } catch {
    return error;
  }
  if (models.includes(model)) return error;

  error.message += `\n\n网关诊断：\n请求模型 ${model} 未出现在当前发现的 Antigravity 模型目录中，可能是客户端模型配置错误、模型尚未向当前账号开放，或模型目录暂未刷新。\n请输入 /model 更换可用模型。`;
  return error;
}

function codexModelInfo(slug, priority) {
  const upstream = usesDirectTransport() ? ACCOUNT_POOL.modelInfo(slug) : null;
  // Cloud Code currently reports 1,048,576 input tokens for Gemini 3.7/3.8
  // Flash. Keep that verified fallback even when a transient discovery request
  // fails; otherwise the client would compact a healthy 1M context at 200K.
  const contextWindow = upstream?.maxTokens
    || (/^gemini-3\.[78]-flash(?:[.-]|$)/i.test(slug) ? 1048576 : 200000);
  return {
    slug,
    display_name: upstream?.displayName || slug,
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
    context_window: contextWindow,
    max_context_window: contextWindow,
    max_output_tokens: upstream?.maxOutputTokens || null,
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

function codexCatalogPath() {
  return path.join(CONFIG_DIR, 'codex-models.json');
}

function claudeConfigPath() {
  return path.join(CONFIG_DIR, 'claude-models.json');
}

// Presentation order only. Request routing always uses the untouched model ID
// supplied by the client and never depends on this list.
const MODEL_DISPLAY_PRIORITY = [
  'gemini-3.8-flash-high',
  'gemini-3.7-flash-high',
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6',
  'gemini-3.1-pro-high',
  'gemini-3.1-flash-image',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-tiered',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash',
  'gemini-3.7-flash-tiered',
  'gemini-3.5-flash-extra-low',
  'gemini-3.1-pro-low',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-agent',
  'gemini-3-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-pro-agent'
];

const MODEL_DISPLAY_RANK = new Map(MODEL_DISPLAY_PRIORITY.map((model, index) => [model, index]));

function displayModels(models) {
  return [...models].sort((left, right) => {
    const leftRank = MODEL_DISPLAY_RANK.get(left);
    const rightRank = MODEL_DISPLAY_RANK.get(right);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    const leftKey = left.toLowerCase();
    const rightKey = right.toLowerCase();
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function codexCatalogBody(models) {
  const ordered = displayModels(models);
  return {
    object: 'list',
    data: ordered.map((id) => ({ id, object: 'model', created: 0, owned_by: 'antigravity', display_name: id })),
    models: ordered.map((id, index) => codexModelInfo(id, index))
  };
}

function writeCodexCatalog(models) {
  const target = codexCatalogPath();
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(codexCatalogBody(models), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function claudeConfigBody(models) {
  const ordered = displayModels(models);
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    modelPicker: {
      options: ordered.map((model) => ({
        model,
        label: model,
        description: 'Antigravity Gateway'
      })),
      replaceBuiltInOptions: true
    }
  };
}

function writeClaudeConfig(models) {
  const target = claudeConfigPath();
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(claudeConfigBody(models), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function featuredModels(models) {
  return displayModels(models).filter((model) => (
    /^gemini-3\.[78](?:[.-]|$)/i.test(model)
    || model === 'claude-opus-4-6-thinking'
    || model === 'claude-sonnet-4-6'
  ));
}

function credentialSourceDescription() {
  if (!usesDirectTransport()) return '官方 agy 系统 Keyring（由 agy 管理）';
  if (ACCOUNT_POOL.hasManagedAccounts()) return `${ACCOUNT_STORE.directory}（${ACCOUNT_POOL.status().length} 个账号）`;
  if (DIRECT_PROVIDER.localAuth?.last?.sourcePath) return DIRECT_PROVIDER.localAuth.last.sourcePath;
  if (DIRECT_PROVIDER.authFile) return DIRECT_PROVIDER.authFile;
  if (process.env.ANTIGRAVITY_ACCESS_TOKEN || process.env.ANTIGRAVITY_REFRESH_TOKEN) return '环境变量（值不显示）';
  return '未检测到';
}

function startupBanner({ models = [], modelError = '', credentialSource = credentialSourceDescription() } = {}) {
  const baseUrl = `http://${HOST}:${PORT}`;
  const apiKey = API_KEY
    ? '已配置（使用 ANTIGRAVITY_GATEWAY_API_KEY 的值）'
    : 'antigravity-gateway（任意内容）';
  const lines = [
    '=================================================================',
    ' 🚀 Antigravity Gateway 已启动',
    '-----------------------------------------------------------------',
    ` 网关版本: v${GATEWAY_VERSION}`,
    ' BaseURL:',
    `    Anthropic: ${baseUrl}`,
    `    OpenAI: ${baseUrl}/v1`,
    ` API Key: ${apiKey}`,
    ` 本地密钥: ${credentialSource}`,
    ` 传输模式: ${usesDirectTransport() ? '✅ 原生 Cloud Code 直连（跳过 agy 包装）' : 'agy CLI stream-json'}`,
    ' 可用模型:'
  ];
  const selected = featuredModels(models);
  if (selected.length) lines.push(...selected.map((model) => `    ${model}`));
  else lines.push(`    ${modelError ? `检测失败：${modelError}` : '未发现精选模型'}`);
  lines.push(' 更多模型: antigravity-gateway --models');
  lines.push(' Claude Code 模型配置: antigravity-gateway --claude-config-path');
  lines.push(' Token 看板: antigravity-gateway stats');
  lines.push('=================================================================');
  return lines.join('\n');
}

function printHelp() {
  console.log(`Antigravity Gateway ${GATEWAY_VERSION}

用法:
  antigravity-gateway [选项]
  antigravity-gateway stats
  antigravity-gateway service <start|status|restart|stop|logs|uninstall>

选项:
  -h, --help, -help       显示帮助
  -v, --version           显示版本
  -p, --port <number>     监听端口，默认 9897
  -H, --host <address>    监听地址，默认 127.0.0.1
  --agy-path <path>       agy 可执行文件路径
  -m, --model <id>        默认 Antigravity 模型
  --models                 显示当前账号的全部真实模型 ID
  --codex-catalog-path    显示自动生成的 Codex 模型目录绝对路径
  --claude-config-path    显示自动生成的 Claude Code 模型配置路径
  --claude-config         输出 Claude Code modelPicker 配置 JSON
  stats                   在默认浏览器打开本地 Token 用量看板

后台保活:
  service start           自动注册开机/登录自启并立即后台启动；重复执行会更新并重启
  service status          显示配置与运行状态
  service restart         重启已配置的后台服务
  service stop            停止后台服务但保留自启配置
  service logs            显示最近的后台日志
  service uninstall       停止并移除后台服务（保留历史日志）

传输模式:
  ANTIGRAVITY_GATEWAY_TRANSPORT=auto|direct|agy
  默认 direct：从系统安全凭证存储或本地 agy 会话文件读取登录态并直连 Cloud Code。
  auto/agy 仅为显式兼容选项；手动凭据兜底可用 ANTIGRAVITY_AUTH_FILE。

接口:
  GET  /
  GET  /dashboard
  GET  /dashboard/data
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

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = String(process.env.ANTIGRAVITY_GATEWAY_CORS_ORIGIN || '').split(',').map((value) => value.trim());
    let sameOrigin = false;
    try {
      const url = new URL(origin);
      sameOrigin = url.origin === `http://${req.headers.host}`
        && (isLoopbackHost(url.hostname) || url.hostname === HOST);
    } catch { /* reject malformed origins */ }
    if (!sameOrigin && !allowed.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return true;
}

function clientScope(req) {
  const material = [
    req.headers['x-session-id'] || '',
    req.headers.authorization || req.headers['x-api-key'] || '',
    req.socket?.remoteAddress || ''
  ].join('\0');
  return crypto.createHash('sha256').update(material).digest('hex');
}

function clientSessionScope(req, payload = {}, normalized = {}) {
  const headers = req.headers || {};
  const explicit = [
    headers['x-session-id'],
    headers['x-claude-session-id'],
    headers['x-codex-session-id'],
    headers['x-client-session-id'],
    headers['session-id'],
    payload?.metadata?.parent_session_id,
    payload?.metadata?.session_id,
    payload?.metadata?.user_id,
    payload?.prompt_cache_key,
    payload?.session_id,
    payload?.conversation_id,
    payload?.user
  ].find((value) => typeof value === 'string' && value.trim());
  const firstMessage = normalized.messages?.find((message) => message?.role === 'user') || normalized.messages?.[0] || {};
  const fallback = JSON.stringify({
    model: normalized.model || payload.model || '',
    role: firstMessage.role || '',
    text: String(firstMessage.text || '').slice(0, 4096),
    parts: Array.isArray(firstMessage.parts) ? firstMessage.parts.slice(0, 4) : []
  });
  return crypto.createHash('sha256')
    .update(`${clientScope(req)}\0${explicit || fallback}`)
    .digest('hex');
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
setInterval(cleanupResponseStore, 60_000).unref();

async function runTurn(normalized, model, signal, { sessionId, onDelta } = {}) {
  const release = await requestSlots.acquire(signal);
  if (usesDirectTransport()) {
    try {
      const onAccountSelected = ({ accountId, email, source, attempt }) => {
        gatewayLog(`[Antigravity Gateway] 路由账号=${email || accountId} source=${source} model=${model} attempt=${attempt}`);
      };
      let raw = await ACCOUNT_POOL.send(normalized, model, { signal, sessionId, onDelta, onAccountSelected });
      try {
        return finalizeModelResult(normalized, raw);
      } catch (error) {
        if (error.code === 'invalid_auto_mode_classifier_output') {
          raw = await ACCOUNT_POOL.send(normalized, model, { signal, sessionId, onAccountSelected, repairInstruction: 'Return only the XML verdict required by the client contract. No prose or Markdown.' });
          return finalizeModelResult(normalized, raw);
        }
        if (error.code === 'invalid_structured_output') {
          raw = await ACCOUNT_POOL.send(normalized, model, { signal, sessionId, onAccountSelected, repairInstruction: `Return only one valid JSON value conforming to this schema: ${JSON.stringify(normalized.structuredSchema)}` });
          return finalizeModelResult(normalized, raw);
        }
        throw error;
      }
    } finally {
      release();
    }
  }
  let prompt;
  try { prompt = buildPrompt(normalized); } catch (error) { release(); throw error; }
  if (Buffer.byteLength(prompt) > PROMPT_BYTE_LIMIT) {
    release();
    throw new GatewayError('请求编码后超过网关的字节安全上限；这不是模型上下文窗口判定。', {
      code: 'prompt_bytes_too_large', status: 413
    });
  }
  const workerId = crypto.randomUUID();
  const workDir = path.join(RUNTIME, 'workspaces', workerId);
  // agy requires a log path. Keep it inside the per-request directory so the
  // gateway can remove it with the isolated workspace after the turn.
  const logFile = path.join(workDir, 'agy.log');
  let worker;
  try { worker = new AgyWorker({
    agyPath: AGY_PATH,
    prefixArgs: AGY_PREFIX_ARGS,
    model,
    cwd: workDir,
    logFile,
    timeoutMs: REQUEST_TIMEOUT
  }); } catch (error) { release(); throw error; }
  activeWorkers.add(worker);
  try {
    const trackedSend = async (input, sendOptions) => {
      try {
        const output = await worker.send(input, sendOptions);
        USAGE_STORE.recordUpstream({ accountId: 'agy-cli', model, usage: output.usage, success: true });
        return output;
      } catch (error) {
        USAGE_STORE.recordUpstream({ accountId: 'agy-cli', model, success: false });
        throw error;
      }
    };
    let raw = await trackedSend(prompt, { signal, onDelta });
    try {
      return finalizeModelResult(normalized, raw);
    } catch (error) {
      if (error.code === 'invalid_auto_mode_classifier_output') {
        raw = await trackedSend('AUTO_MODE_XML_REPAIR: Return only the XML verdict required by the original system contract. No prose or Markdown.', { signal, onDelta });
        return finalizeModelResult(normalized, raw);
      }
      if (error.code === 'invalid_structured_output') {
        raw = await trackedSend(`STRUCTURED_OUTPUT_REPAIR: Return only one valid JSON value conforming to this schema: ${JSON.stringify(normalized.structuredSchema)}`, { signal, onDelta });
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

async function runTurnWithModelDiagnostic(normalized, model, signal, options) {
  try {
    return await runTurn(normalized, model, signal, options);
  } catch (error) {
    throw await upstreamModelDiagnostic(error, model);
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
      // message_start went out before upstream usage existed; message_delta usage is cumulative per the Messages API.
      sendSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: body.stop_reason, stop_sequence: null }, usage: body.usage });
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
  sendSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: body.stop_reason, stop_sequence: null }, usage: body.usage });
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
  USAGE_STORE.recordClientRequest();
  const normalized = normalizeAnthropic(payload);
  const model = await resolveModel(normalized.model, { preferFast: normalized.autoMode });
  const requestClass = normalized.autoMode ? 'auto-mode' : 'client';
  gatewayLog(`[Antigravity Gateway] /v1/messages model=${model} requested=${normalized.model || '-'} class=${requestClass} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} maxOut=${normalized.generationConfig?.maxOutputTokens || '-'} stream=${normalized.stream}`);
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  const liveEmitter = textStreamingAllowed(normalized) ? createAnthropicTextEmitter(res, normalized.model || model) : null;
  let result;
  try { result = await runTurnWithModelDiagnostic(normalized, model, signal, { sessionId: clientSessionScope(req, payload, normalized), onDelta: liveEmitter?.onDelta }); } finally { stopHeartbeat?.(); }
  const body = anthropicResponse(normalized.model || model, result);
  if (liveEmitter) liveEmitter.finish(body);
  else if (normalized.stream) emitAnthropicStream(res, body); else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

async function handleChat(payload, req, res, signal) {
  USAGE_STORE.recordClientRequest();
  const normalized = normalizeChat(payload);
  const model = await resolveModel(normalized.model);
  gatewayLog(`[Antigravity Gateway] /v1/chat/completions model=${model} requested=${normalized.model || '-'} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} stream=${normalized.stream}`);
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  const liveEmitter = textStreamingAllowed(normalized) ? createChatTextEmitter(res, normalized.model || model) : null;
  let result;
  try { result = await runTurnWithModelDiagnostic(normalized, model, signal, { sessionId: clientSessionScope(req, payload, normalized), onDelta: liveEmitter?.onDelta }); } finally { stopHeartbeat?.(); }
  const body = chatResponse(normalized.model || model, result);
  if (liveEmitter) liveEmitter.finish(body);
  else if (normalized.stream) emitChatStream(res, body); else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

async function handleResponses(payload, req, res, signal) {
  USAGE_STORE.recordClientRequest();
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
  gatewayLog(`[Antigravity Gateway] /v1/responses model=${model} requested=${normalized.model || '-'} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} stream=${normalized.stream}`);
  if (process.env.ANTIGRAVITY_GATEWAY_DEBUG === '1') {
    const customTools = (payload.tools || []).filter((tool) => tool?.type === 'custom');
    if (customTools.length) gatewayLog(`[Antigravity Gateway Debug] custom-tools=${JSON.stringify(customTools).slice(0, 4000)}`);
  }
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  let result;
  try { result = await runTurnWithModelDiagnostic(normalized, model, signal, { sessionId: clientSessionScope(req, payload, normalized) }); } finally { stopHeartbeat?.(); }
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
          ...(call.kind === 'custom' ? { kind: 'custom', input: call.input } : {}),
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
        }))
      ]
    }]
  });
  if (normalized.stream) emitResponsesStream(res, body); else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

async function requestHandler(req, res) {
  if (!setCors(req, res)) { sendJson(res, 403, { error: { type: 'origin_not_allowed', message: '浏览器来源未获授权。' } }); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let route;
  try {
    // Validate Host, but never use client-controlled Host as the URL parser base.
    if (req.headers.host) new URL(`http://${req.headers.host}`);
    route = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
  } catch { sendJson(res, 400, { error: { type: 'invalid_url', message: '请求 URL 或 Host 无效。' } }); return; }
  if (req.method === 'GET' && route === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }
  if (route === '/dashboard' || route === '/dashboard/data') {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: { type: 'dashboard_local_only', message: 'Token 看板仅允许从网关所在设备访问。' } });
      return;
    }
    if (req.method === 'GET' && route === '/dashboard') {
      const body = dashboardHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && route === '/dashboard/data') {
      sendJson(res, 200, dashboardData({
        usageStore: USAGE_STORE,
        accountPool: ACCOUNT_POOL,
        quotaManager: QUOTA_MANAGER,
        version: GATEWAY_VERSION
      }), { 'Cache-Control': 'no-store' });
      return;
    }
    sendJson(res, 405, { error: { type: 'method_not_allowed', message: '看板接口只支持 GET。' } });
    return;
  }
  if (!authorized(req)) { sendJson(res, 401, errorBody(new GatewayError('API key 无效。', { code: 'authentication_error', status: 401 }), route.includes('messages') ? 'anthropic' : 'openai')); return; }
  const controller = new AbortController();
  let timedOut = false;
  let releaseUpload;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort(new GatewayError('网关请求超时。', { code: 'request_timeout', status: 504 }));
    // Uploads may be stalled; aborting upstream alone does not end readJson.
    if (!res.headersSent) sendJson(res, 504, errorBody(controller.signal.reason, protocol));
    else { sendSse(res, 'error', errorBody(controller.signal.reason, protocol)); res.end(); }
  }, REQUEST_TIMEOUT);
  deadline.unref();
  res.on('finish', () => { if (timedOut) req.destroy(); });
  req.on('aborted', () => controller.abort());
  req.on('error', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let protocol = route === '/v1/messages' || route === '/v1/messages/count_tokens' ? 'anthropic' : 'openai';
  try {
    if (req.method === 'POST') releaseUpload = await uploadSlots.acquire(controller.signal);
    // Claude Code probes custom providers with this lightweight endpoint.
    // Treat it as a connectivity check instead of logging a false 404 error.
    if (route === '/api/hello' && ['GET', 'POST', 'HEAD'].includes(req.method)) {
      sendJson(res, 200, { status: 'ok', name: 'antigravity-gateway', version: GATEWAY_VERSION });
      return;
    }
    // Recent Claude Code releases post local telemetry batches to the configured
    // provider base URL. The gateway does not forward telemetry; acknowledge it
    // locally so the client neither retries nor produces a misleading 404.
    if (route === '/api/event_logging/batch' && ['POST', 'HEAD'].includes(req.method)) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && route === '/') {
      const models = await availableModels();
      if (!versionCache) versionCache = await getVersion({ agyPath: AGY_PATH, prefixArgs: AGY_PREFIX_ARGS }).catch(() => 'unknown');
      sendJson(res, 200, {
        name: 'antigravity-gateway', version: GATEWAY_VERSION, status: 'ok',
        listen: `http://${HOST}:${PORT}`, agy: { path: AGY_PATH, version: versionCache },
        transport: usesDirectTransport() ? 'direct' : 'agy',
        auth: usesDirectTransport() ? directAuthDescription() : 'official-agy-keyring-session',
        credential_source: credentialSourceDescription(),
        codex_model_catalog: codexCatalogPath(),
        claude_model_config: claudeConfigPath(),
        default_model: DEFAULT_MODEL,
        fast_model: preferredFastModel(models),
        models: models.length,
        transport_limits: { request_body_bytes: REQUEST_LIMIT, normalized_prompt_bytes: PROMPT_BYTE_LIMIT },
        account_pool: { managed_accounts: ACCOUNT_POOL.status().length, accounts: ACCOUNT_POOL.status() },
        usage: { file: USAGE_STORE.file, ...USAGE_STORE.summary() },
        capabilities: { anthropic_messages: true, openai_responses: true, chat_completions: true, tools_experimental: true, direct_upstream_sse: usesDirectTransport(), local_agy_session_bridge: Boolean(DIRECT_PROVIDER.localAuth?.isConfigured?.()), multi_account: true, persistent_usage: true, web_dashboard: true, interactive_console: true, credentials_read_by_gateway: usesDirectTransport() }
      });
      return;
    }
    if (req.method === 'GET' && route === '/v1/models') {
      const models = await availableModels(true);
      sendJson(res, 200, {
        ...codexCatalogBody(models),
        default_model: DEFAULT_MODEL,
        fast_model: preferredFastModel(models)
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
    if (timedOut || controller.signal.aborted || res.destroyed) {
      if (process.env.ANTIGRAVITY_GATEWAY_DEBUG === '1') {
        gatewayWarn(`[Antigravity Gateway] 请求已由客户端取消 (${error.code || 'request_aborted'})`);
      }
      return;
    }
    const diagnostic = process.env.ANTIGRAVITY_GATEWAY_DEBUG === '1' && error.details ? ` (${error.details})` : '';
    gatewayError(`[Antigravity Gateway Error] ${error.message}${diagnostic}`);
    if (!res.headersSent) sendJson(res, error.status || 500, errorBody(error, protocol));
    else {
      if (protocol === 'anthropic') sendSse(res, 'error', errorBody(error, protocol));
      else sendSse(res, null, { type: route === '/v1/responses' ? 'response.failed' : 'error', error: errorBody(error, protocol).error });
      res.end();
    }
  } finally {
    clearTimeout(deadline);
    releaseUpload?.();
  }
}

function createServer() {
  return http.createServer((req, res) => {
    void requestHandler(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, { error: { message: 'Antigravity Gateway 内部错误。' } });
      else res.destroy();
    });
  });
}

if (require.main === module) {
  if (CLI_ARGS.help) { printHelp(); return; }
  if (CLI_ARGS.version) { console.log(GATEWAY_VERSION); return; }
  if (CLI_ARGS.serviceRequested) {
    void manageService(CLI_ARGS.serviceAction, {
      configDir: CONFIG_DIR,
      gatewayFile: __filename
    }).then((message) => console.log(message)).catch((error) => {
      const details = error.details ? `\n${error.details}` : '';
      console.error(`[Antigravity Gateway Error] ${error.message}${details}`);
      process.exitCode = 1;
    });
    return;
  }
  if (CLI_ARGS.stats) {
    const url = dashboardUrl();
    void checkDashboard(url).then(() => {
      openBrowser(url);
      console.log(`Antigravity Gateway Token 看板：${url}`);
    }).catch(() => {
      console.error(`[Antigravity Gateway Error] 网关尚未运行。请先执行 antigravity-gateway 或 antigravity-gateway service start，然后再次运行 antigravity-gateway stats。\n看板地址：${url}`);
      process.exitCode = 1;
    });
    return;
  }
  if (CLI_ARGS.codexCatalogPath) { console.log(codexCatalogPath()); return; }
  if (CLI_ARGS.claudeConfigPath) { console.log(claudeConfigPath()); return; }
  if (CLI_ARGS.models || CLI_ARGS.claudeConfig) {
    void availableModels(true).then((models) => {
      console.log(CLI_ARGS.models ? displayModels(models).join('\n') : JSON.stringify(claudeConfigBody(models), null, 2));
    }).catch((error) => {
      console.error(`[Antigravity Gateway Error] ${error.message}`);
      process.exitCode = 1;
    });
    return;
  }
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
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    TERMINAL?.stop();
    QUOTA_MANAGER.stop();
    USAGE_STORE.stop();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...activeWorkers].map((worker) => worker.close()));
  };
  TERMINAL = new TerminalConsole({
    usageStore: USAGE_STORE,
    accountPool: ACCOUNT_POOL,
    quotaManager: QUOTA_MANAGER,
    oauthFlow: OAUTH_FLOW,
    accountStore: ACCOUNT_STORE,
    commands: {
      models: async () => displayModels(await availableModels(true)),
      status: async () => gatewayLog(`网关运行中：${HOST}:${PORT}，账号 ${ACCOUNT_POOL.status().length || '本地 agy'}，并发 ${requestSlots.active}/${MAX_CONCURRENCY}`),
      config: async () => [
        `Anthropic: http://${HOST}:${PORT}`,
        `OpenAI: http://${HOST}:${PORT}/v1`,
        `API Key: ${API_KEY ? '使用 ANTIGRAVITY_GATEWAY_API_KEY 的值' : 'antigravity-gateway（任意内容）'}`,
        `Claude Code 模型配置: ${claudeConfigPath()}`,
        `Codex 模型目录: ${codexCatalogPath()}`
      ].join('\n'),
      logs: async () => `后台日志目录：${path.join(CONFIG_DIR, 'logs')}`,
      stats: async () => {
        const url = dashboardUrl();
        openBrowser(url);
        return `Token 看板：${url}`;
      },
      version: async () => `Antigravity Gateway v${GATEWAY_VERSION}`,
      quit: async () => { await shutdown(); process.exit(0); }
    }
  });
  USAGE_STORE.start();
  QUOTA_MANAGER.start();
  server.requestTimeout = REQUEST_TIMEOUT + 10000;
  server.headersTimeout = 30000;
  server.listen(PORT, HOST, async () => {
    let models = [];
    let modelError = '';
    let localAccountImport = null;
    if (usesDirectTransport()) {
      try {
        localAccountImport = await LOCAL_ACCOUNT_IMPORTER.importIfNew();
        if (localAccountImport.status === 'imported') void QUOTA_MANAGER.refresh().catch(() => {});
      } catch (error) {
        localAccountImport = { status: 'error', message: error.message };
      }
    }
    try {
      models = await availableModels(true);
      try { writeCodexCatalog(models); }
      catch (error) { gatewayWarn(`[Antigravity Gateway] Codex 模型目录写入失败：${error.message}`); }
      try { writeClaudeConfig(models); }
      catch (error) { gatewayWarn(`[Antigravity Gateway] Claude Code 模型配置写入失败：${error.message}`); }
      // Version detection is read-only and works for both the subprocess and
      // direct transports. Showing the real Windows CLI version is valuable
      // diagnostics even though direct mode does not invoke it per request.
      versionCache = await getVersion({ agyPath: AGY_PATH, prefixArgs: AGY_PREFIX_ARGS });
    } catch (error) {
      modelError = error.message;
    }
    gatewayLog(startupBanner({ models, modelError }));
    if (localAccountImport?.status === 'imported') {
      gatewayLog(`[Antigravity Gateway] ✅ 已将本地 agy 新账号加入账号池：${localAccountImport.account.email || localAccountImport.account.id}`);
    } else if (localAccountImport?.status === 'existing') {
      gatewayLog(`[Antigravity Gateway] 本地 agy 账号已在账号池，未重复导入：${localAccountImport.account.email || localAccountImport.account.id}`);
    } else if (localAccountImport?.status === 'error') {
      gatewayWarn(`[Antigravity Gateway] 本地 agy 账号自动导入未完成：${localAccountImport.message}（不影响已有账号池和原有登录态）`);
    }
    TERMINAL.showDashboard();
    TERMINAL.start();
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') gatewayError(`[Antigravity Gateway Error] ${HOST}:${PORT} 已被占用，请关闭旧进程或设置 ANTIGRAVITY_GATEWAY_PORT。`);
    else gatewayError(`[Antigravity Gateway Error] ${error.message}`);
    QUOTA_MANAGER.stop();
    USAGE_STORE.stop();
    process.exitCode = 1;
  });
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}

module.exports = {
  availableModels,
  claudeConfigBody,
  claudeConfigPath,
  clientSessionScope,
  codexCatalogBody,
  codexCatalogPath,
  codexModelInfo,
  createServer,
  displayModels,
  emitAnthropicStream,
  emitChatStream,
  emitResponsesStream,
  featuredModels,
  resolveModel,
  runTurn,
  startupBanner
};
