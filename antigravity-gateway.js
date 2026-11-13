#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { resolveAgyCommand } = require('./src/agy-installation');
const { AGY_CLI_VERSION } = require('./src/agy-request-profile');
const { AccountPool } = require('./src/account-pool');
const { AccountStore } = require('./src/account-store');
const { imageArtifact, imageArtifacts, internalImageToolResult, streamTextRemainder } = require('./src/artifacts');
const { createDashboardAccessPolicy } = require('./src/dashboard-access');
const { DiagnosticLog } = require('./src/diagnostic-log');
const { DirectProviderError } = require('./src/direct-provider');
const { closeNativeTransport } = require('./src/agy-native-transport');
const { imageReferencePaths } = require('./src/agy-image-references');
const { nativeImageToolResponse } = require('./src/agy-tool-results');
const { checkDashboard, dashboardAsset, dashboardData, dashboardHtml, openBrowser } = require('./src/dashboard');
const { MediaStore, MultimediaError, mediaParts, normalizeMime, imageFileExtension, localMediaOptions, safeRasterImage } = require('./src/multimedia');
const { OAuthFlow } = require('./src/oauth-flow');
const { DashboardAccountAuth, handleDashboardAccountAuth } = require('./src/dashboard-account-auth');
const { QuotaManager } = require('./src/quota-manager');
const { acquireDirectoryGuard } = require('./src/agy-file-lease');
const { manageService } = require('./src/service-manager');
const { TerminalConsole } = require('./src/terminal-console');
const { UsageStore } = require('./src/usage-store');
const { SessionManager, credentialScope } = require('./src/session-manager');
const { resolveModelConfiguration } = require('./src/antigravity-model-config');
const { isConversionError } = require('./src/conversion-errors');
const { withAsyncSchemaBoundary } = require('./src/schema-contract');
const { ServerSearchReceipts } = require('./src/server-search-contract');
const { prepareServerSearchForwardAsync, buildServerSearchMessage, buildServerSearchErrorMessage } = require('./src/server-search-protocol');
const { version: GATEWAY_VERSION } = require('./package.json');
const {
  GatewayError,
  anthropicResponse,
  finalizeModelResultAsync,
  normalizeAnthropicAsync,
  normalizeResponsesAsync,
  NATIVE_IMAGE_TOOL_NAME,
  prepareNativeMultimodal,
  responsesResponse,
  upstreamTermination
} = require('./src/protocol');

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
const DEFAULT_MODEL = CLI_ARGS.model || process.env.ANTIGRAVITY_DEFAULT_MODEL || 'gemini-3.8-flash-high';
const FAST_MODEL = String(process.env.ANTIGRAVITY_FAST_MODEL || '').trim();
const API_KEY = process.env.ANTIGRAVITY_GATEWAY_API_KEY || '';
// These are transport/memory guards measured in bytes, not model context
// windows measured in tokens. Keep them comfortably above Gemini 3.8 Flash's
// 1,048,576-token input window and let Google Antigravity API perform the authoritative
// token accounting.
const REQUEST_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_BODY_LIMIT || 64 * 1024 * 1024);
const REQUEST_TIMEOUT = Number(process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS || 300000);
const PROMPT_BYTE_LIMIT = Number(
  process.env.ANTIGRAVITY_GATEWAY_PROMPT_BYTE_LIMIT
  || process.env.ANTIGRAVITY_GATEWAY_CONTEXT_LIMIT
  || 64 * 1024 * 1024
);
const DEFAULT_MAX_CONCURRENCY = 12;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.ANTIGRAVITY_GATEWAY_MAX_CONCURRENCY || DEFAULT_MAX_CONCURRENCY));
const MAX_QUEUE = Math.max(0, Number(process.env.ANTIGRAVITY_GATEWAY_MAX_QUEUE || 32));
const MODEL_CACHE_MS = 60000;
// 先取得目录守护，再初始化可能清理或落盘状态的账号池。
function initializeGateway(directoryGuard = null) {
const DIAGNOSTIC_LOG = new DiagnosticLog({ directory: path.join(CONFIG_DIR, 'logs') });
let diagnosticsEnabled = false;
const diagnosticReporter = (event, fields) => {
  if (diagnosticsEnabled) DIAGNOSTIC_LOG.write(event, fields);
};
const ACCOUNT_STORE = new AccountStore({ configDir: CONFIG_DIR });
const USAGE_STORE = new UsageStore({ configDir: CONFIG_DIR });
const ACCOUNT_POOL = new AccountPool({
  store: ACCOUNT_STORE,
  usageStore: USAGE_STORE,
  agyPath: AGY_PATH,
  diagnosticReporter
});
const QUOTA_MANAGER = new QuotaManager({ configDir: CONFIG_DIR, accountPool: ACCOUNT_POOL });
ACCOUNT_POOL.quotaManager = QUOTA_MANAGER;
const OAUTH_FLOW = new OAuthFlow({ agyPath: AGY_PATH });
const DASHBOARD_ACCOUNT_AUTH = new DashboardAccountAuth({
  flow: OAUTH_FLOW, store: ACCOUNT_STORE, pool: ACCOUNT_POOL, quotaManager: QUOTA_MANAGER,
  onAdded: () => { modelCache.at = 0; upstreamModelCache.at = 0; }
});
const MEDIA_STORE = new MediaStore({ directory: path.join(CONFIG_DIR, 'media'), ...localMediaOptions({ configDir: CONFIG_DIR }) });
const SESSION_MANAGER = new SessionManager();
// Only search results/history need this persistent key. Reading configuration,
// displaying models or handling ordinary inference must not create it.
let serverSearchReceipts;
function searchReceipts() {
  return serverSearchReceipts ||= new ServerSearchReceipts({ directory: path.join(CONFIG_DIR, 'state', 'server-search') });
}
const SEARCH_RECEIPTS = {
  issueResult: value => searchReceipts().issueResult(value),
  restoreResult: value => searchReceipts().restoreResult(value)
};
let TERMINAL = null;
let diagnosticHeartbeat = null;

function gatewayLog(message) { return TERMINAL ? TERMINAL.log(message) : console.log(message); }
function gatewayWarn(message) { return TERMINAL ? TERMINAL.log(message, 'warn') : console.warn(message); }
function gatewayError(message) { return TERMINAL ? TERMINAL.log(message, 'error') : console.error(message); }

function startDiagnosticHeartbeat() {
  if (diagnosticHeartbeat) return;
  let previous = Date.now();
  diagnosticHeartbeat = setInterval(() => {
    const now = Date.now();
    const gapMs = now - previous;
    if (gapMs > 90_000) diagnosticReporter('runtime_gap_detected', {
      gapMs,
      previousAt: new Date(previous).toISOString(),
      resumedAt: new Date(now).toISOString(),
      likelySleepOrSuspend: true
    });
    previous = now;
  }, 30_000);
  diagnosticHeartbeat.unref?.();
}

function stopDiagnosticHeartbeat() {
  if (diagnosticHeartbeat) clearInterval(diagnosticHeartbeat);
  diagnosticHeartbeat = null;
}

const DASHBOARD_ACCESS = createDashboardAccessPolicy(
  process.env.ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW,
  { warn: (message) => gatewayWarn(`[Antigravity Gateway Warning] ${message}`) }
);

let modelCache = { at: 0, models: [], error: null };
let upstreamModelCache = { at: 0, models: [] };

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

function dashboardUrl() {
  const host = isLoopbackHost(HOST) ? (HOST === '::1' ? '[::1]' : HOST) : '127.0.0.1';
  return `http://${host}:${PORT}/dashboard`;
}

function requestBaseUrl(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' ? 'https' : req.socket?.encrypted ? 'https' : 'http';
  return `${protocol}://${req.headers.host || `${HOST}:${PORT}`}`;
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

function directAuthDescription() {
  return `gateway account pool（${ACCOUNT_POOL.status().length} 个账号；仅看板 OAuth 添加）`;
}

async function availableModels(force = false) {
  if (force) upstreamModelCache.at = 0;
  if (!force && Date.now() - modelCache.at < MODEL_CACHE_MS && modelCache.models.length) return modelCache.models;
  try {
    const models = ACCOUNT_POOL.hasManagedAccounts() ? await ACCOUNT_POOL.listModels(undefined, { force }) : [];
    modelCache = { at: Date.now(), models, error: null };
  } catch (error) {
    modelCache = { at: Date.now(), models: modelCache.models, error };
    if (!modelCache.models.length) throw error;
  }
  return modelCache.models;
}

async function availableApiModels() {
  if (Date.now() - upstreamModelCache.at < MODEL_CACHE_MS && upstreamModelCache.models.length) {
    return upstreamModelCache.models;
  }
  const models = ACCOUNT_POOL.hasManagedAccounts() ? await ACCOUNT_POOL.listModels(undefined, { force: true }) : [];
  upstreamModelCache = { at: Date.now(), models };
  return models;
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
  // Claude Code's built-in Auto Mode classifier selects Sonnet 5 separately
  // from the user's main model. Route that classifier to the supported fast
  // model without requiring a client override. Ordinary Sonnet requests and
  // other explicitly selected classifier models retain their own contracts.
  if (preferFast && requested === 'claude-sonnet-5') return 'gemini-3.8-flash-low';
  const aliases = configuredAliases();
  const original = requested || DEFAULT_MODEL;
  const mapped = Object.prototype.hasOwnProperty.call(aliases, original) ? aliases[original] : original;
  // Normal requests preserve the exact client model ID; aliases are opt-in.
  if (requested || !preferFast) {
    return mapped;
  }
  try {
    return preferredFastModel(await availableApiModels());
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
    models = await availableApiModels();
  } catch {
    return error;
  }
  if (models.includes(model)) return error;

  error.message += `\n\n网关诊断：\n请求模型 ${model} 未出现在当前发现的 Antigravity 模型目录中，可能是客户端模型配置错误、模型尚未向当前账号开放，或模型目录暂未刷新。\n请输入 /model 更换可用模型。`;
  return error;
}

function codexModelInfo(slug, priority) {
  const upstream = ACCOUNT_POOL.modelInfo(slug);
  const mimeTypes = upstream?.supportedMimeTypes && typeof upstream.supportedMimeTypes === 'object'
    && !Array.isArray(upstream.supportedMimeTypes) ? structuredClone(upstream.supportedMimeTypes) : {};
  const mediaCapability = (field, prefix) => typeof upstream?.[field] === 'boolean' ? upstream[field]
    : Object.entries(mimeTypes).some(([type, supported]) => supported === true && type.toLowerCase().startsWith(prefix + '/'));
  const supportsImages = mediaCapability('supportsImages', 'image');
  const supportsVideo = mediaCapability('supportsVideo', 'video');
  const supportsAudio = mediaCapability('supportsAudio', 'audio');
  const thinking = resolveModelConfiguration(slug, upstream).thinkingConfig;
  const effort = thinking?.thinkingLevel?.toLowerCase() || null;
  // Google Antigravity API currently reports 1,048,576 input tokens for Gemini 3.7/3.8
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
    // Codex accepts text/image here; broader media capabilities are separate.
    input_modalities: supportsImages ? ['text', 'image'] : ['text'],
    supports_images: supportsImages,
    supports_video: supportsVideo,
    supports_audio: supportsAudio,
    supported_mime_types: mimeTypes,
    supports_image_detail_original: supportsImages && upstream?.supportsImageDetailOriginal === true,
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
    default_reasoning_level: effort,
    supported_reasoning_levels: effort ? [{ effort, description: `Fixed by model name: ${slug}` }] : [],
    ...(thinking ? { fixed_thinking_config: structuredClone(thinking) } : {}),
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
  const catalog = ordered.map((id, index) => codexModelInfo(id, index));
  return {
    object: 'list',
    data: catalog.map((model) => ({ id: model.slug, object: 'model', created: 0, owned_by: 'antigravity',
      display_name: model.display_name, input_modalities: model.input_modalities,
      supports_images: model.supports_images, supports_video: model.supports_video, supports_audio: model.supports_audio,
      supported_mime_types: structuredClone(model.supported_mime_types),
      default_reasoning_level: model.default_reasoning_level, supported_reasoning_levels: model.supported_reasoning_levels,
      ...(model.fixed_thinking_config ? { fixed_thinking_config: structuredClone(model.fixed_thinking_config) } : {}) })),
    models: catalog
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
    // Google Antigravity does not provide Anthropic's server-side safeguards.
    // Keep Claude's own classifier active; its default model is routed below.
    env: { CLAUDE_CODE_AUTO_MODE_SERVER: '0' },
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

async function refreshClientModelCatalogs() {
  const models = await availableModels(true);
  try { writeCodexCatalog(models); }
  catch (error) { gatewayWarn(`[Antigravity Gateway] Codex 模型目录写入失败：${error.message}`); }
  try { writeClaudeConfig(models); }
  catch (error) { gatewayWarn(`[Antigravity Gateway] Claude Code 模型配置写入失败：${error.message}`); }
  return models;
}

function featuredModels(models) {
  return displayModels(models).filter((model) => (
    /^gemini-3\.[78](?:[.-]|$)/i.test(model)
    || model === 'claude-opus-4-6-thinking'
    || model === 'claude-sonnet-4-6'
  ));
}

function credentialSourceDescription() {
  return `${ACCOUNT_STORE.directory}（${ACCOUNT_POOL.status().length} 个账号）`;
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
    ` 上游协议: Google Antigravity API（agy ${AGY_CLI_VERSION}）`,
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
  --agy-path <path>       OAuth 客户端配置所用的 agy 安装路径
  -m, --model <id>        默认 Antigravity 模型
  --models                 显示当前账号的全部真实模型 ID
  --codex-catalog-path    显示自动生成的 Codex 模型目录绝对路径
  --claude-config-path    显示自动生成的 Claude Code 模型配置路径
  --claude-config         输出 Claude Code 模型与 Auto 兼容配置 JSON
  stats                   在默认浏览器打开本地 Token 用量看板

后台保活:
  service start           自动注册开机/登录自启并立即后台启动；重复执行会更新并重启
  service status          显示配置与运行状态
  service restart         重启已配置的后台服务
  service stop            停止后台服务但保留自启配置
  service logs            显示最近的后台日志
  service uninstall       停止并移除后台服务（保留历史日志）

账号与上游:
  仅使用 Google Antigravity API（agy ${AGY_CLI_VERSION}）及原 accounts 账号池。
  新增账号请运行 antigravity-gateway stats，在看板中完成 OAuth 授权。

接口:
  GET  /
  GET  /dashboard
  GET  /dashboard/data
  GET  /v1/models
  POST /v1/files
  GET  /v1/files/:id/content
  POST /v1/images/generations
  POST /v1/images/edits
  POST /v1/messages
  POST /v1/messages/count_tokens
  POST /v1/responses`);
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
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, session-id, session_id, x-session-affinity, x-claude-session-id, x-claude-code-session-id, x-codex-session-id, x-deepseek-harness-session-id, x-deepseek-harness-user-id, x-deepseek-harness-compact, x-client-session-id, conversation-id, x-conversation-id, x-thread-id, x-client-id, x-agent-id, x-client-name, parent-session-id, x-parent-session-id, x-affinity-id, x-routing-affinity-id, x-request-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
  return true;
}

function clientScope(req) {
  return credentialScope(req);
}

function clientSessionScope(req, payload = {}, normalized = {}, previous = null) {
  return SESSION_MANAGER.resolve(req, payload, normalized, previous);
}

function clientSessionIdentity(req, payload = {}, normalized = {}, previous = null, options) {
  return SESSION_MANAGER.resolveIdentity(req, payload, normalized, previous, options);
}

function identityTrace(identity = {}) {
  const short = (value) => String(value || '-').slice(0, 10);
  return `request=${short(identity.requestId)} client=${identity.clientLabel || short(identity.clientId)} session=${short(identity.sessionId)} affinity=${short(identity.routingKey)}`;
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

async function readBuffer(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > REQUEST_LIMIT) throw new GatewayError('请求体过大。', { code: 'request_too_large', status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buffer = await readBuffer(req);
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8') || '{}');
  } catch {
    throw new GatewayError('请求体不是有效 JSON。', { code: 'invalid_json', status: 400 });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError('请求体必须是 JSON 对象。', { code: 'invalid_request_body', status: 400 });
  }
  return value;
}

function parseMultipart(buffer, contentType) {
  const boundaryValue = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryValue?.[1] || boundaryValue?.[2];
  if (!boundary) throw new GatewayError('multipart/form-data 缺少 boundary。', { code: 'invalid_multipart', status: 400 });
  const marker = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = 0;
  while (true) {
    const start = buffer.indexOf(marker, cursor);
    if (start < 0) break;
    const next = buffer.indexOf(marker, start + marker.length);
    if (next < 0) break;
    let part = buffer.subarray(start + marker.length, next);
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(-2).toString() === '\r\n') part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const body = part.subarray(headerEnd + 4);
      const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
      const name = disposition.match(/name="([^"]+)"/i)?.[1] || '';
      const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
      const mediaType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
      if (name && filename !== undefined) files.push({ name, filename, mediaType: normalizeMime(mediaType, filename), buffer: body });
      else if (name) fields[name] = body.toString('utf8');
    }
    cursor = next;
  }
  return { fields, files };
}

function errorBody(error, protocol) {
  const message = error.message || 'Gateway error';
  const code = error.code || 'gateway_error';
  if (protocol === 'anthropic') return { type: 'error', error: { type: code, message } };
  return { error: { message, type: code, code } };
}

function mapAgyError(error) {
  if (error instanceof GatewayError || error instanceof DirectProviderError
    || error instanceof MultimediaError || isConversionError(error)) return error;
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
  SESSION_MANAGER.cleanup();
}
setInterval(cleanupResponseStore, 60_000).unref();

function combinedUsage(...values) {
  return values.reduce((total, value) => ({
    input_tokens: total.input_tokens + (Number(value?.input_tokens) || 0),
    output_tokens: total.output_tokens + (Number(value?.output_tokens) || 0),
    total_tokens: total.total_tokens + (Number(value?.total_tokens) || 0),
    thinking_tokens: total.thinking_tokens + (Number(value?.thinking_tokens) || 0),
    cache_read_tokens: total.cache_read_tokens + (Number(value?.cache_read_tokens) || 0)
  }), { input_tokens: 0, output_tokens: 0, total_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 });
}

function imageReferences(normalized, requested = []) {
  const images = mediaParts(normalized, (part) => String(part.mediaType || '').startsWith('image/'));
  if (!Array.isArray(requested) || !requested.length) return [];
  const wanted = new Set(requested.map(String));
  return images.filter((part) => wanted.has(String(part.id)) || wanted.has(String(part.fileId)) || wanted.has(String(part.filename))
    || imageReferencePaths(part).some(file => wanted.has(file))).slice(0, 3);
}

function artifactUrl(base, id) {
  return base ? `${String(base).replace(/\/$/, '')}/v1/files/${encodeURIComponent(id)}/content` : '';
}

async function runTurn(normalized, model, signal, { sessionId, routingKey, requestId, clientId, clientLabel, auxiliaryScope, nativeCompaction, nativeClientProfile, onDelta, onThinkingDelta, reuseConversation = false, mediaScope = '', publicBaseUrl = '' } = {}) {
  const release = await requestSlots.acquire(signal);
  const taskScope = auxiliaryScope ? { auxiliaryScope } : {};
  try {
    const resolved = await MEDIA_STORE.resolveNormalized(normalized, { scope: mediaScope, signal });
    const prepared = prepareNativeMultimodal(resolved);
    const finalize = raw => finalizeModelResultAsync(normalized, raw, { signal });
    const upstreamModel = model;
    const trace = identityTrace({ sessionId, routingKey, requestId, clientId, clientLabel });
    const onAccountSelected = ({ accountId, email, source, attempt }) => {
      gatewayLog(`[Antigravity Gateway] 路由账号=${email || accountId} source=${source} model=${upstreamModel} attempt=${attempt} ${trace}`);
    };
    let raw = await ACCOUNT_POOL.send(prepared.normalized, upstreamModel, {
      signal, sessionId, routingKey, requestId, clientId, clientLabel, onDelta, onAccountSelected, reuseConversation, ...taskScope,
      ...(nativeCompaction ? { nativeCompaction } : {}),
      ...(nativeClientProfile ? { nativeClientProfile } : {}),
      onThinkingDelta: normalized.includeThinking ? onThinkingDelta : undefined
    });
    const initialUsage = raw.usage;
    const internalCalls = prepared.imageToolInjected
      ? (raw.toolCalls || []).filter((call) => call.name === NATIVE_IMAGE_TOOL_NAME)
      : [];
    if (internalCalls.length) {
      if (upstreamTermination(raw) !== 'complete') {
        throw new GatewayError('上游生图工具调用未正常完成，已停止内部生图执行。', { code: 'incomplete_native_image_call', status: 502 });
      }
      if (internalCalls.length > 1 || (raw.toolCalls || []).some((call) => call.name !== NATIVE_IMAGE_TOOL_NAME)) {
        throw new GatewayError('原生生图工具必须单独调用且每轮只能调用一次。', { code: 'invalid_native_image_call', status: 502 });
      }
      const call = internalCalls[0];
      const args = call.arguments || {};
      const references = imageReferences(resolved, args.ImagePaths);
      if (process.env.ANTIGRAVITY_GATEWAY_DEBUG === '1') {
        gatewayLog(`[Antigravity Gateway Debug] native-image-call=${JSON.stringify({
          prompt: String(args.Prompt || '').slice(0, 120),
          requestedReferences: args.ImagePaths || [],
          availableReferences: mediaParts(resolved, (part) => String(part.mediaType || '').startsWith('image/')).map((part) => ({ id: part.id, fileId: part.fileId, filename: part.filename }))
        })}`);
      }
      if ((args.ImagePaths || []).length !== references.length) {
        throw new GatewayError('生图工具引用了不存在或非图片类型的附件。', { code: 'invalid_image_reference', status: 400 });
      }
      const imageStartedAt = Date.now();
      const generated = await ACCOUNT_POOL.generateImage({
        prompt: args.Prompt,
        aspectRatio: args.AspectRatio || '1:1',
        images: references
      }, {
        signal,
        sessionId,
        routingKey,
        bindRouting: false,
        accountId: raw.accountId,
        nativeToolContext: raw.nativeToolContext,
        onAccountSelected: ({ accountId, email, source, model: imageModel, attempt }) => {
          gatewayLog(`[Antigravity Gateway] 生图账号=${email || accountId} source=${source} model=${imageModel} attempt=${attempt} ${trace}`);
        }
      });
      const saved = MEDIA_STORE.saveGeneratedImage(Buffer.from(generated.data, 'base64'), {
        mediaType: generated.mimeType,
        filename: `${String(args.ImageName || 'generated_image').replace(/[^a-z0-9_-]+/gi, '_')}.${imageFileExtension(generated.mimeType)}`,
        purpose: 'generated',
        scope: mediaScope
      });
      const image = {
        id: saved.id,
        mimeType: generated.mimeType,
        data: generated.data,
        filename: saved.filename,
        bytes: saved.bytes,
        gatewayLocalPath: MEDIA_STORE.contentPath(saved.id),
        url: artifactUrl(publicBaseUrl, saved.id),
        prompt: args.Prompt,
        name: args.ImageName || 'generated_image'
      };
      const internalResult = internalImageToolResult(image);
      const continuation = {
        ...prepared.normalized,
        stream: false,
        // Keep the caller's tools available for legitimate follow-up work;
        // only the gateway's private image tool is removed after generation.
        tools: resolved.tools,
        toolChoice: resolved.toolChoice,
        messages: [
          ...prepared.normalized.messages,
          { role: 'assistant', text: raw.text || '', parts: [
            ...(raw.text ? [{ type: 'text', text: raw.text }] : []),
            { type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments, thoughtSignature: call.thoughtSignature }
          ] },
          { role: 'user', text: '', parts: [{
            type: 'tool_result', id: call.id, name: call.name,
            content: JSON.stringify(internalResult),
            // Local structured metadata remains available to the API/client
            // layer; only the native text projection goes to Google Antigravity API.
            response: nativeImageToolResponse(image, { createdAt: imageStartedAt }),
            media: [{ type: 'media', id: saved.id, mediaType: generated.mimeType, data: generated.data, filename: saved.filename }]
          }] }
        ]
      };
      raw = await ACCOUNT_POOL.send(continuation, upstreamModel, {
        signal, sessionId, routingKey, requestId, clientId, clientLabel, onAccountSelected, reuseConversation, ...taskScope,
        clientProjection: { source: prepared.normalized, images: [image], streamedPrefix: onDelta ? raw.streamedText || raw.text || '' : '' }
      });
      const final = await finalize(raw);
      return { ...final, images: [image], usage: combinedUsage(initialUsage, generated.usage, raw.usage) };
    }
    try {
      return await finalize(raw);
    } catch (error) {
      if (error.code === 'invalid_auto_mode_classifier_output') {
        raw = await ACCOUNT_POOL.send(prepared.normalized, upstreamModel, { signal, sessionId, routingKey, requestId, clientId, clientLabel, onAccountSelected, reuseConversation, ...taskScope, repairInstruction: 'Return only the XML verdict required by the client contract. No prose or Markdown.' });
        return await finalize(raw);
      }
      if (error.code === 'invalid_structured_output') {
        raw = await ACCOUNT_POOL.send(prepared.normalized, upstreamModel, { signal, sessionId, routingKey, requestId, clientId, clientLabel, onAccountSelected, reuseConversation, ...taskScope, repairInstruction: `Return only one valid JSON value conforming to this schema: ${JSON.stringify(normalized.structuredSchema)}` });
        return await finalize(raw);
      }
      throw error;
    }
  } finally {
    release();
  }
}

const activeTransactions = new Set();

function trackTransaction(promise) {
  const cleanup = () => { activeTransactions.delete(promise); };
  activeTransactions.add(promise);
  promise.then(cleanup, cleanup);
  return promise;
}

async function drainTransactions(timeoutMs = Infinity) {
  const until = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Infinity;
  while (activeTransactions.size) {
    const pending = Promise.allSettled([...activeTransactions]);
    if (until === Infinity) await pending;
    else {
      const left = until - Date.now();
      if (left <= 0) return false;
      let timer;
      try { await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, left); })]); }
      finally { clearTimeout(timer); }
    }
  }
  return true;
}


async function runTurnWithModelDiagnostic(normalized, model, signal, options) {
  const transaction = (async () => {
    try {
      return await runTurn(normalized, model, signal, options);
    } catch (error) {
      throw await upstreamModelDiagnostic(error, model);
    }
  })();
  return await trackTransaction(transaction);
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
  let blockCount = 0;
  let activeBlock = null;
  let emittedText = '';
  let emittedThinking = '';
  const start = () => {
    if (started) return;
    started = true;
    sendSse(res, 'message_start', { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    } });
  };
  const closeBlock = () => {
    if (activeBlock) sendSse(res, 'content_block_stop', { type: 'content_block_stop', index: activeBlock.index });
    activeBlock = null;
  };
  const emitBlock = (kind, text) => {
    text = String(text || '');
    if (!text) return;
    start();
    if (activeBlock?.kind !== kind) {
      closeBlock();
      activeBlock = { index: blockCount++, kind };
      sendSse(res, 'content_block_start', { type: 'content_block_start', index: activeBlock.index,
        content_block: kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } });
    }
    if (kind === 'thinking') emittedThinking += text;
    else emittedText += text;
    sendSse(res, 'content_block_delta', { type: 'content_block_delta', index: activeBlock.index,
      delta: kind === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text } });
  };
  return {
    onDelta: (text) => emitBlock('text', text),
    onThinkingDelta: (text) => emitBlock('thinking', text),
    finish: (body) => {
      start();
      const finalThinking = (body.content || []).filter(block => block.type === 'thinking').map(block => block.thinking || '').join('');
      emitBlock('thinking', streamTextRemainder(emittedThinking, finalThinking));
      const finalText = (body.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('');
      emitBlock('text', streamTextRemainder(emittedText, finalText));
      closeBlock();
      // message_start went out before upstream usage existed; message_delta usage is cumulative per the Messages API.
      sendSse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: body.stop_reason, stop_sequence: null },
        usage: body.usage,
        ...(body.usage_known === false ? { usage_known: false } : {}),
        ...(body.artifacts ? { artifacts: body.artifacts } : {})
      });
      sendSse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    }
  };
}

function sendChatChunk(res, base, choices, { includeUsage = false, usage = null, usageKnown } = {}) {
  res.write(`data: ${JSON.stringify({ id: base.id, object: 'chat.completion.chunk', created: base.created,
    model: base.model, choices, ...(includeUsage ? { usage } : {}),
    ...(usageKnown === false ? { usage_known: false } : {}) })}\n\n`);
}

function createChatTextEmitter(res, model, { includeUsage = false } = {}) {
  const id = `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  let started = false;
  let emittedText = '';
  let emittedThinking = '';
  const base = { id, created, model };
  const chunk = (delta, finish_reason = null, extra = {}) => sendChatChunk(res, base,
    [{ index: 0, delta, finish_reason }], { includeUsage, ...extra });
  const start = () => {
    if (started) return;
    started = true;
    chunk({ role: 'assistant' });
  };
  return {
    onThinkingDelta: (text) => {
      text = String(text || '');
      if (!text) return;
      start();
      emittedThinking += text;
      chunk({ reasoning_content: text });
    },
    onDelta: (text) => {
      text = String(text || '');
      if (!text) return;
      start();
      emittedText += text;
      chunk({ content: text });
    },
    finish: (body) => {
      start();
      const thinking = body.choices?.[0]?.message?.reasoning_content || '';
      const thinkingRemainder = streamTextRemainder(emittedThinking, thinking);
      if (thinkingRemainder) chunk({ reasoning_content: thinkingRemainder });
      const finalText = body.choices?.[0]?.message?.content || '';
      const remainder = streamTextRemainder(emittedText, finalText);
      if (remainder) {
        chunk({ content: remainder });
      }
      const finalMessage = body.choices?.[0]?.message || {};
      if (finalMessage.images || finalMessage.artifacts) {
        const delta = {};
        if (finalMessage.images) delta.images = finalMessage.images;
        if (finalMessage.artifacts) delta.artifacts = finalMessage.artifacts;
        chunk(delta);
      }
      const finishReason = body.choices?.[0]?.finish_reason || 'stop';
      chunk({}, finishReason, { usageKnown: body.usage_known });
      if (includeUsage) sendChatChunk(res, base, [], { includeUsage: true, usage: body.usage ?? null, usageKnown: body.usage_known });
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
        : ['tool_use', 'server_tool_use'].includes(block.type) ? { ...block, input: {} } : block;
    sendSse(res, 'content_block_start', { type: 'content_block_start', index, content_block: empty });
    if (block.type === 'text') {
      sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      if (block.thinking) sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      if (block.signature) sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (['tool_use', 'server_tool_use'].includes(block.type)) {
      sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    sendSse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sendSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: body.stop_reason, stop_sequence: null },
    usage: body.usage,
    ...(body.usage_known === false ? { usage_known: false } : {}),
    ...(body.artifacts ? { artifacts: body.artifacts } : {})
  });
  sendSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function emitChatStream(res, body, { includeUsage = false } = {}) {
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const choice = body.choices[0];
  const first = { role: 'assistant' };
  if (choice.message.content) first.content = choice.message.content;
  if (choice.message.reasoning_content) first.reasoning_content = choice.message.reasoning_content;
  if (choice.message.tool_calls) first.tool_calls = choice.message.tool_calls.map((call, index) => ({ index, ...call }));
  if (choice.message.images) first.images = choice.message.images;
  if (choice.message.artifacts) first.artifacts = choice.message.artifacts;
  sendChatChunk(res, body, [{ index: 0, delta: first, finish_reason: null }], { includeUsage });
  sendChatChunk(res, body, [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], { includeUsage, usageKnown: body.usage_known });
  if (includeUsage) sendChatChunk(res, body, [], { includeUsage: true, usage: body.usage ?? null, usageKnown: body.usage_known });
  res.write('data: [DONE]\n\n');
  res.end();
}

function emitResponsesItem(emit, item, outputIndex) {
  emit({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: item.content ? [] : undefined,
    ...(item.type === 'function_call' ? { arguments: '' } : {}),
    ...(item.type === 'custom_tool_call' ? { input: '' } : {}),
    ...(item.type === 'reasoning' ? { summary: [] } : {}) } });
  if (item.type === 'message') {
    const part = item.content[0];
    emit({ type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text });
    emit({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text });
    emit({ type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: 0, part });
  } else if (item.type === 'reasoning') {
    (item.summary || []).forEach((part, summaryIndex) => {
      const ids = { item_id: item.id, output_index: outputIndex, summary_index: summaryIndex };
      emit({ type: 'response.reasoning_summary_part.added', ...ids, part: { type: 'summary_text', text: '' } });
      emit({ type: 'response.reasoning_summary_text.delta', ...ids, delta: part.text });
      emit({ type: 'response.reasoning_summary_text.done', ...ids, text: part.text });
      emit({ type: 'response.reasoning_summary_part.done', ...ids, part });
    });
  } else if (item.type === 'function_call') {
    emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: item.arguments });
    emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: item.arguments });
  } else if (item.type === 'custom_tool_call') {
    emit({ type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: outputIndex, delta: item.input });
    emit({ type: 'response.custom_tool_call_input.done', item_id: item.id, output_index: outputIndex, input: item.input });
  }
  emit({ type: 'response.output_item.done', output_index: outputIndex, item });
}

const responsesStreamErrors = new WeakMap();
function sendResponsesStreamError(res, error) {
  const event = { type: 'error', code: error.code || 'server_error', message: error.message, param: null };
  const emit = responsesStreamErrors.get(res);
  if (emit) emit(event);
  else sendSse(res, null, { ...event, sequence_number: 0 });
  res.end();
}

function createResponsesTextEmitter(res, model, responseId) {
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let started = false;
  const states = new Map();
  const emit = (event) => sendSse(res, null, { ...event, sequence_number: sequence++ });
  responsesStreamErrors.set(res, emit);
  const start = () => {
    if (started) return;
    started = true;
    emit({ type: 'response.created', response: {
      id: responseId, object: 'response', created_at: createdAt, model,
      status: 'in_progress', output: [], error: null, incomplete_details: null, usage: null
    } });
  };
  const emitDelta = (kind, value) => {
    const text = String(value || '');
    if (!text) return;
    start();
    let state = states.get(kind);
    if (!state) {
      state = { id: `${kind === 'reasoning' ? 'rs' : 'msg'}_${crypto.randomUUID().replaceAll('-', '')}`, index: states.size, text: '' };
      states.set(kind, state);
      const item = kind === 'reasoning'
        ? { id: state.id, type: 'reasoning', status: 'in_progress', summary: [] }
        : { id: state.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      emit({ type: 'response.output_item.added', output_index: state.index, item });
      if (kind === 'reasoning') emit({ type: 'response.reasoning_summary_part.added', item_id: state.id,
        output_index: state.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      else emit({ type: 'response.content_part.added', item_id: state.id, output_index: state.index,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    }
    state.text += text;
    emit({ type: kind === 'reasoning' ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta',
      item_id: state.id, output_index: state.index, ...(kind === 'reasoning' ? { summary_index: 0 } : { content_index: 0 }), delta: text });
  };
  return { onDelta: value => emitDelta('message', value), onThinkingDelta: value => emitDelta('reasoning', value), finish(body) {
    start();
    body.id = responseId;
    body.created_at = createdAt;
    const message = body.output.find((item) => item.type === 'message');
    const reasoning = body.output.find((item) => item.type === 'reasoning');
    emitDelta('reasoning', streamTextRemainder(states.get('reasoning')?.text || '',
      (reasoning?.summary || []).map(part => part.text || '').join('')));
    emitDelta('message', streamTextRemainder(states.get('message')?.text || '', message?.content?.[0]?.text || ''));
    const completed = [];
    for (const [kind, state] of states) {
      const part = kind === 'reasoning' ? { type: 'summary_text', text: state.text }
        : { type: 'output_text', text: state.text, annotations: message?.content?.[0]?.annotations || [] };
      const item = kind === 'reasoning'
        ? { id: state.id, type: 'reasoning', status: reasoning?.status || body.status, summary: [part] }
        : { id: state.id, type: 'message', role: 'assistant', status: message?.status || body.status, content: [part] };
      const ids = { item_id: state.id, output_index: state.index,
        ...(kind === 'reasoning' ? { summary_index: 0 } : { content_index: 0 }) };
      emit({ type: kind === 'reasoning' ? 'response.reasoning_summary_text.done' : 'response.output_text.done', ...ids, text: state.text });
      emit({ type: kind === 'reasoning' ? 'response.reasoning_summary_part.done' : 'response.content_part.done', ...ids, part });
      emit({ type: 'response.output_item.done', output_index: state.index, item });
      completed.push(item);
    }
    const remaining = body.output.filter(item => !(item === message && states.has('message'))
      && !(item === reasoning && states.has('reasoning')));
    body.output = [...completed, ...remaining];
    remaining.forEach((item, index) => emitResponsesItem(emit, item, completed.length + index));
    emit({ type: `response.${body.status}`, response: body });
    res.write('data: [DONE]\n\n');
    res.end();
  } };
}

function emitResponsesStream(res, body) {
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let sequence = 0;
  sendSse(res, null, { type: 'response.created', sequence_number: sequence++, response: { ...body, status: 'in_progress', output: [] } });
  body.output.forEach((item, index) => emitResponsesItem((event) => sendSse(res, null, { ...event, sequence_number: sequence++ }), item, index));
  sendSse(res, null, { type: `response.${body.status}`, sequence_number: sequence++, response: body });
  res.write('data: [DONE]\n\n');
  res.end();
}

function aspectRatioFromSize(size, fallback = '1:1') {
  const match = String(size || '').match(/^(\d+)x(\d+)$/i);
  if (!match) return fallback;
  const ratio = Number(match[1]) / Number(match[2]);
  const supported = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['9:16', 9 / 16], ['16:9', 16 / 9]];
  return supported.sort((left, right) => Math.abs(left[1] - ratio) - Math.abs(right[1] - ratio))[0][0];
}

async function generateImages(payload, req, signal, references = []) {
  const count = Math.max(1, Math.min(4, Number(payload.n) || 1));
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new GatewayError('生图请求缺少 prompt。', { code: 'image_prompt_missing', status: 400 });
  const requestedModel = payload.model ? await resolveModel(payload.model) : '';
  const imageModel = await ACCOUNT_POOL.resolveImageModel(requestedModel, signal);
  const scope = clientScope(req);
  const identity = clientSessionIdentity(req, payload, { model: payload.model, messages: [{ role: 'user', text: prompt, parts: references }] });
  const trace = identityTrace(identity);
  const images = [];
  let accountId = '';
  for (let index = 0; index < count; index += 1) {
    const result = await ACCOUNT_POOL.generateImage({
      prompt,
      model: imageModel,
      aspectRatio: payload.aspect_ratio || aspectRatioFromSize(payload.size),
      images: references
    }, {
      signal, sessionId: identity.sessionId, routingKey: identity.routingKey, accountId,
      onAccountSelected: ({ accountId: selected, email, source, model: selectedModel, attempt }) => {
        gatewayLog(`[Antigravity Gateway] 生图账号=${email || selected} source=${source} model=${selectedModel} attempt=${attempt} ${trace}`);
      }
    });
    accountId = result.accountId;
    const saved = MEDIA_STORE.saveGeneratedImage(Buffer.from(result.data, 'base64'), {
      mediaType: result.mimeType,
      filename: `generated_${Date.now()}_${index + 1}.${imageFileExtension(result.mimeType)}`, purpose: 'generated', scope
    });
    images.push({
      id: saved.id,
      mimeType: result.mimeType,
      data: result.data,
      filename: saved.filename,
      bytes: saved.bytes,
      gatewayLocalPath: MEDIA_STORE.contentPath(saved.id),
      url: artifactUrl(requestBaseUrl(req), saved.id)
    });
  }
  return images;
}

function imagesResponse(images, payload) {
  const format = payload.response_format || 'url';
  return {
    created: Math.floor(Date.now() / 1000),
    data: images.map((image) => ({
      ...(format === 'b64_json' ? { b64_json: image.data } : { url: image.url }),
      revised_prompt: payload.prompt,
      artifact: imageArtifact(image)
    })),
    artifacts: imageArtifacts(images)
  };
}

async function handleImageGeneration(payload, req, res, signal) {
  USAGE_STORE.recordClientRequest();
  const images = await generateImages(payload, req, signal);
  sendJson(res, 200, imagesResponse(images, payload));
}

async function handleImageEdit(req, res, signal) {
  USAGE_STORE.recordClientRequest();
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new GatewayError('图片编辑接口需要 multipart/form-data。', { code: 'invalid_multipart', status: 400 });
  }
  const { fields, files } = parseMultipart(await readBuffer(req), contentType);
  const sourceFiles = files.filter((file) => ['image', 'images[]', 'reference_image'].includes(file.name));
  if (!sourceFiles.length) throw new GatewayError('图片编辑请求缺少 image 文件。', { code: 'image_reference_missing', status: 400 });
  if (sourceFiles.length > 3) throw new GatewayError('参考图最多 3 张。', { code: 'too_many_reference_images', status: 400 });
  const references = sourceFiles.map((file, index) => ({
    type: 'media', id: `upload_${index + 1}`, mediaType: file.mediaType, data: file.buffer.toString('base64'), bytes: file.buffer.length, filename: file.filename
  }));
  const payload = { ...fields, n: Number(fields.n) || 1 };
  const images = await generateImages(payload, req, signal, references);
  sendJson(res, 200, imagesResponse(images, payload));
}

async function handleFileUpload(req, res) {
  const contentType = String(req.headers['content-type'] || '');
  const scope = clientScope(req);
  let buffer;
  let filename = '';
  let mediaType = '';
  let purpose = 'assistants';
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const parsed = parseMultipart(await readBuffer(req), contentType);
    const file = parsed.files.find((item) => item.name === 'file') || parsed.files[0];
    if (!file) throw new GatewayError('文件上传请求缺少 file。', { code: 'file_missing', status: 400 });
    ({ buffer, filename, mediaType } = file);
    purpose = parsed.fields.purpose || purpose;
  } else {
    const payload = await readJson(req);
    filename = payload.filename || '';
    mediaType = payload.media_type || payload.mime_type || '';
    purpose = payload.purpose || purpose;
    const encoded = payload.data || payload.file_data || '';
    const match = String(encoded).match(/^data:([^;,]+)?;base64,(.+)$/s);
    buffer = Buffer.from(match ? match[2] : encoded, 'base64');
    if (match?.[1]) mediaType = match[1];
  }
  const saved = MEDIA_STORE.save(buffer, { filename, mediaType, purpose, scope });
  sendJson(res, 200, saved);
}

async function handleServerSearchForward(prepared, payload, req, res, signal) {
  const { normalized, query, contents, instructions, generationConfig, tool } = prepared;
  const scope = clientScope(req);
  const identity = clientSessionIdentity(req, payload, normalized, null);
  let body;
  if (prepared.blockedByBudget) {
    body = buildServerSearchErrorMessage({ model: normalized.model || DEFAULT_MODEL, query, tool, errorCode: 'max_uses_exceeded' });
  } else {
    const release = await requestSlots.acquire(signal);
    let stopHeartbeat;
    try {
      const result = await ACCOUNT_POOL.searchWeb({ query, contents, instructions, generationConfig }, {
        ...identity, signal, bindRouting: false,
        onAccountSelected: ({ accountId, email, source, model, attempt }) => {
          gatewayLog(`[Antigravity Gateway] 搜索账号=${email || accountId} source=${source} model=${model} attempt=${attempt} ${identityTrace(identity)}`);
          if (!res.headersSent) res.setHeader('x-antigravity-model', model);
          if (normalized.stream) stopHeartbeat = beginSse(res);
        }
      });
      body = buildServerSearchMessage({ model: result.model, query, result, tool, receipts: SEARCH_RECEIPTS, scope });
    } finally {
      stopHeartbeat?.();
      release();
    }
  }
  if (normalized.stream) emitAnthropicStream(res, body);
  else sendJson(res, 200, body, { 'x-antigravity-model': body.model });
}

async function handleAnthropic(payload, req, res, signal) {
  USAGE_STORE.recordClientRequest();
  const search = await prepareServerSearchForwardAsync(payload, { receipts: SEARCH_RECEIPTS, scope: clientScope(req), signal });
  if (search && !search.skipSearch) return await handleServerSearchForward(search, payload, req, res, signal);
  const normalized = search?.normalized || await normalizeAnthropicAsync(payload, { signal });
  const model = await resolveModel(normalized.model, { preferFast: normalized.autoMode });
  const requestClass = normalized.autoMode ? 'auto-mode' : 'client';
  const identity = clientSessionIdentity(req, payload, normalized, null);
  gatewayLog(`[Antigravity Gateway] /v1/messages model=${model} requested=${normalized.model || '-'} class=${requestClass} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} maxOut=${normalized.generationConfig?.maxOutputTokens || '-'} stream=${normalized.stream} ${identityTrace(identity)}`);
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  const liveEmitter = textStreamingAllowed(normalized) ? createAnthropicTextEmitter(res, normalized.model || model) : null;
  let result;
  try { result = await runTurnWithModelDiagnostic(normalized, model, signal, { ...identity, mediaScope: clientScope(req), publicBaseUrl: requestBaseUrl(req), onDelta: liveEmitter?.onDelta, onThinkingDelta: normalized.includeThinking ? liveEmitter?.onThinkingDelta : undefined }); } finally { stopHeartbeat?.(); }
  const body = anthropicResponse(normalized.model || model, result);
  if (liveEmitter) liveEmitter.finish(body);
  else if (normalized.stream) emitAnthropicStream(res, body); else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

async function handleResponses(payload, req, res, signal) {
  USAGE_STORE.recordClientRequest();
  cleanupResponseStore();
  const previous = payload.previous_response_id ? SESSION_MANAGER.getResponse(payload.previous_response_id, req, payload) : null;
  if (payload.previous_response_id && !previous) {
    throw new GatewayError('previous_response_id 不属于当前客户端会话。', { code: 'previous_response_not_found', status: 400 });
  }
  const normalized = await normalizeResponsesAsync(payload, previous, { signal });
  const model = await resolveModel(normalized.model);
  const identity = clientSessionIdentity(req, payload, normalized, previous);
  gatewayLog(`[Antigravity Gateway] /v1/responses model=${model} requested=${normalized.model || '-'} chars=${JSON.stringify(payload).length} tools=${normalized.tools.length} stream=${normalized.stream} ${identityTrace(identity)}`);
  if (process.env.ANTIGRAVITY_GATEWAY_DEBUG === '1') {
    const customTools = (payload.tools || []).filter((tool) => tool?.type === 'custom');
    if (customTools.length) gatewayLog(`[Antigravity Gateway Debug] custom-tools=${JSON.stringify(customTools).slice(0, 4000)}`);
  }
  const stopHeartbeat = normalized.stream ? beginSse(res) : null;
  const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
  const liveEmitter = textStreamingAllowed(normalized) ? createResponsesTextEmitter(res, normalized.model || model, responseId) : null;
  let result;
  const sessionId = identity.sessionId;
  try { result = await runTurnWithModelDiagnostic(normalized, model, signal, { ...identity, mediaScope: clientScope(req), publicBaseUrl: requestBaseUrl(req), onDelta: liveEmitter?.onDelta, onThinkingDelta: normalized.includeThinking ? liveEmitter?.onThinkingDelta : undefined }); } finally { stopHeartbeat?.(); }
  const body = responsesResponse(normalized.model || model, result, responseId);
  SESSION_MANAGER.bindResponse(responseId, req, {
    sessionId,
    ...(identity.anonymousTask ? { anonymousTask: true } : {}),
    routingKey: identity.routingKey,
    system: normalized.system,
    instructions: normalized.instructions,
    instructionMessages: normalized.instructionMessages,
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
  }, payload);
  if (liveEmitter) liveEmitter.finish(body);
  else if (normalized.stream) emitResponsesStream(res, body);
  else sendJson(res, 200, body, { 'x-antigravity-model': model });
}

function dashboardAccountPool(requestUrl) {
  const providers = requestUrl.searchParams.getAll('provider');
  // Preserve the persisted discriminator accepted by existing dashboard links.
  if (providers.length > 1 || (providers.length === 1 && providers[0] !== 'cloudcode')) {
    throw new GatewayError('账号来源无效；当前仅支持 Google Antigravity API 账号池。', {
      code: 'invalid_account_provider', status: 400
    });
  }
  return ACCOUNT_POOL;
}

async function requestHandler(req, res) {
  if (!setCors(req, res)) { sendJson(res, 403, { error: { type: 'origin_not_allowed', message: '浏览器来源未获授权。' } }); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let route;
  let requestUrl;
  try {
    // Validate Host, but never use client-controlled Host as the URL parser base.
    if (req.headers.host) new URL(`http://${req.headers.host}`);
    requestUrl = new URL(req.url, 'http://localhost');
    route = requestUrl.pathname.replace(/\/$/, '') || '/';
  } catch { sendJson(res, 400, { error: { type: 'invalid_url', message: '请求 URL 或 Host 无效。' } }); return; }
  if (req.method === 'GET' && route === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }
  if (route === '/dashboard' || route === '/dashboard/data' || route.startsWith('/dashboard/assets/') || route.startsWith('/dashboard/accounts/')) {
    if (!DASHBOARD_ACCESS.allows(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: { type: 'dashboard_local_only', message: 'Token 看板仅允许从网关所在设备或 ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW 所列来源访问。' } });
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
    if (await handleDashboardAccountAuth(req, res, route, DASHBOARD_ACCOUNT_AUTH, sendJson)) return;
    const accountRecheckMatch = route.match(/^\/dashboard\/accounts\/([^/]+)\/recheck$/);
    const accountDeleteMatch = route.match(/^\/dashboard\/accounts\/([^/]+)$/);
    if (req.method === 'POST' && accountRecheckMatch) {
      try {
        const accountId = decodeURIComponent(accountRecheckMatch[1]);
        const pool = dashboardAccountPool(requestUrl, accountId);
        const result = await pool.recheckAccount(accountId, { signal: AbortSignal.timeout(45_000) });
        modelCache.at = 0;
        if (pool === ACCOUNT_POOL) upstreamModelCache.at = 0;
        sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
      } catch (error) {
        sendJson(res, Number(error?.status) || 502, {
          error: { type: error?.code || 'account_recheck_failed', message: error?.message || '账号重新检测失败。' }
        }, { 'Cache-Control': 'no-store' });
      }
      return;
    }
    if (req.method === 'DELETE' && accountDeleteMatch) {
      try {
        const accountId = decodeURIComponent(accountDeleteMatch[1]);
        const pool = dashboardAccountPool(requestUrl, accountId);
        const result = pool.removeAccount(accountId);
        modelCache.at = 0;
        if (pool === ACCOUNT_POOL) upstreamModelCache.at = 0;
        sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
      } catch (error) {
        sendJson(res, Number(error?.status) || 500, {
          error: { type: error?.code || 'account_delete_failed', message: error?.message || '账号删除失败。' }
        }, { 'Cache-Control': 'no-store' });
      }
      return;
    }
    if (route.startsWith('/dashboard/assets/')) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: { type: 'method_not_allowed', message: '看板资源只支持 GET。' } });
        return;
      }
      const asset = dashboardAsset(route.slice('/dashboard/assets/'.length));
      if (!asset) {
        sendJson(res, 404, { error: { type: 'not_found', message: '看板资源不存在。' } });
        return;
      }
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': asset.body.length,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(asset.body);
      return;
    }
    sendJson(res, 405, { error: { type: 'method_not_allowed', message: '看板请求方法不受支持。' } });
    return;
  }
  const publicFileMatch = route.match(/^\/v1\/files\/(file_[a-f0-9]{32})\/content$/);
  if (['GET', 'HEAD'].includes(req.method) && publicFileMatch) {
    let item = MEDIA_STORE.get(publicFileMatch[1], { allowPublic: true });
    if (!item?.publicOutput) {
      if (!authorized(req)) {
        sendJson(res, 401, errorBody(new GatewayError('API key 无效。', { code: 'authentication_error', status: 401 }), 'openai'));
        return;
      }
      item = MEDIA_STORE.get(publicFileMatch[1], { scope: clientScope(req) });
    }
    if (!item) { sendJson(res, 404, { error: { type: 'file_not_found', message: '文件不存在。' } }); return; }
    res.writeHead(200, {
      'Content-Type': item.metadata.mediaType || 'application/octet-stream',
      'Content-Length': item.buffer.length,
      'Content-Disposition': `${safeRasterImage(item.buffer, item.metadata.mediaType) ? 'inline' : 'attachment'}; filename="${String(item.metadata.filename || item.metadata.id).replace(/[^\x20-\x7e]|["\\]/g, '_')}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    res.end(req.method === 'HEAD' ? undefined : item.buffer);
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
    else if (route === '/v1/responses') sendResponsesStreamError(res, controller.signal.reason);
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
      sendJson(res, 200, {
        name: 'antigravity-gateway', version: GATEWAY_VERSION, status: 'ok',
        listen: `http://${HOST}:${PORT}`, agy: { path: AGY_PATH, version: AGY_CLI_VERSION },
        transport: 'direct',
        upstream_protocol: 'Google Antigravity API',
        auth: directAuthDescription(),
        credential_source: credentialSourceDescription(),
        codex_model_catalog: codexCatalogPath(),
        claude_model_config: claudeConfigPath(),
        default_model: DEFAULT_MODEL,
        fast_model: preferredFastModel(models),
        models: models.length,
        transport_limits: { request_body_bytes: REQUEST_LIMIT, normalized_prompt_bytes: PROMPT_BYTE_LIMIT },
        account_pool: {
          managed_accounts: ACCOUNT_POOL.status().length,
          accounts: ACCOUNT_POOL.status()
        },
        usage: { file: USAGE_STORE.file, ...USAGE_STORE.summary() },
        capabilities: { anthropic_messages: true, openai_responses: true, chat_completions: false, image_generation: true, image_edits: true, image_understanding: true, video_understanding: true, file_uploads: true, tools_experimental: true, direct_upstream_sse: true, local_agy_session_bridge: false, multi_account: true, persistent_usage: true, web_dashboard: true, interactive_console: true, credentials_read_by_gateway: true }
      });
      return;
    }
    if (req.method === 'GET' && route === '/v1/models') {
      const models = await availableModels(true);
      sendJson(res, 200, {
        ...codexCatalogBody(models),
        image_generation_model_ids: ACCOUNT_POOL.imageModelCatalog(),
        default_model: DEFAULT_MODEL,
        fast_model: preferredFastModel(models)
      });
      return;
    }
    if (req.method === 'POST' && route === '/v1/files') return await handleFileUpload(req, res);
    const fileMatch = route.match(/^\/v1\/files\/(file_[a-f0-9]{32})$/);
    if (req.method === 'GET' && fileMatch) {
      const item = MEDIA_STORE.get(fileMatch[1], { scope: clientScope(req) });
      if (!item) throw new GatewayError('文件不存在。', { code: 'file_not_found', status: 404 });
      sendJson(res, 200, item.metadata);
      return;
    }
    if (req.method === 'DELETE' && fileMatch) {
      if (!MEDIA_STORE.delete(fileMatch[1], { scope: clientScope(req) })) throw new GatewayError('文件不存在。', { code: 'file_not_found', status: 404 });
      sendJson(res, 200, { id: fileMatch[1], object: 'file', deleted: true });
      return;
    }
    if (req.method === 'POST' && route === '/v1/images/edits') return await handleImageEdit(req, res, controller.signal);
    if (req.method === 'POST' && route === '/v1/messages/count_tokens') {
      const payload = await readJson(req);
      const text = JSON.stringify(payload.system || '') + JSON.stringify(payload.messages || []) + JSON.stringify(payload.tools || []);
      sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) }, { 'x-token-count-estimated': 'true' });
      return;
    }
    if (route === '/v1/chat/completions') throw new GatewayError('Chat Completions 已移除，请将客户端配置为 Messages 或 Responses。', { code: 'unsupported_api', status: 410 });
    const payload = await readJson(req);
    if (req.method === 'POST' && route === '/v1/images/generations') return await handleImageGeneration(payload, req, res, controller.signal);
    if (req.method === 'POST' && route === '/v1/messages') return await handleAnthropic(payload, req, res, controller.signal);
    if (req.method === 'POST' && route === '/v1/responses') return await handleResponses(payload, req, res, controller.signal);

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
    if (!res.headersSent) {
      const retryHeaders = error.status === 429 && ['account_pool_unavailable', 'direct_upstream_error'].includes(error.code)
        && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0
        ? { 'Retry-After': String(error.retryAfterSeconds) } : {};
      sendJson(res, error.status || 500, errorBody(error, protocol), retryHeaders);
    }
    else {
      if (protocol === 'anthropic') sendSse(res, 'error', errorBody(error, protocol));
      else if (route === '/v1/responses') { sendResponsesStreamError(res, error); return; }
      else sendSse(res, null, { type: 'error', error: errorBody(error, protocol).error });
      res.end();
    }
  } finally {
    clearTimeout(deadline);
    releaseUpload?.();
  }
}

function createServer({ directoryGuard = null } = {}) {
  if (directoryGuard) {
    ACCOUNT_POOL.bindDirectoryGuard(directoryGuard);
  }
  const server = http.createServer((req, res) => {
    void trackTransaction(withAsyncSchemaBoundary(() => requestHandler(req, res))).catch(() => {
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, { error: { message: 'Antigravity Gateway 内部错误。' } });
      else res.destroy();
    });
  });
  server.drainTransactions = drainTransactions;
  return server;
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
  diagnosticsEnabled = true;
  const server = createServer({ directoryGuard });
  let shuttingDown = false;
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      TERMINAL?.stop();
      stopDiagnosticHeartbeat();
      diagnosticReporter('gateway_process_stopping', { pid: process.pid });
      directoryGuard.hold();
      QUOTA_MANAGER.stop();
      await DASHBOARD_ACCOUNT_AUTH.stop();
      await new Promise((resolve) => server.close(resolve));
      await drainTransactions();
      await QUOTA_MANAGER.drain();
      // 最后一条请求可能刚更新用量、账号亲和性；排空后才落盘和交接目录。
      USAGE_STORE.stop();
      ACCOUNT_POOL.stop();
      closeNativeTransport();
      ACCOUNT_POOL.bindDirectoryGuard(null);
      directoryGuard.close();
    })();
    return shutdownPromise;
  };
  const exitAfterShutdown = (code = 0) => {
    void shutdown().then(() => process.exit(code), error => {
      gatewayError(`[Antigravity Gateway Error] 排空退出失败：${error.message}`);
      process.exit(1);
    });
  };
  TERMINAL = new TerminalConsole({
    usageStore: USAGE_STORE,
    accountPool: ACCOUNT_POOL,
    quotaManager: QUOTA_MANAGER,
    commands: {
      models: async () => displayModels(await refreshClientModelCatalogs()),
      status: async () => gatewayLog(`网关运行中：${HOST}:${PORT}，账号 ${ACCOUNT_POOL.status().length}，并发 ${requestSlots.active}/${MAX_CONCURRENCY}`),
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
  server.listen(PORT, HOST, () => { void trackTransaction((async () => {
    diagnosticReporter('gateway_process_started', {
      pid: process.pid,
      version: GATEWAY_VERSION,
      transport: 'direct',
      host: HOST,
      port: PORT,
      maxConcurrency: MAX_CONCURRENCY,
      accountCount: ACCOUNT_POOL.status().length
    });
    startDiagnosticHeartbeat();
    gatewayLog(`[Antigravity Gateway] 看板来源：${DASHBOARD_ACCESS.description}`);
    let models = [];
    let modelError = '';
    try {
      models = await refreshClientModelCatalogs();
    } catch (error) {
      modelError = error.message;
    }
    gatewayLog(startupBanner({ models, modelError }));
    if (!shuttingDown) {
      TERMINAL.showDashboard();
      TERMINAL.start();
    }
  })()).catch(error => gatewayWarn(`[Antigravity Gateway Warning] 启动初始化未完成：${error.message}`)); });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') gatewayError(`[Antigravity Gateway Error] ${HOST}:${PORT} 已被占用，请关闭旧进程或设置 ANTIGRAVITY_GATEWAY_PORT。`);
    else gatewayError(`[Antigravity Gateway Error] ${error.message}`);
    diagnosticReporter('gateway_process_error', {
      pid: process.pid,
      errorCode: String(error.code || ''),
      message: String(error.message || error || '').slice(0, 1000)
    });
    exitAfterShutdown(1);
  });
  process.once('SIGINT', () => exitAfterShutdown());
  process.once('SIGTERM', () => exitAfterShutdown());
}

module.exports = {
  availableModels,
  claudeConfigBody,
  claudeConfigPath,
  clientSessionScope,
  clientSessionIdentity,
  codexCatalogBody,
  codexCatalogPath,
  codexModelInfo,
  createServer,
  createChatTextEmitter,
  createAnthropicTextEmitter,
  createResponsesTextEmitter,
  displayModels,
  emitAnthropicStream,
  emitChatStream,
  emitResponsesStream,
  featuredModels,
  imagesResponse,
  refreshClientModelCatalogs,
  resolveModel,
  runTurn,
  startupBanner,
  activeTransactions,
  drainTransactions
};

}

const daemonStart = require.main === module && ![
  'help', 'version', 'serviceRequested', 'stats', 'codexCatalogPath',
  'claudeConfigPath', 'models', 'claudeConfig'
].some(key => CLI_ARGS[key]);
if (daemonStart) {
  void acquireDirectoryGuard(CONFIG_DIR).then(guard => {
    try { initializeGateway(guard); }
    catch (error) { guard.close(); throw error; }
  }).catch(error => {
    console.error(`[Antigravity Gateway Error] ${error.message}`);
    process.exitCode = 1;
  });
} else initializeGateway();
