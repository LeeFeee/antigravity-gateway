'use strict';

const crypto = require('node:crypto');
const { GeminiAccountAuth } = require('./gemini-auth');
const { GeminiRpcTransport } = require('./gemini-rpc');
const { GeminiOnboarding } = require('./gemini-onboarding');
const { GeminiGeneration } = require('./gemini-generation');
const { geminiRequestHeaders, geminiRequestMetadata } = require('./gemini-request-profile');
const { parseGeminiModelCatalog, publicGeminiModels } = require('./gemini-model-catalog');
const { prepareGeminiClientRequest, trailingGeminiToolResults, geminiClientToolResults, contractError } = require('./gemini-client-request');
const { messageField } = require('./gemini-wire');
const { geminiQuotaSnapshot } = require('./gemini-quota');
const { waitForShared } = require('./shared-task');

const CATALOG_TTL_MS = 60000;
const MAX_ACTIVE_TURNS = 128;

class GeminiProvider {
  constructor({ account, store, timeoutMs = 300000, diagnosticReporter, onFrame, initializationId = '' } = {}) {
    this.localAuth = new GeminiAccountAuth({ account, store, initializationId });
    this.transport = new GeminiRpcTransport({ credentials: this.localAuth.credentials.bind(this.localAuth), requestHeaders: geminiRequestHeaders, timeoutMs });
    this.onboarding = new GeminiOnboarding({ request: this.transport.request.bind(this.transport), metadata: geminiRequestMetadata });
    this.timeoutMs = timeoutMs;
    this.diagnosticReporter = diagnosticReporter;
    this.onFrame = onFrame;
    this.catalog = null;
    this.catalogAt = 0;
    this.catalogDiscovery = null;
    this.active = new Set();
    this.receipts = new Map();
    const disableAuth = this.localAuth.disable.bind(this.localAuth);
    this.localAuth.disable = () => { disableAuth(); this.dispose(); };
  }

  report(event, fields) { try { this.diagnosticReporter?.(event, fields); } catch { /* diagnostics cannot change routing */ } }

  async probeAuthentication(signal) {
    await this.localAuth.credentials({ signal });
    const status = await this.onboarding.status(signal);
    if (status.onboardingStatus !== 1) throw contractError('Gemini 账号尚未完成初始化，请在看板继续处理。', 'gemini_initialization_required', 409);
    const preference = await this.onboarding.preferences(signal);
    if (preference.activityEnabled) throw contractError('Gemini 活动偏好尚未符合账号初始化要求，请在看板重新检测。', 'gemini_initialization_preference_required', 409);
    return status.response;
  }

  async listModels(signal, { force = false } = {}) {
    signal?.throwIfAborted();
    if (!force && this.catalog && Date.now() - this.catalogAt < CATALOG_TTL_MS) return this.modelCatalog();
    if (!this.catalogDiscovery) {
      const pending = this.probeAuthentication(AbortSignal.timeout(45_000)).then(response => {
        this.catalog = parseGeminiModelCatalog(response);
        this.catalogAt = Date.now();
        return this.modelCatalog();
      }).finally(() => { if (this.catalogDiscovery === pending) this.catalogDiscovery = null; });
      this.catalogDiscovery = pending;
    }
    return waitForShared(this.catalogDiscovery, signal);
  }

  modelCatalog() { return this.catalog ? publicGeminiModels(this.catalog).map(model => model.id) : null; }
  modelInfo(id) { return this.catalog ? publicGeminiModels(this.catalog).find(model => model.id === id) || null : null; }
  imageModelCatalog() { return []; }
  webSearchModelCatalog() { return []; }

  async getQuota(signal) {
    const response = await this.transport.request('GetUsageInfo', messageField(1, geminiRequestMetadata()), { signal });
    return geminiQuotaSnapshot(response);
  }

  drop(entry) {
    clearTimeout(entry.timer);
    entry.generation.cancel();
    for (const id of entry.ids) if (this.receipts.get(id) === entry) this.receipts.delete(id);
    this.active.delete(entry);
  }

  dispose() { for (const entry of [...this.active]) this.drop(entry); }

  refreshExpiry(entry) {
    clearTimeout(entry.timer);
    entry.generation.deadline = Date.now() + this.timeoutMs;
    entry.timer = setTimeout(() => {
      entry.generation.fail(contractError('Gemini 任务等待当前请求或工具回传超时。', 'gemini_task_timeout', 504));
      this.drop(entry);
    }, this.timeoutMs + 1000);
    entry.timer.unref?.();
  }

  callerScope(options) {
    // Main entry passes mediaScope (bound to gateway credentials), clientId
    // and session/routing identity. This digest is local, never sent upstream.
    return crypto.createHash('sha256').update(JSON.stringify([options.mediaScope || '', options.clientId || '',
      options.routingKey || options.sessionId || '', options.auxiliaryScope || ''])).digest('hex');
  }

  async send(normalized, id, options = {}) {
    const { signal } = options;
    signal?.throwIfAborted();
    this.localAuth.current();
    await this.listModels(signal);
    const model = this.modelInfo(id);
    if (!model) throw contractError(`Gemini 账号没有模型 ${id} 的可用目录记录。`, 'gemini_model_unavailable', 404);
    const prepared = prepareGeminiClientRequest(normalized, options);
    const { results } = trailingGeminiToolResults(prepared.normalized);
    const scope = this.callerScope(options);
    let entry, continuing = false;
    if (results.length && results.some(result => String(result.id || '').startsWith('gemini_tool_'))) {
      entry = this.receipts.get(results[0].id);
      if (!entry || results.some(result => this.receipts.get(result.id) !== entry)) {
        throw contractError('Gemini 工具结果不属于当前账号的有效调用；请由客户端重新发起请求。', 'gemini_tool_session_missing', 409);
      }
      if (entry.scope !== scope) throw contractError('Gemini 工具结果不属于当前客户端会话。', 'gemini_tool_scope_mismatch', 403);
      if (entry.busy) throw contractError('Gemini 同一工具调用已有请求正在处理。', 'gemini_tool_session_busy', 409);
      if (entry.model.upstreamId !== model.upstreamId || entry.model.thinkingLevel !== model.thinkingLevel) {
        throw contractError('Gemini 工具回传期间模型配置已改变，请由客户端重新发起请求。', 'gemini_tool_model_changed', 409);
      }
      continuing = true;
    } else {
      for (const stale of this.active) if (stale.generation.finished) this.drop(stale);
      if (this.active.size >= MAX_ACTIVE_TURNS) throw contractError('Gemini 待回传工具请求过多，请完成或取消现有请求后重试。', 'gemini_active_turn_limit', 429);
      const controller = new AbortController();
      const generation = new GeminiGeneration({ transport: this.transport, prompt: prepared.prompt, model,
        tools: prepared.toolExecutionEnabled ? prepared.tools : [], signal: controller.signal,
        timeoutMs: this.timeoutMs, onFrame: this.onFrame, onUpstreamAttempt: options.onUpstreamAttempt });
      entry = { generation, controller, model, scope, ids: new Set(), busy: false };
      this.active.add(entry);
    }
    entry.busy = true;
    // Bound each active request/tool-result wait. A valid multi-round task
    // must not expire merely because its first request started minutes ago.
    this.refreshExpiry(entry);
    const abort = () => entry.controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let text = '', thinking = '', responseReported = false;
    const reportResponse = success => {
      if (responseReported) return;
      responseReported = true;
      // Suppress the pool's legacy one-call-per-send fallback. Native RPC
      // completion is counted by GeminiGeneration, including confirmation
      // continuation RPCs and errors after an earlier HTTP tool response.
      options.onUpstreamAttempt?.({ phase: 'response', success, count: false, provider: 'gemini', model: model.upstreamId });
    };
    try {
      if (continuing) {
        entry.generation.replaceTools(prepared.toolExecutionEnabled ? prepared.tools : []);
        await entry.generation.submitToolResults(geminiClientToolResults(results, prepared));
        for (const result of results) { this.receipts.delete(result.id); entry.ids.delete(result.id); }
      } else {
        await entry.generation.start();
      }
      while (true) {
        const next = await entry.generation.next();
        if (next.done) throw contractError('Gemini 生成在没有结果时结束。', 'gemini_generation_incomplete', 502);
        const event = next.value;
        if (event.type === 'error') throw event.error;
        if (event.type === 'text_delta') { text += event.delta; options.onDelta?.(event.delta); }
        else if (event.type === 'thinking_delta') { thinking += event.delta; options.onThinkingDelta?.(event.delta); }
        else if (event.type === 'tool_calls') {
          for (const call of event.toolCalls) { entry.ids.add(call.id); this.receipts.set(call.id, entry); }
          reportResponse(true);
          this.refreshExpiry(entry);
          return { text, thinking, streamedText: text, toolCalls: event.toolCalls, usage: {}, usageKnown: false,
            internalToolUsed: false, conversationId: options.sessionId, providerType: 'gemini' };
        } else if (event.type === 'completed') {
          const nativeSearch = event.result.nativeSearch;
          if (prepared.normalized.serverSearch?.mode === 'none' && nativeSearch) {
            throw contractError('Gemini 未遵守禁止服务器搜索的约定。', 'gemini_server_search_not_allowed', 502);
          }
          if (prepared.normalized.serverSearch?.mode === 'required' && nativeSearch?.state !== 4) {
            throw contractError('Gemini 未完成要求的原生 Google 搜索。', 'gemini_server_search_incomplete', 502);
          }
          reportResponse(true);
          this.report('gemini_generation_completed', { model: id, actualModel: event.result.metadata,
            transport: event.result.transport, continuing });
          this.drop(entry);
          return { text, thinking, streamedText: text, toolCalls: [], usage: event.result.usage, usageKnown: false,
            sources: event.result.sources, finishReason: 'STOP', internalToolUsed: false,
            ...(prepared.normalized.serverSearch && nativeSearch?.state === 4 ? { webSearch: {
              sources: [...(event.result.sources || []), ...(nativeSearch.sources || [])]
            } } : {}),
            conversationId: options.sessionId, providerType: 'gemini' };
        }
      }
    } catch (error) {
      reportResponse(false);
      this.drop(entry);
      throw error;
    } finally {
      entry.busy = false;
      signal?.removeEventListener('abort', abort);
    }
  }
}

module.exports = { GeminiProvider };
