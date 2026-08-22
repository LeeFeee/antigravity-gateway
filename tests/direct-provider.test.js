'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { LocalAgyAuthProvider } = require('../src/local-agy-auth');

function normalized(stream = false) {
  return {
    system: 'client system',
    messages: [{ role: 'user', text: 'hello' }],
    tools: [],
    toolChoice: null,
    stream,
  };
}

test('direct request uses native Antigravity envelope without agy prompt', () => {
  const request = buildDirectRequest(normalized(), 'gemini-test-high', 'project-1', '-123');
  assert.equal(request.model, 'gemini-test-high');
  assert.equal(request.project, 'project-1');
  assert.match(request.requestId, /^agent-/);
  assert.equal(request.request.sessionId, '-123');
  assert.equal(request.request.systemInstruction.parts[0].text, 'client system');
  assert.deepEqual(request.request.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
  assert.doesNotMatch(JSON.stringify(request), /ANTIGRAVITY_GATEWAY_INFERENCE_CONTRACT|CLIENT_SYSTEM_BEGIN/);
});

test('direct request follows Antigravity Claude tool mode and strips unsupported schema metadata', () => {
  const request = buildDirectRequest({
    ...normalized(),
    generationConfig: { maxOutputTokens: 42 },
    tools: [{ name: 'shell', description: 'run', schema: {
      type: 'object', title: 'ignored', additionalProperties: false,
      properties: { command: { type: 'string', format: 'shell', description: 'command' } },
      required: ['command']
    } }]
  }, 'claude-sonnet-5', 'project-1', '-123');
  assert.equal(request.request.toolConfig.functionCallingConfig.mode, 'VALIDATED');
  assert.deepEqual(request.request.generationConfig, { maxOutputTokens: 42 });
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.title, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.properties.command.format, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.additionalProperties, false);
});

test('direct request keeps a visible response budget for high-thinking models', () => {
  const request = buildDirectRequest({ ...normalized(), generationConfig: { maxOutputTokens: 16 } }, 'gemini-3.7-flash-high', 'project-1', '-123');
  assert.equal(request.request.generationConfig.maxOutputTokens, 128);
});

test('direct provider parses non-stream text and usage', async () => {
  const calls = [];
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', baseUrl: 'https://example.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello direct' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await provider.send(normalized(), 'gemini-test-high', { sessionId: '-123' });
  assert.equal(result.text, 'hello direct');
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0 });
  assert.equal(calls[0].url, 'https://example.test/v1internal:generateContent');
  assert.equal(calls[0].options.headers.authorization, 'Bearer token');
});

test('direct provider forwards upstream SSE text deltas', async () => {
  const deltas = [];
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', baseUrl: 'https://example.test',
    fetchImpl: async () => new Response([
      'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n',
      'data: {"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  const result = await provider.send(normalized(true), 'gemini-test-high', { sessionId: '-123', onDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(deltas, ['hel', 'lo']);
  assert.equal(result.text, 'hello');
  assert.equal(result.usage.total_tokens, 4);
});

test('direct provider discovers the account model catalog from Cloud Code', async () => {
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token',
    projectId: 'project-1',
    baseUrl: 'https://example.test',
    models: [],
    fetchImpl: async (url, options) => {
      assert.match(url, /fetchAvailableModels$/);
      assert.equal(options.body, '{}');
      return new Response(JSON.stringify({ models: {
        'gemini-3.7-flash-high': { displayName: 'Flash' },
        'models/claude-sonnet-5': { displayName: 'Claude' },
        'not a model': { displayName: 'ignored' }
      } }), { status: 200 });
    }
  });
  assert.deepEqual(await provider.listModels(), ['gemini-3.7-flash-high', 'claude-sonnet-5']);
});

test('direct provider turns native function calls into the gateway envelope', async () => {
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'shell', args: { command: 'pwd' } } }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const result = await provider.send({ ...normalized(), tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }] }, 'gemini-test-high', { sessionId: '-123' });
  assert.match(result.text, /ANTIGRAVITY_GATEWAY_TOOL_CALLS/);
  assert.match(result.text, /"name":"shell"/);
});

test('local agy auth adapter reads jetski state and does not write refreshed plaintext tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-auth-test-'));
  const file = path.join(dir, 'jetski-standalone-oauth-token');
  fs.writeFileSync(file, JSON.stringify({ token: {
    access_token: 'expired-local-token',
    refresh_token: 'local-refresh-token',
    expiry: '2000-01-01T00:00:00Z'
  }, auth_method: 'consumer' }), { mode: 0o600 });
  const auth = new LocalAgyAuthProvider({
    authFile: file,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'refreshed-local-token', expires_in: 3600 }), { status: 200 })
  });
  const result = await auth.get();
  assert.equal(result.accessToken, 'refreshed-local-token');
  assert.equal(result.authMethod, 'consumer');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token.access_token, 'expired-local-token');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('direct provider prefers local agy state over explicit fallback env credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-auth-test-'));
  const file = path.join(dir, 'jetski-standalone-oauth-token');
  fs.writeFileSync(file, JSON.stringify({ token: {
    access_token: 'local-token',
    refresh_token: 'local-refresh-token',
    expiry: '2099-01-01T00:00:00Z'
  }, auth_method: 'consumer' }), { mode: 0o600 });
  const auth = new LocalAgyAuthProvider({ authFile: file });
  let seenAuthorization = '';
  const provider = new DirectAntigravityProvider({
    localAuth: auth,
    accessToken: 'explicit-token',
    projectId: 'project-1',
    baseUrl: 'https://example.test',
    fetchImpl: async (_url, options) => {
      seenAuthorization = options.headers.authorization;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'local auth' }] } }] }), { status: 200 });
    }
  });
  await provider.send(normalized(), 'gemini-test-high', { sessionId: '-123' });
  assert.equal(seenAuthorization, 'Bearer local-token');
  fs.rmSync(dir, { recursive: true, force: true });
});
