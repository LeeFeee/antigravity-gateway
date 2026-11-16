'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareGeminiResponsesSearch } = require('../src/gemini-responses-search');
const { prepareGeminiClientRequest } = require('../src/gemini-client-request');
const { normalizeResponses, responsesResponse } = require('../src/protocol');

test('server search declaration is preserved alongside the complete client tools and context', () => {
  const payload = { model: 'gemini-4-hydrogen-low-g', tool_choice: 'auto',
    instructions: 'Preserve my SOUL and execution permissions.', input: 'Read the file.',
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { type: 'web_search', external_web_access: true }] };
  const before = JSON.stringify(payload), prepared = prepareGeminiResponsesSearch(payload);
  const normalized = { ...normalizeResponses(prepared.payload), serverSearch: prepared.serverSearch };
  const native = prepareGeminiClientRequest(normalized);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(prepared.serverSearch.declaration, payload.tools[1]);
  assert.equal(native.tools.length, 1);
  assert.equal(native.tools[0].name, 'read');
  assert.match(native.prompt, /Preserve my SOUL and execution permissions/);
  assert.match(native.prompt, /"external_web_access":true/);
  assert.match(native.prompt, /"mode":"auto"/);
});

test('unsupported search restrictions fail instead of being dropped', () => {
  for (const extra of [{ external_web_access: false }, { user_location: { type: 'approximate', country: 'US' } },
    { filters: { allowed_domains: ['example.com'] } }]) {
    assert.throws(() => prepareGeminiResponsesSearch({ tools: [{ type: 'web_search', ...extra }] }),
      { code: 'gemini_server_search_contract_unsupported' });
  }
  assert.throws(() => prepareGeminiResponsesSearch({ tools: [{ type: 'web_search' }], tool_choice: 'required' }),
    { code: 'gemini_server_search_contract_unsupported' });
});

test('explicit native search does not become a client-executed tool', () => {
  const prepared = prepareGeminiResponsesSearch({ tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } });
  assert.equal(prepared.serverSearch.mode, 'required');
  assert.equal(prepared.payload.tool_choice, 'none');
  assert.deepEqual(prepared.payload.tools, []);
});

test('search history remains complete client-supplied content without claiming fresh execution', () => {
  const item = { type: 'web_search_call', id: 'ws_original', status: 'completed',
    action: { type: 'search', sources: [{ type: 'url', url: 'https://example.invalid/' }] } };
  const result = prepareGeminiResponsesSearch({ input: [item, { role: 'user', content: 'Continue.' }] });
  assert.equal(result.serverSearch, null);
  assert.ok(result.payload.input[0].content[0].text.endsWith(JSON.stringify(item)));
  assert.match(result.payload.input[0].content[0].text, /not a new verified search/);
  assert.deepEqual(result.payload.input[1], { role: 'user', content: 'Continue.' });
});

test('search output contains only actual metadata and unambiguous citation spans', () => {
  const sources = [{ url: 'https://example.invalid/', title: 'Example', annotatedText: 'Exact sentence.' },
    { url: 'https://other.invalid/', title: 'Other', annotatedText: 'different formatting' }];
  const result = responsesResponse('gemini-4-hydrogen-low-g', { text: 'Exact sentence.', toolCalls: [],
    usageKnown: false, sources, webSearch: { sources } }, 'resp_test');
  const search = result.output.find(item => item.type === 'web_search_call');
  assert.equal(search.status, 'completed');
  assert.equal(search.action.sources.length, 2);
  assert.equal(Object.hasOwn(search.action, 'query'), false);
  const annotations = result.output.find(item => item.type === 'message').content[0].annotations;
  assert.deepEqual(annotations, [{ type: 'url_citation', start_index: 0, end_index: 15,
    url: sources[0].url, title: 'Example' }]);
  assert.equal(result.usage, null);
});
