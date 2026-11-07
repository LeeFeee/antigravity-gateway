'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capturedRequest, createGuard, parseSse, assembleMessage, assess } = require('../../../scripts/verify-server-search-http');
const { searchRequest } = require('../../../src/antigravity-server-search');
const fixture = require('../client-web-tools-20261107/claude-web-search.json');
const endpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent';

test('captured payload keeps 32000 and every original field except the approved query and domain change', () => {
  const before = JSON.stringify(fixture), capture = capturedRequest();
  const expected = structuredClone(fixture.captures[capture.captureIndex].body);
  delete expected.tools[0].allowed_domains; delete expected.tools[0].blocked_domains;
  expected.messages[0].content[0].text = 'Perform a web search for the query: site:example.com Example Domain';
  assert.deepEqual(capture.request.body, expected);
  assert.equal(capture.prepared.generationConfig.maxOutputTokens, 32000);
  assert.equal(capture.prepared.generationConfig.temperature, 1);
  assert.deepEqual(capture.prepared.identityMetadata.rules, ['claude-billing-marker', 'claude-sdk-identity', 'claude-search-helper-model-identity']);
  assert.equal(JSON.stringify(fixture), before);
});

test('guard preserves a full 400 response and rejects retry, trace, budget change, main-model and webpage paths', async () => {
  const expected = capturedRequest().prepared, selected = { model: 'synthetic-helper', declaredModels: ['synthetic-helper'] }, records = [];
  let count = 0;
  const guard = createGuard({ expected, selected, record: value => records.push(value), nativeFetch: async () => {
    count++; return Response.json({ error: { code: 400, message: 'Synthetic budget rejection' }, unknown: { retained: true } }, { status: 400 });
  } });
  const body = searchRequest({ ...expected, project: 'synthetic-project', model: selected.model });
  for (const mutate of [b => { b.model = 'claude-sonnet-4-6'; }, b => { b.request.toolConfig = { includeServerSideToolInvocations: true }; },
    b => { b.request.generationConfig.maxOutputTokens = 2048; }]) {
    const changed = structuredClone(body); mutate(changed);
    await assert.rejects(guard.fetch({}, endpoint, { method: 'POST', body: JSON.stringify(changed) }));
  }
  for (const url of ['https://example.com', endpoint.replace('generateContent', 'streamGenerateContent'), endpoint.replace('daily-cloudcode-pa', 'aicode')]) {
    await assert.rejects(guard.fetch({}, url, { method: 'POST', body: JSON.stringify(body) }));
  }
  assert.equal(count, 0);
  const response = await guard.fetch({}, endpoint, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 400);
  assert.equal(records.find(r => r.type === 'generation-body').body.unknown.retained, true);
  await assert.rejects(guard.fetch({}, endpoint, { method: 'POST', body: JSON.stringify(body) }));
  assert.equal(count, 1);
});

test('metadata 429 prevents helper generation', async () => {
  let count = 0;
  const guard = createGuard({ expected: capturedRequest().prepared, selected: {}, record() {}, nativeFetch: async () => { count++; return Response.json({}, { status: 429 }); } });
  await guard.fetch({}, endpoint.replace('generateContent', 'fetchAvailableModels'), { method: 'POST', body: '{}' });
  await assert.rejects(guard.fetch({}, endpoint, { method: 'POST', body: '{}' }), { code: 'probe_stopped_after_429' });
  assert.equal(count, 1); assert.equal(guard.generationCount, 0);
});

test('SSE assessment verifies actual model, exact summary/links, paired call, usage and normal end', () => {
  const content = [{ type: 'server_tool_use', id: 'srvtoolu_test', name: 'web_search', input: { query: 'test' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_test', content: [{ type: 'web_search_result', url: 'https://example.com/raw', title: 'Source' }] },
    { type: 'text', text: 'Original upstream summary.' }];
  const usage = { input_tokens: 6, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, server_tool_use: { web_search_requests: 1 } };
  const data = [{ type: 'message_start', message: { model: 'synthetic-helper', content: [], usage } }];
  content.forEach((block, index) => {
    data.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : block.type === 'server_tool_use' ? { ...block, input: {} } : block });
    if (block.type === 'text') data.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    if (block.type === 'server_tool_use') data.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    data.push({ type: 'content_block_stop', index });
  });
  data.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }, { type: 'message_stop' });
  const events = parseSse(data.map(d => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join(''));
  assert.deepEqual(assembleMessage(events).content, content);
  const trace = [{ type: 'native-request', purpose: 'helper-generation', expectedEnvelopeMatched: true, body: { request: { generationConfig: { maxOutputTokens: 32000 } } } },
    { type: 'native-response', purpose: 'helper-generation', status: 200, binary: '/tmp/agy-transport-synthetic' },
    { type: 'account-selected', model: 'synthetic-helper', declaredModels: ['synthetic-helper'] },
    { type: 'generation-body', status: 200, body: { response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: content[2].text }] }, groundingMetadata: {
      groundingChunks: [{ web: { uri: 'https://example.com/raw', title: 'Source' } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 4 } } } }];
  const http = { status: 200, headers: { 'x-antigravity-model': 'synthetic-helper', 'content-type': 'text/event-stream; charset=utf-8' }, events };
  assert.equal(assess(http, trace).passed, true);
  assert.deepEqual(assess(http, trace).expectedUsage, { input_tokens: 6, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 4 });
  const changed = structuredClone(trace); changed[3].body.response.candidates[0].groundingMetadata.groundingChunks[0].web.uri = 'https://example.com/changed';
  assert.equal(assess(http, changed).checks.rawLinksPreserved, false);
  const truncated = structuredClone(trace); truncated[3].body.response.candidates[0].finishReason = 'MAX_TOKENS';
  const before = JSON.stringify(truncated);
  assert.equal(assess(http, truncated).passed, false);
  assert.equal(JSON.stringify(truncated), before);
  for (const invalid of [[events[0], ...events], events.filter(e => !(e.data.type === 'content_block_stop' && e.data.index === 0)),
    events.slice(0, -1), [...events, events[0]]]) {
    assert.equal(assess({ ...http, events: invalid }, trace).checks.completeSse, false);
  }
  assert.equal(assess({ ...http, headers: { 'x-antigravity-model': 'synthetic-helper' } }, trace).checks.helperSseHeaders, false);
});
