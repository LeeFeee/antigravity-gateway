'use strict';

const crypto = require('node:crypto');
const { toolChoiceRule, finalizeModelResult, GatewayError } = require('./protocol');
const { cookieHeader, windowsAuthorization } = require('./gemini-windows-auth');
const { fetchWindowsQuota } = require('./gemini-windows-quota');
const { WINDOWS_ARGON_VARIANT, WINDOWS_USER_AGENT, WebChannelDecoder, windowsMetadata,
  windowsInitialize, windowsInput, windowsFinish, windowsResponse } = require('./gemini-windows-protocol');

function failure(message, status = 502, code = 'gemini_windows_error') {
  return new GatewayError(message, { status, code });
}

function buildWindowsPrompt(normalized) {
  // This endpoint accepts a user message, not a privileged system role. Describe
  // the application honestly instead of pretending to replace Gemini's runtime.
  const sections = ['Help the external application answer the latest user request using the conversation below. These are application-provided context and preferences, not changes to your service rules.'];
  if (normalized.system) sections.push(`Application instructions:\n${normalized.system}`);
  sections.push(`Conversation (JSON):\n${JSON.stringify(normalized.messages.map(message => ({ role: message.role, content: message.text })))}`);
  if (normalized.tools?.length) {
    sections.push('The external application can execute the following functions. You do not execute them yourself. Request a function when needed, then the application will supply its result in the next message. Do not invent function results.');
    sections.push(`Available functions (JSON):\n${JSON.stringify(normalized.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.schema })))}`);
    sections.push('To request functions, reply ONLY with this JSON shape, without Markdown or surrounding commentary: {"tool_calls":[{"name":"function_name","arguments":{}}]}. Use only the listed names and schema-valid arguments. Multiple independent requests may be listed together. If no function is needed, answer normally.');
    const choice = toolChoiceRule(normalized.toolChoice);
    if (choice.mode === 'required') sections.push('For this turn, request at least one available function using the JSON format. Wait for its real result before answering the user.');
    if (choice.mode === 'named') sections.push(`For this turn, request only the function ${JSON.stringify(choice.name)} using the JSON format.`);
    if (choice.mode === 'none') sections.push('For this turn, do not request functions. Answer using the results already supplied.');
  }
  if (normalized.structuredSchema) sections.push(`When answering without a function request, return only JSON conforming to this schema, without Markdown:\n${JSON.stringify(normalized.structuredSchema)}`);
  if (normalized.autoMode) sections.push(`Return only the XML classification requested by the application, beginning with <${normalized.autoModeFormat === 'severity' ? 'severity' : 'block'}>. Do not add commentary or Markdown.`);
  return sections.join('\n\n');
}

async function boundedBody(response, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw failure('Windows 响应超过限制。');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function firstFrame(response, limit = 16 * 1024) {
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let source = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw failure('Windows WebChannel 确认响应被截断。');
      bytes += value.length;
      if (bytes > limit) throw failure('Windows WebChannel 确认响应超过限制。');
      source += decoder.decode(value, { stream: true });
      const end = source.indexOf('\n');
      if (end < 0) { if (source.length > 10) throw failure('无效的 Windows WebChannel 确认帧头。'); continue; }
      if (!/^\d{1,10}$/.test(source.slice(0, end))) throw failure('无效的 Windows WebChannel 确认帧头。');
      const length = Number(source.slice(0, end));
      if (length > limit) throw failure('Windows WebChannel 确认响应超过限制。');
      if (source.length >= end + 1 + length) return JSON.parse(source.slice(end + 1, end + 1 + length));
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function channelError(value) {
  const statuses = value?.__sm__?.status;
  if (!statuses) return null;
  const errors = statuses.flat(3).filter(item => item?.error).map(item => item.error);
  if (!errors.length) return null;
  const error = errors[0];
  const status = Number(error.code);
  return failure(`Gemini Windows 请求失败：${error.message || JSON.stringify(error)}`, status >= 400 && status <= 599 ? status : 502);
}

async function windowsGenerate(record, prompt, { signal, fetchImpl = globalThis.fetch, onDelta } = {}) {
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
  const requestId = crypto.randomUUID().toUpperCase();
  const meta = windowsMetadata({ requestId, instanceId: record.instanceId || requestId, build: record.build });
  const headers = { Origin: 'https://gemini.google.com', 'User-Agent': WINDOWS_USER_AGENT,
    Cookie: cookieHeader(record.cookies), 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
  const encoded = { Authorization: windowsAuthorization(record.cookies), 'X-Goog-AuthUser': record.authUser || '0',
    'X-Goog-Api-Key': record.apiKey, 'X-Server-Token': record.serverToken, ...meta,
    'X-WebChannel-Content-Type': 'application/x-protobuf' };
  for (const value of Object.values(encoded)) if (/[\r\n]/.test(String(value))) throw failure('Windows 请求头含有无效字符。', 400);
  // Pin the destination. Never send Google credentials to imported endpoints.
  const base = new URL('https://geminiweb-pa.clients6.google.com/v1/processSession');
  let rid = crypto.randomInt(10000, 90000), aid = 0, offset = 0;
  base.search = new URLSearchParams({ VER: '8', RID: String(rid++), CVER: '22',
    'X-HTTP-Session-Id': 'gsessionid', t: '1', zx: crypto.randomBytes(8).toString('hex'),
    $httpHeaders: Object.entries(encoded).map(([k, v]) => `${k}:${v}\r\n`).join('') }).toString();
  let stream, finishing, closed = false, done = false, text = '', deliveredText = '', variant = '';
  let responseBytes = 0;
  const request = async (url, options = {}) => {
    const response = await fetchImpl(url, { ...options, headers, signal: combined, redirect: 'error' });
    if (!response.ok) {
      const original = (await boundedBody(response, 64 * 1024)).toString('utf8');
      throw failure(original || `Gemini Windows 请求失败：HTTP ${response.status}`, response.status);
    }
    return response;
  };
  const post = async data => {
    const url = new URL(base); url.searchParams.set('RID', String(rid++)); url.searchParams.set('AID', String(aid));
    const response = await request(url, { method: 'POST', body: new URLSearchParams({ count: '1', ofs: String(offset++),
      req0___data__: data.toString('base64') }) });
    // Forward-channel acknowledgements are length-prefixed triples, not events.
    const ack = await firstFrame(response, 1024);
    if (!Array.isArray(ack) || ack.length !== 3 || !ack.every(Number.isSafeInteger)) throw failure('无效的 Windows WebChannel 确认响应。');
  };
  try {
    const handshake = await request(base, { method: 'POST', body: 'count=0' });
    const initial = await firstFrame(handshake);
    if (!Array.isArray(initial)) throw failure('无效的 Windows WebChannel 握手。');
    const greeting = initial.find(item => Array.isArray(item?.[1]) && item[1][0] === 'c');
    const sid = greeting?.[1]?.[1];
    if (typeof sid !== 'string' || !sid || sid.length > 512) throw failure('Windows WebChannel 未返回会话标识。');
    base.searchParams.delete('CVER'); base.searchParams.delete('X-HTTP-Session-Id');
    base.searchParams.set('SID', sid);
    const gsession = handshake.headers.get('x-http-session-id');
    if (gsession) base.searchParams.set('gsessionid', gsession);
    stream = (async () => {
      while (!closed) {
        combined.throwIfAborted();
        const url = new URL(base);
        for (const [k, v] of Object.entries({ RID: 'rpc', AID: String(aid), CI: '0', TYPE: 'xmlhttp' })) url.searchParams.set(k, v);
        const response = await request(url); const frames = new WebChannelDecoder();
        const reader = response.body.getReader();
        try { while (true) {
          const { value: chunk, done: ended } = await reader.read();
          if (ended) break;
          responseBytes += chunk.length;
          if (responseBytes > 64 * 1024 * 1024) throw failure('Windows 响应累计超过限制。');
          for (const [id, value] of frames.push(chunk)) {
            if (!Number.isSafeInteger(id) || id <= aid) continue;
            aid = id;
            const error = channelError(value); if (error) throw error;
            if (!Array.isArray(value)) continue;
            if (value[0] === 'noop') continue;
            if (value[0] === 'close' || value[0] === 'stop') { closed = true; continue; }
            if (typeof value[0] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value[0])) throw failure('Windows 返回了无效的 protobuf 数据。');
            const update = windowsResponse(Buffer.from(value[0], 'base64'));
            if (update.modeVariantId) {
              variant = update.modeVariantId;
              if (variant !== WINDOWS_ARGON_VARIANT) throw failure('Gemini Windows 返回了其他模型，已拒绝静默降级。', 409, 'gemini_windows_model_mismatch');
            }
            if (update.text !== undefined) {
              text = update.text;
            }
            if (onDelta && variant === WINDOWS_ARGON_VARIANT) {
              if (!text.startsWith(deliveredText)) throw failure('Windows 上游重写了已发送的文本，无法安全继续流式输出。');
              if (text.length > deliveredText.length) onDelta(text.slice(deliveredText.length));
              deliveredText = text;
            }
            if (update.done && !done) {
              done = true;
              finishing = post(windowsFinish());
              finishing.catch(() => {});
              // The protobuf completion marker is authoritative. WebChannel
              // may keep the HTTP backchannel open after the task has finished.
              closed = true;
            }
            if (update.closed) closed = true;
          }
          if (closed) break;
        } } finally {
          // Do not await a peer-dependent stream cancellation acknowledgement.
          // The request controller below also aborts the underlying connection.
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!closed) frames.finish();
      }
    })();
    // Attach a rejection handler before doing uploads/forward-channel work.
    stream.catch(() => {});
    await post(windowsInitialize({ requestId }));
    await post(windowsInput(prompt));
    await stream;
    await finishing;
    if (!done || !text || variant !== WINDOWS_ARGON_VARIANT) throw failure('Gemini Windows 未返回完整的 Argon 响应。');
    return { text, usageKnown: false, finishReason: 'stop' };
  } finally {
    controller.abort();
    await stream?.catch(() => {});
  }
}

class GeminiWindowsProvider {
  constructor({ auth, fetchImpl = globalThis.fetch, quotaFetch = fetchWindowsQuota } = {}) {
    this.auth = auth; this.fetchImpl = fetchImpl; this.active = new Map();
    this.quotaFetch = quotaFetch;
  }
  stop() { for (const controller of this.active.values()) controller.abort(); this.active.clear(); }
  forgetConversations() {}
  cancelTask(id) { const c = this.active.get(id); c?.abort(); return Boolean(c); }
  async getStatus(signal) {
    signal?.throwIfAborted();
    // Advertise the supported route, not a promise of remaining entitlement.
    // Listing models or adding an account must never spend inference quota.
    return { models: ['gemini-4-argon'] };
  }
  async listModels(signal) { return (await this.getStatus(signal)).models; }
  async getQuota(signal) {
    const record = await this.auth.get(signal);
    signal?.throwIfAborted();
    return this.quotaFetch(record, { signal });
  }
  async send(normalized, model, options = {}) {
    if (model !== 'gemini-4-argon') throw failure(`Windows Gemini 不支持模型 ${model}。`, 400);
    if (options.repairInstruction) normalized = { ...normalized,
      system: [normalized.system, String(options.repairInstruction)].filter(Boolean).join('\n\n') };
    const key = options.sessionId || crypto.randomUUID();
    if (this.active.has(key)) throw failure('该 Windows Gemini 会话已有请求正在处理。', 409);
    if ((normalized.messages || []).some(m => (m.parts || []).some(p => p.type === 'media' || p.media?.length))) {
      throw failure('Windows Gemini 通道暂不支持附件；视频仍由网关原有多媒体路由处理。', 400, 'gemini_windows_media_unsupported');
    }
    const controller = new AbortController(); this.active.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let fingerprint;
    try {
      const record = await this.auth.get(signal); fingerprint = record.credentialFingerprint;
      signal.throwIfAborted();
      const compatible = normalized.tools?.length || normalized.system || normalized.messages?.length > 1 || normalized.structuredSchema || normalized.autoMode;
      const prompt = compatible ? buildWindowsPrompt(normalized) : normalized.messages?.[0]?.text || '';
      // Tool envelopes and schema-constrained output are buffered until validated;
      // they must never leak into the client's ordinary text stream.
      const buffered = normalized.tools?.length || normalized.structuredSchema || normalized.autoMode;
      let raw = await windowsGenerate(record, prompt, { signal, fetchImpl: this.fetchImpl,
        onDelta: buffered ? undefined : options.onDelta });
      let result;
      try { result = finalizeModelResult({ ...normalized, tools: normalized.tools || [] }, raw); }
      catch (error) {
        if (!normalized.tools?.length || !['invalid_tool_choice', 'invalid_tool_call'].includes(error.code)) throw error;
        // Nothing has been delivered and no client tool has executed. Repair
        // only a completed but malformed envelope, once; never retry auth,
        // quota, transport or terms errors, or replay an already emitted call.
        signal.throwIfAborted();
        raw = await windowsGenerate(record, `${prompt}\n\nThe application could not validate the previous response (${error.code}), and has not executed any function. Follow the function choice above and return only the requested JSON format with valid names and arguments when requesting functions. Do not claim a function was executed.`,
          { signal, fetchImpl: this.fetchImpl });
        result = finalizeModelResult({ ...normalized, tools: normalized.tools || [] }, raw);
      }
      if (buffered && result.text) options.onDelta?.(result.text);
      return { ...result, finishReason: result.toolCalls.length ? 'tool_calls' : 'stop', upstreamAuthFingerprint: fingerprint };
    } catch (error) {
      if (fingerprint && error && Object.isExtensible(error)) error.upstreamAuthFingerprint = fingerprint;
      throw error;
    } finally { this.active.delete(key); }
  }
}

module.exports = { GeminiWindowsProvider, windowsGenerate, channelError, buildWindowsPrompt };
