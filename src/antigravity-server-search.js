'use strict';

const crypto = require('node:crypto');
const { GatewayError } = require('./protocol');

// Captured from the unmodified agy 1.5.2 search_web auxiliary request.
// This model service is separate from the caller's answer/planning model.
const SEARCH_INSTRUCTION = 'You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateSearchParameters({ query, domain, maxOutputTokens, contents, instructions, generationConfig } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new GatewayError('服务器搜索缺少有效查询。', { code: 'invalid_server_search_request', status: 400 });
  }
  if (domain !== undefined && (typeof domain !== 'string' || !domain.trim())) {
    throw new GatewayError('搜索域名提示必须是非空字符串。', { code: 'invalid_server_search_request', status: 400 });
  }
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
    throw new GatewayError('服务器搜索输出预算必须是正整数。', { code: 'invalid_server_search_budget', status: 400 });
  }
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new GatewayError('搜索指令必须是文本。', { code: 'invalid_server_search_request', status: 400 });
  }
  if (contents !== undefined && (!Array.isArray(contents) || !contents.length || contents.some(content =>
    !object(content) || Object.keys(content).some(key => !['role', 'parts'].includes(key))
    || !['user', 'model'].includes(content.role) || !Array.isArray(content.parts) || !content.parts.length
    || content.parts.some(part => !object(part) || Object.keys(part).some(key => key !== 'text') || typeof part.text !== 'string')))) {
    throw new GatewayError('服务器搜索仅支持完整的纯文本对话内容。', { code: 'invalid_server_search_contents', status: 400 });
  }
  if (generationConfig !== undefined && generationConfig !== null) {
    const keys = ['maxOutputTokens', 'temperature', 'topP', 'topK', 'stopSequences'];
    if (!object(generationConfig) || Object.keys(generationConfig).some(key => !keys.includes(key))
      || ['temperature', 'topP', 'topK'].some(key => Object.hasOwn(generationConfig, key) && !Number.isFinite(generationConfig[key]))
      || (Object.hasOwn(generationConfig, 'maxOutputTokens') && (!Number.isSafeInteger(generationConfig.maxOutputTokens) || generationConfig.maxOutputTokens <= 0))
      || (Object.hasOwn(generationConfig, 'stopSequences') && (!Array.isArray(generationConfig.stopSequences) || generationConfig.stopSequences.some(value => typeof value !== 'string')))) {
      throw new GatewayError('服务器搜索生成配置无效或包含不支持的字段。', { code: 'invalid_server_search_generation_config', status: 400 });
    }
    if (maxOutputTokens !== undefined && generationConfig.maxOutputTokens !== undefined && maxOutputTokens !== generationConfig.maxOutputTokens) {
      throw new GatewayError('服务器搜索包含冲突的输出预算。', { code: 'invalid_server_search_budget', status: 400 });
    }
  }
}

function searchRequest({ project, model, query, domain, maxOutputTokens, contents, instructions, generationConfig } = {}) {
  validateSearchParameters({ query, domain, maxOutputTokens, contents, instructions, generationConfig });
  if (typeof project !== 'string' || !project.trim() || typeof model !== 'string' || !model.trim()) {
    throw new GatewayError('服务器搜索缺少项目或搜索模型。', { code: 'invalid_server_search_request', status: 400 });
  }
  return {
    project,
    request: {
      contents: contents === undefined ? [{ role: 'user', parts: [{ text: query }] }] : structuredClone(contents),
      systemInstruction: { role: 'user', parts: [{ text: SEARCH_INSTRUCTION }, ...(instructions ? [{ text: instructions }] : [])] },
      tools: [{ googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 5 } },
        ...(domain === undefined ? {} : { includedDomains: [domain] }) } }],
      generationConfig: { candidateCount: 1, ...structuredClone(generationConfig || {}), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) }
    },
    model,
    userAgent: 'antigravity',
    requestType: 'web_search'
  };
}

function parseSearchResponse(body, { model, evidenceId } = {}) {
  const root = body?.response || body;
  if (!object(root) || !Array.isArray(root.candidates) || root.candidates.length !== 1) {
    throw new GatewayError('服务器搜索响应缺少唯一候选结果。', { code: 'invalid_server_search_response', status: 502 });
  }
  const candidate = root.candidates[0];
  if (!['STOP', 'MAX_TOKENS'].includes(candidate?.finishReason)) {
    throw new GatewayError('服务器搜索没有正常完成。', { code: 'incomplete_server_search', status: 502,
      details: { finishReason: candidate?.finishReason || null } });
  }
  const metadata = candidate.groundingMetadata;
  const queries = metadata?.webSearchQueries;
  const chunks = metadata?.groundingChunks;
  if (!object(metadata) || (queries !== undefined && (!Array.isArray(queries) || queries.some(query => typeof query !== 'string' || !query.trim())))
    || (chunks !== undefined && !Array.isArray(chunks))) {
    throw new GatewayError('服务器搜索未返回可验证的检索信息。', { code: 'server_search_not_grounded', status: 502 });
  }
  const parts = candidate.content?.parts;
  if (parts !== undefined && (!Array.isArray(parts) || parts.some(part => !object(part)))) {
    throw new GatewayError('服务器搜索返回无效内容块。', { code: 'invalid_server_search_response', status: 502 });
  }
  const sourceCandidates = (chunks || []).flatMap((chunk, index) => {
    if (!object(chunk)) throw new GatewayError('服务器搜索来源不是对象。', { code: 'invalid_server_search_response', status: 502 });
    if (chunk.web === undefined) return [];
    if (!object(chunk.web) || typeof chunk.web.uri !== 'string' || !chunk.web.uri.trim()
      || (chunk.web.title !== undefined && typeof chunk.web.title !== 'string')
      || (chunk.web.text !== undefined && typeof chunk.web.text !== 'string')) {
      throw new GatewayError('服务器搜索返回无效网页来源。', { code: 'invalid_server_search_response', status: 502 });
    }
    return [{ index, uri: chunk.web.uri, title: chunk.web.title || '',
      // Preserve a source field if Google actually supplied it. Never fill it
      // from groundingSupports.segment.text, which is generated answer text.
      ...(chunk.web.text === undefined ? {} : { upstreamSourceText: chunk.web.text }) }];
  });
  if (!queries?.length && !sourceCandidates.length) {
    throw new GatewayError('上游仅返回普通文本，没有搜索执行或来源证据。', { code: 'server_search_not_grounded', status: 502 });
  }
  return {
    model,
    finishReason: candidate.finishReason,
    modelVersion: typeof root.modelVersion === 'string' ? root.modelVersion : null,
    evidenceId: evidenceId || crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    queries: [...(queries || [])], sourceCandidates,
    // Deliberately not named `text`: this is not the caller model's answer,
    // nor source page text. Domain filtering happens before any use of it.
    derivedAnswer: (parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join(''),
    groundingMetadata: structuredClone(metadata),
    serverToolParts: structuredClone((parts || []).filter(part => part.toolCall || part.toolResponse))
  };
}

module.exports = { SEARCH_INSTRUCTION, validateSearchParameters, searchRequest, parseSearchResponse };
