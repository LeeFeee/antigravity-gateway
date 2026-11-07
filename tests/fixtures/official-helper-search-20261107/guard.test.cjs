'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuard, inspectSourceFields, INPUT, ENDPOINT } = require('./probe.cjs');
const { searchRequest } = require('../../../src/antigravity-server-search');
const selection = { model: 'synthetic-catalog-helper', declaredModels: ['synthetic-catalog-helper'] };
const request = () => ({ method: 'POST', body: JSON.stringify(searchRequest({ ...INPUT, model: selection.model, project: 'synthetic-project' })) });

test('one catalog helper request retains the complete generation JSON before downstream parsing', async () => {
  const body = { response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Answer' }] },
    groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com', title: 'Source', text: 'Synthetic original source.' } }],
      extraFutureField: { keep: true } } }], modelVersion: 'synthetic-helper-version' }, unknownTopLevel: { keep: [1, 2] } };
  let calls = 0; const report = { observations: [] };
  const guard = createGuard({ fetch: async () => { calls++; return Response.json(body); } }, report, selection);
  const response = await guard.fetch(ENDPOINT, request());
  assert.deepEqual(report.generationResponse.body, body);
  assert.deepEqual(await response.json(), body);
  assert.equal(report.sourceFieldInspection[0].chunks[0].upstreamSourceTextPresent, true);
  await assert.rejects(guard.fetch(ENDPOINT, request()), /Second physical generation/);
  assert.equal(calls, 1);
});

test('trace additions, model substitution, streaming and aicode are rejected before network', async () => {
  let calls = 0; const report = { observations: [] };
  const guard = createGuard({ fetch: async () => { calls++; } }, report, selection);
  for (const mutate of [body => { body.model = 'claude-sonnet-4-6'; },
    body => { body.request.toolConfig = { includeServerSideToolInvocations: true }; },
    body => { body.request.generationConfig.maxOutputTokens = 4096; }]) {
    const options = request(), body = JSON.parse(options.body); mutate(body); options.body = JSON.stringify(body);
    await assert.rejects(guard.fetch(ENDPOINT, options));
  }
  await assert.rejects(guard.fetch(ENDPOINT.replace('generateContent', 'streamGenerateContent'), request()));
  await assert.rejects(guard.fetch(ENDPOINT.replace('daily-cloudcode-pa', 'aicode'), request()));
  assert.equal(calls, 0);
});

test('metadata 429 stops subsequent generation, and answer support is never counted as source text', async () => {
  let calls = 0; const report = { observations: [] };
  const guard = createGuard({ fetch: async () => { calls++; return Response.json({}, { status: 429 }); } }, report, selection);
  await guard.fetch(ENDPOINT.replace('generateContent', 'fetchAvailableModels'), { method: 'POST', body: '{}' });
  await assert.rejects(guard.fetch(ENDPOINT, request()), { code: 'probe_stopped_after_429' });
  assert.equal(calls, 1); assert.equal(guard.generationCount, 0);
  const inspected = inspectSourceFields({ candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com' } }],
    groundingSupports: [{ segment: { text: 'Answer text is not source text.' } }] } }] });
  assert.equal(inspected[0].chunks[0].upstreamSourceTextPresent, false);
});
