'use strict';

const { GatewayError, upstreamTermination } = require('./protocol');
const { SEARCH_TOOL_NAME, createNativeSearchTool } = require('./agy-model-service-tools');

function prepareSearchCapability(normalized) {
  if (!normalized.serverSearch || normalized.serverSearch.mode === 'none' || normalized.serverSearch.maxUses === 0) return { normalized, enabled: false };
  if (normalized.tools.some(tool => tool.name === SEARCH_TOOL_NAME)) {
    throw new GatewayError('客户端工具与服务器搜索的原生名称 search_web 冲突。', { code: 'server_search_name_conflict', status: 400 });
  }
  return { enabled: true, normalized: { ...normalized, tools: [...normalized.tools, createNativeSearchTool()],
    ...(normalized.serverSearch.mode === 'required' ? { toolChoice: { type: 'function', name: SEARCH_TOOL_NAME } } : {}) } };
}

// Forward only a model-selected server search to the existing Google search
// service. No client tool is executed and no page is fetched. Preserve the
// helper's summary and URLs in the receipt for the caller's original model.
async function forwardSearchCalls(result, normalized, search, budget = { remaining: Infinity }) {
  const calls = result.toolCalls.filter(call => call.name === SEARCH_TOOL_NAME);
  if (!calls.length) {
    if (normalized.serverSearch.mode === 'required') throw new GatewayError('上游没有执行明确要求的服务器搜索。', {
      code: 'server_search_incomplete', status: 502 });
    return result;
  }
  if (upstreamTermination(result) !== 'complete') throw new GatewayError('未完成的搜索工具调用不能转发。', {
    code: 'incomplete_server_search_call', status: 502 });
  const summaries = [], sources = [], receipts = [], usages = [result.usage];
  let usageKnown = result.usageKnown !== false;
  for (const call of calls) {
    const args = call.arguments;
    if (!args || typeof args.query !== 'string' || !args.query.trim()) throw new GatewayError('服务器搜索缺少有效查询。', {
      code: 'invalid_server_search_request', status: 502 });
    if (budget.remaining <= 0) {
      const summary = 'The declared server search budget is exhausted; no search was executed for this call.';
      summaries.push(summary);
      receipts.push({ call, errorCode: 'max_uses_exceeded', output: { query: args.query,
        error: 'max_uses_exceeded', summary, sources: [] } });
      continue;
    }
    budget.remaining--;
    const reply = await search({ query: args.query,
      ...(args.domain ? { instructions: `Prioritize sources from this domain when relevant: ${args.domain}` } : {}) });
    summaries.push(reply.derivedAnswer);
    if (reply.searchUnavailable === true) {
      receipts.push({ call, result: reply, errorCode: 'unavailable', output: { query: args.query,
        error: 'unavailable', summary: reply.derivedAnswer, sources: [],
        sourceContent: 'The helper returned no verifiable search sources.' } });
      usages.push(reply.usage); usageKnown &&= reply.usageKnown !== false;
      continue;
    }
    const found = reply.sourceCandidates.map(source => ({ url: source.uri, title: source.title }));
    sources.push(...found);
    receipts.push({ call, result: reply, output: { query: args.query, summary: reply.derivedAnswer, sources: found,
      sourceContent: 'Search metadata and model-generated summary only; not fetched page text.' } });
    usages.push(reply.usage); usageKnown &&= reply.usageKnown !== false;
  }
  const links = [...new Map(sources.map(source => [source.url, source])).values()];
  const text = [result.text, ...summaries, ...links.map(source => `${source.title || source.url}: ${source.url}`)].filter(Boolean).join('\n\n');
  const keys = [...new Set(usages.flatMap(value => Object.keys(value || {})))];
  return { ...result, text, streamedText: '', toolCalls: result.toolCalls.filter(call => call.name !== SEARCH_TOOL_NAME),
    webSearch: { sources: links, status: receipts.some(receipt => !receipt.errorCode) ? 'completed' : 'failed' }, searchReceipts: receipts, usageKnown,
    usage: Object.fromEntries(keys.map(key => [key, usages.reduce((total, usage) => total + (Number(usage?.[key]) || 0), 0)])) };
}

// Responses clients can omit optional source metadata when echoing a completed
// search. The actual emitted IDs, full visible span, model, account and prefix
// still bind this alternate projection. Version strings do not authorize it;
// no incoming field is discarded and the emitted sources remain unchanged.
function expectedResponsesSearchEcho(output) {
  if (!Array.isArray(output)) return null;
  return output.map(item => {
    if (item.type !== 'web_search_call' || !item.action || !Object.hasOwn(item.action, 'sources')) return item;
    const { sources, ...action } = item.action;
    return { ...item, action };
  });
}

module.exports = { prepareSearchCapability, forwardSearchCalls, expectedResponsesSearchEcho };
