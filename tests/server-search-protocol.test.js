'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareServerSearchForward, buildServerSearchMessage, buildServerSearchErrorMessage } = require('../src/server-search-protocol');
const { ServerSearchReceipts } = require('../src/server-search-contract');
const { parseSearchResponse } = require('../src/antigravity-server-search');

const helper = 'gemini-3.5-flash-lite';
const tool = overrides => ({ type: 'web_search_20250305', name: 'web_search', ...overrides });
const payload = overrides => ({ model: 'claude-sonnet-4-6', system: 'Preserve these project rules.',
  messages: [{ role: 'user', content: 'Find the current release.' }], tools: [tool()],
  tool_choice: { type: 'tool', name: 'web_search' }, max_tokens: 321, ...overrides });
function receipts(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-search-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { receipts: new ServerSearchReceipts({ directory }), scope: 'fixture-client:one', directory };
}
function result(overrides = {}) {
  const value = parseSearchResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Original helper answer, not a fetched page.' }] },
    groundingMetadata: { webSearchQueries: ['current release'], groundingChunks: [{ web: {
      uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture', title: 'Upstream title', text: 'Actual upstream source field, not forwarded as a page quote.' } }],
    groundingSupports: [{ segment: { text: 'Original helper answer, not a fetched page.' }, groundingChunkIndices: [0] }] } }] },
  { model: helper, evidenceId: 'fixture:grounded-search' });
  return { ...value, finishReason: 'STOP', usage: { input_tokens: 20, output_tokens: 7, thinking_tokens: 2, cache_read_tokens: 4 }, ...overrides };
}
function captured() {
  const fixture = require('./fixtures/claude-sdk-search-helper-2.1.322.json');
  return structuredClone(fixture.captures[0].body);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('ordinary requests and client-executed WebSearch remain outside this module', () => {
  assert.equal(prepareServerSearchForward({ messages: [], tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }] }), null);
  assert.equal(prepareServerSearchForward({ messages: [], tools: [{ name: 'web_search', input_schema: { type: 'object' } }] }), null);
  assert.equal(prepareServerSearchForward({ messages: [] }), null);
});

test('one search preserves every text turn, text-block boundary, system instruction and generation control', () => {
  const input = freeze(payload({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Earlier question.' }, { type: 'text', text: 'User SOUL: stay literal.' }] },
    { role: 'assistant', content: 'Earlier real answer.' }, { role: 'developer', content: 'AGENTS: preserve execution permissions.' },
    { role: 'user', content: [{ type: 'text', text: 'Compare that to today.' }] }],
  temperature: 0.3, top_p: 0.9, top_k: 12, stop_sequences: ['END'], thinking: { type: 'enabled', budget_tokens: 999 }, output_config: { effort: 'high' } }));
  const before = JSON.stringify(input), prepared = prepareServerSearchForward(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(prepared.query, 'Compare that to today.');
  assert.deepEqual(prepared.contents, [{ role: 'user', parts: [{ text: 'Earlier question.' }, { text: 'User SOUL: stay literal.' }] },
    { role: 'model', parts: [{ text: 'Earlier real answer.' }] }, { role: 'user', parts: [{ text: 'Compare that to today.' }] }]);
  assert.equal(prepared.instructions, 'Preserve these project rules.\n\nAGENTS: preserve execution permissions.');
  assert.deepEqual(prepared.generationConfig, { maxOutputTokens: 321, temperature: 0.3, topP: 0.9, topK: 12, stopSequences: ['END'] });
  assert.equal(prepared.generationConfig.thinkingConfig, undefined);
  assert.equal(prepared.normalized.model, 'claude-sonnet-4-6');
  assert.equal(prepared.normalized.tools.length, 0);
  assert.equal(prepared.skipSearch, false);
});

test('captured Claude secondary template removes only confirmed identity and unwraps only its query metadata', () => {
  const input = captured();
  input.tools[0].allowed_domains = [];
  input.system.push({ type: 'text', text: 'SOUL: I use Claude in this project. Preserve this user-authored text.' });
  const prepared = prepareServerSearchForward(freeze(input));
  assert.equal(prepared.identityMetadata.profile.client, 'claude');
  assert.equal(prepared.query, 'ANTIGRAVITY_LOCAL_WEBSEARCH_PROBE_20261107');
  assert.equal(prepared.contents[0].parts[0].text, input.messages[0].content[0].text);
  assert.ok(prepared.instructions.startsWith('You run a web search for another model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results.'));
  assert.ok(prepared.instructions.endsWith(input.system.at(-1).text));
  assert.doesNotMatch(prepared.instructions, /billing-header|Claude Agent SDK/);
  const ordinary = prepareServerSearchForward(payload({ messages: input.messages }));
  assert.equal(ordinary.query, input.messages[0].content[0].text);
});

test('strict nonempty allowed/blocked domains are rejected even when Google redirect title might match', () => {
  const original = captured();
  assert.throws(() => prepareServerSearchForward(original), { code: 'unsupported_server_search_domain_filter' });
  for (const key of ['allowed_domains', 'blocked_domains']) {
    assert.throws(() => prepareServerSearchForward(payload({ tools: [tool({ [key]: ['example.com'] })] })), { code: 'unsupported_server_search_domain_filter' });
    assert.equal(prepareServerSearchForward(payload({ tools: [tool({ [key]: [] })] })).skipSearch, false);
  }
});

test('any and named web_search permit exactly one forward; zero max_uses blocks generation', () => {
  for (const choice of [{ type: 'any', disable_parallel_tool_use: false }, { type: 'tool', name: 'web_search' }]) {
    const prepared = prepareServerSearchForward(payload({ tool_choice: choice, tools: [tool({ max_uses: 8 })] }));
    assert.equal(prepared.skipSearch, false);
    assert.equal(prepared.blockedByBudget, false);
  }
  assert.equal(prepareServerSearchForward(payload({ tools: [tool({ max_uses: 0 })] })).blockedByBudget, true);
  for (const choice of [{ type: 'tool', name: 'Read' }, { type: 'auto', name: 'web_search' }, 'auto', { type: 'auto', future: true }]) {
    assert.throws(() => prepareServerSearchForward(payload({ tool_choice: choice })), { code: 'unsupported_server_search_tool_choice' });
  }
});

test('ordinary auto is rejected without a planner; only the captured dedicated helper may use auto', () => {
  for (const tool_choice of [undefined, null, { type: 'auto' }]) {
    assert.throws(() => prepareServerSearchForward(payload({ tool_choice })), { code: 'unsupported_server_search_tool_choice' });
    const input = captured();
    input.tools[0].allowed_domains = [];
    input.tool_choice = tool_choice;
    assert.equal(prepareServerSearchForward(input).skipSearch, false);
    // Merely copying a phrase into a user message or an approximate system
    // instruction does not establish the complete captured helper template.
    input.system[0].text = input.system[0].text.replace('2.1.322', '99.0.0');
    assert.throws(() => prepareServerSearchForward(input), { code: 'unsupported_server_search_tool_choice' });
  }
});

test('none removes only disabled server tool, retaining normal-model tools, content and disabled choice', () => {
  const input = payload({ tools: [tool({ allowed_domains: ['example.com'], user_location: { type: 'approximate', country: 'US' } }),
    { name: 'Read', description: 'Client reads a file.', input_schema: { type: 'object', properties: {} } }],
  tool_choice: { type: 'none' }, messages: [{ role: 'user', content: 'Answer without searching.' }] });
  const prepared = prepareServerSearchForward(input);
  assert.equal(prepared.skipSearch, true);
  assert.deepEqual(prepared.normalized.toolChoice, { type: 'none' });
  assert.deepEqual(prepared.normalized.tools.map(item => item.name), ['Read']);
  assert.equal(prepared.normalized.messages[0].text, 'Answer without searching.');
  assert.equal(prepared.query, null);
});

test('mixed tools, media, structured output and unsupported execution controls fail without dropping content', () => {
  for (const change of [{ tools: [tool(), { name: 'Read', input_schema: { type: 'object' } }] }, { tools: [tool(), tool()] }]) {
    assert.throws(() => prepareServerSearchForward(payload(change)), { code: 'unsupported_server_search_tools' });
  }
  for (const block of [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
    { type: 'thinking', thinking: 'Do not drop my text.' }, { type: 'tool_use', id: 'x', name: 'Read', input: {} },
    { type: 'text', text: 'A cited answer.', citations: [{ type: 'web_search_result_location' }] }, { type: 'text', text: 'x', future: 'unknown' }]) {
    assert.throws(() => prepareServerSearchForward(payload({ messages: [{ role: 'user', content: [block] }] })), { code: 'unsupported_server_search_content' });
  }
  for (const change of [{ output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } },
    { output_format: { type: 'json_schema', schema: { type: 'object' } } }, { context_management: { edits: [] } }, { mcp_servers: [] }, { container: 'container1' },
    { future_execution_mode: true }, { output_config: { unknown_output_rule: 'must retain' } }]) {
    assert.throws(() => prepareServerSearchForward(payload(change)), { code: 'unsupported_server_search_request' });
  }
  assert.throws(() => prepareServerSearchForward(payload({ tools: [tool({ user_location: { type: 'approximate', country: 'US' } })] })), { code: 'unsupported_server_search_location' });
  for (const config of [{ allowed_callers: ['code_execution_20260120'] }, { defer_loading: true }]) {
    assert.throws(() => prepareServerSearchForward(payload({ tools: [tool(config)] })), { code: 'unsupported_server_search_execution' });
  }
});

test('missing, empty or assistant-prefilled final query cannot cause a guessed search', () => {
  for (const messages of [[], [{ role: 'user', content: '  ' }], [{ role: 'user', content: 'query' }, { role: 'assistant', content: 'prefill' }]]) {
    assert.throws(() => prepareServerSearchForward(payload({ messages })), { code: 'invalid_server_search_request' });
  }
  assert.throws(() => prepareServerSearchForward(payload({ messages: [{ role: 'tool', content: 'query' }] })), { code: 'unsupported_server_search_content' });
});

test('invalid explicit generation controls cannot silently become helper defaults', () => {
  for (const max_tokens of [0, -1, 1.1, '321', Infinity]) {
    assert.throws(() => prepareServerSearchForward(payload({ max_tokens })), { code: 'invalid_server_search_budget' });
  }
  for (const key of ['temperature', 'top_p', 'top_k']) {
    assert.throws(() => prepareServerSearchForward(payload({ [key]: 'invalid' })), { code: 'invalid_server_search_generation_config' });
  }
});

test('success is paired, exposes real helper and exact answer, and issues metadata-only unverified URL receipts', t => {
  const ctx = receipts(t), actual = result();
  const message = buildServerSearchMessage({ ...ctx, model: helper, query: 'current release', result: actual, tool: tool(), callId: 'srvtoolu_one' });
  assert.equal(message.model, helper);
  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content.map(item => item.type), ['server_tool_use', 'web_search_tool_result', 'text']);
  assert.equal(message.content[0].id, message.content[1].tool_use_id);
  assert.deepEqual(message.content[0].input, { query: 'current release' });
  assert.equal(message.content[2].text, actual.derivedAnswer);
  assert.deepEqual(message.usage, { input_tokens: 16, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 4,
    server_tool_use: { web_search_requests: 1 } });
  const reference = message.content[1].content[0];
  assert.equal(reference.url, actual.sourceCandidates[0].uri);
  assert.equal(reference.title, actual.sourceCandidates[0].title);
  const restored = ctx.receipts.restoreResult({ scope: ctx.scope, callId: 'srvtoolu_one', result: reference });
  assert.equal(restored.source.provenance.verifiedFinalUrl, false);
  assert.equal(restored.source.provenance.contentKind, 'metadata_only');
  assert.equal(restored.source.text, undefined);
  assert.equal(restored.metadata.query, 'current release');
  assert.doesNotMatch(JSON.stringify(message), /citations|cited_text|upstreamSourceText|Actual upstream source field/);
});

test('grounded MAX_TOKENS preserves partial helper answer and reports max_tokens', t => {
  const ctx = receipts(t);
  const message = buildServerSearchMessage({ ...ctx, query: 'query', result: result({ finishReason: 'MAX_TOKENS', derivedAnswer: 'Partial answer' }) });
  assert.equal(message.stop_reason, 'max_tokens');
  assert.equal(message.content.at(-1).text, 'Partial answer');
});

test('ordinary text, mismatched sources/model and abnormal finish cannot be packaged as search success', t => {
  const ctx = receipts(t);
  for (const change of [{ groundingMetadata: {} }, { queries: ['fabricated query'] },
    { sourceCandidates: [{ index: 0, uri: 'https://forged.example/', title: 'forged' }] }, { finishReason: 'SAFETY' }, { finishReason: undefined }]) {
    assert.throws(() => buildServerSearchMessage({ ...ctx, query: 'query', result: result(change) }));
  }
  assert.throws(() => buildServerSearchMessage({ ...ctx, model: 'claude-sonnet-4-6', query: 'query', result: result() }), { code: 'invalid_server_search_response' });
  assert.throws(() => buildServerSearchMessage({ ...ctx, query: 'query', result: result(), tool: tool({ max_uses: 0 }) }), { code: 'invalid_server_search_response' });
});

test('grounded search with no sources preserves actual empty result and does not invent a reference', () => {
  const actual = result({ sourceCandidates: [], groundingMetadata: { webSearchQueries: ['current release'] } });
  const message = buildServerSearchMessage({ query: 'query', result: actual });
  assert.deepEqual(message.content[1].content, []);
  assert.equal(message.usage.server_tool_use.web_search_requests, 1);
});

test('real receipt history survives restart as plain context without native function or signature fabrication', t => {
  const ctx = receipts(t), previous = buildServerSearchMessage({ ...ctx, query: 'current release', result: result(), callId: 'srvtoolu_one' });
  const input = freeze(payload({ messages: [{ role: 'user', content: 'current release' },
    { role: 'assistant', content: previous.content }, { role: 'user', content: 'Find the changelog for that same release.' }] }));
  const prepared = prepareServerSearchForward(input, { ...ctx, receipts: new ServerSearchReceipts({ directory: ctx.directory }) });
  assert.equal(prepared.query, 'Find the changelog for that same release.');
  assert.equal(prepared.contents[1].role, 'model');
  assert.match(prepared.contents[1].parts[1].text, /Previous verified server web search results/);
  assert.match(prepared.contents[1].parts[1].text, /"verifiedFinalUrl":false/);
  assert.equal(prepared.contents[1].parts[2].text, previous.content[2].text);
  assert.doesNotMatch(JSON.stringify(prepared.contents), /encrypted_content|thoughtSignature|functionCall|functionResponse|Actual upstream source field/);
  const ordinary = prepareServerSearchForward({ ...input, tools: [], tool_choice: undefined }, ctx);
  assert.equal(ordinary.skipSearch, true);
  assert.match(ordinary.normalized.messages[1].text, /Previous verified server web search results/);
});

test('receipt scope, call, source and query tampering is rejected; orphaned or duplicate history is rejected', t => {
  const ctx = receipts(t), previous = buildServerSearchMessage({ ...ctx, query: 'current release', result: result(), callId: 'srvtoolu_one' });
  const history = content => payload({ messages: [{ role: 'assistant', content }, { role: 'user', content: 'Next query' }] });
  assert.throws(() => prepareServerSearchForward(history(previous.content), { ...ctx, scope: 'other-client' }), { code: 'invalid_server_search_receipt' });
  for (const patch of [blocks => { blocks[0].input.query = 'forged query'; }, blocks => { blocks[1].content[0].url = 'https://forged.example/'; },
    blocks => { blocks[0].id = 'changed'; blocks[1].tool_use_id = 'changed'; }]) {
    const content = structuredClone(previous.content); patch(content);
    assert.throws(() => prepareServerSearchForward(history(content), ctx), { code: 'invalid_server_search_receipt' });
  }
  for (const content of [[previous.content[0]], [previous.content[1]], [previous.content[0], previous.content[0], previous.content[1]],
    [previous.content[0], previous.content[1], previous.content[1]]]) {
    assert.throws(() => prepareServerSearchForward(history(content), ctx), { code: 'invalid_server_search_history' });
  }
});

test('zero-budget and failed searches use standard paired errors, honest counts, and no synthetic answer', () => {
  const zero = buildServerSearchErrorMessage({ model: helper, query: 'query', tool: tool({ max_uses: 0 }), errorCode: 'max_uses_exceeded' });
  assert.equal(zero.content[1].content.type, 'web_search_tool_result_error');
  assert.equal(zero.content[1].content.error_code, 'max_uses_exceeded');
  assert.equal(zero.content.length, 2);
  assert.equal(zero.usage.server_tool_use.web_search_requests, 0);
  assert.equal(zero.usage.input_tokens, 0);
  const failure = buildServerSearchErrorMessage({ model: helper, query: 'query', errorCode: 'unavailable', searchRequests: 1 });
  assert.equal(failure.usage.server_tool_use.web_search_requests, 1);
  assert.equal(failure.usage_known, false);
  assert.throws(() => buildServerSearchErrorMessage({ model: helper, query: 'query', errorCode: 'max_uses_exceeded', searchRequests: 1 }), { code: 'invalid_server_search_response' });
  const prepared = prepareServerSearchForward(payload({ messages: [{ role: 'assistant', content: zero.content }, { role: 'user', content: 'New query' }] }));
  assert.match(prepared.contents[0].parts[1].text, /client-supplied.*error; no verified sources/);
});
