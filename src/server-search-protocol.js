'use strict';

const crypto = require('node:crypto');
const { runSync, runAsync } = require('./schema-steps');
const { normalizeAnthropic, normalizeAnthropicAsync, anthropicResponse } = require('./protocol');
const { sanitizeClientIdentity } = require('./client-identity');
const { parseSearchResponse, validateSearchParameters } = require('./antigravity-server-search');
const { ServerSearchContractError, validateServerSearchTool } = require('./server-search-contract');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const ERROR_CODES = new Set(['invalid_input', 'unavailable', 'max_uses_exceeded', 'too_many_requests', 'query_too_long']);
const QUERY_PREFIX = 'Perform a web search for the query: ';
const DEFAULT_TOOL = Object.freeze({ type: 'web_search_20250305', name: 'web_search' });
const FORWARD_FIELDS = new Set(['model', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'metadata',
  'max_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'stop',
  // Client thinking/effort controls remain ignored under the fixed helper model
  // configuration, just as conflicting controls cannot redefine public tiers.
  'thinking', 'reasoning', 'reasoning_effort', 'output_config', 'output_format']);

function fail(code, message, status = 400) { throw new ServerSearchContractError(code, message, status); }
function fields(value, allowed, code, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(code, `${label}包含不支持的字段。`);
}
function nonempty(value) { return typeof value === 'string' && Boolean(value.trim()); }
function typedSearch(tool) { return typeof tool?.type === 'string' && tool.type.startsWith('web_search_'); }
function historyBlock(block) { return block?.type === 'web_search_tool_result' || (block?.type === 'server_tool_use' && block.name === 'web_search'); }

function executionCapability(tool) {
  if (tool.allowed_domains?.length || tool.blocked_domains?.length) {
    fail('unsupported_server_search_domain_filter', '服务器搜索暂不支持严格域名过滤；Google 返回的原始来源链接尚未解析为最终域名。');
  }
  if (tool.user_location != null) fail('unsupported_server_search_location', '服务器搜索无法忠实转发 user_location。');
  if (tool.allowed_callers?.some(caller => caller !== 'direct') || tool.defer_loading === true) {
    fail('unsupported_server_search_execution', '服务器搜索仅支持直接、独立的一次查询，不执行代码工具或动态工具加载。');
  }
}

function searchChoice(choice) {
  if (choice == null) return 'auto';
  fields(choice, ['type', 'name', 'disable_parallel_tool_use'], 'unsupported_server_search_tool_choice', '服务器搜索 tool_choice');
  if (own(choice, 'disable_parallel_tool_use') && typeof choice.disable_parallel_tool_use !== 'boolean') {
    fail('unsupported_server_search_tool_choice', 'disable_parallel_tool_use 必须为布尔值。');
  }
  if (['auto', 'any', 'none'].includes(choice.type) && !own(choice, 'name')) return choice.type;
  if (choice.type === 'tool' && choice.name === 'web_search') return 'tool';
  fail('unsupported_server_search_tool_choice', '服务器搜索仅支持 auto、any、none 或指定 web_search。');
}

function plainContent(content) {
  if (typeof content === 'string' || content == null) return;
  if (!Array.isArray(content)) fail('unsupported_server_search_content', '服务器搜索仅支持纯文本内容。');
  for (const block of content) {
    fields(block, ['type', 'text', 'cache_control', 'citations'], 'unsupported_server_search_content', '服务器搜索文本块');
    if (block.type !== 'text' || typeof block.text !== 'string' || (block.citations != null && (!Array.isArray(block.citations) || block.citations.length))) {
      fail('unsupported_server_search_content', '服务器搜索不能无损转发媒体、客户端工具、思考块或文本引用。');
    }
  }
}

function generationControls(payload) {
  for (const key of ['max_tokens', 'max_output_tokens']) {
    if (payload[key] != null && (!Number.isSafeInteger(payload[key]) || payload[key] <= 0)) {
      fail('invalid_server_search_budget', '服务器搜索输出预算必须为正整数，不能被静默丢弃。');
    }
  }
  for (const key of ['temperature', 'top_p', 'top_k']) {
    if (payload[key] != null && !Number.isFinite(payload[key])) fail('invalid_server_search_generation_config', '服务器搜索采样参数必须为有效数字。');
  }
}

// This projection never creates a native functionCall/functionResponse or a
// thought signature. Only authenticated source receipts can become verified
// historical search results. Empty/error results claim no verified sources.
function projectHistory(messages, { receipts, scope }) {
  const calls = new Map();
  const projected = messages.map(message => {
    if (!Array.isArray(message?.content)) return message;
    return { ...message, content: message.content.map(block => {
      if (!historyBlock(block)) return block;
      const code = 'invalid_server_search_history';
      if (message.role !== 'assistant') fail(code, '服务器搜索调用和结果必须属于 assistant 历史。');
      if (block.type === 'server_tool_use') {
        fields(block, ['type', 'id', 'name', 'input', 'caller'], code, '服务器搜索历史调用');
        fields(block.input, ['query'], code, '服务器搜索历史查询');
        if (!nonempty(block.id) || !nonempty(block.input.query) || calls.has(block.id)) fail(code, '服务器搜索历史调用 ID 或查询无效或重复。');
        if (block.caller != null && (!object(block.caller) || Object.keys(block.caller).length !== 1 || block.caller.type !== 'direct')) {
          fail(code, '服务器搜索历史包含不支持的调用者。');
        }
        calls.set(block.id, { query: block.input.query, completed: false });
        return { type: 'text', text: `[Previous server web search call]\n${JSON.stringify({ id: block.id, query: block.input.query })}` };
      }
      fields(block, ['type', 'tool_use_id', 'content'], code, '服务器搜索历史结果');
      const call = calls.get(block.tool_use_id);
      if (!call || call.completed) fail(code, '服务器搜索历史结果缺少唯一的前置调用。');
      call.completed = true;
      if (Array.isArray(block.content)) {
        const sources = block.content.map(result => {
          if (typeof receipts?.restoreResult !== 'function') fail('invalid_server_search_receipt', '服务器搜索历史缺少可验证的本地来源凭据。');
          const restored = receipts.restoreResult({ scope, callId: block.tool_use_id, result });
          if (restored.metadata?.kind !== 'server-search-forward-v1' || restored.metadata.query !== call.query) {
            fail('invalid_server_search_receipt', '服务器搜索历史查询与来源凭据不匹配。');
          }
          const { source } = restored;
          return { url: source.finalUrl, title: source.title, contentKind: source.provenance.contentKind,
            verifiedFinalUrl: source.provenance.verifiedFinalUrl, ...(own(source, 'text') ? { text: source.text } : {}) };
        });
        return { type: 'text', text: sources.length
          ? `[Previous verified server web search results; source metadata is not page text]\n${JSON.stringify(sources)}`
          : '[Previous client-supplied server web search result list was empty; no verified sources]' };
      }
      fields(block.content, ['type', 'error_code'], code, '服务器搜索历史错误');
      if (block.content.type !== 'web_search_tool_result_error' || !ERROR_CODES.has(block.content.error_code)) fail(code, '服务器搜索历史错误类型无效。');
      return { type: 'text', text: `[Previous client-supplied server web search error; no verified sources]\n${JSON.stringify(block.content)}` };
    }) };
  });
  if ([...calls.values()].some(call => !call.completed)) fail('invalid_server_search_history', '服务器搜索历史调用缺少配对结果。');
  return projected;
}

function* prepareServerSearchForwardSteps(payload, { receipts, scope, normalize = normalizeAnthropic } = {}) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const searchTools = tools.filter(typedSearch);
  const hasHistory = Array.isArray(payload?.messages) && payload.messages.some(message => Array.isArray(message?.content) && message.content.some(historyBlock));
  if (!searchTools.length && !hasHistory) return null;
  if (searchTools.length > 1) fail('unsupported_server_search_tools', '一次请求只能包含一个服务器搜索声明。');
  if (!Array.isArray(payload.messages)) fail('invalid_server_search_request', '服务器搜索缺少 messages。');
  const tool = searchTools.length ? validateServerSearchTool(searchTools[0]) : null;
  const choice = tool ? searchChoice(payload.tool_choice) : 'none';
  const skipSearch = !tool || choice === 'none';
  const remainingTools = tools.filter(item => !typedSearch(item));
  if (!skipSearch) {
    if (remainingTools.length) fail('unsupported_server_search_tools', '服务器搜索暂不支持与客户端工具混用。');
    executionCapability(tool);
    generationControls(payload);
    if (Object.keys(payload).some(key => !FORWARD_FIELDS.has(key))
      || (payload.output_config != null && (!object(payload.output_config) || Object.keys(payload.output_config).some(key => !['effort', 'format'].includes(key))))
      || payload.output_config?.format != null || payload.output_format != null) {
      fail('unsupported_server_search_request', '服务器搜索不能忠实转发结构化输出、上下文编辑或其他服务器执行能力。');
    }
  }
  const messages = hasHistory ? projectHistory(payload.messages, { receipts, scope }) : payload.messages;
  const ordinary = { ...payload, messages, tools: remainingTools };
  // A disabled server tool must not accidentally enable remaining client tools.
  if (tool && choice !== 'none') delete ordinary.tool_choice;
  if (!skipSearch) {
    plainContent(ordinary.system);
    for (const message of messages) {
      fields(message, ['role', 'content'], 'unsupported_server_search_content', '服务器搜索消息');
      if (!object(message) || !['user', 'assistant', 'system', 'developer'].includes(message.role)) fail('unsupported_server_search_content', '服务器搜索历史包含不支持的角色。');
      plainContent(message.content);
    }
  }
  const { normalized, metadata: identityMetadata } = sanitizeClientIdentity(yield normalize(ordinary));
  if (skipSearch) return { tool, normalized, query: null, contents: null, instructions: normalized.system,
    generationConfig: normalized.generationConfig, skipSearch: true, blockedByBudget: false, identityMetadata };
  const helperEvidence = identityMetadata.profile?.client === 'claude' ? identityMetadata.profile.evidence : [];
  const tuiHelper = helperEvidence.includes('claude-tui-search-helper-template');
  const capturedHelper = tuiHelper || helperEvidence.includes('claude-sdk-search-helper-template');
  // The interactive helper capture is an independent, single-query request.
  // Its template must not turn an ordinary multi-turn auto conversation into
  // a forced search. Explicit any/named requests retain full text history.
  const tuiQuery = payload.messages.length === 1 && payload.messages[0].role === 'user'
    && Array.isArray(payload.messages[0].content) && payload.messages[0].content.length === 1
    && payload.messages[0].content[0].type === 'text' ? payload.messages[0].content[0].text : null;
  const capturedTuiQuery = typeof tuiQuery === 'string' && tuiQuery.startsWith(QUERY_PREFIX)
    && nonempty(tuiQuery.slice(QUERY_PREFIX.length));
  // General auto means "the answer model may choose no search". Without a
  // planner this module cannot honor that contract by forcing a helper call.
  // The captured dedicated helper explicitly says to search once, so its full
  // template is sufficient even if the caller leaves tool_choice at auto.
  if (choice === 'auto' && (!capturedHelper || (tuiHelper && !capturedTuiQuery))) {
    fail('unsupported_server_search_tool_choice', '普通 auto 请求允许不搜索，不能强制转发为独立搜索；请明确指定 web_search 或 any。');
  }
  if (normalized.structuredSchema != null) fail('unsupported_server_search_request', '服务器搜索不支持结构化输出。');
  const instructions = [normalized.system];
  const contents = [];
  let query = null;
  for (const message of normalized.messages) {
    if (message.role === 'system' || message.role === 'developer') { instructions.push(message.text); continue; }
    const parts = message.parts.length ? message.parts.map(part => ({ text: part.text })) : [{ text: message.text }];
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    if (message.role === 'user') query = message.text;
  }
  if (!contents.length || contents.at(-1).role !== 'user' || !nonempty(query)) fail('invalid_server_search_request', '一次服务器搜索必须以非空的 user 查询结束。');
  // Only a captured dedicated auxiliary template owns this exact wrapper. The
  // contents still preserve the complete client text and all prior context.
  if (capturedHelper
    && query.startsWith(QUERY_PREFIX) && nonempty(query.slice(QUERY_PREFIX.length))) query = query.slice(QUERY_PREFIX.length);
  const instructionText = instructions.filter(Boolean).join('\n\n');
  validateSearchParameters({ query, contents, instructions: instructionText, generationConfig: normalized.generationConfig });
  return { tool, normalized, query, contents, instructions: instructionText,
    generationConfig: normalized.generationConfig, skipSearch: false, blockedByBudget: tool.max_uses === 0, identityMetadata };
}

function identity(model, query, callId) {
  if (!nonempty(model) || !nonempty(query) || !nonempty(callId)) fail('invalid_server_search_response', '服务器搜索响应缺少真实模型、查询或调用 ID。', 500);
}
function messageBase(model, usage, finishReason = 'STOP', usageKnown = true) {
  return anthropicResponse(model, { text: '', toolCalls: [], usage: usage || {}, finishReason, usageKnown });
}
function pair(callId, query, content) {
  return [{ type: 'server_tool_use', id: callId, name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', tool_use_id: callId, content }];
}

function buildServerSearchMessage({ model, query, result, tool = DEFAULT_TOOL, receipts, scope,
  callId = `srvtoolu_${crypto.randomUUID().replaceAll('-', '')}` } = {}) {
  model ??= result?.model;
  identity(model, query, callId);
  const checkedTool = validateServerSearchTool(tool);
  executionCapability(checkedTool);
  if (checkedTool.max_uses === 0) fail('invalid_server_search_response', '零次搜索预算不能构造成功搜索结果。', 500);
  if (!object(result) || result.model !== model || !nonempty(result.evidenceId)
    || !['STOP', 'MAX_TOKENS'].includes(result.finishReason) || typeof result.derivedAnswer !== 'string'
    || !Array.isArray(result.sourceCandidates) || !Array.isArray(result.queries)) {
    fail('invalid_server_search_response', '服务器搜索响应缺少真实辅助模型或检索证据。', 502);
  }
  // Recheck the actual grounding fields, not a generated text pretending to be
  // search results. Do not treat groundingSupports text as source page text.
  const checked = parseSearchResponse({ candidates: [{ finishReason: result.finishReason,
    content: { parts: [{ text: result.derivedAnswer }] }, groundingMetadata: result.groundingMetadata }] }, { model, evidenceId: result.evidenceId });
  if (JSON.stringify(checked.sourceCandidates) !== JSON.stringify(result.sourceCandidates)
    || JSON.stringify(checked.queries) !== JSON.stringify(result.queries)) {
    fail('invalid_server_search_response', '服务器搜索来源与原始检索证据不匹配。', 502);
  }
  const sourceResults = result.sourceCandidates.map(candidate => {
    if (typeof receipts?.issueResult !== 'function') fail('server_search_key_error', '服务器搜索缺少本地来源凭据存储。', 500);
    return receipts.issueResult({ scope, callId,
      source: { url: candidate.uri, finalUrl: candidate.uri, title: candidate.title,
        provenance: { kind: 'google_search_result', verifiedFinalUrl: false, contentKind: 'metadata_only',
          evidenceId: result.evidenceId, chunkIndex: candidate.index } },
      metadata: { kind: 'server-search-forward-v1', query, model } });
  });
  const response = messageBase(model, result.usage, result.finishReason, result.usageKnown !== false && object(result.usage));
  response.content = pair(callId, query, sourceResults);
  if (result.derivedAnswer) response.content.push({ type: 'text', text: result.derivedAnswer });
  response.usage.server_tool_use = { web_search_requests: 1 };
  return response;
}

function buildServerSearchErrorMessage({ model, query, tool = DEFAULT_TOOL, errorCode, usage,
  searchRequests = 0, callId = `srvtoolu_${crypto.randomUUID().replaceAll('-', '')}` } = {}) {
  identity(model, query, callId);
  validateServerSearchTool(tool);
  if (!ERROR_CODES.has(errorCode) || ![0, 1].includes(searchRequests)) fail('invalid_server_search_response', '服务器搜索错误代码或请求计数无效。', 500);
  if (errorCode === 'max_uses_exceeded' && searchRequests !== 0) fail('invalid_server_search_response', '预算阻止的搜索不能计为已执行。', 500);
  const response = messageBase(model, usage, 'STOP', searchRequests === 0 || object(usage));
  response.content = pair(callId, query, { type: 'web_search_tool_result_error', error_code: errorCode });
  response.usage.server_tool_use = { web_search_requests: searchRequests };
  return response;
}

const prepareServerSearchForward = (...args) => runSync(prepareServerSearchForwardSteps(...args));
const prepareServerSearchForwardAsync = (payload, options = {}) => runAsync(prepareServerSearchForwardSteps(payload, { ...options, normalize: ordinary => normalizeAnthropicAsync(ordinary, { signal: options.signal }) }));
module.exports = { prepareServerSearchForward, prepareServerSearchForwardAsync, buildServerSearchMessage, buildServerSearchErrorMessage };
