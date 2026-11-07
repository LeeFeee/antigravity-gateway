'use strict';

const { directory } = require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { normalizeAnthropic, normalizeChat, normalizeResponses } = require('../src/protocol');
const { CODEX_CLIENT_PROFILE } = require('../src/agy-client-profile');
const codex = require('./fixtures/codex-exec-0.159.2-tools.json');

const { declaredCall } = require('./helpers/declared-tool-fixture');
const model = 'gemini-3.8-flash-high';
const name = 'lookup_record';
const schema = { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false };
const cases = [
  {
    protocol: 'anthropic', normalize: normalizeAnthropic,
    payload: { messages: [{ role: 'user', content: 'Look up the record.' }], tools: [{ name, input_schema: schema }] },
    choice: { type: 'tool', name }
  },
  {
    protocol: 'chat', normalize: normalizeChat,
    payload: { messages: [{ role: 'user', content: 'Look up the record.' }], tools: [{ type: 'function', function: { name, parameters: schema } }] },
    choice: { type: 'function', function: { name } }
  },
  {
    protocol: 'responses', normalize: normalizeResponses,
    payload: { input: 'Look up the record.', tools: [{ type: 'function', name, parameters: schema }] },
    choice: { type: 'function', name }
  }
];

function normalizedFor(entry, choice) {
  return entry.normalize({ ...entry.payload, ...(choice === undefined ? {} : { tool_choice: choice }) });
}

function selection(normalized, selectedModel = model, native = {}) {
  return buildDirectRequest(normalized, selectedModel, 'fake-project', 'fake-session', '', null, native)
    .request.toolConfig?.functionCallingConfig;
}

for (const entry of cases) {
  test(`${entry.protocol} named tool requires ANY and preserves the requested name`, async () => {
    const normalized = normalizedFor(entry, entry.choice), before = structuredClone(normalized), sent = [];
    const provider = new DirectAntigravityProvider({
      authFile: '', accessToken: 'fake-tool-choice-token', refreshToken: '', projectId: 'fake-project', maxRetries: 0,
      models: [model], retryPolicy: 'legacy',
      baseUrl: 'https://tool-choice.invalid',
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:fake-tool-choice' }) },
      sessionStore: new AgySessionStore({ directory: path.join(directory, entry.protocol) }),
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://tool-choice.invalid/v1internal:streamGenerateContent?alt=sse');
        assert.equal(options.headers.authorization, 'Bearer fake-tool-choice-token');
        sent.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
          functionCall: declaredCall(sent.at(-1), { id: 'fake-call', name, args: { key: 'fixture' } })
        }] } }] }), { headers: { 'content-type': 'application/json' } });
      }
    });
    const result = await provider.send(normalized, model, { sessionId: `fake-${entry.protocol}` });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].request.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: [sent[0].request.tools[0].functionDeclarations[0].name] });
    assert.deepEqual(result.toolCalls[0].arguments, { key: 'fixture' });
    assert.equal(result.toolCalls[0].name, name);
    assert.deepEqual(normalized, before);
  });
}

test('ordinary AUTO, none and required selections retain their existing modes', () => {
  for (const entry of cases) {
    for (const choice of [undefined, 'auto', { type: 'auto' }]) assert.equal(selection(normalizedFor(entry, choice)), undefined);
    for (const choice of ['none', { type: 'none' }]) assert.deepEqual(selection(normalizedFor(entry, choice)), { mode: 'NONE' });
    for (const choice of ['required', 'any', { type: 'required' }, { type: 'any' }]) {
      assert.deepEqual(selection(normalizedFor(entry, choice)), { mode: 'ANY' });
    }
  }
});

test('Claude 1.5.2 omits default toolConfig and honors explicit client constraints', () => {
  for (const entry of cases) {
    const config = selection(normalizedFor(entry, entry.choice), 'claude-test');
    assert.equal(config.mode, 'ANY');
    assert.equal(config.allowedFunctionNames.length, 1);
    assert.match(config.allowedFunctionNames[0], /^mcp_gateway_tool_/);
    for (const choice of [undefined, 'auto', { type: 'auto' }]) assert.equal(selection(normalizedFor(entry, choice), 'claude-test'), undefined);
    for (const choice of ['required', 'any', { type: 'required' }, { type: 'any' }]) assert.deepEqual(selection(normalizedFor(entry, choice), 'claude-test'), { mode: 'ANY' });
    for (const choice of ['none', { type: 'none' }]) assert.deepEqual(selection(normalizedFor(entry, choice), 'claude-test'), { mode: 'NONE' });
  }
});

test('named Codex choice preserves the client name when forcing ANY', () => {
  const normalized = normalizeResponses({ input: 'Read the fixture.', tools: structuredClone(codex.tools),
    tool_choice: { type: 'function', name: 'exec_command' } });
  const before = structuredClone(normalized);
  const native = { clientProfile: CODEX_CLIENT_PROFILE };
  const choice = selection(normalized, model, native);
  assert.equal(choice.mode, 'ANY');
  assert.deepEqual(choice.allowedFunctionNames, [native.toolAdapter.toProviderName('exec_command')]);
  assert.equal(native.toolAdapter.toClientName(choice.allowedFunctionNames[0]), 'exec_command');
  assert.deepEqual(normalized, before);
});
