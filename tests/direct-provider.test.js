'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { LocalAgyAuthProvider, decodeKeychainRecord, discoverClientCredentials } = require('../src/local-agy-auth');

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

test('direct request normalizes nullable union schema types for Cloud Code', () => {
  const request = buildDirectRequest({
    ...normalized(),
    tools: [{ name: 'save', description: 'save', schema: {
      type: 'object', properties: { path: { type: ['string', 'null'] } }
    } }]
  }, 'gemini-test-high', 'project-1', '-123');
  const pathSchema = request.request.tools[0].functionDeclarations[0].parameters.properties.path;
  assert.equal(pathSchema.type, 'string');
  assert.equal(pathSchema.nullable, true);
});

test('direct request maps tool IDs inside native Gemini function calls', () => {
  const request = buildDirectRequest({
    ...normalized(),
    messages: [
      { role: 'user', text: 'previous task' },
      { role: 'assistant', text: '[ASSISTANT_TOOL_CALL id=call_old name=shell]\n{"command":"pwd"}' },
      { role: 'user', text: 'continue' }
    ],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-test-high', 'project-1', '-123');
  const part = request.request.contents[1].parts[0];
  assert.deepEqual(part.functionCall, { id: 'call_old', name: 'shell', args: { command: 'pwd' } });
  assert.equal(part.id, undefined);
});

test('direct request maps tool results to the original function name and ID', () => {
  const request = buildDirectRequest({
    ...normalized(),
    messages: [
      { role: 'user', text: 'previous task' },
      { role: 'assistant', text: '[ASSISTANT_TOOL_CALL id=call_old name=shell]\n{"command":"pwd"}' },
      { role: 'user', text: '[CLIENT_TOOL_RESULT id=call_old]\n/tmp' },
      { role: 'user', text: 'continue' }
    ],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-test-high', 'project-1', '-123');
  const part = request.request.contents[2].parts[0];
  assert.deepEqual(part.functionResponse, {
    id: 'call_old', name: 'shell', response: { result: '/tmp' }
  });
});

test('direct request keeps an orphaned tool result as text instead of inventing a function name', () => {
  const request = buildDirectRequest({
    ...normalized(),
    messages: [{ role: 'user', text: '[CLIENT_TOOL_RESULT id=orphan]\nold output' }],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-test-high', 'project-1', '-123');
  assert.equal(request.request.contents[0].parts[0].functionResponse, undefined);
  assert.match(request.request.contents[0].parts[0].text, /CLIENT_TOOL_RESULT id=orphan/);
});

test('direct request restores the Cloud Code thought signature for a prior tool call', () => {
  const request = buildDirectRequest({
    ...normalized(),
    messages: [
      { role: 'user', text: 'previous task' },
      { role: 'assistant', text: '[ASSISTANT_TOOL_CALL id=call_old name=shell]\n{"command":"pwd"}' },
      { role: 'user', text: 'continue' }
    ],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-test-high', 'project-1', '-123', '', new Map([['call_old', 'signature-1']]));
  const part = request.request.contents[1].parts[0];
  assert.equal(part.thoughtSignature, 'signature-1');
  assert.equal(part.id, undefined);
});

test('direct request uses the Cloud Code compatibility sentinel when Gemini 3 history lost its signature', () => {
  const request = buildDirectRequest({
    ...normalized(),
    messages: [
      { role: 'user', text: 'previous task' },
      { role: 'assistant', text: '[ASSISTANT_TOOL_CALL id=call_old name=shell]\n{"command":"pwd"}' },
      { role: 'user', text: '[CLIENT_TOOL_RESULT id=call_old]\n/tmp' },
      { role: 'user', text: 'continue' }
    ],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-3.7-flash-high', 'project-1', '-123');
  assert.equal(request.request.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(request.request.contents[2].parts[0].functionResponse.name, 'shell');
});

test('direct request does not duplicate the signature sentinel for parallel Gemini 3 calls', () => {
  const request = buildDirectRequest({
    ...normalized(),
    messages: [{ role: 'assistant', text: 'ignored', parts: [
      { type: 'tool_call', id: 'call_a', name: 'shell', arguments: { command: 'pwd' } },
      { type: 'tool_call', id: 'call_b', name: 'shell', arguments: { command: 'ls' } }
    ] }],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-3.7-flash-high', 'project-1', '-123');
  assert.equal(request.request.contents[0].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(request.request.contents[0].parts[1].thoughtSignature, undefined);
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

test('direct provider assembles streamed native function-call arguments', async () => {
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', baseUrl: 'https://example.test',
    fetchImpl: async () => new Response([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"stream-call","name":"shell","args":"{\\"command\\":\\"p"}}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"thoughtSignature":"sig-stream","functionCall":{"id":"stream-call","name":"shell","args":"wd\\"}"}}]}}]}\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  const result = await provider.send({ ...normalized(true), tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }] }, 'gemini-test-high', { sessionId: '-stream-call' });
  assert.deepEqual(result.toolCalls, [{
    id: 'stream-call', name: 'shell', arguments: '{"command":"pwd"}', thoughtSignature: 'sig-stream'
  }]);
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

test('direct provider returns native function calls without a gateway envelope', async () => {
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ thoughtSignature: 'signature-1', functionCall: { id: 'upstream-call', name: 'shell', args: { command: 'pwd' } } }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const result = await provider.send({ ...normalized(), tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }] }, 'gemini-test-high', { sessionId: '-123' });
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, [{
    id: 'upstream-call', name: 'shell', arguments: { command: 'pwd' }, thoughtSignature: 'signature-1'
  }]);
});

test('direct provider carries a tool thought signature into the next turn', async () => {
  const requests = [];
  let turn = 0;
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', baseUrl: 'https://example.test',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (turn++ === 0) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ thoughtSignature: 'signature-1', functionCall: { id: 'upstream-call', name: 'shell', args: { command: 'pwd' } } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const tools = [{ name: 'shell', description: 'run', schema: { type: 'object' } }];
  const first = await provider.send({ ...normalized(), tools, toolChoice: { type: 'required' } }, 'gemini-test-high', { sessionId: '-signature-sequence' });
  const call = first.toolCalls[0];
  await provider.send({ ...normalized(), messages: [
    { role: 'user', text: 'previous task' },
    { role: 'assistant', text: `[ASSISTANT_TOOL_CALL id=${call.id} name=${call.name}]\n${JSON.stringify(call.arguments)}` },
    { role: 'user', text: `[CLIENT_TOOL_RESULT id=${call.id}]\npwd output` },
    { role: 'user', text: 'continue' }
  ], tools }, 'gemini-test-high', { sessionId: '-signature-sequence' });
  assert.equal(requests[1].request.contents[1].parts[0].thoughtSignature, 'signature-1');
  assert.deepEqual(requests[1].request.contents[2].parts[0].functionResponse, {
    id: call.id, name: 'shell', response: { result: 'pwd output' }
  });
  assert.equal(requests[1].request.contents[1].parts[0].id, undefined);
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
    clientCredentials: [{ clientId: 'test-client', clientSecret: 'test-secret' }],
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'refreshed-local-token', expires_in: 3600 }), { status: 200 })
  });
  const result = await auth.get();
  assert.equal(result.accessToken, 'refreshed-local-token');
  assert.equal(result.authMethod, 'consumer');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token.access_token, 'expired-local-token');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('local agy auth reads the official macOS Keychain record before stale files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-keychain-test-'));
  const file = path.join(dir, '.gemini', 'jetski-standalone-oauth-token');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token: {
    access_token: 'stale-file-token',
    refresh_token: 'stale-file-refresh',
    expiry: '2000-01-01T00:00:00Z'
  } }));
  const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify({ token: {
    access_token: 'current-keychain-token',
    refresh_token: 'current-keychain-refresh',
    expiry: '2099-01-01T00:00:00Z'
  }, auth_method: 'consumer' })).toString('base64')}`;
  const auth = new LocalAgyAuthProvider({
    homeDir: dir,
    platform: 'darwin',
    execFileSyncImpl: () => encoded
  });
  const result = await auth.get();
  assert.equal(result.accessToken, 'current-keychain-token');
  assert.equal(result.sourcePath, 'keychain:gemini/antigravity');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Keychain decoder rejects malformed records without exposing the secret', () => {
  assert.equal(decodeKeychainRecord('go-keyring-base64:not-valid-base64'), null);
});

test('OAuth credential discovery does not absorb adjacent Mach-O bytes into the secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-client-test-'));
  const binary = path.join(dir, 'agy');
  const expectedSecret = `GOCSPX-${'a'.repeat(28)}`;
  fs.writeFileSync(binary, `123456789-${'b'.repeat(20)}.apps.googleusercontent.com\0${expectedSecret}${'Z'.repeat(40)}`);
  const credentials = discoverClientCredentials({ homeDir: dir, agyPath: binary });
  assert.equal(credentials[0].clientSecret, expectedSecret);
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
