'use strict';

const { GatewayError } = require('./protocol');

// Separate a Responses server capability from client-executed functions. The
// declaration is preserved in Gemini's complete request; it is never exposed
// as a fake MCP tool for the gateway to execute.
function prepareResponsesSearch(payload, upstream = 'Gemini', code = 'gemini_server_search_contract_unsupported') {
  const unsupported = message => { throw new GatewayError(message.replaceAll('Gemini', upstream), { code, status: 400 }); };
  const declarations = (Array.isArray(payload.tools) ? payload.tools : []).filter(tool => tool?.type === 'web_search');
  const history = Array.isArray(payload.input) && payload.input.some(item => item?.type === 'web_search_call');
  if (!declarations.length && !history) return { payload, serverSearch: null };
  if (declarations.length > 1) unsupported('Gemini 一次请求仅支持一个原生搜索声明。');
  const tool = declarations[0];
  if (tool && (Object.keys(tool).some(key => !['type', 'external_web_access'].includes(key))
    || (tool.external_web_access != null && tool.external_web_access !== true))) {
    unsupported('Gemini 原生搜索尚不能等价支持离线、域名或位置等额外搜索限制。');
  }
  const choice = payload.tool_choice ?? 'auto';
  const required = choice && typeof choice === 'object' && choice.type === 'web_search' && Object.keys(choice).length === 1;
  if (tool && !['auto', 'none'].includes(choice) && !required) {
    unsupported('Gemini 原生搜索当前支持 auto、none 或明确指定 web_search。');
  }
  const input = history ? payload.input.map(item => item?.type === 'web_search_call' ? {
    role: 'assistant', content: [{ type: 'output_text', text: '[Client-supplied previous server search record; not a new verified search]\n' + JSON.stringify(item) }]
  } : item) : payload.input;
  return { payload: { ...payload, input, tools: (payload.tools || []).filter(item => item?.type !== 'web_search'),
    ...(required ? { tool_choice: 'none' } : {}) },
    serverSearch: tool ? { declaration: { ...tool }, mode: required ? 'required' : choice } : null };
}

const prepareGeminiResponsesSearch = payload => prepareResponsesSearch(payload);
const prepareAntigravityResponsesSearch = payload => prepareResponsesSearch(payload, 'Antigravity', 'antigravity_server_search_contract_unsupported');
module.exports = { prepareGeminiResponsesSearch, prepareAntigravityResponsesSearch };
