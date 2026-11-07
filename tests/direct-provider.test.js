'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-direct-state-'));
process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR = testStateDir;
test.after(() => fs.rmSync(testStateDir, { recursive: true, force: true }));

const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const {
  LocalAgyAuthProvider,
  agyBinaryPaths,
  decodeKeychainRecord,
  defaultPaths,
  discoverClientCredentials,
  readLinuxKeyringRecord,
  readWindowsCredentialRecord,
  scanClientMetadata
} = require('../src/local-agy-auth');

function normalized(stream = false) {
  return {
    system: 'client system',
    messages: [{ role: 'user', text: 'hello' }],
    tools: [],
    toolChoice: null,
    stream,
  };
}

function issuedTool(options, id, args) {
  const declarations = JSON.parse(options.body).request.tools.flatMap(tool => tool.functionDeclarations);
  const tool = declarations.find(item => item.name.endsWith('_json')) || declarations.find(item => item.name !== 'finish');
  return { id, name: tool.name, args: tool.parameters.properties.argumentsJson
    ? { argumentsJson: JSON.stringify(args), toolSummary: 'Controlled execution' }
    : { ...args, toolSummary: 'Controlled execution' } };
}

test('direct request uses native Antigravity envelope without agy prompt', () => {
  const request = buildDirectRequest(normalized(), 'gemini-test-high', 'project-1', '-123');
  assert.equal(request.model, 'gemini-test-high');
  assert.equal(request.project, 'project-1');
  assert.match(request.requestId, /^agent\/[a-f0-9-]{36}\/\d+\/[a-f0-9-]{36}\/1$/);
  assert.equal(request.request.sessionId, '-3750763034362895579');
  assert.doesNotMatch(JSON.stringify(request), /-123/);
  assert.equal(request.request.systemInstruction.parts[0].text, 'client system');
  assert.equal(request.request.contents[0].role, 'user');
  assert.match(request.request.contents[0].parts[0].text, /^<USER_REQUEST>\nhello\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>/);
  assert.doesNotMatch(JSON.stringify(request), /ANTIGRAVITY_GATEWAY_INFERENCE_CONTRACT|CLIENT_SYSTEM_BEGIN/);
});

test('direct request retains unsupported formats through a reversible declaration', () => {
  const source = { ...normalized(), generationConfig: { maxOutputTokens: 42 },
    tools: [{ name: 'shell', description: 'run', schema: {
      type: 'object', title: 'Business tool', additionalProperties: false,
      properties: { command: { type: 'string', format: 'shell', description: 'command' } }, required: ['command']
    } }] };
  const before = structuredClone(source), native = {};
  const request = buildDirectRequest(source, 'claude-sonnet-5', 'project-1', '-123', '', null, native);
  assert.equal(request.request.toolConfig, undefined);
  assert.deepEqual(request.request.generationConfig, { maxOutputTokens: 42 });
  const declaration = request.request.tools[0].functionDeclarations[0];
  assert.match(declaration.name, /^mcp_gateway_tool_/);
  assert.equal(declaration.parameters.properties.argumentsJson.type, 'STRING');
  assert.equal(declaration.parameters.additionalProperties, undefined);
  assert.match(declaration.description, /"format":"shell"/);
  const call = { id: 'call', name: 'shell', arguments: { command: 'pwd' } };
  assert.deepEqual(native.toolAdapter.toClient(native.toolAdapter.toProvider(call)), call);
  assert.deepEqual(source, before);
});

test('direct nullable unions and exact tuples keep their full contract in JSON views', () => {
  for (const schema of [
    { type: 'object', properties: { path: { type: ['string', 'null'] } }, required: ['path'] },
    { type: 'object', properties: { tuple: { type: 'array', prefixItems: [{ type: 'string' }, { enum: [0, false] }], items: false, minItems: 2 } }, required: ['tuple'] }
  ]) {
    const native = {}, input = { ...normalized(), tools: [{ name: 'save', description: 'save', schema }] };
    const request = buildDirectRequest(input, 'gemini-3.8-flash-high', 'project-1', '-123', '', null, native);
    const declaration = request.request.tools[0].functionDeclarations[0];
    assert.deepEqual(Object.keys(declaration.parameters.properties).sort(), ['argumentsJson', 'toolSummary']);
    const args = schema.properties.path ? { path: null } : { tuple: ['field', false] };
    const call = { id: 'call', name: 'save', arguments: args };
    assert.deepEqual(native.toolAdapter.toClient(native.toolAdapter.toProvider(call)), call);
    const invalid = schema.properties.path ? { path: 4 } : { tuple: ['field', false, 'extra'] };
    assert.throws(() => native.toolAdapter.toClient({ name: declaration.name, arguments: { argumentsJson: JSON.stringify(invalid), toolSummary: 'Save value' } }), { code: 'invalid_tool_arguments' });
  }
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
  assert.equal(part.functionCall.id, 'call_old');
  assert.ok(request.request.tools.flatMap(tool => tool.functionDeclarations).some(tool => tool.name === part.functionCall.name));
  assert.deepEqual(JSON.parse(part.functionCall.args.argumentsJson), { command: 'pwd' });
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
    id: 'call_old', name: request.request.contents[1].parts[0].functionCall.name, response: { output: '/tmp' }
  });
  assert.equal(request.request.contents[2].role, 'model');
});

test('direct request rejects an orphaned tool result instead of downgrading it to text', () => {
  assert.throws(() => buildDirectRequest({
    ...normalized(),
    messages: [{ role: 'user', text: '[CLIENT_TOOL_RESULT id=orphan]\nold output' }],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-test-high', 'project-1', '-123'), { code: 'invalid_tool_history', status: 400 });
});

test('direct request preserves the provided thought signature for a prior tool call', () => {
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

test('raw request construction does not fabricate a missing tool signature', () => {
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
  assert.equal(request.request.contents[1].parts[0].thoughtSignature, undefined);
  assert.equal(request.request.contents[2].parts[0].functionResponse.name, request.request.contents[1].parts[0].functionCall.name);
});

test('raw parallel history does not invent a signature for any sibling', () => {
  const request = buildDirectRequest({
    ...normalized(),
    messages: [{ role: 'assistant', text: 'ignored', parts: [
      { type: 'tool_call', id: 'call_a', name: 'shell', arguments: { command: 'pwd' } },
      { type: 'tool_call', id: 'call_b', name: 'shell', arguments: { command: 'ls' } }
    ] }],
    tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }]
  }, 'gemini-3.7-flash-high', 'project-1', '-123');
  assert.equal(request.request.contents[0].parts[0].thoughtSignature, undefined);
  assert.equal(request.request.contents[0].parts[1].thoughtSignature, undefined);
});

test('direct request retains explicit output cap for high-thinking models', () => {
  const request = buildDirectRequest({ ...normalized(), generationConfig: { maxOutputTokens: 16 } }, 'gemini-3.7-flash-high', 'project-1', '-123');
  assert.equal(request.request.generationConfig.maxOutputTokens, 16);
});

test('direct request retains the explicit output cap for low-tier Gemini 3 models', () => {
  const request = buildDirectRequest({ ...normalized(), generationConfig: { maxOutputTokens: 64 } }, 'gemini-3.7-flash-low', 'project-1', '-123');
  assert.equal(request.request.generationConfig.maxOutputTokens, 64);
});

test('client Auto Mode retains its explicit output cap including hidden thinking', () => {
  const request = buildDirectRequest({
    ...normalized(),
    autoMode: true,
    autoModeFormat: 'severity',
    generationConfig: { maxOutputTokens: 64 }
  }, 'gemini-3.7-flash-low', 'project-1', '-123');
  assert.equal(request.request.generationConfig.maxOutputTokens, 64);
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
  assert.equal(calls[0].url, 'https://example.test/v1internal:streamGenerateContent?alt=sse');
  assert.equal(calls[0].options.headers.authorization, 'Bearer token');
});

test('direct provider falls back from a daily Cloud Code 429 to the normal endpoint', async () => {
  const calls = [];
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', maxRetries: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith('https://daily-cloudcode-pa.googleapis.com')) {
        return new Response(JSON.stringify({ error: { message: 'Resource has been exhausted' } }), { status: 429 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fallback-ok' }] } }] }), { status: 200 });
    }
  });
  const result = await provider.send(normalized(), 'gemini-test-high', { sessionId: '-429-fallback' });
  assert.equal(result.text, 'fallback-ok');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^https:\/\/daily-cloudcode-pa\.googleapis\.com/);
  assert.match(calls[1], /^https:\/\/cloudcode-pa\.googleapis\.com/);
});

test('direct provider retries transient 429 responses with a bounded backoff', async () => {
  let calls = 0;
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', maxRetries: 1, retryBaseMs: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 2) return new Response(JSON.stringify({ error: { message: 'Resource has been exhausted' } }), { status: 429 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'retry-ok' }] } }] }), { status: 200 });
    }
  });
  const result = await provider.send(normalized(), 'gemini-test-high', { sessionId: '-429-retry' });
  assert.equal(result.text, 'retry-ok');
  assert.equal(calls, 3);
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
    fetchImpl: async (_url, options) => {
      const call = issuedTool(options, 'stream-call', { command: 'pwd' });
      const encoded = JSON.stringify(call.args), midpoint = Math.floor(encoded.length / 2);
      return new Response([
        { candidates: [{ content: { parts: [{ functionCall: { ...call, args: encoded.slice(0, midpoint) } }] } }] },
        { candidates: [{ content: { parts: [{ thoughtSignature: 'sig-stream', functionCall: { ...call, args: encoded.slice(midpoint) } }] } }] }
      ].map(value => `data: ${JSON.stringify(value)}\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  });
  const result = await provider.send({ ...normalized(true), tools: [{ name: 'shell', description: 'run', schema: { type: 'object' } }] }, 'gemini-test-high', { sessionId: '-stream-call' });
  assert.deepEqual(result.toolCalls, [{
    id: 'stream-call', name: 'shell', arguments: { command: 'pwd' }, thoughtSignature: 'sig-stream'
  }]);
});

test('explicitly disabled catalog entries are excluded from account and service routing until enabled', async () => {
  let disabled = true;
  const provider = new DirectAntigravityProvider({
    accessToken: 'synthetic-token', projectId: 'synthetic-project', baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify({
      models: {
        'gemini-4-argon-disabled': { disabled, maxTokens: 1048576, maxOutputTokens: 65536 },
        'enabled-model-with-disabled-in-name': { disabled: false },
        'image-model': { disabled: true },
        'search-helper': { disabled: true },
        'ordinary-model': {}
      }, imageGenerationModelIds: ['image-model'], webSearchModelIds: ['search-helper']
    }), { status: 200 })
  });
  assert.deepEqual(await provider.listModels(), ['enabled-model-with-disabled-in-name', 'ordinary-model']);
  assert.deepEqual(provider.imageModelCatalog(), []);
  assert.deepEqual(provider.webSearchModelCatalog(), []);
  assert(!provider.modelCatalog().includes('gemini-4-argon-disabled'));
  disabled = false;
  assert((await provider.listModels(undefined, { force: true })).includes('gemini-4-argon-disabled'));
});

test('direct provider preserves model capabilities and separate image generation catalog', async () => {
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token',
    projectId: 'project-1',
    baseUrl: 'https://example.test',
    models: [],
    fetchImpl: async (url, options) => {
      assert.match(url, /fetchAvailableModels$/);
      assert.deepEqual(JSON.parse(options.body), { project: 'project-1' });
      return new Response(JSON.stringify({ models: {
        'gemini-3.7-flash-high': { displayName: 'Flash', maxTokens: 1048576, maxOutputTokens: 65536, supportsImages: true, supportsThinking: true,
          supportsVideo: true, supportsAudio: true, supportedMimeTypes: { 'video/mp4': true, 'image/png': true } },
        'models/claude-sonnet-5': { displayName: 'Claude' },
        'not a model': { displayName: 'ignored' }
      }, imageGenerationModelIds: ['gemini-3.1-flash-image'] }), { status: 200 });
    }
  });
  assert.deepEqual(await provider.listModels(), ['gemini-3.7-flash-high', 'claude-sonnet-5']);
  assert.deepEqual(provider.modelCatalog(), ['gemini-3.7-flash-high', 'claude-sonnet-5', 'gemini-3.1-flash-image']);
  assert.deepEqual(provider.modelInfo('gemini-3.7-flash-high'), {
    displayName: 'Flash',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    supportsImages: true,
    supportsThinking: true,
    supportsVideo: true,
    supportsAudio: true,
    supportedMimeTypes: { 'video/mp4': true, 'image/png': true }
  });
  assert.deepEqual(provider.imageModelCatalog(), ['gemini-3.1-flash-image']);
  provider.modelInfo('gemini-3.7-flash-high').supportedMimeTypes['video/mp4'] = false;
  assert.equal(provider.modelInfo('gemini-3.7-flash-high').supportedMimeTypes['video/mp4'], true);
  assert.equal(provider.modelInfo('missing'), null);
});

test('lightweight authentication probe preserves upstream rejection instead of using the fallback catalog', async () => {
  const rejected = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token',
    projectId: 'project-1',
    baseUrl: 'https://example.test',
    models: [],
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Verify your account to continue' } }), { status: 403 })
  });
  await assert.rejects(rejected.probeAuthentication(), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /Verify your account/);
    return true;
  });

  const accepted = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token',
    projectId: 'project-1',
    baseUrl: 'https://example.test',
    models: [],
    fetchImpl: async () => new Response('{"models":{}}', { status: 200 })
  });
  assert.deepEqual(await accepted.probeAuthentication(), { ok: true, status: 200 });
});

test('authentication probe accepts either official Cloud Code endpoint without generating content', async () => {
  const calls = [];
  const diagnostics = [];
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token',
    projectId: 'project-1',
    models: [],
    diagnosticReporter: (event, fields) => diagnostics.push({ event, fields }),
    fetchImpl: async (url) => {
      calls.push(url);
      return url.startsWith('https://daily-cloudcode-pa.googleapis.com')
        ? new Response('{"error":{"message":"temporary daily denial"}}', { status: 403 })
        : new Response('{"models":{}}', { status: 200 });
    }
  });
  assert.deepEqual(await provider.probeAuthentication(), { ok: true, status: 200 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.endsWith('/v1internal:fetchAvailableModels')));
  assert.deepEqual(diagnostics.filter(({ event }) => event === 'auth_probe_response_received').map(({ fields }) => fields.status), [403, 200]);
  assert.ok(diagnostics.some(({ event, fields }) => event === 'auth_probe_succeeded' && fields.upstreamIndex === 2));
  assert.ok(diagnostics.every(({ fields }) => !JSON.stringify(fields).includes('token')));
});

test('forced catalog refresh is deduplicated and preserves stale catalog on failure', async () => {
  let count = 0;
  let fail = false;
  const provider = new DirectAntigravityProvider({ localAuth: null, accessToken: 'test', projectId: 'test', baseUrl: 'https://example.test', models: [],
    fetchImpl: async () => {
      count++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ models: { [`gemini-test-${count}`]: {} } }), { status: fail ? 503 : 200 });
    }
  });
  assert.deepEqual(await provider.listModels(), ['gemini-test-1']);
  assert.deepEqual(await provider.listModels(), ['gemini-test-1']);
  const results = await Promise.all([provider.listModels(undefined, { force: true }), provider.listModels(undefined, { force: true })]);
  assert.deepEqual(results, [['gemini-test-2'], ['gemini-test-2']]);
  assert.equal(count, 2);
  fail = true;
  assert.deepEqual(await provider.listModels(undefined, { force: true }), ['gemini-test-2']);
});

test('concurrent local refreshes share one exchange and caller cancellation stays local', async () => {
  let count = 0;
  const provider = new LocalAgyAuthProvider({ useKeychain: false });
  provider.last = { accessToken: 'expired', refreshToken: 'refresh', expiry: new Date(0) };
  provider.find = () => null;
  provider.refresh = async () => {
    count++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { accessToken: 'fresh' };
  };
  const controller = new AbortController();
  const first = provider.get(controller.signal);
  const second = provider.get();
  controller.abort(new Error('cancelled'));
  await assert.rejects(first, /cancelled/);
  assert.equal((await second).accessToken, 'fresh');
  assert.equal(count, 1);
});

test('failed initial discovery cannot invent a model catalog', async () => {
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token',
    projectId: 'project-1',
    baseUrl: 'https://example.test',
    models: [],
    fetchImpl: async () => new Response('temporarily unavailable', { status: 503 })
  });
  await assert.rejects(provider.listModels(), { code: 'direct_model_discovery_failed', status: 503 });
  assert.equal(provider.modelCatalog(), null);
});

test('direct provider returns native function calls without a gateway envelope', async () => {
  const provider = new DirectAntigravityProvider({
    localAuth: null,
    accessToken: 'token', projectId: 'project-1', baseUrl: 'https://example.test',
    fetchImpl: async (_url, options) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ thoughtSignature: 'signature-1', functionCall: issuedTool(options, 'upstream-call', { command: 'pwd' }) }] } }]
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
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ thoughtSignature: 'signature-1', functionCall: issuedTool(options, 'upstream-call', { command: 'pwd' }) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const tools = [{ name: 'shell', description: 'run', schema: { type: 'object' } }];
  const first = await provider.send({ ...normalized(), tools, toolChoice: { type: 'required' } }, 'gemini-test-high', { sessionId: '-signature-sequence' });
  const call = first.toolCalls[0];
  await provider.send({ ...normalized(), messages: [
    ...normalized().messages,
    { role: 'assistant', text: `[ASSISTANT_TOOL_CALL id=${call.id} name=${call.name}]\n${JSON.stringify(call.arguments)}` },
    { role: 'user', text: `[CLIENT_TOOL_RESULT id=${call.id}]\npwd output` },
    { role: 'user', text: 'continue' }
  ], tools }, 'gemini-test-high', { sessionId: '-signature-sequence' });
  assert.equal(requests[1].request.contents[1].parts[0].thoughtSignature, 'signature-1');
  assert.deepEqual(requests[1].request.contents[2].parts[0].functionResponse, {
    id: call.id, name: requests[0].request.tools.find(tool => tool.functionDeclarations[0].name.endsWith('_json')).functionDeclarations[0].name, response: { output: 'pwd output' }
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

test('Windows local agy auth reads the official antigravity-cli session without changing macOS paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-windows-auth-test-'));
  const windowsFile = path.join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  fs.mkdirSync(path.dirname(windowsFile), { recursive: true });
  fs.writeFileSync(windowsFile, JSON.stringify({ token: {
    access_token: 'windows-local-token',
    refresh_token: 'windows-local-refresh',
    expiry: '2099-01-01T00:00:00Z'
  }, auth_method: 'consumer' }));
  const auth = new LocalAgyAuthProvider({ homeDir: dir, platform: 'win32', useKeychain: false });
  const result = await auth.get();
  assert.equal(result.accessToken, 'windows-local-token');
  assert.equal(result.sourcePath, windowsFile);
  assert.equal(defaultPaths(dir, 'win32')[0], windowsFile);
  assert.equal(defaultPaths(dir, 'darwin').includes(windowsFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Linux local agy auth reads the official antigravity-cli session without changing macOS paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-linux-auth-test-'));
  const linuxFile = path.join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  fs.mkdirSync(path.dirname(linuxFile), { recursive: true });
  fs.writeFileSync(linuxFile, JSON.stringify({ token: {
    access_token: 'linux-local-token',
    refresh_token: 'linux-local-refresh',
    expiry: '2099-01-01T00:00:00Z'
  }, auth_method: 'consumer' }));
  const auth = new LocalAgyAuthProvider({ homeDir: dir, platform: 'linux', useKeychain: false });
  const result = await auth.get();
  assert.equal(result.accessToken, 'linux-local-token');
  assert.equal(result.sourcePath, linuxFile);
  assert.equal(defaultPaths(dir, 'linux')[0], linuxFile);
  assert.equal(defaultPaths(dir, 'darwin').includes(linuxFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Linux local agy auth reads Secret Service before files', async () => {
  const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify({ token: {
    access_token: 'linux-keyring-token',
    refresh_token: 'linux-keyring-refresh',
    expiry: '2099-01-01T00:00:00Z'
  }, auth_method: 'consumer' })).toString('base64')}`;
  let command = '';
  const result = readLinuxKeyringRecord({
    platform: 'linux',
    execFileSyncImpl: (file, args) => {
      command = `${file} ${args.join(' ')}`;
      return encoded;
    }
  });
  assert.equal(result.accessToken, 'linux-keyring-token');
  assert.equal(result.sourcePath, 'secret-service:gemini/antigravity');
  assert.match(command, /^secret-tool lookup service gemini username antigravity$/);
});

test('Windows agy binary discovery uses LOCALAPPDATA while macOS candidates remain unchanged', () => {
  const dir = path.join(os.tmpdir(), 'antigravity-platform-paths');
  const localAppData = path.join(dir, 'Local');
  assert.equal(
    agyBinaryPaths(dir, 'win32', { LOCALAPPDATA: localAppData })[0],
    path.resolve(localAppData, 'agy', 'bin', 'agy.exe')
  );
  const macPaths = agyBinaryPaths(dir, 'darwin', {});
  assert.equal(macPaths.includes(path.resolve(dir, '.local', 'bin', 'agy')), true);
  assert.equal(macPaths.some((item) => item.endsWith('agy.exe')), false);
});

test('Windows local agy auth reads the Windows Credential Manager record before files', async () => {
  const encoded = Buffer.from(JSON.stringify({ token: {
    access_token: 'windows-keyring-token',
    refresh_token: 'windows-keyring-refresh',
    expiry: '2099-01-01T00:00:00Z'
  }, auth_method: 'consumer' })).toString('base64');
  let command = '';
  const result = readWindowsCredentialRecord({
    platform: 'win32',
    target: 'LegacyGeneric:target=gemini:antigravity',
    execFileSyncImpl: (file, args) => {
      command = `${file} ${args.join(' ')}`;
      return encoded;
    }
  });
  assert.equal(result.accessToken, 'windows-keyring-token');
  assert.equal(result.sourcePath, 'windows-credential:LegacyGeneric:target=gemini:antigravity');
  assert.match(command, /CredReadW/);
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

test('OAuth metadata scanner handles large native executables incrementally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-stream-scan-test-'));
  const binary = path.join(dir, 'agy.exe');
  const clientId = `123456789-${'c'.repeat(20)}.apps.googleusercontent.com`;
  const clientSecret = `GOCSPX-${'d'.repeat(28)}`;
  fs.writeFileSync(binary, Buffer.concat([
    Buffer.alloc((4 * 1024 * 1024) - 20, 0),
    Buffer.from(`${clientId}\0${clientSecret}`),
    Buffer.alloc(128, 0)
  ]));
  assert.deepEqual(scanClientMetadata(binary), {
    clientIds: [clientId],
    clientSecrets: [clientSecret]
  });
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


test('catalog auth rejection is visible even with a previous successful catalog', async () => {
  let status = 200;
  const provider = new DirectAntigravityProvider({ accessToken: 'fixture', projectId: 'p', baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify(status === 200 ? { models: { 'gemini-3.8-flash-high': {} } }
      : { error: { message: 'Verify your account to continue' } }), { status }) });
  await provider.listModels();
  const observedAt = provider.modelsDiscoveredAt;
  status = 403;
  await assert.rejects(provider.listModels(undefined, { force: true }), error => error.status === 403 && /Verify your account/.test(error.details));
  assert.equal(provider.modelsDiscoveredAt, observedAt);
});

test('authoritative empty catalog clears previous models without a guessed default', async () => {
  let models = { 'gemini-3.8-flash-high': {} };
  const provider = new DirectAntigravityProvider({ accessToken: 'fixture', projectId: 'p', baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify({ models })) });
  await provider.listModels();
  models = {};
  assert.deepEqual(await provider.listModels(undefined, { force: true }), []);
  assert.deepEqual(provider.modelCatalog(), []);
  assert.equal(provider.modelInfo('gemini-3.8-flash-high'), null);
});
