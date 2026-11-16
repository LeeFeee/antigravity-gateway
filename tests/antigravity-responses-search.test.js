'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareAntigravityResponsesSearch } = require('../src/gemini-responses-search');
const { prepareSearchCapability } = require('../src/antigravity-responses-search');
const { normalizeResponses } = require('../src/protocol');
const { buildDirectRequest } = require('../src/direct-provider');
const { trustedModelServiceDefinition } = require('../src/agy-model-service-tools');

function prepare(tool_choice = 'auto') {
  const payload = { model: 'gemini-3.8-flash-high', instructions: 'Keep user SOUL and permissions.', input: 'Read the test file.',
    tools: [{ type: 'web_search', external_web_access: true },
      { type: 'function', name: 'read', description: 'Client file reader.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], tool_choice };
  const separated = prepareAntigravityResponsesSearch(payload);
  const normalized = { ...normalizeResponses(separated.payload), serverSearch: separated.serverSearch };
  return { normalized, result: prepareSearchCapability(normalized) };
}

test('Antigravity Responses search uses the captured official descriptor alongside unchanged client tools', () => {
  const { normalized, result } = prepare();
  assert.equal(result.enabled, true);
  assert.deepEqual(result.normalized.tools.slice(0, -1), normalized.tools);
  assert.equal(result.normalized.system, normalized.system);
  assert.deepEqual(result.normalized.messages, normalized.messages);
  const wire = buildDirectRequest(result.normalized, normalized.model, 'project', 'session');
  const search = wire.request.tools.flatMap(tool => tool.functionDeclarations).find(tool => tool.name === 'search_web');
  assert.equal(search.description, 'Performs a web search for a given query. Returns a summary of relevant information along with URL citations.');
  assert.deepEqual(search.parameters.required, ['query']);
  assert.deepEqual(Object.keys(search.parameters.properties), ['domain', 'query']);
  const issued = result.normalized.tools.at(-1);
  assert.ok(trustedModelServiceDefinition(issued));
  assert.equal(trustedModelServiceDefinition(structuredClone(issued)), null);
});

test('disabled, required and unsupported server search contracts retain their explicit meaning', () => {
  const disabled = prepare('none');
  assert.equal(disabled.result.enabled, false);
  assert.equal(disabled.result.normalized, disabled.normalized);
  const required = prepare({ type: 'web_search' });
  assert.deepEqual(required.result.normalized.toolChoice, { type: 'function', name: 'search_web' });
  const wire = buildDirectRequest(required.result.normalized, required.normalized.model, 'project', 'session');
  assert.deepEqual(wire.request.toolConfig.functionCallingConfig.allowedFunctionNames, ['search_web']);
  for (const tool of [{ type: 'web_search', external_web_access: false }, { type: 'web_search', filters: { allowed_domains: ['example.com'] } }]) {
    assert.throws(() => prepareAntigravityResponsesSearch({ tools: [tool] }), { code: 'antigravity_server_search_contract_unsupported' });
  }
  assert.throws(() => prepareSearchCapability({ ...required.normalized,
    tools: [...required.normalized.tools, { name: 'search_web' }] }), { code: 'server_search_name_conflict' });
});
