'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalAgyAuthProvider, LocalAgyAuthError, discoverClientCredentials } = require('./local-agy-auth');

const DEFAULT_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const DAILY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';
const GENERATE_PATH = '/v1internal:generateContent';
const STREAM_PATH = '/v1internal:streamGenerateContent';
const MODELS_PATH = '/v1internal:fetchAvailableModels';
const MODEL_DISCOVERY_TIMEOUT_MS = Number(process.env.ANTIGRAVITY_DIRECT_MODEL_DISCOVERY_TIMEOUT_MS || 3000);
const DEFAULT_MAX_RETRIES = Math.max(0, Number(process.env.ANTIGRAVITY_DIRECT_MAX_RETRIES || 1));
const DEFAULT_RETRY_BASE_MS = Math.max(100, Number(process.env.ANTIGRAVITY_DIRECT_RETRY_BASE_MS || 1500));
const DEFAULT_USER_AGENT = `antigravity/cli/${process.env.ANTIGRAVITY_CLI_VERSION || '1.1.18'} (aidev_client; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`;
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';
const thoughtSignatureSessions = new Map();
const THOUGHT_SIGNATURE_TTL_MS = 60 * 60 * 1000;

class DirectProviderError extends Error {
  constructor(message, { code = 'direct_provider_error', status = 502, details, cause } = {}) {
    super(message, { cause });
    this.name = 'DirectProviderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function compact(value) {
  try { return JSON.stringify(value); } catch { return '{}'; }
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?[^\s"']+/gi, 'token=[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(-2000);
}

function envModels() {
  const raw = String(process.env.ANTIGRAVITY_DIRECT_MODELS || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter((item) => MODEL_SLUG.test(item));
  } catch { /* also accept comma-separated values */ }
  return raw.split(',').map((item) => item.trim()).filter((item) => MODEL_SLUG.test(item));
}

function authFilePath() {
  const configured = String(process.env.ANTIGRAVITY_AUTH_FILE || '').trim();
  return configured ? path.resolve(configured) : '';
}

function readAuthFile(file) {
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.metadata && typeof raw.metadata === 'object') return raw.metadata;
    return raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    throw new DirectProviderError(`无法读取 Antigravity 直连凭据文件: ${file}`, {
      code: 'direct_auth_file_invalid', status: 400, details: redact(error.message), cause: error
    });
  }
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function extractProject(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') return firstString(value.id, value.projectId, value.project_id);
  return '';
}

function extractModelId(value) {
  const raw = typeof value === 'string'
    ? value
    : firstString(value?.name, value?.id, value?.model, value?.modelId);
  const id = String(raw || '').trim().replace(/^models\//, '');
  return MODEL_SLUG.test(id) ? id : '';
}

function tokenExpiry(auth) {
  const expired = firstString(auth.expired, auth.expires_at, auth.expiresAt);
  if (expired) {
    const date = new Date(expired);
    if (!Number.isNaN(date.valueOf())) return date;
  }
  const expiresIn = Number(auth.expires_in || auth.expiresIn || 0);
  const timestamp = Number(auth.timestamp || 0);
  if (expiresIn > 0 && timestamp > 0) {
    const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    return new Date(milliseconds + expiresIn * 1000);
  }
  return null;
}

function stableSessionId(value) {
  const digest = crypto.createHash('sha256').update(String(value || '')).digest();
  let number = 0n;
  for (const byte of digest.subarray(0, 8)) number = (number << 8n) | BigInt(byte);
  return `-${(number & 0x7fffffffffffffffn).toString()}`;
}

function normalizedRole(role) {
  return role === 'assistant' || role === 'model' ? 'model' : 'user';
}

function parseToolMarker(text) {
  const match = String(text || '').match(/^\[ASSISTANT_TOOL_CALL id=([^\s\]]*) name=([^\s\]]+)\]\n([\s\S]*)$/);
  if (!match) return null;
  try { return { id: match[1], name: match[2], args: JSON.parse(match[3]) }; } catch { return null; }
}

function parseToolResultMarker(text) {
  const match = String(text || '').match(/^\[CLIENT_TOOL_RESULT id=([^\s\]]*)[^\]]*\]\n([\s\S]*)$/);
  return match ? { id: match[1], result: match[2] } : null;
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  const source = value.trim();
  if (!source) return '';
  try { return JSON.parse(source); } catch { return value; }
}

function deriveToolNameFromId(id) {
  const value = String(id || '').trim();
  if (!value) return '';
  const parts = value.split('-');
  if (parts.length > 2) return parts.slice(0, -2).join('-');
  return '';
}

function thoughtSignaturesForSession(sessionId) {
  const key = String(sessionId || '');
  if (!key) return new Map();
  const now = Date.now();
  let entry = thoughtSignatureSessions.get(key);
  if (!entry || now - entry.at > THOUGHT_SIGNATURE_TTL_MS) {
    entry = { at: now, signatures: new Map() };
    thoughtSignatureSessions.set(key, entry);
  } else {
    entry.at = now;
  }
  while (thoughtSignatureSessions.size > 1000) {
    const oldest = thoughtSignatureSessions.keys().next().value;
    if (oldest === undefined) break;
    thoughtSignatureSessions.delete(oldest);
  }
  return entry.signatures;
}

function rememberThoughtSignatures(sessionId, calls) {
  if (!sessionId) return;
  const signatures = thoughtSignaturesForSession(sessionId);
  for (const call of calls || []) {
    if (call?.id && typeof call.thoughtSignature === 'string' && call.thoughtSignature) {
      signatures.set(call.id, call.thoughtSignature);
    }
  }
}

function cleanToolSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return { type: 'object' };
  if (Array.isArray(schema)) return schema.map((item) => cleanToolSchema(item, depth + 1));
  const output = {};
  for (const key of ['description', 'enum', 'nullable', 'required', 'additionalProperties']) {
    if (schema[key] !== undefined) output[key] = key === 'enum' && Array.isArray(schema[key]) ? schema[key].map(String) : schema[key];
  }
  const rawType = schema.type;
  if (Array.isArray(rawType)) {
    const types = rawType.map(String).filter(Boolean);
    const nonNull = types.filter((type) => type !== 'null');
    output.type = nonNull[0] || 'object';
    if (types.includes('null')) output.nullable = true;
  } else if (typeof rawType === 'string' && rawType) {
    output.type = rawType;
  }
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (!output.type && variants.length) {
    const candidate = variants.find((item) => item && item.type !== 'null') || variants[0];
    Object.assign(output, cleanToolSchema(candidate, depth + 1));
    if (variants.some((item) => item?.type === 'null')) output.nullable = true;
  }
  if (schema.properties && typeof schema.properties === 'object') {
    output.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => [name, cleanToolSchema(value, depth + 1)]));
  }
  if (schema.items) output.items = cleanToolSchema(schema.items, depth + 1);
  if (!output.type && (output.properties || output.required)) output.type = 'object';
  return output;
}

function upstreamErrorMessage(text) {
  try {
    const body = JSON.parse(String(text || '{}'));
    return redact(body?.error?.message || body?.message || '');
  } catch {
    return redact(text);
  }
}

function retryAfterMs(response, attempt, baseMs) {
  const raw = String(response?.headers?.get?.('retry-after') || '').trim();
  let headerMs = 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) headerMs = Number(raw) * 1000;
  else if (raw) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) headerMs = Math.max(0, at - Date.now());
  }
  const exponential = baseMs * (2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseMs / 3)));
  return Math.min(30_000, Math.max(headerMs, exponential + jitter));
}

function waitForRetry(milliseconds, signal) {
  if (!(milliseconds > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal.reason || new Error('Request aborted'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function normalizedMessageParts(message) {
  if (Array.isArray(message?.parts)) return message.parts;
  const marker = normalizedRole(message?.role) === 'model' ? parseToolMarker(message?.text) : null;
  if (marker) return [{ type: 'tool_call', id: marker.id, name: marker.name, arguments: marker.args }];
  const result = parseToolResultMarker(message?.text);
  if (result) return [{ type: 'tool_result', id: result.id, content: result.result }];
  return message?.text ? [{ type: 'text', text: String(message.text) }] : [];
}

function contentsFromNormalized(normalized, thoughtSignatures = null, model = '') {
  const toolNames = new Map();
  const contents = [];
  const needsThoughtSignature = /^gemini-3(?:[.-]|$)/i.test(String(model || ''));
  for (const message of normalized.messages || []) {
    const nativeParts = [];
    let functionCallSeen = false;
    for (const part of normalizedMessageParts(message)) {
      if (part?.type === 'tool_call') {
        const id = String(part.id || '').trim();
        const name = String(part.name || '').trim();
        if (!name) continue;
        if (id) toolNames.set(id, name);
        const args = parseJsonValue(part.arguments ?? part.args ?? {});
        const recoveredSignature = String(part.thoughtSignature || thoughtSignatures?.get?.(id) || '').trim();
        // Gemini 3 requires a signature on the first functionCall part of
        // each step. If an old Claude transcript no longer contains the
        // provider signature (for example after a gateway restart), use the
        // the same explicit compatibility sentinel used by established
        // Cloud Code proxy implementations. Never
        // add it to parallel sibling calls: only the first call in a part
        // group may carry a signature.
        const signature = recoveredSignature || (needsThoughtSignature && !functionCallSeen ? THOUGHT_SIGNATURE_SENTINEL : '');
        functionCallSeen = true;
        nativeParts.push({
          ...(signature ? { thoughtSignature: signature } : {}),
          functionCall: { ...(id ? { id } : {}), name, args }
        });
        continue;
      }
      if (part?.type === 'tool_result') {
        const id = String(part.id || '').trim();
        const name = String(part.name || toolNames.get(id) || deriveToolNameFromId(id)).trim();
        const result = parseJsonValue(part.content ?? part.result ?? '');
        if (!name) {
          nativeParts.push({ text: `[CLIENT_TOOL_RESULT id=${id}]\n${typeof result === 'string' ? result : compact(result)}` });
          continue;
        }
        nativeParts.push({ functionResponse: {
          ...(id ? { id } : {}),
          name,
          response: { result }
        } });
        continue;
      }
      if (part?.type === 'text' && String(part.text || '')) nativeParts.push({ text: String(part.text) });
    }
    if (nativeParts.length) contents.push({ role: normalizedRole(message.role), parts: nativeParts });
  }
  return contents;
}

function buildDirectRequest(normalized, model, projectId, sessionId, repairInstruction = '', thoughtSignatures = null) {
  let generationConfig = normalized.generationConfig ? { ...normalized.generationConfig } : null;
  // Gemini 3 models at every reasoning tier spend part of maxOutputTokens on
  // hidden reasoning. The previous 128-token floor was still observed to cut
  // a six-token health reply down to "MAC_". Reserve provider-side reasoning
  // room for tiny client caps; models still stop naturally after the requested
  // short answer and the protocol adapter exposes only visible output.
  if (generationConfig && generationConfig.maxOutputTokens > 0 && generationConfig.maxOutputTokens < 1024 && /^gemini-3(?:[.-]|$)/i.test(model || '')) {
    generationConfig.maxOutputTokens = 1024;
  }
  // Claude Code Auto Mode often asks for only 64 visible tokens. Gemini 3's
  // hidden reasoning is charged against the same upstream output budget, so
  // 128 can still truncate a tiny verdict to "<severity>0". Reserve enough
  // provider-side room for reasoning plus the complete XML classifier result;
  // the adapter still returns only the normalized client contract.
  if (normalized.autoMode && /^gemini-3(?:[.-]|$)/i.test(model || '')) {
    generationConfig ||= {};
    generationConfig.maxOutputTokens = Math.max(Number(generationConfig.maxOutputTokens) || 0, 8192);
  }
  const request = {
    contents: contentsFromNormalized(normalized, thoughtSignatures, model),
    ...(generationConfig ? { generationConfig } : {}),
    ...(normalized.system || repairInstruction ? {
      systemInstruction: { role: 'user', parts: [{ text: [normalized.system, repairInstruction].filter(Boolean).join('\n\n') }] }
    } : {})
  };
  if (normalized.tools?.length) {
    request.tools = [{ functionDeclarations: normalized.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parameters: cleanToolSchema(tool.schema || { type: 'object' })
    })) }];
    const choice = normalized.toolChoice;
    const type = typeof choice === 'string' ? choice : choice?.type;
    const mode = type === 'none' ? 'NONE' : /claude/i.test(model || '') ? 'VALIDATED' : type === 'required' || type === 'any' || type === 'tool' ? 'ANY' : 'AUTO';
    request.toolConfig = { functionCallingConfig: { mode } };
    const name = choice?.name || choice?.function?.name;
    if (name) request.toolConfig.functionCallingConfig.allowedFunctionNames = [name];
  }
  return {
    model,
    userAgent: 'antigravity',
    requestType: 'agent',
    project: projectId,
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      ...request,
      sessionId: sessionId || stableSessionId(contentsFromNormalized(normalized, null, model).slice(0, 1).map(compact).join(''))
    }
  };
}

function jsonFromSseLine(line) {
  let source = String(line || '').trim();
  if (!source || source.startsWith(':')) return null;
  if (source.startsWith('data:')) source = source.slice(5).trim();
  if (!source || source === '[DONE]') return null;
  try { return JSON.parse(source); } catch { return null; }
}

function usageFrom(value) {
  const usage = value?.usageMetadata || value?.response?.usageMetadata || value?.usage || {};
  return {
    input_tokens: Number(usage.promptTokenCount ?? usage.inputTokens ?? usage.input_tokens ?? 0),
    output_tokens: Number(usage.candidatesTokenCount ?? usage.outputTokens ?? usage.output_tokens ?? 0),
    total_tokens: Number(usage.totalTokenCount ?? usage.totalTokens ?? usage.total_tokens ?? 0),
    thinking_tokens: Number(usage.thoughtsTokenCount ?? usage.thinkingTokens ?? 0),
    cache_read_tokens: Number(usage.cachedContentTokenCount ?? usage.cacheReadTokens ?? 0)
  };
}

function partsFrom(value) {
  const root = value?.response || value;
  const candidate = root?.candidates?.[0] || value?.candidates?.[0];
  return candidate?.content?.parts || root?.content?.parts || [];
}

function consumeUpstreamValue(value, state, onDelta) {
  if (!value || typeof value !== 'object') return;
  if (value.error) throw new DirectProviderError('Antigravity 直连上游返回错误。', {
    code: 'direct_upstream_error', status: Number(value.error.code) || 502, details: redact(value.error.message || compact(value.error))
  });
  for (const part of partsFrom(value)) {
    if (typeof part.text === 'string') {
      state.text += part.text;
      onDelta?.(part.text, part);
    }
    const call = part.functionCall || part.function_call;
    if (call?.name) appendUpstreamToolCall(state, call, part);
  }
  const usage = usageFrom(value);
  if (usage.total_tokens || usage.input_tokens || usage.output_tokens) state.usage = usage;
}

function appendUpstreamToolCall(state, call, part = {}) {
  const id = String(call.id || '').trim();
  const name = String(call.name || '').trim();
  if (!name) return;
  const thoughtSignature = String(part.thoughtSignature || part.thought_signature || call.thoughtSignature || '').trim();
  const key = id || `${name}:${state.calls.length}`;
  let existing = state.callsByKey?.get(key);
  const rawArguments = call.args ?? call.arguments ?? {};
  if (!existing) {
    existing = {
      ...(id ? { id } : {}),
      name,
      arguments: typeof rawArguments === 'string' ? rawArguments : rawArguments,
      ...(thoughtSignature ? { thoughtSignature } : {})
    };
    state.callsByKey ||= new Map();
    state.callsByKey.set(key, existing);
    state.calls.push(existing);
    return;
  }
  if (typeof rawArguments === 'string' && typeof existing.arguments === 'string') {
    if (rawArguments.startsWith(existing.arguments)) existing.arguments = rawArguments;
    else if (!existing.arguments.startsWith(rawArguments) && rawArguments !== existing.arguments) existing.arguments += rawArguments;
  } else if (rawArguments && typeof rawArguments === 'object') {
    existing.arguments = rawArguments;
  }
  if (thoughtSignature) existing.thoughtSignature = thoughtSignature;
}

async function readBody(response) {
  try { return await response.text(); } catch (error) { throw new DirectProviderError('读取 Antigravity 直连响应失败。', { details: redact(error.message), cause: error }); }
}

class DirectAntigravityProvider {
  constructor({ fetchImpl = globalThis.fetch, authFile = authFilePath(), localAuth = new LocalAgyAuthProvider({ fetchImpl }), baseUrl = process.env.ANTIGRAVITY_DIRECT_BASE_URL || '', accessToken = process.env.ANTIGRAVITY_ACCESS_TOKEN, refreshToken = process.env.ANTIGRAVITY_REFRESH_TOKEN, projectId = process.env.ANTIGRAVITY_PROJECT_ID, userAgent = process.env.ANTIGRAVITY_DIRECT_USER_AGENT || DEFAULT_USER_AGENT, models = envModels(), maxRetries = DEFAULT_MAX_RETRIES, retryBaseMs = DEFAULT_RETRY_BASE_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.authFile = authFile;
    this.localAuth = localAuth;
    this.baseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
    this.accessToken = String(accessToken || '').trim();
    this.refreshToken = String(refreshToken || '').trim();
    this.projectId = String(projectId || '').trim();
    this.userAgent = userAgent;
    this.modelList = models;
    this.maxRetries = Math.max(0, Number(maxRetries) || 0);
    this.retryBaseMs = Math.max(1, Number(retryBaseMs) || DEFAULT_RETRY_BASE_MS);
    this.discoveredModels = [];
    this.discoveredModelInfo = new Map();
    this.fileAuth = {};
    this.authLoaded = false;
    this.projectLoaded = false;
  }

  isConfigured() {
    if (this.localAuth?.isConfigured()) return true;
    if (this.accessToken || this.refreshToken) return true;
    if (!this.authFile) return false;
    try { return Boolean(firstString(readAuthFile(this.authFile).access_token, readAuthFile(this.authFile).refresh_token)); } catch { return false; }
  }

  loadAuth() {
    if (!this.authLoaded) {
      this.fileAuth = readAuthFile(this.authFile);
      this.authLoaded = true;
    }
    const local = this.localAuth?.load?.() || {};
    const accessToken = firstString(local.accessToken, this.accessToken, this.fileAuth.access_token);
    const refreshToken = firstString(local.refreshToken, this.refreshToken, this.fileAuth.refresh_token);
    const projectId = firstString(local.projectId, this.projectId, this.fileAuth.project_id, this.fileAuth.projectId, this.fileAuth.cloudaicompanionProject);
    return { accessToken, refreshToken, projectId, expiry: local.expiry || tokenExpiry(this.fileAuth), authMethod: local.authMethod || 'consumer', sourcePath: local.sourcePath || '' };
  }

  async refreshAccessToken(signal, refreshToken) {
    if (!refreshToken) throw new DirectProviderError('缺少 Antigravity refresh token。', { code: 'direct_refresh_token_missing', status: 401 });
    const candidates = this.localAuth?.clientCredentials?.length
      ? this.localAuth.clientCredentials
      : discoverClientCredentials();
    if (!candidates.length) throw new DirectProviderError('无法从本地 agy 安装中发现 OAuth 客户端配置。', { code: 'direct_client_credentials_missing', status: 401 });
    let lastStatus = 401;
    for (const candidate of candidates) {
      const form = new URLSearchParams({ client_id: candidate.clientId, client_secret: candidate.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
      let response;
      try {
        response = await this.fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal });
      } catch (error) {
        throw new DirectProviderError('Antigravity OAuth token 刷新请求失败。', { code: 'direct_refresh_failed', status: 502, cause: error });
      }
      const text = await readBody(response);
      lastStatus = response.status;
      let body = {};
      try { body = JSON.parse(text || '{}'); } catch { /* try the next embedded client */ }
      const accessToken = String(body.access_token || body.accessToken || '').trim();
      if (response.ok && accessToken) {
        this.accessToken = accessToken;
        this.refreshToken = String(body.refresh_token || refreshToken).trim();
        return this.accessToken;
      }
      if (response.status >= 500) break;
    }
    throw new DirectProviderError('Antigravity OAuth token 刷新失败。', { code: 'direct_refresh_failed', status: lastStatus });
  }

  async access(signal, forceRefresh = false) {
    if (this.localAuth?.isConfigured()) {
      try {
        const local = await this.localAuth.get(signal, { forceRefresh });
        this.accessToken = local.accessToken;
        this.refreshToken = local.refreshToken;
        if (local.projectId) this.projectId = local.projectId;
        return this.accessToken;
      } catch (error) {
        if (!(error instanceof LocalAgyAuthError)) throw error;
        throw new DirectProviderError(error.message, { code: error.code, status: error.status, details: error.details, cause: error });
      }
    }
    const auth = this.loadAuth();
    if (!forceRefresh && auth.accessToken && (!auth.expiry || auth.expiry > new Date(Date.now() + 60_000))) {
      this.accessToken = auth.accessToken;
      this.refreshToken = auth.refreshToken;
      return this.accessToken;
    }
    if (auth.refreshToken) return this.refreshAccessToken(signal, auth.refreshToken);
    if (auth.accessToken) return auth.accessToken;
    throw new DirectProviderError('未找到本地 agy 登录态，也未配置手动直连凭据。请先登录 agy，或显式设置 ANTIGRAVITY_AUTH_FILE。', { code: 'direct_auth_missing', status: 401 });
  }

  async project(signal, token) {
    if (this.projectId) return this.projectId;
    if (this.projectLoaded) return '';
    let response;
    let text = '';
    for (const base of this.baseUrls()) {
      try {
        response = await this.fetchImpl(`${base}${LOAD_CODE_ASSIST_PATH}`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': this.userAgent },
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }), signal
        });
        text = await readBody(response);
        if (response.ok || response.status < 500) break;
      } catch (error) {
        if (base === this.baseUrls().at(-1)) throw new DirectProviderError('Antigravity project discovery 失败。', { code: 'direct_project_discovery_failed', status: 502, details: redact(error.message), cause: error });
      }
    }
    if (!response?.ok) throw new DirectProviderError('Antigravity project discovery 失败。', { code: 'direct_project_discovery_failed', status: response?.status || 502, details: redact(text) });
    let body;
    try { body = JSON.parse(text); } catch (error) { throw new DirectProviderError('Antigravity project discovery 响应不是 JSON。', { code: 'direct_project_invalid', status: 502, cause: error }); }
    this.projectId = extractProject(body.cloudaicompanionProject) || extractProject(body.projectId) || extractProject(body.project);
    this.projectLoaded = true;
    if (!this.projectId) throw new DirectProviderError('Antigravity project discovery 未返回 project ID，请设置 ANTIGRAVITY_PROJECT_ID。', { code: 'direct_project_missing', status: 400 });
    return this.projectId;
  }

  async listModels(signal) {
    if (this.modelList.length) return [...this.modelList];
    if (this.discoveredModels.length) return [...this.discoveredModels];
    try {
      const token = await this.access(signal);
      for (const base of this.baseUrls()) {
        try {
          const response = await this.fetchImpl(`${base}${MODELS_PATH}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: '*/*', 'user-agent': this.userAgent },
            body: '{}',
            signal: signal || AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS)
          });
          const text = await readBody(response);
          if (!response.ok) continue;
          let body;
          try { body = JSON.parse(text || '{}'); } catch { continue; }
          const entries = Array.isArray(body.models)
            ? body.models.map((value) => [extractModelId(value), value])
            : body.models && typeof body.models === 'object'
              ? Object.entries(body.models).map(([id, value]) => [extractModelId(id) || extractModelId(value), value])
              : [];
          const models = entries.map(([id]) => id).filter(Boolean);
          if (models.length) {
            this.discoveredModels = [...new Set(models)];
            this.discoveredModelInfo = new Map(entries.filter(([id]) => id).map(([id, value]) => {
              const metadata = value && typeof value === 'object' ? value : {};
              return [id, {
                displayName: firstString(metadata.displayName, metadata.display_name) || id,
                maxTokens: Math.max(0, Number(metadata.maxTokens ?? metadata.max_tokens ?? 0) || 0),
                maxOutputTokens: Math.max(0, Number(metadata.maxOutputTokens ?? metadata.max_output_tokens ?? 0) || 0),
                supportsImages: Boolean(metadata.supportsImages ?? metadata.supports_images),
                supportsThinking: Boolean(metadata.supportsThinking ?? metadata.supports_thinking)
              }];
            }));
            return [...this.discoveredModels];
          }
        } catch {
          // Try the next Cloud Code endpoint, then use the conservative fallback.
        }
      }
    } catch {
      // Model discovery must not prevent the local gateway from starting.
    }
    return ['gemini-3.8-flash-high'];
  }

  modelInfo(model) {
    const value = this.discoveredModelInfo.get(String(model || ''));
    return value ? { ...value } : null;
  }

  baseUrls() {
    if (this.baseUrl) return [this.baseUrl];
    return [DAILY_BASE_URL, DEFAULT_BASE_URL];
  }

  async send(normalized, model, { signal, sessionId, repairInstruction = '', onDelta } = {}) {
    let token = await this.access(signal);
    let project = await this.project(signal, token);
    const thoughtSignatures = thoughtSignaturesForSession(sessionId);
    const requestBody = buildDirectRequest(normalized, model, project, sessionId, repairInstruction, thoughtSignatures);
    const attempt = async (base, forceRefresh = false) => {
      if (forceRefresh) {
        token = await this.access(signal, true);
        project = await this.project(signal, token);
        requestBody.project = project;
      }
      const stream = Boolean(normalized.stream);
      const url = `${base}${stream ? STREAM_PATH : GENERATE_PATH}${stream ? '?alt=sse' : ''}`;
      return this.fetchImpl(url, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', 'user-agent': this.userAgent },
        body: JSON.stringify(requestBody)
      });
    };
    let response;
    let lastFailure;
    const bases = this.baseUrls();
    requestRounds:
    for (let retry = 0; retry <= this.maxRetries; retry += 1) {
      for (const base of bases) {
        let candidate;
        try {
          candidate = await attempt(base, false);
          if (candidate.status === 401 && this.refreshToken) candidate = await attempt(base, true);
        } catch (error) {
          lastFailure = { error };
          continue;
        }
        if (candidate.ok) {
          response = candidate;
          break requestRounds;
        }
        const text = await readBody(candidate);
        const detail = upstreamErrorMessage(text);
        lastFailure = { response: candidate, status: candidate.status, detail, diagnostic: redact(text) };
        const retryable = candidate.status === 429 || candidate.status >= 500;
        if (!retryable) {
          throw new DirectProviderError(detail ? `Antigravity 直连请求失败：${detail}` : 'Antigravity 直连请求失败。', {
            code: 'direct_upstream_error', status: candidate.status, details: detail
          });
        }
        // A 429 from daily-cloudcode is allowed to fall through to the normal
        // Cloud Code endpoint. The previous implementation stopped at every
        // status below 500, so a transient daily-capacity limit never reached
        // the healthy fallback endpoint.
      }
      if (retry < this.maxRetries) {
        const delay = retryAfterMs(lastFailure?.response, retry, this.retryBaseMs);
        await waitForRetry(delay, signal);
      }
    }
    if (!response) {
      if (lastFailure?.error) throw lastFailure.error;
      const detail = lastFailure?.detail || '';
      throw new DirectProviderError(detail ? `Antigravity 直连请求失败：${detail}` : 'Antigravity 直连请求失败。', {
        code: 'direct_upstream_error', status: lastFailure?.status || 502, details: lastFailure?.diagnostic || detail
      });
    }
    const state = { text: '', calls: [], usage: {} };
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (normalized.stream || contentType.includes('text/event-stream')) {
      const reader = response.body?.getReader?.();
      if (!reader) return this._parseJson(await readBody(response), state, onDelta);
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const parsed = jsonFromSseLine(line);
          if (parsed) consumeUpstreamValue(parsed, state, onDelta);
        }
      }
      const tail = jsonFromSseLine(buffer);
      if (tail) consumeUpstreamValue(tail, state, onDelta);
    } else {
      this._parseJson(await readBody(response), state, onDelta);
    }
    if (state.calls.length) {
      for (const call of state.calls) if (!call.id) call.id = `call_${crypto.randomUUID().replaceAll('-', '')}`;
      rememberThoughtSignatures(sessionId, state.calls);
    }
    return {
      text: state.text,
      streamedText: state.text,
      toolCalls: state.calls,
      usage: state.usage,
      conversationId: sessionId,
      internalToolUsed: false
    };
  }

  _parseJson(text, state, onDelta) {
    let body;
    try { body = JSON.parse(text || '{}'); } catch (error) { throw new DirectProviderError('Antigravity 直连响应不是 JSON。', { code: 'direct_response_invalid', status: 502, details: redact(text), cause: error }); }
    consumeUpstreamValue(body, state, onDelta);
    return state;
  }
}

module.exports = {
  DAILY_BASE_URL,
  DEFAULT_BASE_URL,
  DirectAntigravityProvider,
  DirectProviderError,
  MODEL_SLUG,
  buildDirectRequest,
  cleanToolSchema,
  stableSessionId
};
