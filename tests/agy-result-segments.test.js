'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { AgySessionStore, newState, recordClientProjection } = require('../src/agy-session-state');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');

const model = 'gemini-3.8-flash-high';
const normalizers = { messages: normalizeAnthropic, responses: normalizeResponses };
const definitions = [
  { name: 'Search', description: 'Find tools.', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'ReadTarget', description: 'Read requested content.', schema: { type: 'object', properties: { path: { type: 'string' } } } }
];

function tools(protocol) {
  return definitions.map(({ schema, ...tool }) => protocol === 'messages' ? { ...tool, input_schema: schema }
    : { type: 'function', ...tool, parameters: schema });
}

function payload(protocol, blocks, { deleted = false, error = false, follow = false } = {}) {
  const common = { model, tools: deleted ? [] : tools(protocol), max_output_tokens: 128 };
  if (protocol === 'messages') return { ...common, messages: [
    { role: 'user', content: 'Find a file reader.' },
    ...(blocks ? [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'search', name: 'Search', input: { query: 'file' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search', content: blocks, ...(error ? { is_error: true } : {}) }] }
    ] : []),
    ...(follow ? [{ role: 'assistant', content: 'DONE' }, { role: 'user', content: 'Continue after removing the declarations.' }] : [])
  ] };
  return { ...common, input: [
    { role: 'user', content: 'Find a file reader.' },
    ...(blocks ? [
      { type: 'function_call', call_id: 'search', name: 'Search', arguments: '{"query":"file"}' },
      { type: 'function_call_output', call_id: 'search', output: blocks, ...(error ? { is_error: true } : {}) }
    ] : []),
    ...(follow ? [{ role: 'assistant', content: 'DONE' }, { role: 'user', content: 'Continue after removing the declarations.' }] : [])
  ] };
}

function resultPart(normalized) {
  return normalized.messages.flatMap(message => message.parts || []).find(part => part.type === 'tool_result');
}

for (const protocol of Object.keys(normalizers)) for (const field of ['tool_name', 'name']) for (const error of [false, true]) {
  test(`${protocol} ${field} ${error ? 'error' : 'success'}: actual reference blocks survive Direct and restart without rewriting quoted JSON`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-result-segments-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reference = { type: 'tool_reference', [field]: 'ReadTarget', annotation: 'reference metadata' };
    const literal = JSON.stringify(reference);
    const privateText = 'private-result-segment-keep-literal';
    const nested = JSON.stringify({ nested: reference });
    const encoded = Buffer.from('synthetic-image-bytes-not-persisted').toString('base64');
    const media = protocol === 'messages' ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: encoded } }
      : { type: 'input_image', image_url: `data:image/png;base64,${encoded}` };
    const blocks = [{ type: 'text', text: privateText }, { type: 'text', text: literal }, reference,
      media, { type: 'text', text: nested }, { type: 'text', text: 'ReadTarget remains literal prose.' }];
    const sourcePayload = payload(protocol, blocks, { error });
    const sourceBefore = JSON.stringify(sourcePayload), normalized = normalizers[protocol](sourcePayload);
    const part = resultPart(normalized);
    assert.equal(JSON.stringify(sourcePayload), sourceBefore);
    assert.deepEqual(part.references, ['ReadTarget']);
    assert.equal(part.content, [privateText, literal, literal, nested, 'ReadTarget remains literal prose.'].join('\n'));
    assert.deepEqual(part.resultSegments, [{ type: 'text', text: privateText }, { type: 'text', text: literal }, reference,
      { type: 'text', text: nested }, { type: 'text', text: 'ReadTarget remains literal prose.' }]);
    assert.doesNotMatch(JSON.stringify(part.resultSegments), new RegExp(encoded));
    assert.equal(part.media[0].data, encoded);
    assert.equal(JSON.stringify(part).split(encoded).length - 1, 1, 'Media Base64 appears only in the media representation');
    const adapter = prepareAntigravityTools(normalizers[protocol](payload(protocol)));
    const mappedReferences = adapter.toProviderReferences([reference]);
    assert.equal(mappedReferences.length, 2, 'Open-object tool exposes two real compatibility views');
    const expected = [privateText, literal, ...mappedReferences.map(item => JSON.stringify(item)), nested,
      'ReadTarget remains literal prose.'].join('\n');
    const requests = [];
    async function send(input) {
      const provider = new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'synthetic-token', projectId: 'synthetic-project',
        maxRetries: 0, localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:segments-test' }) },
        fetchImpl: async (_url, options) => {
          requests.push(JSON.parse(options.body));
          const parts = requests.length === 1 ? [{ functionCall: { id: 'search', name: adapter.toProviderName('Search'),
            args: { query: 'file', toolSummary: 'Finding tools' } }, thoughtSignature: 'actual-call-signature' }]
            : [{ text: requests.length === 2 ? 'DONE' : 'REPLAYED', thoughtSignature: 'actual-answer-signature' }];
          return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { headers: { 'content-type': 'application/json' } });
        } });
      return provider.send(normalizers[protocol](input), model, { sessionId: 'same-session' });
    }
    await send(payload(protocol));
    await send(sourcePayload);
    await send(payload(protocol, blocks, { error, deleted: true, follow: true }));
    for (const request of requests.slice(1)) {
      const response = request.request.contents.flatMap(content => content.parts).find(part => part.functionResponse)?.functionResponse;
      assert.equal(response.name, adapter.toProviderName('Search'));
      assert.deepEqual(response.response, { [error ? 'error' : 'output']: expected });
      assert.deepEqual(response.parts, [{ inlineData: { mimeType: 'image/png', data: encoded } }]);
      assert.doesNotMatch(JSON.stringify(request), /resultSegments|parsedResult|sourceFingerprint/);
    }
    assert.equal(requests[2].request.contents.find(content => content.parts.some(part => part.text === 'DONE')).parts[0].thoughtSignature,
      'actual-answer-signature');
    const saved = fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))), 'utf8');
    assert.doesNotMatch(saved, /private-result-segment-keep-literal|ReadTarget remains literal prose|resultSegments/);
    assert.ok(!saved.includes(encoded));
  });
}

for (const protocol of Object.keys(normalizers)) test(`${protocol}: segment provenance participates in receipt fingerprinting`, () => {
  const reference = { type: 'tool_reference', name: 'ReadTarget' }, quoted = { type: 'text', text: JSON.stringify(reference) };
  const first = normalizers[protocol](payload(protocol, [quoted, reference]));
  const second = normalizers[protocol](payload(protocol, [reference, quoted]));
  assert.equal(resultPart(first).content, resultPart(second).content, 'Flattened text alone cannot distinguish these receipts');
  const state = newState('account', 'session'), native = { state };
  buildDirectRequest(normalizers[protocol](payload(protocol)), model, 'project', 'session', '', null, native);
  const providerCall = { role: 'model', parts: [{ functionCall: { id: 'search', name: native.toolAdapter.toProviderName('Search'),
    args: { query: 'file', toolSummary: 'Finding tools' } }, thoughtSignature: 'real-signature' }] };
  const visible = { role: 'model', parts: [{ functionCall: { id: 'search', name: 'Search', args: { query: 'file' } } }] };
  recordClientProjection(state, native.context.sourceContents, visible, model, [providerCall], Date.now(), { kind: 'client_tools' });
  const firstBody = buildDirectRequest(first, model, 'project', 'session', '', null, { state });
  const firstFingerprint = Object.values(state.receiptTransforms)[0].sourceFingerprint;
  const secondBody = buildDirectRequest(second, model, 'project', 'session', '', null, { state });
  const secondFingerprint = Object.values(state.receiptTransforms)[0].sourceFingerprint;
  assert.notEqual(firstFingerprint, secondFingerprint);
  assert.notEqual(firstBody.request.contents.at(-1).parts[0].functionResponse.response.output,
    secondBody.request.contents.at(-1).parts[0].functionResponse.response.output);
});

test('both explicit reference aliases can agree, while conflicting aliases fail instead of choosing a name', () => {
  for (const protocol of Object.keys(normalizers)) {
    const agreed = { type: 'tool_reference', tool_name: 'ReadTarget', name: 'ReadTarget' };
    assert.deepEqual(resultPart(normalizers[protocol](payload(protocol, [agreed]))).references, ['ReadTarget']);
    assert.throws(() => normalizers[protocol](payload(protocol, [{ ...agreed, name: 'DifferentTool' }])), { code: 'invalid_tool_reference' });
    const textOnly = resultPart(normalizers[protocol](payload(protocol, [{ type: 'text', text: JSON.stringify(agreed) }])));
    assert.equal(textOnly.references, undefined);
    assert.equal(textOnly.resultSegments, undefined);
  }
});
