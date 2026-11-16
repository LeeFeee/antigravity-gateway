'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { field, decodeFields, messageField: m, stringField: s, intField: i, concatFields: c } = require('./gemini-wire');
const { encodeGeminiStruct, decodeGeminiStruct } = require('./gemini-struct');
const { geminiGenerationMessages, geminiRequestMetadata } = require('./gemini-request-profile');
const { geminiTaskResult } = require('./gemini-task-result');
const { matchesGeminiModel } = require('./gemini-model-catalog');
const { GatewayError } = require('./protocol');
const { geminiToolConfirmation } = require('./gemini-tool-confirmation');
const { geminiResponseSources, geminiDisplayText } = require('./gemini-sources');
const { prepareGeminiToolSchema, decodeGeminiToolArguments } = require('./gemini-tool-schema');
const { geminiSearchState } = require('./gemini-search-state');
const { CLIENT_UPDATE_PREFIX } = require('./gemini-client-request');

function repeated(bytes, tag) { return decodeFields(bytes).filter(item => item.number === tag && item.wireType === 2).map(item => item.value); }
function text(bytes, tag) { return field(bytes, tag, 2)?.toString('utf8') || ''; }
// Local conversion and response-contract failures are not evidence that an
// account is unhealthy. Preserve their status at the HTTP boundary without
// cooling or replaying them across accounts; transport errors stay distinct.
function failure(message, code, status = 502) { return new GatewayError(message, { code, status }); }

// One native generation and its remote-tool exchange. This module never
// executes a client tool, reconstructs an agent's context or retries a task.
// A provider must bind the object to its account/grant and caller scope and
// release it after completion, cancellation, expiry or account invalidation.
class GeminiGeneration {
  constructor({ transport, prompt, model, tools = [], signal, timeoutMs = 300000, onFrame, onUpstreamAttempt } = {}) {
    if (!transport?.open) throw new TypeError('Gemini generation requires an RPC transport');
    if (!Array.isArray(tools)) throw new TypeError('Gemini tools must be an array');
    this.replaceTools(tools);
    this.deviceId = crypto.randomUUID().toUpperCase();
    this.messages = geminiGenerationMessages({ prompt, model, tools: tools.length > 0, deviceId: this.deviceId });
    Object.assign(this, { transport, model, signal, timeoutMs, onFrame, onUpstreamAttempt });
    this.pending = new Map();
    this.responses = new Map();
    this.remotes = new Set();
    this.queue = [];
    this.waiter = null;
    this.finished = false;
    this.started = false;
    this.metadata = { complete: false, usageKnown: false };
    this.nativeSearch = null;
    this.streamEpoch = 0;
    this.readbackExcludedIds = new Set();
    this.currentPrompt = prompt;
  }

  replaceTools(tools) {
    const next = new Map();
    const nativeTools = new Map(), encodedTools = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name || next.has(tool.name)) throw failure('Gemini 工具声明名称缺失或重复。', 'gemini_tool_declaration_invalid', 400);
      if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw failure('Gemini 工具声明缺少参数结构。', 'gemini_tool_declaration_invalid', 400);
      const original = decodeGeminiStruct(encodeGeminiStruct(tool));
      next.set(tool.name, original);
      const prepared = prepareGeminiToolSchema(original);
      nativeTools.set(tool.name, prepared.tool);
      if (prepared.encoded) encodedTools.add(tool.name);
    }
    this.tools = next;
    this.nativeTools = nativeTools;
    this.encodedTools = encodedTools;
  }

  async start() {
    if (this.started) throw new Error('Gemini generation already started');
    this.started = true;
    this.deadline = Date.now() + this.timeoutMs;
    return this.openProcess(this.messages);
  }

  async openProcess(messages) {
    const epoch = ++this.streamEpoch;
    clearTimeout(this.readbackTimer);
    this.readbackEpoch = 0;
    if (this.identifiers?.requestId) this.readbackExcludedIds.add(this.identifiers.requestId);
    this.identifiers = null;
    const initial = field(messages[0], 1000, 2);
    const generate = initial && field(field(initial, 1001, 2), 1, 2);
    const query = generate && field(generate, 1, 2);
    if (query) this.currentPrompt = text(query, 1);
    try {
      this.signal?.throwIfAborted();
      this.attemptPending = true;
      this.reportAttempt({ phase: 'start', provider: 'gemini', model: this.model.upstreamId, thinkingLevel: this.model.thinkingLevel });
      this.process = await this.transport.open('ProcessQuery', { signal: this.signal, timeoutMs: this.timeoutMs,
        onMessage: async bytes => { this.onFrame?.('process-response', bytes); await this.consume(bytes); } });
      this.process.done.then(result => {
        if (epoch !== this.streamEpoch) return;
        // A resumed Task may omit the already-known RUNNING status. Its
        // successful RPC EOF still needs the same task's stored result.
        if (!this.metadata.complete && this.taskConversationId && this.metadata.goalStatus !== 3
          && !this.metadata.punt && !this.metadata.fallback) {
          if (this.readbackEpoch !== epoch) {
            this.readbackEpoch = epoch;
            this.readTaskResult(result, epoch);
          }
        } else this.complete(result);
      }, error => { if (epoch === this.streamEpoch) this.fail(error); });
      for (const message of messages) { this.onFrame?.('process-request', message); this.process.write(message); }
      this.messages = null;
      this.process.end();
    } catch (error) { this.fail(error); }
    return this;
  }

  reportAttempt(event) { try { this.onUpstreamAttempt?.(event); } catch { /* accounting cannot change execution */ } }

  finishAttempt(success) {
    if (!this.attemptPending) return;
    this.attemptPending = false;
    this.reportAttempt({ phase: 'response', success, count: true, provider: 'gemini', model: this.model.upstreamId });
  }

  emit(event) {
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value: event, done: false }); }
    else this.queue.push(event);
  }

  next() {
    if (!this.started) return Promise.reject(new Error('Gemini generation has not started'));
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.finished) return Promise.resolve({ done: true });
    if (this.waiter) return Promise.reject(new Error('Concurrent Gemini event consumers are not supported'));
    return new Promise(resolve => { this.waiter = resolve; });
  }

  [Symbol.asyncIterator]() { return this; }
  async return() { this.cancel(); return { done: true }; }
  cancel() { this.fail(new DOMException('Gemini 生成已取消。', 'AbortError')); }

  closeStreams() {
    clearTimeout(this.readbackTimer);
    this.deferredCompletion = null;
    this.process?.cancel();
    for (const remote of this.remotes) remote.cancel();
    this.remotes.clear();
    this.pending.clear();
  }

  async readTaskResult(transport, epoch) {
    if (this.finished || epoch !== this.streamEpoch) return;
    try {
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) throw failure('Gemini 任务结果等待超时。', 'gemini_task_timeout', 504);
      const request = c([s(1, this.taskConversationId), i(2, 10), m(4, i(1, 1)),
        m(6, geminiRequestMetadata({ modelId: this.model.upstreamId, tools: true, deviceId: this.deviceId }))]);
      this.onFrame?.('task-readback-request', request);
      const bytes = await this.transport.request('ListConversationTurns', request, { signal: this.signal, timeoutMs: Math.min(30000, remaining) });
      if (this.finished || epoch !== this.streamEpoch) return;
      this.onFrame?.('task-readback-response', bytes);
      const result = geminiTaskResult(bytes, { conversationId: this.taskConversationId,
        requestId: this.identifiers?.requestId, prompt: this.currentPrompt, excludedRequestIds: this.readbackExcludedIds });
      if (result) {
        await this.consume(result.message);
        if (this.metadata.complete) { this.complete(transport); return; }
      }
      this.readbackTimer = setTimeout(() => this.readTaskResult(transport, epoch), 1000);
      this.readbackTimer.unref?.();
    } catch (error) { if (epoch === this.streamEpoch) this.fail(error); }
  }

  fail(error) {
    if (this.finished) return;
    if (error?.name === 'AbortError') this.attemptPending = false;
    else this.finishAttempt(false);
    this.finished = true;
    this.closeStreams();
    // Do not deliver buffered tool actions after their native task failed.
    this.queue = [];
    this.emit({ type: 'error', error });
  }

  complete(transport) {
    if (this.finished || this.waitingConfirmation) return;
    try {
      if (!this.metadata.complete) throw failure('Gemini 未返回完整的业务结束标记。', 'gemini_generation_incomplete');
      const confirmationBoundary = this.confirmationCard && this.metadata.goalStatus === 2
        && !this.metadata.punt && !this.metadata.fallback;
      if (this.pending.size) {
        // A real Task can publish its next confirmation while an earlier
        // remote tool is still being reviewed/executed by the client. This
        // is a waiting boundary, not task completion. Keep the offered card
        // until every outstanding result has actually been returned.
        if (confirmationBoundary) { this.deferredCompletion = transport; return; }
        throw failure('Gemini 在客户端工具结果回传前结束。', 'gemini_tool_exchange_incomplete');
      }
      this.deferredCompletion = null;
      if (this.confirmedResult) throw failure('Gemini 未接收客户端已经执行的工具结果。', 'gemini_confirmed_result_unconsumed');
      if (confirmationBoundary) {
        if (!this.identifiers?.conversationId || !this.identifiers.requestId) throw failure('Gemini 工具确认缺少上游关联标识。', 'gemini_tool_confirmation_identifiers_missing');
        // ProcessQuery has ended at a native confirmation boundary. Keep
        // the task's remote channel alive until the client's result arrives;
        // cancelling that channel can terminate the server-side task itself.
        // The next ProcessQuery can announce the same conversation again.
        // Its live remote channel belongs to the task, not one ProcessQuery:
        // retain it instead of opening a competing connection at every card.
        const id = `gemini_tool_${crypto.randomBytes(16).toString('hex')}`;
        const card = this.confirmationCard;
        this.waitingConfirmation = { ...card, id, ...this.identifiers };
        this.finishAttempt(true);
        this.emit({ type: 'tool_calls', toolCalls: [{ id, name: card.name,
          arguments: decodeGeminiToolArguments(card.arguments, this.encodedTools.has(card.name)) }] });
        return;
      }
      if (this.metadata.confirmation || [2, 3, 4].includes(this.metadata.goalStatus) || this.metadata.punt || this.metadata.fallback) {
        throw failure('Gemini 任务尚未正常完成。', 'gemini_task_not_completed');
      }
      if (!matchesGeminiModel(this.model, this.metadata)) {
        throw failure('Gemini 返回的模型或思考档位与指定配置不一致。', 'gemini_model_configuration_mismatch');
      }
      const responses = [...this.responses.values()];
      const answer = responses.map(item => item.text).filter(Boolean).join('\n');
      if (!answer) throw failure('Gemini 结束时未返回有效正文。', 'gemini_empty_response');
      // Task search has no per-tool completion enum. Only a normally completed
      // native task plus its typed allToolsUsed evidence closes that operation.
      if (this.nativeSearch?.protocol === 'task' && this.nativeSearch.taskToolUsed) {
        this.nativeSearch = { ...this.nativeSearch, state: 4, completionEvidence: 'native_task_completed' };
      }
      this.finishAttempt(true);
      this.finished = true;
      this.closeStreams();
      this.emit({ type: 'completed', result: { text: answer,
        thinking: responses.map(item => item.thinking).filter(Boolean).join('\n'),
        sources: responses.flatMap(item => item.sources || []),
        nativeSearch: this.nativeSearch,
        usage: {}, usageKnown: false, metadata: { ...this.metadata },
        transport: Object.fromEntries(['httpStatus', 'grpcStatus', 'messageCount', 'receivedBytes', 'decodedBytes',
          'firstByteMs', 'firstMessageMs', 'elapsedMs'].map(key => [key, transport[key]])) } });
    } catch (error) { this.fail(error); }
  }

  async connectTools(conversationId) {
    if (!this.tools.size && !this.confirmedResult && !this.pending.size) return;
    if (this.remoteConnecting) {
      if (this.conversationId !== conversationId) throw failure('Gemini 工具通道返回了不同会话。', 'gemini_tool_session_mismatch');
      // A continuation announces the same conversation before the previous
      // remote RPC necessarily closes. Its sessionComplete message, rather
      // than HTTP EOF, releases that round's tool channel.
      if (this.remoteEpoch !== this.streamEpoch) this.remoteContinuation = conversationId;
      return this.remoteConnecting;
    }
    this.conversationId = conversationId;
    this.remoteEpoch = this.streamEpoch;
    this.remoteConnecting = (async () => {
      const remote = await this.transport.open('ExecuteRemoteTools', { service: 'notify', signal: this.signal,
        timeoutMs: this.timeoutMs, onMessage: bytes => {
          this.onFrame?.('remote-response', bytes);
          this.consumeTools(bytes, remote);
        } });
      this.remote = remote;
      this.remotes.add(remote);
      remote.done.then(() => {
        this.remotes.delete(remote);
        if (this.remote !== remote) return;
        this.remote = null;
        this.remoteConnecting = null;
        if (!this.finished && !this.waitingConfirmation
          && !(this.confirmationCard && this.metadata.goalStatus === 2)) this.fail(failure('Gemini 工具通道提前关闭。', 'gemini_tool_stream_closed'));
      }, error => {
        this.remotes.delete(remote);
        if (this.remote !== remote) return;
        this.remote = null;
        this.remoteConnecting = null;
        if (!this.finished) this.fail(error);
      });
      if (this.finished) { remote.cancel(); return; }
      const connect = m(1, s(1, conversationId));
      this.onFrame?.('remote-request', connect); remote.write(connect);
    })();
    return this.remoteConnecting;
  }

  writeToolResult(name, id, value, remote = this.remote) {
    const message = m(2, m(1, c([s(1, name), s(2, id), m(3, encodeGeminiStruct(value))])));
    this.onFrame?.('remote-request', message);
    remote.write(message);
  }

  consumeTools(bytes, remote = this.remote) {
    if (this.finished) return;
    if (field(bytes, 3, 2) !== undefined) {
      // The native server can leave this RPC open after sessionComplete.
      // Retire it only on that explicit boundary, then connect the already
      // announced continuation. Never open competing channels for one round.
      if (this.remote === remote) {
        const continuation = this.remoteContinuation;
        this.remoteContinuation = null;
        this.remote = null;
        this.remoteConnecting = null;
        this.remotes.delete(remote);
        remote.cancel();
        if (continuation) this.connectTools(continuation).catch(error => this.fail(error));
      }
      return;
    }
    const wrapper = field(bytes, 2, 2);
    if (!wrapper) return;
    const calls = [];
    for (const call of repeated(wrapper, 1)) {
      const name = text(call, 1), id = text(call, 2), rawArgs = field(call, 3, 2);
      const args = rawArgs ? decodeGeminiStruct(rawArgs) : {};
      if (name === 'list_mcp') {
        this.writeToolResult(name, id, { servers: [{ name: 'external_client',
          description: 'Tools provided and executed by the connected agent.', tools: [...this.nativeTools.values()] }] }, remote);
        continue;
      }
      if (name !== 'execute_mcp' || args.ServerName !== 'external_client'
        || !args.Arguments || typeof args.Arguments !== 'object' || Array.isArray(args.Arguments)) {
        throw failure('Gemini 请求了未声明或无法映射的客户端工具。', 'gemini_undeclared_client_tool');
      }
      if (this.confirmedResult) {
        const confirmed = this.confirmedResult;
        if (args.ToolName !== confirmed.name || !isDeepStrictEqual(args.Arguments, confirmed.arguments)) {
          throw failure('Gemini 确认后的工具与客户端已处理的工具不一致，未重复执行。', 'gemini_confirmed_tool_mismatch');
        }
        this.writeToolResult(name, id, confirmed.result, remote);
        this.confirmedResult = null;
        continue;
      }
      // The current client may remove a tool after executing it. Its existing
      // confirmed result above still belongs to that exact old invocation;
      // only new actions must belong to the current catalog.
      if (!this.tools.has(args.ToolName)) throw failure('Gemini 请求了未声明或无法映射的客户端工具。', 'gemini_undeclared_client_tool');
      const publicId = `gemini_tool_${crypto.randomBytes(16).toString('hex')}`;
      this.pending.set(publicId, { nativeName: name, nativeId: id, remote });
      calls.push({ id: publicId, name: args.ToolName,
        arguments: decodeGeminiToolArguments(args.Arguments, this.encodedTools.has(args.ToolName)) });
    }
    if (calls.length) this.emit({ type: 'tool_calls', toolCalls: calls });
  }

  async submitToolResults(results) {
    if (this.finished) throw failure('Gemini 工具任务已结束。', 'gemini_tool_session_expired', 409);
    if (!Array.isArray(results) || !results.length) throw failure('Gemini 工具结果为空。', 'gemini_tool_results_invalid', 400);
    if (this.waitingConfirmation) {
      const card = this.waitingConfirmation;
      if (results.length !== 1 || results[0]?.id !== card.id) throw failure('Gemini 工具确认结果无法关联。', 'gemini_tool_result_mismatch', 400);
      const result = results[0].result;
      encodeGeminiStruct(result);
      // A failed/denied tool is never reported as consent to execute. A real
      // successful client result acknowledges only this exact operation; the
      // following native MCP request receives that result, with no re-execution.
      const cancelled = result.isError === true;
      this.confirmedResult = cancelled ? null : { name: card.name, arguments: card.arguments, result };
      this.waitingConfirmation = null;
      this.confirmationCard = null;
      this.responses.clear();
      this.metadata = { complete: false, usageKnown: false };
      // Cancellation does not issue execute_mcp, so there will be no result
      // channel on which to relay its error or the latest client context.
      // Preserve the actual cancel choice, followed by the current request
      // in the already-supported UserQuery text carrier. Never send Allow for
      // a client-denied operation or discard its concrete failure details.
      const prompt = cancelled ? card.cancelQuery + (results[0].clientRequest
        ? '\n\n' + CLIENT_UPDATE_PREFIX + results[0].clientRequest : '') : card.allowQuery;
      return this.openProcess(geminiGenerationMessages({ prompt,
        model: this.model, tools: true, deviceId: this.deviceId, confirmation: card }));
    }
    const seen = new Set();
    // Validate the entire result batch before sending any result. Preserve
    // partial batches without inventing missing results for remaining calls.
    const checked = results.map(result => {
      const pending = this.pending.get(result?.id);
      if (!pending || seen.has(result.id)) throw failure('Gemini 工具结果无法关联或重复提交。', 'gemini_tool_result_mismatch', 400);
      seen.add(result.id);
      encodeGeminiStruct(result.result);
      return { ...pending, publicId: result.id, result: result.result };
    });
    for (const item of checked) {
      this.writeToolResult(item.nativeName, item.nativeId, item.result, item.remote);
      this.pending.delete(item.publicId);
    }
    if (!this.pending.size && this.deferredCompletion) this.complete(this.deferredCompletion);
  }

  async consume(bytes) {
    if (this.finished) return;
    const connection = field(bytes, 1014, 2), identifiers = connection && field(connection, 1, 2);
    const conversationId = identifiers && text(identifiers, 1);
    if (conversationId) await this.connectTools(conversationId);
    for (const wrapper of repeated(bytes, 1003)) for (const generated of repeated(wrapper, 1)) {
      const fields = decodeFields(generated);
      // Both incremental status and final tool invocations are native server
      // execution evidence. A source URL in model-written text alone is not.
      for (const update of fields.filter(item => [6, 8].includes(item.number) && item.wireType === 2)) {
        this.nativeSearch = geminiSearchState(update.value, this.nativeSearch);
      }
      const identifiers = field(fields, 2, 2);
      if (identifiers && text(identifiers, 1) && text(identifiers, 2)) {
        this.identifiers = { conversationId: text(identifiers, 1), requestId: text(identifiers, 2) };
      }
      for (const [tag, key] of [[25, 'modelId'], [30, 'attribution'], [39, 'modeVariantId'], [40, 'routingVariantId']]) {
        const value = field(fields, tag, 2); if (value) this.metadata[key] = value.toString('utf8');
      }
      for (const [tag, key] of [[41, 'category'], [42, 'thinkingLevel']]) {
        const value = field(fields, tag, 0); if (value !== undefined) this.metadata[key] = Number(value);
      }
      if (field(fields, 9, 0) === 1n) this.metadata.complete = true;
      if (field(fields, 11, 0) === 1n) this.metadata.fallback = true;
      if (field(fields, 32, 0) === 1n) this.metadata.confirmation = true;
      if (field(fields, 13, 2) || field(fields, 17, 2)) this.metadata.punt = true;
      const status = field(fields, 6, 2), processing = status && field(status, 13, 2), goal = processing && field(processing, 5, 2);
      const goalStatus = goal && field(goal, 1, 0);
      if (goalStatus !== undefined) this.metadata.goalStatus = Number(goalStatus);
      if (goal && text(goal, 2)) this.taskConversationId = text(goal, 2);
      // Text-only Task results can finish in the persisted turn while the
      // original stream is still displaying RUNNING. Read that native result
      // promptly; waiting for RPC EOF would unnecessarily delay Auto review.
      if (!this.tools.size && this.metadata.goalStatus === 4 && this.taskConversationId
        && this.readbackEpoch !== this.streamEpoch) {
        this.readbackEpoch = this.streamEpoch;
        this.readTaskResult({ resultSource: 'ListConversationTurns' }, this.streamEpoch);
      }
      for (const item of fields.filter(item => item.number === 1 && item.wireType === 2)) {
        const id = text(item.value, 1);
        if (!id) throw failure('Gemini 模型输出缺少响应标识。', 'gemini_response_identifier_missing');
        const response = this.responses.get(id) || { text: '', thinking: '', sources: [] };
        const sources = geminiResponseSources(item.value);
        if (sources.length) response.sources = sources;
        const card = geminiToolConfirmation(item.value, this.nativeTools);
        if (card) this.confirmationCard = card;
        const display = field(item.value, 2, 2), thoughts = field(item.value, 12, 2), thoughtDisplay = thoughts && field(thoughts, 1, 2);
        for (const [key, source, type] of [['text', display, 'text_delta'], ['thinking', thoughtDisplay, 'thinking_delta']]) {
          if (!source) continue;
          const rawText = text(source, 1);
          const previous = response[key];
          const displayText = key === 'text' ? geminiDisplayText(rawText, previous, sources) : rawText;
          const current = key === 'text' && card?.placeholder ? displayText.replace(card.placeholder, '').trim() : displayText;
          if (current && !current.startsWith(previous)) throw failure('Gemini 累计输出发生无法无损转发的改写。', 'gemini_non_monotonic_stream');
          if (current.length > previous.length) { response[key] = current; this.emit({ type, delta: current.slice(previous.length), responseId: id }); }
        }
        this.responses.set(id, response);
      }
    }
  }
}

module.exports = { GeminiGeneration };
