'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchRequest, parseSearchResponse } = require('../src/antigravity-server-search');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { webSearch } = require('./fixtures/agy-1.5.8-wire.json');
const recorded = require('./fixtures/client-web-tools-20261107/latest-release-batch/gemini-low-latest-release.json');
const helper = 'gemini-3.5-flash-lite';

const grounded = () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Generated summary, not a page quote.' }] },
  groundingMetadata: { webSearchQueries: ['controlled query'], groundingChunks: [{ web: { uri: 'https://example.com/source', title: 'Source' } }],
    groundingSupports: [{ segment: { text: 'Generated summary, not a page quote.' }, groundingChunkIndices: [0] }] } }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 9, totalTokenCount: 20 } });

test('search helper request matches the 1.5.8 envelope with the site hint in the query', () => {
  const request = webSearch;
  assert.deepEqual(searchRequest({ project: request.project, model: request.model,
    query: request.request.contents[0].parts[0].text }), request);
  const plain = searchRequest({ project: 'controlled-project', model: helper, query: 'controlled query' });
  assert.equal(plain.requestId, undefined);
  assert.equal(plain.request.generationConfig.thinkingConfig, undefined);
  assert.equal(plain.request.tools[0].googleSearch.includedDomains, undefined);
});

test('search helper output budget is explicit and never coerced or expanded', () => {
  const base = { project: 'controlled-project', model: helper, query: 'controlled query' };
  assert.equal(searchRequest({ ...base, maxOutputTokens: 321 }).request.generationConfig.maxOutputTokens, 321);
  for (const maxOutputTokens of [0, -1, 1.1, '321', Infinity]) {
    assert.throws(() => searchRequest({ ...base, maxOutputTokens }), { code: 'invalid_server_search_budget' });
  }
});

test('search forwarding preserves original text context, instructions, output and stop controls', () => {
  const contents = [{ role: 'user', parts: [{ text: 'Earlier query' }] }, { role: 'model', parts: [{ text: 'Earlier answer' }] },
    { role: 'user', parts: [{ text: 'Current query' }] }];
  const generationConfig = { maxOutputTokens: 321, temperature: 0.5, topP: 0.8, topK: 12, stopSequences: ['STOP_HERE'] };
  const result = searchRequest({ project: 'controlled', model: helper, query: 'Current query', contents,
    instructions: 'Preserved user SOUL and task instructions.', generationConfig });
  assert.deepEqual(result.request.contents, contents);
  assert.deepEqual(result.request.generationConfig, { candidateCount: 1, ...generationConfig });
  assert.equal(result.request.systemInstruction.parts[1].text, 'Preserved user SOUL and task instructions.');
  result.request.contents[0].parts[0].text = 'mutation';
  result.request.generationConfig.stopSequences.push('mutation');
  assert.equal(contents[0].parts[0].text, 'Earlier query');
  assert.deepEqual(generationConfig.stopSequences, ['STOP_HERE']);
  assert.throws(() => searchRequest({ project: 'controlled', model: helper, query: 'query', generationConfig, maxOutputTokens: 999 }), { code: 'invalid_server_search_budget' });
  assert.throws(() => searchRequest({ project: 'controlled', model: helper, query: 'query', contents: [{ role: 'user', parts: [{ inlineData: {} }] }] }), { code: 'invalid_server_search_contents' });
});

test('real recorded grounding remains source metadata, not manufactured source quotes', () => {
  const captured = recorded.response.candidates[0];
  const result = parseSearchResponse({ candidates: [{ ...captured, content: { parts: [{ text: captured.text }] } }] }, { model: 'gemini-3.8-flash-low' });
  assert.equal(result.sourceCandidates.length, 3);
  assert.equal(result.queries.length, 2);
  assert.ok(result.sourceCandidates.every(source => !Object.hasOwn(source, 'upstreamSourceText')));
  assert.equal(result.derivedAnswer, captured.text);
  assert.equal(result.text, undefined);
  assert.deepEqual(result.groundingMetadata, captured.groundingMetadata);
  result.groundingMetadata.webSearchQueries.push('mutation');
  assert.equal(captured.groundingMetadata.webSearchQueries.length, 2);
});

test('a real source-text field is preserved independently from generated answer text', () => {
  const body = grounded();
  body.candidates[0].groundingMetadata.groundingChunks[0].web.text = 'Controlled source excerpt.';
  const parsed = parseSearchResponse(body, { model: helper });
  assert.equal(parsed.sourceCandidates[0].upstreamSourceText, 'Controlled source excerpt.');
  assert.notEqual(parsed.sourceCandidates[0].upstreamSourceText, parsed.derivedAnswer);
});

test('ordinary text, incomplete search and malformed grounding cannot masquerade as search success', () => {
  assert.throws(() => parseSearchResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Search Results' }] } }] }), { code: 'server_search_not_grounded' });
  for (const finishReason of ['SAFETY', undefined]) {
    const value = grounded(); value.candidates[0].finishReason = finishReason;
    assert.throws(() => parseSearchResponse(value), { code: 'incomplete_server_search' });
  }
  const invalid = grounded(); invalid.candidates[0].groundingMetadata.groundingChunks[0].web.uri = { text: 'url' };
  assert.throws(() => parseSearchResponse(invalid), { code: 'invalid_server_search_response' });
  const empty = grounded(); empty.candidates[0].groundingMetadata.groundingChunks = [];
  assert.deepEqual(parseSearchResponse(empty).sourceCandidates, []);
  empty.candidates[0].groundingMetadata.webSearchQueries = ['   '];
  assert.throws(() => parseSearchResponse(empty), { code: 'server_search_not_grounded' });
  const blankSource = grounded(); blankSource.candidates[0].groundingMetadata.groundingChunks[0].web.uri = '   ';
  assert.throws(() => parseSearchResponse(blankSource), { code: 'invalid_server_search_response' });
  const partial = grounded(); partial.candidates[0].finishReason = 'MAX_TOKENS';
  assert.equal(parseSearchResponse(partial).finishReason, 'MAX_TOKENS', 'actual grounded results keep their truncated summary status');
});

function providerFor(fetchImpl, extra = {}) {
  return new DirectAntigravityProvider({ fetchImpl, accessToken: 'controlled-token', projectId: 'controlled-project',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com', userAgent: 'controlled-ua', maxRetries: 100,
    localAuth: { isConfigured: () => false, load: () => ({}) }, ...extra });
}

test('search service uses only catalog-declared helper, one physical request and separately attributed usage', async () => {
  const calls = [], observations = [];
  const provider = providerFor(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.endsWith(':fetchAvailableModels')) return Response.json({ models: { 'claude-sonnet-4-6': {} }, webSearchModelIds: [helper, helper] });
    return Response.json(grounded());
  });
  const result = await provider.searchWeb({ model: helper, query: 'controlled query' }, { onUpstreamAttempt: entry => observations.push(entry) });
  assert.deepEqual(provider.webSearchModelCatalog(), [helper]);
  assert.deepEqual(provider.modelCatalog(), ['claude-sonnet-4-6']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith(':generateContent'));
  assert.equal(calls[1].init.headers['user-agent'], 'controlled-ua');
  assert.equal(calls[1].body.model, helper);
  assert.equal(result.model, helper);
  assert.equal(result.usageKnown, true);
  assert.equal(result.usage.total_tokens, 20);
  assert.deepEqual(observations.map(entry => entry.phase), ['start', 'response']);
});

test('missing search usage is reported as unknown rather than a measured zero', async () => {
  const body = grounded();
  delete body.usageMetadata;
  const provider = providerFor(async url => url.endsWith(':fetchAvailableModels')
    ? Response.json({ models: { 'claude-sonnet-4-6': {} }, webSearchModelIds: [helper] }) : Response.json(body));
  const result = await provider.searchWeb({ model: helper, query: 'controlled query' });
  assert.equal(result.usageKnown, false);
});

test('unknown helper never becomes a silent model substitute', async () => {
  const calls = [];
  const provider = providerFor(async url => {
    calls.push(url); return Response.json({ models: { 'claude-sonnet-4-6': {} }, webSearchModelIds: [helper] });
  });
  await assert.rejects(provider.searchWeb({ model: 'claude-sonnet-4-6', query: 'controlled query' }), { code: 'server_search_model_unavailable' });
  assert.equal(calls.length, 1);
});

test('invalid helper input is rejected before catalog, authentication or generation I/O', async () => {
  let calls = 0;
  const provider = providerFor(async () => { calls++; throw new Error('Unexpected I/O'); });
  await assert.rejects(provider.searchWeb({ model: helper, query: 'controlled query', maxOutputTokens: 0 }), { code: 'invalid_server_search_budget' });
  assert.equal(calls, 0);
});

for (const status of [401, 429, 503]) test(`search helper ${status} performs no hidden retry or model/account fallback`, async () => {
  let generations = 0;
  const provider = providerFor(async url => {
    if (url.endsWith(':fetchAvailableModels')) return Response.json({ models: {}, webSearchModelIds: [helper] });
    generations++; return Response.json({ error: { message: 'controlled failure' } }, { status });
  });
  await assert.rejects(provider.searchWeb({ model: helper, query: 'controlled query' }), { code: 'direct_search_upstream_error', status });
  assert.equal(generations, 1);
});
