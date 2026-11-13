'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { errorDetails } = require('./diagnostic-log');
const { LocalAgyAuthError, discoverClientCredentials } = require('./local-agy-auth');
const { nativeCloudCodeFetch } = require('./agy-native-transport');
const { AgySessionStore, newState, contentFingerprint, restoreClientProjections, recordClientProjection,
  recordStreamProjection, recordStreamRecovery, clearStreamRecovery, recordToolStreamError } = require('./agy-session-state');
const { deliveryText, streamTextRemainder } = require('./artifacts');
const { prepareNativeContext, prepareNativeContextAsync, completeNativeContext, interruptNativeContext, interruptCheckpointContext, continueInterruptedStream } = require('./agy-context-state');
const { isStreamError } = require('./agy-stream-recovery');
const { CLAUDE_COMPACTION_PROFILE } = require('./agy-client-compaction');
const { AgyImageStore, registerImagePart } = require('./agy-image-references');
const { agentEnvelope, generationProfile, cliUserAgent } = require('./agy-request-profile');
const { assertGenerationCompatibility } = require('./antigravity-model-config');
const { CAPTURED_IMAGE_MODEL, DEFAULT_IMAGE_MODEL, imageModelName, assertImageModel } = require('./image-model-config');
const { validateSearchParameters, searchRequest, parseSearchResponse } = require('./antigravity-server-search');
const { sanitizeClientIdentity } = require('./client-identity');
const { prepareStructuredOutput, prepareStructuredOutputAsync, finishResultAsync, finishResponse } = require('./agy-structured-output');
const { nativeClientToolResponse, attachClientToolResult } = require('./agy-tool-results');
const { runSync, runAsync } = require('./schema-steps');
const { prepareAntigravityTools, prepareAntigravityToolsAsync } = require('./antigravity-tool-contract');
const { CAPTURED_MODEL, nativeRetryDecision, nativeRetryDelayMs } = require('./agy-retry-policy');
const { GatewayError, upstreamTermination, validateToolChoice } = require('./protocol');
const { hasToolResultHistory } = require('./tool-history');

const DEFAULT_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const DAILY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';
const GENERATE_PATH = '/v1internal:generateContent';
const STREAM_PATH = '/v1internal:streamGenerateContent';
const MODELS_PATH = '/v1internal:fetchAvailableModels';
const IMAGE_MODEL = DEFAULT_IMAGE_MODEL;
const IMAGE_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']);
const MODEL_DISCOVERY_TIMEOUT_MS = Number(process.env.ANTIGRAVITY_DIRECT_MODEL_DISCOVERY_TIMEOUT_MS || 8000);
const DEFAULT_MAX_RETRIES = Math.max(0, Number(process.env.ANTIGRAVITY_DIRECT_MAX_RETRIES || 1));
const DEFAULT_RETRY_BASE_MS = Math.max(100, Number(process.env.ANTIGRAVITY_DIRECT_RETRY_BASE_MS || 1500));
const DEFAULT_USER_AGENT = cliUserAgent();
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
// Only statuses observed in actual agy error/retry/recovery captures belong
// here. HTTP failures are distinct from an uncaptured transport exception.
const NATIVE_HTTP_ERROR_STATUSES = new Set([400, 429, 500, 502, 503, 504]);
const NATIVE_CHECKPOINT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

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
  signal?.throwIfAborted();
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
  const messages = (normalized.messages || []).map(message => ({ ...message, parts: normalizedMessageParts(message) }));
  const resultIds = messages.flatMap(message => message.parts.filter(part => part?.type === 'tool_result').map(part => part.id));
  if (resultIds.length && (resultIds.some(id => typeof id !== 'string' || !id.trim())
    || !hasToolResultHistory({ messages: messages.map(message => message.role === 'tool'
      ? { ...message, role: 'user' } : message) }, resultIds))) {
    throw new DirectProviderError('工具结果必须对应请求中先前唯一且匹配的工具调用。', {
      code: 'invalid_tool_history', status: 400
    });
  }
  const toolNames = new Map();
  const callOrder = new Map();
  const contents = [];
  for (const message of messages) {
    const nativeParts = [];
    const preserveFilenames = message.parts.some(p => p?.type === 'media' && !/^image\//.test(p.mediaType || ''));
    for (const part of message.parts) {
      if (part?.type === 'tool_call') {
        const id = String(part.id || '').trim();
        const name = String(part.name || '').trim();
        if (!name) continue;
        if (id) toolNames.set(id, name);
        if (id) callOrder.set(id, callOrder.size);
        const args = Object.hasOwn(part, 'arguments') ? part.arguments : parseJsonValue(part.args ?? {});
        const recoveredSignature = String(part.thoughtSignature || thoughtSignatures?.get?.(id) || '').trim();
        nativeParts.push({
          functionCall: { ...(id ? { id } : {}), name, args },
          ...(recoveredSignature ? { thoughtSignature: recoveredSignature } : {})
        });
        continue;
      }
      if (part?.type === 'tool_result') {
        const id = String(part.id || '').trim();
        const name = String(part.name || toolNames.get(id) || deriveToolNameFromId(id)).trim();
        const result = parseJsonValue(part.content ?? part.result ?? '');
        if (!name) {
          nativeParts.push({ text: typeof result === 'string' ? result : compact(result) });
          continue;
        }
        const media = (part.media || []).filter((item) => item?.data).map((item) => ({
          inlineData: { mimeType: item.mediaType || item.mimeType || 'application/octet-stream', data: item.data }
        }));
        const response = {
          ...(id ? { id } : {}), name, response: nativeClientToolResponse(part, result),
          ...(media.length ? { parts: media } : {})
        };
        attachClientToolResult(response, part, result);
        nativeParts.push({ functionResponse: response });
        continue;
      }
      if (part?.type === 'media' && part.data) {
        // Attachment IDs belong to the client-side resolver. Random IDs in
        // prompt text broke exact history restoration on every media turn.
        // Retain filenames in non-image/mixed input as ordinary content, adjacent
        // to their bytes; do not invent native tool calls or image metadata for
        // user-uploaded audio/video/PDF. Their full agy upload layout is unverified.
        if (part.filename && preserveFilenames) nativeParts.push({ text: `File: ${String(part.filename)}` });
        const image = { inlineData: { mimeType: part.mediaType || 'application/octet-stream', data: String(part.data) } };
        nativeParts.push(registerImagePart(image, part));
        continue;
      }
      if (part?.type === 'text' && String(part.text || '')) nativeParts.push({ text: String(part.text) });
    }
    // agy's captured tool output is a separate model-role content, including
    // when an Anthropic client places tool_result and a new user text together.
    let current;
    for (const part of nativeParts) {
      const role = part.functionResponse ? 'model' : normalizedRole(message.role);
      if (!current || current.role !== role || Boolean(current.parts[0]?.functionResponse) !== Boolean(part.functionResponse)) {
        const previous = contents.at(-1);
        if (part.functionResponse && previous?.parts.every(p => p.functionResponse)) current = previous;
        // Real Codex Responses history splits one server-produced step into
        // an assistant message plus separate function_call/custom_tool_call
        // items. Rejoin that observed shape before timeline/signature lookup.
        // Do not merge plain adjacent answers, tool results or user turns, or
        // change the original client-visible history.
        else if (normalized.protocol === 'responses' && !part.functionResponse && role === 'model' && previous?.role === 'model'
          && !previous.parts.some(p => p.functionResponse)
          && (part.functionCall || previous.parts.some(p => p.functionCall))) current = previous;
        else { current = { role, parts: [] }; contents.push(current); }
      }
      current.parts.push(part);
    }
  }
  for (const content of contents) {
    if (content.parts.length > 1 && content.parts.every(p => p.functionResponse)) {
      content.parts.sort((a, b) => (callOrder.get(a.functionResponse.id) ?? Number.MAX_SAFE_INTEGER)
        - (callOrder.get(b.functionResponse.id) ?? Number.MAX_SAFE_INTEGER));
    }
  }
  return contents;
}

function* buildDirectRequestSteps(normalized, model, projectId, sessionId, repairInstruction = '', thoughtSignatures = null, native = {}, effects = {}) {
  const prepareTools = effects.prepareTools || prepareAntigravityTools;
  const prepareStructured = effects.prepareStructured || prepareStructuredOutput;
  const prepareContext = effects.prepareContext || prepareNativeContext;
  validateToolChoice(normalized.tools, normalized.toolChoice);
  const sourceTools = normalized.tools;
  const identity = sanitizeClientIdentity(normalized, { clientProfile: native.identityClientProfile || native.clientProfile || '' });
  native.clientIdentity = identity.metadata.profile;
  native.toolAdapter = yield prepareTools(identity.normalized, { ...native, sourceTools, clientIdentity: identity.metadata.profile });
  normalized = native.toolAdapter.normalized;
  const structured = yield prepareStructured(normalized, native);
  normalized = structured.normalized;
  native.structuredSchema = structured.schema;
  let generationConfig = generationProfile(normalized, model, native.modelInfo);
  if (native.checkpoint) {
    generationConfig ||= {};
    generationConfig.maxOutputTokens = Math.min(generationConfig.maxOutputTokens || 16384, 16384);
  }
  const request = {
    contents: contentsFromNormalized(normalized, thoughtSignatures, model),
    ...(generationConfig ? { generationConfig } : {}),
    ...(normalized.system || native.toolAdapter.instructions || structured.instructions || repairInstruction ? {
      systemInstruction: { role: 'user', parts: [{ text: [normalized.system, native.toolAdapter.instructions,
        normalized.parallelToolCalls === false && normalized.tools.length
          ? 'Request at most one client tool call in each response. Wait for its result before requesting another tool.' : '',
        structured.instructions, repairInstruction].filter(Boolean).join('\n\n') }] }
    } : {})
  };
  if (normalized.tools?.length) {
    request.tools = normalized.tools.map((tool) => ({ functionDeclarations: [{
      name: tool.name,
      description: tool.description || '',
      parameters: tool.nativeSchema
    }] }));
    const choice = normalized.toolChoice;
    const type = typeof choice === 'string' ? choice : choice?.type;
    const name = choice?.name || choice?.function?.name;
    // All six captured 1.5.2 models omit default toolConfig. Only explicit
    // client constraints should add it; named choices require that function.
    const mode = type === 'none' ? 'NONE' : name || type === 'required' || type === 'any' || type === 'tool' ? 'ANY' : 'AUTO';
    // A public model name fixes its reasoning configuration. An incompatible
    // tool constraint cannot silently disable it; client effort is irrelevant.
    assertGenerationCompatibility(model, generationConfig, mode);
    // Default Gemini AUTO was absent from every captured agy agent request.
    // Explicit client constraints and the existing Claude bridge remain native
    // functionCallingConfig values, not private gateway metadata.
    if (mode !== 'AUTO' || name) {
      request.toolConfig = { functionCallingConfig: { mode } };
      if (name) request.toolConfig.functionCallingConfig.allowedFunctionNames = [name];
    }
  }
  const state = native.state || newState('', '');
  native.context = yield prepareContext(state, request.contents, model, { metadata: native.modelInfo, now: native.now, checkpoint: native.checkpoint, compactionProfile: native.compactionProfile, clientProfile: native.clientProfile, imageStore: native.imageStore,
    restoreStreamRecovery: native.restoreStreamRecovery, toolAdapter: native.toolAdapter });
  request.contents = native.context.contents;
  return agentEnvelope({ ...request, model, project: projectId, state, metadata: native.modelInfo, now: native.now,
    step: native.context.step, requestType: native.checkpoint ? 'checkpoint' : 'agent' });
}

const buildDirectRequest = (...args) => runSync(buildDirectRequestSteps(...args));
const buildDirectRequestAsync = (normalized, model, projectId, sessionId, repair = '', signatures = null, native = {}) =>
  runAsync(buildDirectRequestSteps(normalized, model, projectId, sessionId, repair, signatures, native, {
    prepareTools: prepareAntigravityToolsAsync, prepareStructured: prepareStructuredOutputAsync,
    prepareContext: prepareNativeContextAsync
  }));

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

function imageFromResponse(value, requestedModel = IMAGE_MODEL) {
  const parts = partsFrom(value);
  const image = parts.find((part) => part?.inlineData?.data || part?.inline_data?.data);
  const inline = image?.inlineData || image?.inline_data;
  if (!inline?.data) return null;
  return {
    mimeType: firstString(inline.mimeType, inline.mime_type) || 'image/jpeg',
    data: String(inline.data),
    usage: usageFrom(value),
    model: firstString(value?.response?.modelVersion, value?.modelVersion) || requestedModel,
    responseId: firstString(value?.response?.responseId, value?.responseId),
    thoughtSignature: firstString(image.thoughtSignature, image.thought_signature)
  };
}

function consumeUpstreamValue(value, state, onDelta, onThinkingDelta) {
  if (!value || typeof value !== 'object') return;
  if (value.error) throw new DirectProviderError('Antigravity 直连上游返回错误。', {
    code: 'direct_upstream_error', status: Number(value.error.code) || 502, details: redact(value.error.message || compact(value.error))
  });
  const root = value.response || value;
  const reason = (root.candidates?.[0] || value.candidates?.[0])?.finishReason;
  if (reason) state.finishReason = reason;
  if (root.promptFeedback?.blockReason) state.promptBlockReason = root.promptFeedback.blockReason;
  const parts = partsFrom(value);
  state.receivedContent ||= parts.some(part => part.text || part.thoughtSignature || part.functionCall || part.function_call);
  for (const part of parts) {
    if (typeof part.text === 'string') {
      if (part.thought) {
        state.thinking = (state.thinking || '') + part.text;
        if (part.text) onThinkingDelta?.(part.text, part);
      } else {
        state.text += part.text;
        if (part.text) onDelta?.(part.text, part);
        if (part.thoughtSignature) state.textSignature = part.thoughtSignature;
      }
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
  if (existing && existing.name !== name) {
    throw new GatewayError('上游重复使用同一调用 ID 请求不同工具。', { code: 'invalid_tool_call', status: 502 });
  }
  const rawArguments = Object.hasOwn(call, 'args') ? call.args : Object.hasOwn(call, 'arguments') ? call.arguments : {};
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
  constructor({ fetchImpl = nativeCloudCodeFetch, authFile = '', localAuth = null, baseUrl = process.env.ANTIGRAVITY_DIRECT_BASE_URL || '', accessToken = '', refreshToken = '', projectId = '', userAgent = process.env.ANTIGRAVITY_DIRECT_USER_AGENT || DEFAULT_USER_AGENT, models = [], maxRetries = DEFAULT_MAX_RETRIES, retryBaseMs = DEFAULT_RETRY_BASE_MS, retryPolicy = process.env.ANTIGRAVITY_DIRECT_RETRY_POLICY || '', diagnosticReporter, sessionStore, directoryGuard = null } = {}) {
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
    const policy = String(retryPolicy).trim();
    if (policy && !['agy', 'legacy'].includes(policy)) throw new TypeError('Unknown Antigravity retry policy.');
    // Request translation is not an agent task-recovery policy. Restore the
    // original bounded transport retries by default; the existing explicit
    // agy setting stays opt-in for old configurations, never automatic.
    this.retryPolicy = policy || 'legacy';
    this.discoveredModels = [];
    this.imageGenerationModels = [];
    this.webSearchModels = [];
    this.discoveredModelInfo = new Map();
    this.fileAuth = {};
    this.authLoaded = false;
    this.projectLoaded = false;
    this.diagnosticReporter = typeof diagnosticReporter === 'function' ? diagnosticReporter : null;
    this.sessionStore = sessionStore || new AgySessionStore({ diagnosticReporter, directoryGuard });
    this.imageStore = this.sessionStore.directory ? new AgyImageStore({ directory: path.join(this.sessionStore.directory, 'images') }) : null;
  }

  bindDirectoryGuard(guard) {
    this.sessionStore?.bindDirectoryGuard?.(guard);
  }

  reportDiagnostic(event, fields = {}) {
    try { this.diagnosticReporter?.(event, fields); }
    catch { /* diagnostics are best effort */ }
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
    throw new DirectProviderError('没有可用的账号凭据，请通过看板 OAuth 添加账号。', { code: 'direct_auth_missing', status: 401 });
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
    if (!this.projectId) throw new DirectProviderError('账号项目发现未返回 project ID，请在看板重新授权或重新检测该账号。', { code: 'direct_project_missing', status: 400 });
    return this.projectId;
  }

  async listModels(signal, { force = false } = {}) {
    if (this.modelList.length) return [...this.modelList];
    if (!force && this.discoveredModels.length && Date.now() - this.modelsDiscoveredAt < 60_000) return [...this.discoveredModels];
    if (this.modelDiscovery) return this.modelDiscovery;
    this.modelDiscovery = this.discoverModels(signal);
    try { return await this.modelDiscovery; } finally { this.modelDiscovery = null; }
  }

  modelCatalog() {
    if (this.modelList.length) return [...this.modelList];
    return this.modelsDiscoveredAt ? [...new Set([...this.discoveredModels, ...this.imageGenerationModels])] : null;
  }

  projectRequestBody() {
    const project = this.projectId || this.loadAuth().projectId;
    return project ? { project } : {};
  }

  async probeAuthentication(signal) {
    const probeStartedAt = Date.now();
    let token = await this.access(signal);
    this.reportDiagnostic('auth_probe_token_ready', { durationMs: Date.now() - probeStartedAt });
    let lastError;
    let accountError;
    const bases = this.baseUrls();
    for (const [baseIndex, base] of bases.entries()) {
      for (let refresh = 0; refresh < 2; refresh += 1) {
        let response;
        let text = '';
        const requestStartedAt = Date.now();
        this.reportDiagnostic('auth_probe_request_started', { upstreamIndex: baseIndex + 1, refreshAttempt: refresh });
        try {
          response = await this.fetchImpl(`${base}${MODELS_PATH}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': this.userAgent },
            body: JSON.stringify(this.projectRequestBody()),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS)
          });
          text = await readBody(response);
        } catch (cause) {
          this.reportDiagnostic('auth_probe_request_failed', {
            upstreamIndex: baseIndex + 1,
            refreshAttempt: refresh,
            durationMs: Date.now() - requestStartedAt,
            ...errorDetails(cause)
          });
          lastError = new DirectProviderError('Antigravity 账号检测请求失败。', {
            code: 'direct_auth_probe_failed', status: 502, details: redact(cause.message), cause
          });
          break;
        }
        this.reportDiagnostic('auth_probe_response_received', {
          upstreamIndex: baseIndex + 1,
          refreshAttempt: refresh,
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
          ok: response.ok
        });
        if (response.ok) {
          try { JSON.parse(text || '{}'); }
          catch (cause) {
            lastError = new DirectProviderError('Antigravity 账号检测响应不是有效 JSON。', {
              code: 'direct_auth_probe_invalid', status: 502, details: redact(cause.message), cause
            });
            break;
          }
          this.reportDiagnostic('auth_probe_succeeded', { durationMs: Date.now() - probeStartedAt, status: response.status, upstreamIndex: baseIndex + 1 });
          return { ok: true, status: response.status };
        }
        if (response.status === 401 && refresh === 0) {
          this.reportDiagnostic('auth_probe_force_refresh_started', { upstreamIndex: baseIndex + 1 });
          try {
            token = await this.access(signal, true);
            this.reportDiagnostic('auth_probe_force_refresh_succeeded', { upstreamIndex: baseIndex + 1 });
            continue;
          } catch (error) {
            this.reportDiagnostic('auth_probe_force_refresh_failed', {
              upstreamIndex: baseIndex + 1,
              ...errorDetails(error)
            });
            lastError = error;
            if (error?.status === 401 || error?.status === 403) accountError ||= error;
            break;
          }
        }
        const details = upstreamErrorMessage(text) || redact(text);
        lastError = new DirectProviderError(details ? `Antigravity 账号检测失败：${details}` : 'Antigravity 账号检测失败。', {
          code: 'direct_auth_probe_rejected', status: response.status, details
        });
        if (response.status === 401 || response.status === 403) accountError ||= lastError;
        break;
      }
    }
    this.reportDiagnostic('auth_probe_failed', {
      durationMs: Date.now() - probeStartedAt,
      ...errorDetails(accountError || lastError)
    });
    throw accountError || lastError || new DirectProviderError('Antigravity 账号检测失败。', { code: 'direct_auth_probe_failed', status: 502 });
  }

  async discoverModels(signal) {
    const token = await this.access(signal);
    let lastError, accountError;
    for (const base of this.baseUrls()) {
      try {
        const response = await this.fetchImpl(`${base}${MODELS_PATH}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': this.userAgent },
          body: JSON.stringify(this.projectRequestBody()),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS)
        });
        const text = await readBody(response);
        if (!response.ok) throw new DirectProviderError('Antigravity 模型目录查询失败。', {
          code: 'direct_model_discovery_failed', status: response.status, details: upstreamErrorMessage(text)
        });
        let body;
        try { body = JSON.parse(text); }
        catch (cause) { throw new DirectProviderError('Antigravity 模型目录响应不是 JSON。', { code: 'direct_model_catalog_invalid', status: 502, cause }); }
        if (!body.models || typeof body.models !== 'object') throw new DirectProviderError('Antigravity 模型目录缺少 models。', { code: 'direct_model_catalog_invalid', status: 502 });
        const entries = Array.isArray(body.models)
          ? body.models.map(value => [extractModelId(value), value])
          : Object.entries(body.models).map(([id, value]) => [extractModelId(id) || extractModelId(value), value]);
        // Discovery also contains unavailable upgrade offers. A catalog entry
        // explicitly marked disabled is not an account's usable model, even
        // when it has limits, capabilities and a valid-looking public ID.
        const disabledModels = new Set(entries.filter(([, value]) => value?.disabled === true).map(([id]) => id));
        const models = entries.map(([id]) => id).filter(id => id && !disabledModels.has(id));
        this.discoveredModels = [...new Set(models)];
        this.imageGenerationModels = Array.isArray(body.imageGenerationModelIds)
          ? [...new Set(body.imageGenerationModelIds.map(extractModelId).filter(id => id && !disabledModels.has(id)))] : [];
        this.webSearchModels = Array.isArray(body.webSearchModelIds)
          ? [...new Set(body.webSearchModelIds.map(extractModelId).filter(id => id && !disabledModels.has(id)))] : [];
        this.modelsDiscoveredAt = Date.now();
        this.discoveredModelInfo = new Map(entries.filter(([id]) => id).map(([id, value]) => {
          const metadata = value && typeof value === 'object' ? value : {};
          return [id, {
            displayName: firstString(metadata.displayName, metadata.display_name) || id,
            maxTokens: Math.max(0, Number(metadata.maxTokens ?? metadata.max_tokens ?? 0) || 0),
            maxOutputTokens: Math.max(0, Number(metadata.maxOutputTokens ?? metadata.max_output_tokens ?? 0) || 0),
            ...(typeof (metadata.supportsImages ?? metadata.supports_images) === 'boolean'
              ? { supportsImages: metadata.supportsImages ?? metadata.supports_images } : {}),
            ...(typeof (metadata.supportsThinking ?? metadata.supports_thinking) === 'boolean'
              ? { supportsThinking: metadata.supportsThinking ?? metadata.supports_thinking } : {}),
            ...(typeof metadata.supportsVideo === 'boolean' ? { supportsVideo: metadata.supportsVideo } : {}),
            ...(typeof metadata.supportsAudio === 'boolean' ? { supportsAudio: metadata.supportsAudio } : {}),
            ...(metadata.supportedMimeTypes && typeof metadata.supportedMimeTypes === 'object'
              && !Array.isArray(metadata.supportedMimeTypes)
              ? { supportedMimeTypes: structuredClone(metadata.supportedMimeTypes) } : {}),
            ...(typeof metadata.model === 'string' ? { model: metadata.model } : {}),
            ...(Number.isFinite(metadata.thinkingBudget) ? { thinkingBudget: metadata.thinkingBudget } : {}),
            ...(Number.isFinite(metadata.thinkingLevel) || typeof metadata.thinkingLevel === 'string' ? { thinkingLevel: metadata.thinkingLevel } : {}),
            ...(typeof metadata.apiProvider === 'string' ? { apiProvider: metadata.apiProvider } : {})
          }];
        }));
        return [...this.discoveredModels];
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if (error.status === 401 || error.status === 403) accountError ||= error;
      }
    }
    // A temporary metadata outage may retain an actual previous catalog,
    // without advancing its timestamp. Auth failures must reach pool health.
    if (accountError) throw accountError;
    if (this.modelsDiscoveredAt) return [...this.discoveredModels];
    throw lastError || new DirectProviderError('Antigravity 未返回模型目录。', { code: 'direct_model_discovery_failed', status: 502 });
  }

  modelInfo(model) {
    const value = this.discoveredModelInfo.get(String(model || ''));
    return value ? structuredClone(value) : null;
  }

  imageModelCatalog() { return [...this.imageGenerationModels]; }

  webSearchModelCatalog() { return [...this.webSearchModels]; }

  async searchWeb({ query, model, maxOutputTokens, contents, instructions, generationConfig } = {}, { signal, onUpstreamAttempt } = {}) {
    signal?.throwIfAborted();
    validateSearchParameters({ query, maxOutputTokens, contents, instructions, generationConfig });
    if (!this.modelsDiscoveredAt) await this.listModels(signal);
    signal?.throwIfAborted();
    if (!model || !this.webSearchModels.includes(model)) {
      throw new GatewayError('账号目录没有声明指定的专用搜索模型。', { code: 'server_search_model_unavailable', status: 400 });
    }
    const token = await this.access(signal);
    const project = await this.project(signal, token);
    const body = searchRequest({ project, model, query, maxOutputTokens, contents, instructions, generationConfig });
    signal?.throwIfAborted();
    const base = this.baseUrls()[0];
    // A logical server-tool execution performs one physical helper request.
    // Do not hide retries or switch models behind the caller's max_uses.
    onUpstreamAttempt?.({ phase: 'start', base, model });
    let response;
    try {
      response = await this.fetchImpl(`${base}${GENERATE_PATH}`, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': this.userAgent },
        body: JSON.stringify(body)
      });
      onUpstreamAttempt?.({ phase: 'response', base, model, status: response.status, success: response.ok });
    } catch (error) {
      onUpstreamAttempt?.({ phase: 'response', base, model, status: 0, success: false });
      throw error;
    }
    const text = await readBody(response);
    if (!response.ok) throw new DirectProviderError('Antigravity 搜索服务请求失败。', {
      code: 'direct_search_upstream_error', status: response.status, details: upstreamErrorMessage(text)
    });
    let result;
    try { result = JSON.parse(text); }
    catch { throw new GatewayError('服务器搜索响应不是 JSON。', { code: 'invalid_server_search_response', status: 502 }); }
    const usage = result?.usageMetadata || result?.response?.usageMetadata || result?.usage;
    const knownCount = names => names.some(name => Number.isFinite(usage?.[name]) && usage[name] >= 0);
    return { ...parseSearchResponse(result, { model }), usage: usageFrom(result),
      usageKnown: knownCount(['promptTokenCount', 'inputTokens', 'input_tokens'])
        && knownCount(['candidatesTokenCount', 'outputTokens', 'output_tokens']) };
  }

  baseUrls() {
    if (this.baseUrl) return [this.baseUrl];
    return [DAILY_BASE_URL, DEFAULT_BASE_URL];
  }

  async generateImage({ prompt, model: requestedModel, aspectRatio = '1:1', images = [] } = {}, { signal, onUpstreamAttempt, nativeToolContext } = {}) {
    const model = imageModelName(requestedModel);
    const instruction = String(prompt || '').trim();
    if (!instruction) throw new DirectProviderError('生图请求缺少 prompt。', { code: 'image_prompt_missing', status: 400 });
    const ratio = IMAGE_ASPECT_RATIOS.has(String(aspectRatio || '')) ? String(aspectRatio) : '1:1';
    if (!Array.isArray(images) || images.length > 3) {
      throw new DirectProviderError('参考图最多 3 张。', { code: 'too_many_reference_images', status: 400 });
    }
    const imageContext = nativeToolContext ?? { trajectoryId: crypto.randomUUID(), stepIndex: 1 };
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(imageContext.trajectoryId || '')
      || !Number.isSafeInteger(imageContext.stepIndex) || imageContext.stepIndex < 1) {
      throw new GatewayError('内部生图请求缺少有效的原生轨迹或工具步骤。', { code: 'invalid_native_image_context', status: 502 });
    }
    if (model !== CAPTURED_IMAGE_MODEL && !this.modelsDiscoveredAt) await this.listModels(signal);
    assertImageModel(model, this.imageModelCatalog());
    let token = await this.access(signal);
    let project = await this.project(signal, token);
    const requestBody = {
      project,
      requestId: `image_gen/${Date.now()}/${imageContext.trajectoryId}/${imageContext.stepIndex}`,
      request: {
        contents: [{ role: 'user', parts: [
          { text: instruction },
          ...images.map((image) => ({ inlineData: {
            mimeType: firstString(image?.mimeType, image?.mediaType) || 'image/jpeg',
            data: String(image?.data || '')
          } }))
        ] }],
        generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: ratio } }
      },
      model,
      userAgent: 'antigravity',
      requestType: 'image_gen'
    };
    let lastFailure;
    const attempt = async (base, forceRefresh = false) => {
      if (forceRefresh) {
        token = await this.access(signal, true);
        project = await this.project(signal, token);
        requestBody.project = project;
      }
      onUpstreamAttempt?.({ phase: 'start', base, model });
      try {
        const response = await this.fetchImpl(`${base}${GENERATE_PATH}`, {
          method: 'POST', signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': this.userAgent },
          body: JSON.stringify(requestBody)
        });
        onUpstreamAttempt?.({ phase: 'response', base, model, status: response.status, success: response.ok });
        return response;
      } catch (error) {
        onUpstreamAttempt?.({ phase: 'response', base, model, status: 0, success: false });
        throw error;
      }
    };
    for (let retry = 0; retry <= this.maxRetries; retry += 1) {
      for (const base of this.baseUrls()) {
        let response;
        try {
          response = await attempt(base);
          if (response.status === 401) response = await attempt(base, true);
        } catch (error) {
          lastFailure = { error };
          continue;
        }
        const text = await readBody(response);
        if (response.ok) {
          let body;
          try { body = JSON.parse(text || '{}'); }
          catch (error) { throw new DirectProviderError('Antigravity 生图响应不是 JSON。', { code: 'image_response_invalid', status: 502, details: redact(text), cause: error }); }
          const image = imageFromResponse(body, model);
          if (!image) throw new DirectProviderError('Antigravity 生图响应没有图片数据。', { code: 'image_response_missing', status: 502 });
          return image;
        }
        const detail = upstreamErrorMessage(text);
        lastFailure = { response, status: response.status, detail, diagnostic: redact(text) };
        // A confirmed account/model quota reset cannot recover by changing
        // hosts. Hand the original 429 to the pool before a later transport
        // failure can replace it and lose the model-specific reset time.
        let hardQuota = false;
        if (response.status === 429) {
          try {
            const details = JSON.parse(text)?.error?.details;
            if (Array.isArray(details)) {
              const quota = details.find(item => item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
                && item.reason === 'QUOTA_EXHAUSTED');
              const positiveDuration = value => typeof value === 'string'
                && /^(?:\d+(?:\.\d+)?(?:ms|[smhd]))+$/.test(value)
                && [...value.matchAll(/\d+(?:\.\d+)?/g)].some(match => Number(match[0]) > 0);
              hardQuota = Boolean(quota && (Date.parse(quota.metadata?.quotaResetTimeStamp) > Date.now()
                || positiveDuration(quota.metadata?.quotaResetDelay)
                || details.some(item => item?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
                  && /^\d+(?:\.\d{1,9})?s$/.test(item.retryDelay || '') && positiveDuration(item.retryDelay))));
            }
          } catch { /* Unstructured/transient 429 retains the existing retry policy. */ }
        }
        if (hardQuota) {
          throw new DirectProviderError(detail ? `Antigravity 上游生图失败：${detail}` : 'Antigravity 上游生图失败。', {
            code: 'direct_image_upstream_error', status: 429, details: lastFailure.diagnostic
          });
        }
        if (response.status !== 429 && response.status < 500) {
          throw new DirectProviderError(detail ? `Antigravity 上游生图失败：${detail}` : 'Antigravity 上游生图失败。', {
            code: 'direct_image_upstream_error', status: response.status, details: detail
          });
        }
      }
      if (retry < this.maxRetries) await waitForRetry(retryAfterMs(lastFailure?.response, retry, this.retryBaseMs), signal);
    }
    if (lastFailure?.error) throw lastFailure.error;
    throw new DirectProviderError(lastFailure?.detail ? `Antigravity 上游生图失败：${lastFailure.detail}` : 'Antigravity 上游生图失败。', {
      code: 'direct_image_upstream_error', status: lastFailure?.status || 502, details: lastFailure?.diagnostic || lastFailure?.detail
    });
  }

  sessionOwner(auth) {
    return auth.sourcePath.startsWith('managed-account:') ? auth.sourcePath
      : JSON.stringify([auth.sourcePath || this.authFile, auth.refreshToken || auth.accessToken]);
  }

  async send(normalized, model, options = {}) {
    const { signal, sessionId, auxiliaryScope = '' } = options;
    await this.access(signal);
    const auth = this.loadAuth();
    // Managed auth supplies an identity-bound namespace, stable across token
    // refreshes for a known Google identity. Local/manual records include a
    // credential in the private namespace; the session store hashes it. Neither
    // private identity nor client session ID is emitted as an upstream field.
    const owner = this.sessionOwner(auth);
    const scope = auxiliaryScope === 'compaction' ? '' : auxiliaryScope;
    return this.sessionStore.transact(owner, sessionId ? `${sessionId}\0${scope}` : '', signal,
      (state, checkpoint) => this.sendInSession(normalized, model, options, state, checkpoint));
  }

  async sendInSession(normalized, model, { signal, sessionId, auxiliaryScope = '', nativeCompaction = '', nativeClientProfile = '', repairInstruction = '', onDelta, onThinkingDelta, onUpstreamAttempt, clientProjection } = {}, nativeState, checkpoint) {
    let token = await this.access(signal);
    let project = await this.project(signal, token);
    const compactionProfile = nativeCompaction === CLAUDE_COMPACTION_PROFILE ? nativeCompaction : '';
    const native = { state: nativeState, modelInfo: this.modelInfo(model), checkpoint: auxiliaryScope === 'compaction' || Boolean(compactionProfile), compactionProfile,
      clientProfile: model === CAPTURED_MODEL ? nativeClientProfile : '', identityClientProfile: nativeClientProfile, imageStore: this.imageStore, signal,
      restoreStreamRecovery: this.retryPolicy === 'agy' };
    const requestBody = await buildDirectRequestAsync(normalized, model, project, sessionId, repairInstruction, null, native);
    if (native.context.toolRecovery?.retryCount === 9) {
      // The actual tool receipt is retained, but the native retry budget is
      // exhausted. A new user turn may continue; identical SDK retries must
      // neither regenerate/execute the tool nor add an unsent logical request.
      checkpoint();
      throw new DirectProviderError('上一次响应流已中断，工具结果已保留。请发送新的用户消息继续。',
        { code: 'direct_stream_interrupted', status: 400 });
    }
    const pendingStream = native.context.streamRecovery;
    if (pendingStream?.terminal && pendingStream.contents.at(-1)?.role === 'model') {
      // An identical client retry has no new user turn after the saved partial
      // answer. Google rejects this actual model-ended history with HTTP 400.
      // Do not invent another native continuation after its budget is exhausted,
      // discard the partial answer, or allocate a request that cannot be sent.
      throw new DirectProviderError('上一次响应流已中断，部分回答已保留。请发送新的用户消息继续。',
        // Actual Claude SDK retries 409 ten times without new input. This is
        // an invalid continuation, not a transient conflict: return a local
        // non-retryable 400, as with the observed model-ended Google response.
        { code: 'direct_stream_interrupted', status: 400 });
    }
    // A terminal function's arguments, not preceding prose, are the final
    // structured answer. Never stream text that will be replaced locally.
    if (normalized.structuredSchema != null) onDelta = undefined;
    try { this.imageStore?.cleanup(native.context.imagePaths); }
    catch (error) { this.reportDiagnostic('native_image_cache_cleanup_failed', { code: error.code || 'cache_cleanup_failed' }); }
    let deferredToolDispatch = this.retryPolicy === 'agy' && model === CAPTURED_MODEL && !native.checkpoint
      && native.context.toolRecovery?.readyAt > Date.now();
    if (!native.checkpoint && !deferredToolDispatch) nativeState.requestIndex += 1;
    checkpoint();
    const emptyResponse = () => ({ text: '', thinking: '', textSignature: '', calls: [], usage: {}, receivedContent: false });
    let state = emptyResponse();
    const streamPrefix = native.context.inputContents;
    let streamContents = native.context.streamRecovery?.contents || [];
    let visiblePrefix = native.context.streamRecovery?.visibleText || '';
    let recoveredThinking = '';
    const recoveredUsage = {};
    // Pure first-turn text/thought captures have the same native continuation
    // shape as tool-result captures. Eligibility depends on the actual parsed
    // response below, not on whether the caller previously executed a tool.
    const canRecoverStream = this.retryPolicy === 'agy' && model === CAPTURED_MODEL && !native.checkpoint;
    const nativeEventBoundary = model === CAPTURED_MODEL && !native.checkpoint;
    let nativeFailures = native.context.streamRecovery?.terminal ? 0
      : native.context.streamRecovery?.retryCount ?? native.context.toolRecovery?.retryCount ?? streamContents.filter(isStreamError).length;
    let toolReadRecovery;
    if (visiblePrefix) onDelta?.(visiblePrefix);
    let attempted = false, contextCompleted = false, retryStepPending = false;
    const attempt = async (base, forceRefresh = false) => {
      signal?.throwIfAborted();
      if (deferredToolDispatch) {
        await waitForRetry(Math.max(0, native.context.toolRecovery.readyAt - Date.now()), signal);
        signal?.throwIfAborted();
        nativeState.requestIndex += 1;
        requestBody.requestId = `agent/${nativeState.cascadeId}/${Date.now()}/${nativeState.trajectoryId}/${native.context.step}`;
        deferredToolDispatch = false;
        checkpoint();
      }
      if (forceRefresh) {
        token = await this.access(signal, true);
        project = await this.project(signal, token);
        requestBody.project = project;
      }
      if (retryStepPending) {
        // An agent's failed HTTP attempt was recorded when it completed.
        // Reuse that next step without consuming another step for dispatch.
        // The logical counter and every content/signature byte stay unchanged.
        if (!native.checkpoint) {
          native.context.step = nativeState.nextStep;
          requestBody.request.labels.last_step_index = String(native.context.step - 1);
        }
        // Native checkpoint retries change only the timestamp, unlike agent
        // retries. Keep their step, logical counter and entire request intact.
        requestBody.requestId = `${native.checkpoint ? 'checkpoint' : 'agent'}/${nativeState.cascadeId}/${Date.now()}/${nativeState.trajectoryId}/${native.context.step}`;
        retryStepPending = false;
        checkpoint();
      }
      // agy streams generation upstream even when an API caller wants a single
      // final JSON response. Client streaming is a downstream-only choice.
      const url = `${base}${STREAM_PATH}?alt=sse`;
      onUpstreamAttempt?.({ phase: 'start', base, model });
      try {
        attempted = true;
        const response = await this.fetchImpl(url, {
          method: 'POST', signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': this.userAgent },
          body: JSON.stringify(requestBody)
        });
        onUpstreamAttempt?.({ phase: 'response', base, model, status: response.status, success: response.ok });
        return response;
      } catch (error) {
        onUpstreamAttempt?.({ phase: 'response', base, model, status: 0, success: false });
        throw error;
      }
    };
    let response;
    let lastFailure;
    const bases = this.baseUrls();
    let nativeRetry = this.retryPolicy === 'agy' && model === CAPTURED_MODEL;
    const retryLimit = () => nativeRetry ? (native.checkpoint ? 4 : 8) : this.maxRetries;
    try {
    while (true) {
    response = undefined;
    lastFailure = undefined;
    requestRounds:
    for (let retry = 0; retry <= retryLimit(); retry += 1) {
      for (const base of bases) {
        let candidate;
        try {
          candidate = await attempt(base, false);
          if (candidate.status === 401 && this.refreshToken) {
            await candidate.body?.cancel?.().catch(() => {});
            candidate = await attempt(base, true);
          }
        } catch (error) {
          signal?.throwIfAborted();
          lastFailure = { error };
          // No native transport-error baseline: retain existing failover.
          nativeRetry = false;
          continue;
        }
        if (candidate.ok) {
          response = candidate;
          break requestRounds;
        }
        const text = await readBody(candidate);
        const detail = upstreamErrorMessage(text);
        lastFailure = { response: candidate, status: candidate.status, detail, diagnostic: redact(text) };
        const decision = nativeRetry ? nativeRetryDecision(candidate.status, text) : null;
        if (!decision) nativeRetry = false;
        // Captured alternating 503 / response-read failures share one native
        // consecutive-failure budget, even when a stream error creates a new
        // logical request. A successful response header alone does not reset it.
        if (nativeRetry && !native.checkpoint) nativeFailures += 1;
        // Real agy also retains the final failed step when retries are exhausted
        // or cancelled during backoff. Persist the observed error now, not only
        // if another request is dispatched. Do not add a fake model message.
        // Only these HTTP statuses have a captured native agent baseline.
        if (!native.checkpoint && NATIVE_HTTP_ERROR_STATUSES.has(candidate.status)) {
          nativeState.nextStep = Math.max(native.context.step, nativeState.nextStep || 0) + 1;
          retryStepPending = true;
          if (streamContents.length) recordStreamRecovery(nativeState, streamPrefix, model,
            streamContents, visiblePrefix, Date.now(), false, nativeFailures);
          checkpoint();
        } else if (native.checkpoint && NATIVE_CHECKPOINT_RETRY_STATUSES.has(candidate.status)) {
          retryStepPending = true;
        }
        lastFailure.nativeMinimumMs = decision?.minimumMs || 0;
        const retryable = decision ? decision.retryable : candidate.status === 429 || candidate.status >= 500;
        if (!retryable) {
          throw new DirectProviderError(detail ? `Antigravity 上游请求失败：${detail}` : 'Antigravity 上游请求失败。', {
            code: 'direct_upstream_error', status: candidate.status, details: decision ? redact(text) : detail
          });
        }
        // Captured native HTTP failures retry the same endpoint. Do not add an
        // immediate normal-endpoint attempt between native retries. The pool
        // still rotates accounts after this account's policy is exhausted.
        if (nativeRetry) break;
        // Explicit legacy configuration, unobserved statuses and other models
        // retain daily -> normal failover, including transient HTTP 429.
      }
      if (nativeRetry && !native.checkpoint && nativeFailures >= 9) break;
      if (retry < retryLimit()) {
        const delay = nativeRetry
          ? nativeRetryDelayMs(native.checkpoint ? retry : nativeFailures - 1, { checkpoint: native.checkpoint, minimumMs: lastFailure?.nativeMinimumMs })
          : retryAfterMs(lastFailure?.response, retry, this.retryBaseMs);
        await waitForRetry(delay, signal);
      }
    }
    if (!response) {
      if (lastFailure?.error) throw lastFailure.error;
      const detail = lastFailure?.detail || '';
      throw new DirectProviderError(detail ? `Antigravity 上游请求失败：${detail}` : 'Antigravity 上游请求失败。', {
        code: 'direct_upstream_error', status: lastFailure?.status || 502, details: lastFailure?.diagnostic || detail
      });
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    try {
    if (contentType.includes('text/event-stream')) {
      const reader = response.body?.getReader?.();
      if (!reader) throw new DirectProviderError('Antigravity 流式响应缺少可读正文。', { code: 'direct_response_invalid' });
      const decoder = new TextDecoder();
      let buffer = '', eventLines = [];
      const consumeEvent = () => {
        const data = eventLines.join('\n'); eventLines = [];
        if (!data || data === '[DONE]') return;
        let parsed;
        try { parsed = JSON.parse(data); }
        catch {
          // Legacy non-captured profiles also accepted one complete JSON per
          // data line without event separators. Prefer the real SSE grammar;
          // use this fallback only if every individual line is complete JSON.
          const lines = data.split('\n');
          const values = lines.map(line => line === '[DONE]' ? null : jsonFromSseLine(line));
          if (!nativeEventBoundary && lines.every((line, i) => line === '[DONE]' || values[i])) {
            for (const value of values) if (value) consumeUpstreamValue(value, state, onDelta, onThinkingDelta);
            return;
          }
          throw new GatewayError('上游 SSE 事件不是有效 JSON。', { code: 'invalid_upstream_response', status: 502 });
        }
        consumeUpstreamValue(parsed, state, onDelta, onThinkingDelta);
      };
      const consumeLine = line => {
        // Captured agy does not dispatch a JSON data line until the SSE event's
        // terminating blank line arrives. A complete tool event does not need
        // a later STOP event; an unfinished event is never an executable call.
        if (line === '') consumeEvent();
        else if (line.startsWith('data:')) eventLines.push(line.slice(5).replace(/^ /, ''));
      };
      try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          consumeLine(line);
        }
      }
      // Other profiles retain their existing clean-EOF compatibility. This
      // does not extend high-profile read-error recovery or EOF tool dispatch.
      if (!nativeEventBoundary) { if (buffer) consumeLine(buffer); consumeEvent(); }
      } finally {
        // Release the upstream body on parser errors and downstream cancellation.
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } else {
      this._parseJson(await readBody(response), state, onDelta, onThinkingDelta);
    }
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code !== 'upstream_read_error' || !contentType.includes('text/event-stream')) throw error;
      if (!canRecoverStream) {
        // Deliver a complete committed call to the real executor. Do not
        // regenerate it, invent a continuation user, or veto the agent's retry.
        if (nativeEventBoundary && !native.structuredSchema && state.calls.length && state.calls.every(call =>
          call.id && call.thoughtSignature && call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments))) break;
        if (nativeEventBoundary && !state.calls.length) {
          interruptNativeContext(nativeState, native.context, model,
            { receivedContent: state.receivedContent, text: state.text, signature: state.textSignature });
          nativeState.lastExecutionId = crypto.randomUUID();checkpoint();
        }
        throw error;
      }
      if (state.calls.length) {
        if (native.structuredSchema || state.calls.some(call => !call.id || !call.thoughtSignature
          || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments))) throw error;
        // Deliver only complete, signed calls actually received in SSE events.
        // Defer the raw native error until matching real tool receipts arrive.
        // No STOP requirement: independently observed before and after STOP.
        nativeFailures += 1;
        toolReadRecovery = { retryCount: nativeFailures, readyAt: nativeFailures >= 9 ? 0 : Date.now() + nativeRetryDelayMs(nativeFailures - 1) };
        break;
      }
      if (!state.receivedContent) {
        // Actual agy retries a read failure before any parsed model content
        // within the SAME logical request, just like an HTTP error. There is
        // no interrupted model step and no user-role continuation message.
        nativeFailures += 1;
        nativeState.nextStep = Math.max(native.context.step, nativeState.nextStep || 0) + 1;
        retryStepPending = true;
        if (streamContents.length) recordStreamRecovery(nativeState, streamPrefix, model,
          streamContents, visiblePrefix, Date.now(), nativeFailures >= 9, nativeFailures);
        if (nativeFailures >= 9) nativeState.lastExecutionId = crypto.randomUUID();
        checkpoint();
        if (nativeFailures >= 9) throw error;
        state = emptyResponse();
        await waitForRetry(nativeRetryDelayMs(nativeFailures - 1), signal);
        continue;
      }
      const partial = state.text;
      nativeFailures += 1;
      // Nine consecutive real cuts exhausted agy after eight continuations.
      // The final interrupted model + terminal error consume two steps, but
      // that terminal error is NOT a ninth recovery user message.
      if (nativeFailures >= 9) {
        interruptNativeContext(nativeState, native.context, model,
          { receivedContent: true, text: partial, signature: state.textSignature });
        nativeState.nextStep += 1;
        if (partial) {
          streamContents = [...streamContents, { role: 'model', parts: [{ text: partial,
            ...(state.textSignature ? { thoughtSignature: state.textSignature } : {}) }] }];
          visiblePrefix += partial + '\n';
        }
        recordStreamRecovery(nativeState, streamPrefix, model, streamContents, visiblePrefix, Date.now(), true, nativeFailures);
        if (visiblePrefix) recordStreamProjection(nativeState, streamPrefix,
          { role: 'model', parts: [{ text: visiblePrefix }] }, model, streamContents);
        nativeState.lastExecutionId = crypto.randomUUID();
        state = emptyResponse();
        checkpoint();
        throw error;
      }
      const added = continueInterruptedStream(nativeState, native.context, model,
        { receivedContent: true, text: partial, signature: state.textSignature });
      // These deltas have already reached the client. Keep the final local
      // aggregate identical so emitters do not append the resumed thought a
      // second time after the answer. Unfinished thoughts stay out of history.
      recoveredThinking += state.thinking;
      streamContents = [...streamContents, ...added];
      if (partial) visiblePrefix += partial + '\n';
      for (const [key, value] of Object.entries(state.usage)) recoveredUsage[key] = (recoveredUsage[key] || 0) + value;
      requestBody.request.contents = native.context.contents;
      recordStreamRecovery(nativeState, streamPrefix, model, streamContents, visiblePrefix, Date.now(), false, nativeFailures);
      if (visiblePrefix) recordStreamProjection(nativeState, streamPrefix,
        { role: 'model', parts: [{ text: visiblePrefix }] }, model, streamContents);
      // Persist the actual error/history before waiting. An aborted backoff
      // must not allocate an unsent logical request or repeat its model step.
      state = emptyResponse();
      checkpoint();
      await waitForRetry(nativeRetryDelayMs(nativeFailures - 1), signal);
      if (partial) onDelta?.('\n');
      requestBody.request.labels.last_step_index = String(native.context.step - 1);
      requestBody.request.labels.request_id = `${nativeState.trajectoryId}-${nativeState.requestIndex++}`;
      requestBody.requestId = `agent/${nativeState.cascadeId}/${Date.now()}/${nativeState.trajectoryId}/${native.context.step}`;
      retryStepPending = false;
      checkpoint();
      continue;
    }
    break;
    }
    if (state.calls.length) {
      for (const call of state.calls) if (!call.id) call.id = `call_${crypto.randomUUID().replaceAll('-', '')}`;
    }
    const termination = upstreamTermination(state);
    if (termination === 'filtered' && state.calls.length) {
      throw new GatewayError('被上游过滤的响应不能执行工具。', { code: 'invalid_tool_call', status: 502 });
    }
    if (termination !== 'complete' && native.structuredSchema && state.calls.some(call => call.name === 'finish')) {
      // A locally executed finish receipt would falsely say the task completed.
      // Do not synthesize that receipt for an explicitly truncated terminal call.
      throw new GatewayError('上游结构化完成工具已截断，无法生成可信的完成回执。', { code: 'incomplete_structured_tool_call', status: 502 });
    }
    const finished = await finishResultAsync(native.structuredSchema, state.calls, { signal });
    const clientCalls = [];
    if (!finished) for (const call of state.calls) clientCalls.push(await native.toolAdapter.toClient(call));
    const historyParts = [];
    // Captured agy drops the thought-summary text on tool-call steps, but keeps
    // it on ordinary answer steps and always retains the provider signatures.
    if (!state.calls.length && state.thinking) historyParts.push({ text: state.thinking, thought: true });
    if (state.text) historyParts.push({ text: state.text, ...(state.textSignature ? { thoughtSignature: state.textSignature } : {}) });
    for (const call of state.calls) historyParts.push({ functionCall: {
      id: call.id, name: call.name, args: parseJsonValue(call.arguments)
    }, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) });
    contextCompleted = true;
    completeNativeContext(nativeState, native.context, model, { role: 'model', parts: historyParts });
    const visibleParts = historyParts.filter(p => !p.functionCall).concat(clientCalls.map(call => ({
      functionCall: { id: call.id, name: call.name, args: call.arguments },
      ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
    })));
    if (!finished && clientCalls.some((call, i) => call !== state.calls[i])) {
      recordClientProjection(nativeState, native.context.sourceContents,
        { role: 'model', parts: visibleParts }, model, [{ role: 'model', parts: historyParts }], Date.now(), { kind: 'client_tools' });
    }
    if (toolReadRecovery) recordToolStreamError(nativeState, native.context.sourceContents, model,
      { role: 'model', parts: historyParts }, toolReadRecovery.retryCount, toolReadRecovery.readyAt);
    if (finished) {
      const content = { role: 'model', parts: historyParts };
      const response = finishResponse(finished.call);
      completeNativeContext(nativeState, { ...native.context,
        sourceContents: [...native.context.sourceContents, content] }, model, response);
      // The client receives only its strict JSON. On an exact same-account,
      // same-model history echo, restore the actual signed finish call and
      // locally executed native terminal result, including after restart.
      recordClientProjection(nativeState, native.context.sourceContents,
        { role: 'model', parts: [{ text: finished.text }] }, model, [content, response]);
    }
    const combinedText = visiblePrefix + state.text;
    if (streamContents.length) {
      const visible = { role: 'model', parts: finished ? [{ text: finished.text }]
        : [...(combinedText ? [{ text: combinedText }] : []), ...visibleParts.filter(p => p.functionCall)] };
      recordStreamProjection(nativeState, streamPrefix, visible, model,
        [...streamContents, { role: 'model', parts: historyParts }, ...(finished ? [finishResponse(finished.call)] : [])]);
      clearStreamRecovery(nativeState, streamPrefix);
    }
    if (clientProjection && !native.checkpoint) {
      const prefix = restoreClientProjections(nativeState, contentsFromNormalized(clientProjection.source, null, model), model, { clientProfile: native.clientProfile,
        restoreStreamRecovery: native.restoreStreamRecovery, toolAdapter: native.toolAdapter });
      const source = native.context.sourceContents;
      if (prefix.length <= source.length && prefix.every((c, i) => contentFingerprint(c) === contentFingerprint(source[i]))) {
        const text = deliveryText({ text: combinedText, images: clientProjection.images });
        const emitted = clientProjection.streamedPrefix || '';
        const visibleText = emitted + streamTextRemainder(emitted, text);
        const visible = { role: 'model', parts: [...(visibleText ? [{ text: visibleText }] : []), ...visibleParts.filter(p => p.functionCall)] };
        const recordProjection = streamContents.length ? recordStreamProjection : recordClientProjection;
        recordProjection(nativeState, prefix, visible, model, [...source.slice(prefix.length), { role: 'model', parts: historyParts }]);
      }
    }
    if (!native.checkpoint && (!state.calls.length || finished)) nativeState.lastExecutionId = crypto.randomUUID();
    nativeState.usedClaude ||= /claude/i.test(model);
    nativeState.usedNonGemini ||= !/^gemini-/i.test(model);
    checkpoint();
    return {
      text: finished ? finished.text : combinedText,
      thinking: recoveredThinking + state.thinking,
      streamedText: finished ? '' : combinedText,
      toolCalls: clientCalls,
      ...(state.finishReason ? { finishReason: state.finishReason } : {}),
      ...(state.promptBlockReason ? { promptBlockReason: state.promptBlockReason } : {}),
      usage: Object.fromEntries([...new Set([...Object.keys(state.usage), ...Object.keys(recoveredUsage)])]
        .map(key => [key, (state.usage[key] || 0) + (recoveredUsage[key] || 0)])),
      conversationId: sessionId,
      // Internal metadata from this exact account's persisted native timeline.
      // The image subrequest occupies the tool step after this agent response;
      // its receipt will advance the timeline before the following generation.
      ...(clientCalls.length ? { nativeToolContext: { trajectoryId: nativeState.trajectoryId, stepIndex: nativeState.nextStep } } : {}),
      internalToolUsed: false
    };
    } catch (error) {
      // Captured terminal HTTP failures and backoff cancellations end the
      // execution just as text cancellation does. The HTTP error step is already
      // checkpointed above. Auth and transport failures remain unguessed.
      const observedTerminalHttpError = !response && NATIVE_HTTP_ERROR_STATUSES.has(lastFailure?.status);
      if (attempted && !contextCompleted && native.checkpoint && !state.calls.length
        && (signal?.aborted || observedTerminalHttpError)) {
        try {
          interruptCheckpointContext(nativeState, native.context,
            { terminalFailure: !signal?.aborted && observedTerminalHttpError });
          nativeState.lastExecutionId = crypto.randomUUID();
          checkpoint();
        } catch (saveError) {
          this.reportDiagnostic('interrupted_checkpoint_state_save_failed', { code: saveError.code || 'state_save_failed' });
        }
      } else if (attempted && !contextCompleted && !native.checkpoint && !state.calls.length
        && (signal?.aborted || observedTerminalHttpError)) {
        try {
          if (signal?.aborted) interruptNativeContext(nativeState, native.context, model,
            { receivedContent: state.receivedContent, text: state.text, signature: state.textSignature });
          if (streamContents.length) {
            const partial = state.text ? [{ role: 'model', parts: [{ text: state.text,
              ...(state.textSignature ? { thoughtSignature: state.textSignature } : {}) }] }] : [];
            const interruptedContents = [...streamContents, ...partial];
            const visible = visiblePrefix + state.text;
            const clientCancelled = signal?.aborted && signal.reason?.name === 'AbortError';
            recordStreamRecovery(nativeState, streamPrefix, model, interruptedContents,
              visible + (state.text ? '\n' : ''), Date.now(), true, nativeFailures, clientCancelled);
            if (visible) recordStreamProjection(nativeState, streamPrefix,
              { role: 'model', parts: [{ text: visible }] }, model, interruptedContents, Date.now(), clientCancelled);
          }
          nativeState.lastExecutionId = crypto.randomUUID();
          checkpoint();
        } catch (saveError) {
          this.reportDiagnostic('interrupted_native_state_save_failed', { code: saveError.code || 'state_save_failed' });
        }
      }
      throw error;
    }
  }

  _parseJson(text, state, onDelta, onThinkingDelta) {
    let body;
    try { body = JSON.parse(text || '{}'); } catch (error) { throw new DirectProviderError('Antigravity 直连响应不是 JSON。', { code: 'direct_response_invalid', status: 502, details: redact(text), cause: error }); }
    consumeUpstreamValue(body, state, onDelta, onThinkingDelta);
    return state;
  }
}

module.exports = {
  DAILY_BASE_URL,
  DEFAULT_BASE_URL,
  DirectAntigravityProvider,
  DirectProviderError,
  IMAGE_MODEL,
  MODEL_SLUG,
  buildDirectRequest,
  buildDirectRequestAsync,
  stableSessionId
};
