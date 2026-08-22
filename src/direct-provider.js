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
  const generationConfig = normalized.generationConfig ? { ...normalized.generationConfig } : null;
  // High/thinking models spend part of maxOutputTokens on hidden reasoning. A
  // tiny client cap (common in health checks and Auto-mode probes) otherwise
  // leaves zero visible tokens and produces an empty response.
  if (generationConfig && generationConfig.maxOutputTokens > 0 && generationConfig.maxOutputTokens < 128 && /(?:high|thinking)/i.test(model || '')) {
    generationConfig.maxOutputTokens = 128;
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
  constructor({ fetchImpl = globalThis.fetch, authFile = authFilePath(), localAuth = new LocalAgyAuthProvider({ fetchImpl }), baseUrl = process.env.ANTIGRAVITY_DIRECT_BASE_URL || '', accessToken = process.env.ANTIGRAVITY_ACCESS_TOKEN, refreshToken = process.env.ANTIGRAVITY_REFRESH_TOKEN, projectId = process.env.ANTIGRAVITY_PROJECT_ID, userAgent = process.env.ANTIGRAVITY_DIRECT_USER_AGENT || DEFAULT_USER_AGENT, models = envModels() } = {}) {
    this.fetchImpl = fetchImpl;
    this.authFile = authFile;
    this.localAuth = localAuth;
    this.baseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
    this.accessToken = String(accessToken || '').trim();
    this.refreshToken = String(refreshToken || '').trim();
    this.projectId = String(projectId || '').trim();
    this.userAgent = userAgent;
    this.modelList = models;
    this.discoveredModels = [];
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
          const rawModels = Array.isArray(body.models)
            ? body.models
            : body.models && typeof body.models === 'object'
              ? Object.keys(body.models)
              : [];
          const models = rawModels.map(extractModelId).filter(Boolean);
          if (models.length) {
            this.discoveredModels = [...new Set(models)];
            return [...this.discoveredModels];
          }
        } catch {
          // Try the next Cloud Code endpoint, then use the conservative fallback.
        }
      }
    } catch {
      // Model discovery must not prevent the local gateway from starting.
    }
    return ['gemini-3.7-flash-high'];
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
    let lastError;
    for (const base of this.baseUrls()) {
      try {
        response = await attempt(base, false);
        if (response.status === 401 && this.refreshToken) response = await attempt(base, true);
        if (response.ok || response.status < 500 || base === this.baseUrls().at(-1)) break;
        await response.body?.cancel?.();
      } catch (error) {
        lastError = error;
        if (base === this.baseUrls().at(-1)) throw error;
      }
    }
    if (!response && lastError) throw lastError;
    if (!response.ok) {
      const text = await readBody(response);
      const detail = upstreamErrorMessage(text);
      throw new DirectProviderError(detail ? `Antigravity 直连请求失败：${detail}` : 'Antigravity 直连请求失败。', { code: 'direct_upstream_error', status: response.status, details: detail });
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
