'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./fixtures/agy-1.5.8-wire.json');
const { buildDirectRequest, DirectAntigravityProvider } = require('../src/direct-provider');
const { generationProfile, cliUserAgent } = require('../src/agy-request-profile');
const { AgySessionStore, newState } = require('../src/agy-session-state');
const { normalizeChat, normalizeAnthropic, normalizeResponses, prepareNativeMultimodal } = require('../src/protocol');
const { finishResult } = require('../src/agy-structured-output');

for (const [model, captured] of Object.entries(fixture.models)) {
  test(`1.5.8 captured ${model}: generation, first-turn flags and envelope`, () => {
    assert.equal(captured.status, 200);
    const request = buildDirectRequest({ messages: [{ role: 'user', text: 'hello' }] }, model, 'fixture-project', 'client-session');
    assert.deepEqual(Object.keys(request), fixture.transport.outerKeys);
    assert.deepEqual(request.request.generationConfig, captured.generationConfig);
    for (const [key, value] of Object.entries(captured.labels)) assert.equal(request.request.labels[key], value);
    assert.equal(request.request.sessionId, captured.sessionId);
    assert.equal(request.request.toolConfig, undefined);
    assert.equal(request.request.tools, undefined);
  });
}

test('numeric catalog defaults cannot replace a captured named thinking tier', () => {
  for (const number of [1, 2, 3]) {
    const config = generationProfile({ generationConfig: { maxOutputTokens: 4096 } }, 'gemini-3.8-flash-high',
      { supportsThinking: true, maxOutputTokens: 65536, thinkingLevel: number, thinkingBudget: -1 });
    assert.deepEqual(config, { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } });
  }
});

test('provider metadata and generation carry captured UA and Bearer headers without extra Accept', async () => {
  const seen = [];
  const provider = new DirectAntigravityProvider({ authFile: '', accessToken: 'fixture-token', projectId: 'fixture-project',
    localAuth: { isConfigured: () => false, load: () => ({}) }, sessionStore: new AgySessionStore({ directory: '' }),
    fetchImpl: async (url, options) => {
      seen.push(options);
      return new Response(JSON.stringify(url.includes('fetchAvailableModels')
        ? { models: { 'gemini-3.8-flash-high': { supportsThinking: true, thinkingLevel: 3 } } }
        : { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
    }
  });
  await provider.listModels();
  await provider.send({ messages: [{ role: 'user', text: 'hello' }] }, 'gemini-3.8-flash-high');
  const capturedUA = fixture.transport.headers.find(([key]) => key.toLowerCase() === 'user-agent')[1];
  assert.equal(cliUserAgent({ platform: 'darwin', arch: 'arm64' }), capturedUA);
  for (const options of seen) assert.deepEqual(options.headers, {
    authorization: 'Bearer fixture-token', 'content-type': 'application/json', 'user-agent': cliUserAgent()
  });
});

test('all normalized entrances retain business fields through standard compatibility declarations', () => {
  const schema = { type: 'object', properties: { file_path: { type: 'string' }, toolSummary: { type: 'boolean' } }, required: ['file_path', 'toolSummary'] };
  const inputs = [
    [normalizeChat({ messages: [{ role: 'user', content: 'Read' }], tools: [{ type: 'function', function: { name: 'Read', parameters: schema } }], tool_choice: { type: 'function', function: { name: 'Read' } } }), 'hermes-0.21.7-captured'],
    [normalizeAnthropic({ messages: [{ role: 'user', content: 'Read' }], tools: [{ name: 'Read', input_schema: schema }], tool_choice: { type: 'tool', name: 'Read' } }), 'claude-code-2.1.285'],
    [normalizeResponses({ input: 'Read', tools: [{ type: 'function', name: 'Read', parameters: schema }], tool_choice: { type: 'function', name: 'Read' } }), 'codex-exec-0.159.2']
  ];
  for (const [normalized, clientProfile] of inputs) {
    const before = structuredClone(normalized), native = { clientProfile };
    const wire = buildDirectRequest(normalized, 'gemini-3.8-flash-high', 'p', 's', '', null, native);
    const declaration = wire.request.tools[0].functionDeclarations[0];
    assert.match(declaration.name, /^mcp_gateway_tool_.*_json$/);
    assert.equal(declaration.parameters.properties.toolSummary.type, 'STRING');
    assert.deepEqual(wire.request.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: [declaration.name] });
    const call = { name: 'Read', arguments: { file_path: '/fixture', toolSummary: false } };
    assert.deepEqual(native.toolAdapter.toClient(native.toolAdapter.toProvider(call)), call);
    assert.deepEqual(normalized, before);
  }
});

test('ordinary turns include the built-in image service and preserve client-owned tool declarations', () => {
  for (const tools of [[], [{ name: 'client_tool', schema: { type: 'object' } }]]) {
    const normalized = { messages: [{ role: 'user', text: 'Create an image' }], tools };
    const prepared = prepareNativeMultimodal(normalized);
    assert.equal(prepared.imageToolInjected, true);
    assert.deepEqual(prepared.normalized.tools.slice(0, -1), tools);
    assert.deepEqual(normalized.tools, tools);
    assert.equal(prepared.normalized.tools.at(-1).name, 'generate_image');
    assert.equal(prepared.normalized.tools.at(-1).internal, true);
  }
});

test('Claude forced tools cannot turn off the configuration bound to the public model name', () => {
  const input = { messages: [{ role: 'user', text: 'lookup' }], tools: [{ name: 'lookup', schema: { type: 'object' } }],
    toolChoice: { type: 'tool', name: 'lookup' } };
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
    for (const client of [{}, { includeThinking: true }, { reasoningEffort: 'none' },
      { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }]) {
      assert.throws(() => buildDirectRequest({ ...input, ...client }, model, 'p', 's'),
        { code: 'model_capability_conflict', status: 400 });
      const auto = buildDirectRequest({ ...input, ...client, toolChoice: 'auto' }, model, 'p', 's');
      assert.deepEqual(auto.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
    }
  }
});

test('1.5.2 structured completion preserves formerly reserved business fields', () => {
  const value = { explanation: '', toolSummary: false, toolAction: 0, waitForPreviousTools: 'business' };
  const schema = { type: 'object', properties: { explanation: { type: 'string' }, toolSummary: { type: 'boolean' },
    toolAction: { type: 'integer' }, waitForPreviousTools: { type: 'string' } }, required: Object.keys(value), additionalProperties: false };
  const wire = buildDirectRequest({ messages: [{ role: 'user', text: 'JSON' }], structuredSchema: schema }, 'gemini-3.8-flash-high', 'p', 's');
  const declaration = wire.request.tools[0].functionDeclarations[0];
  assert.deepEqual(declaration.parameters.required, Object.keys(value));
  assert.deepEqual(Object.keys(declaration.parameters.properties).sort(), Object.keys(value).sort());
  assert.deepEqual(JSON.parse(finishResult(schema, [{ name: 'finish', arguments: value }]).text), value);
});

test('old cached aliases and signed projections are not restored after profile migration', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-152-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const old = { ...newState('owner', 'key'), version: 1, projections: { old: { name: 'view_file' } } };
  const file = path.join(directory, 'old.json');
  fs.writeFileSync(file, JSON.stringify(old));
  const state = new AgySessionStore({ directory }).read(file, 'owner', 'key');
  assert.equal(state.version, 2);
  assert.notEqual(state.cascadeId, old.cascadeId);
  assert.equal(state.projections, undefined);
});
