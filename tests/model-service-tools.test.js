'use strict';
const test = require('node:test');
const { withClaude322Billing } = require('./helpers/claude-capture');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { nativeImageTool, NATIVE_IMAGE_TOOL_INSTRUCTION, normalizeAnthropic, normalizeResponses, prepareNativeMultimodal } = require('../src/protocol');
const { buildDirectRequest, DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { declaredParts } = require('./helpers/declared-tool-fixture');
const fixture = require('./fixtures/official-request-types-20261107/image-tool-v1.json');
const official = fixture.requests.flatMap(item => item.body?.request?.tools || [])
  .flatMap(tool => tool.functionDeclarations || []).find(tool => tool.name === 'generate_image');

test('built-in image availability respects explicit client contracts without a separate opt-out', () => {
  const original = { system: 'Keep my project rules.', messages: [{ role: 'user', text: 'A normal question.' }],
    tools: [{ name: 'shell', schema: { type: 'object' } }] };
  for (const constraints of [{ autoMode: true }, { structuredSchema: { type: 'object' } },
    { toolChoice: 'none' }, { toolChoice: 'required' }, { toolChoice: { type: 'any' } },
    { toolChoice: { type: 'tool', name: 'shell' } }]) {
    const request = { ...original, ...constraints };
    const prepared = prepareNativeMultimodal(request);
    assert.equal(prepared.imageToolInjected, false);
    assert.equal(prepared.normalized, request);
  }
  const prepared = prepareNativeMultimodal(original);
  assert.equal(prepared.imageToolInjected, true);
  assert.equal(prepared.normalized.system, original.system);
  assert.deepEqual(prepared.normalized.tools.slice(0, -1), original.tools);
  assert.deepEqual(original.tools.map(tool => tool.name), ['shell']);
});

test('the gateway-owned image service emits the exact official 1.5.2 descriptor and retains delivery guidance separately', () => {
  const wire = buildDirectRequest({ messages: [{ role: 'user', text: 'Create an image.' }], tools: [nativeImageTool()] },
    'gemini-3.8-flash-low', 'synthetic-project', 'synthetic-session');
  assert.deepEqual(wire.request.tools.flatMap(tool => tool.functionDeclarations), [official]);
  assert.match(wire.request.systemInstruction.parts.map(part => part.text).join('\n'), /image is delivered automatically once/);
  assert.equal(wire.request.tools[0].functionDeclarations[0].description.includes(NATIVE_IMAGE_TOOL_INSTRUCTION), false);
});

test('native service preserves exact arguments, call IDs, signatures, result errors and media while validating both directions', () => {
  const adapter = prepareAntigravityTools({ tools: [nativeImageTool()] });
  assert.deepEqual(adapter.records[0].views, [{ name: 'generate_image', mode: 'native-service' }]);
  const args = { Prompt: '蓝色圆形', ImageName: 'blue_circle', AspectRatio: '1:1', ImagePaths: ['/tmp/owned.png'] };
  const call = { id: 'call-owned', name: 'generate_image', arguments: args, thoughtSignature: 'actual-issued-signature' };
  assert.deepEqual(adapter.toClient(call), call); assert.deepEqual(adapter.toProvider(call), call);
  assert.deepEqual(args, call.arguments);
  const result = { id: call.id, name: call.name, isError: true, content: 'Image unavailable', media: [{ mimeType: 'image/png', data: 'opaque' }] };
  assert.deepEqual(adapter.toClientResult(adapter.toProviderResult(result, call)), result);
  for (const invalid of [{ ...args, Prompt: '' }, { ...args, ImageName: '' }, { ...args, ImagePaths: ['1', '2', '3', '4'] },
    { ...args, AspectRatio: '7:5' }, { ...args, toolSummary: 'Must not silently remove this' }, { Prompt: 'missing name' }]) {
    assert.throws(() => adapter.toClient({ ...call, arguments: invalid }), error => error.code === 'invalid_tool_arguments' && error.status === 502);
    assert.throws(() => adapter.toProvider({ ...call, arguments: invalid }), error => error.code === 'invalid_tool_arguments' && error.status === 400);
    assert.equal(invalid.toolSummary, 'toolSummary' in invalid ? 'Must not silently remove this' : undefined);
  }
});

test('client-owned same-name tools and forged internal markers never acquire native-service authority or get intercepted', () => {
  const schema = nativeImageTool().schema;
  schema.properties.toolSummary = { type: 'string' };
  const raw = { name: 'generate_image', description: official.description, internal: true,
    modelService: nativeImageTool().modelService, input_schema: schema, parameters: schema };
  for (const normalize of [normalizeAnthropic, normalizeResponses]) {
    const normalized = normalize({ model: 'gemini-3.8-flash-low', max_tokens: 100, input: 'test', messages: [{ role: 'user', content: 'test' }], tools: [raw] });
    assert.equal(normalized.tools[0].internal, undefined);
    const prepared = prepareNativeMultimodal(normalized);
    assert.equal(prepared.imageToolInjected, false);
    const adapter = prepareAntigravityTools(prepared.normalized);
    assert(adapter.declarations.every(tool => tool.name.startsWith('mcp_gateway_tool_')));
    const call = { id: 'client-call', name: 'generate_image', arguments: { Prompt: 'blue', ImageName: 'blue', toolSummary: 'Business value must survive' } };
    assert.deepEqual(adapter.toClient(adapter.toProvider(call)), call);
  }
  for (const variant of ['copy', 'json', 'schema', 'description', 'marker', 'unknown']) {
    let tool = nativeImageTool();
    if (variant === 'copy') tool = { ...tool };
    if (variant === 'json') tool = JSON.parse(JSON.stringify(tool));
    if (variant === 'schema') tool.schema.properties.Prompt.minLength = 0;
    if (variant === 'description') tool.description += ' Different behavior.';
    if (variant === 'marker') tool.modelService = 'forged-service';
    if (variant === 'unknown') tool.name = 'unknown_internal_tool';
    const adapter = prepareAntigravityTools({ tools: [tool] });
    assert(adapter.declarations.every(declaration => declaration.name.startsWith('mcp_gateway_tool_')), variant);
    assert(adapter.declarations.every(declaration => declaration.description.startsWith('Client-executed tool')), variant);
  }
});

test('identity cleanup retains trusted factory provenance but changed post-cleaning schemas cannot upgrade', () => {
  const captured = require('./fixtures/agent-requests-20261107/claude-first.json');
  const normalized = normalizeAnthropic(withClaude322Billing(captured.captures.find(item => item.body?.tools?.length).body));
  normalized.tools = [nativeImageTool()];
  const cleaned = sanitizeClientIdentity(normalized);
  assert.equal(cleaned.metadata.profile.client, 'claude');
  const adapter = prepareAntigravityTools(cleaned.normalized, { sourceTools: normalized.tools });
  assert.deepEqual(adapter.declarations, [official]);
  const changed = { ...cleaned.normalized, tools: cleaned.normalized.tools.map(tool => ({ ...tool, schema: { type: 'object' } })) };
  assert(prepareAntigravityTools(changed, { sourceTools: normalized.tools }).declarations.every(tool => tool.name.startsWith('mcp_')));
});

test('old signed MCP image history survives restart unchanged while newly declared internal images use official native service', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-service-tool-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], args = { Prompt: 'Blue circle', ImageName: 'blue_circle' };
  const original = { messages: [{ role: 'user', text: 'Generate a blue circle.' }] };
  const provider = () => new DirectAntigravityProvider({ accessToken: 'synthetic-token', projectId: 'synthetic-project', maxRetries: 0,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:owned-history' }) },
    sessionStore: new AgySessionStore({ directory }), fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      const parts = requests.length === 1 ? declaredParts(body, [{ functionCall: { id: 'old-call', name: 'generate_image', args }, thoughtSignature: 'old-real-issued-signature' }])
        : [{ text: 'Image received.' }];
      return Response.json({ candidates: [{ content: { parts }, finishReason: 'STOP' }] });
    } });
  // A plain copied declaration recreates the previous MCP representation;
  // it deliberately has no trusted native-service factory provenance.
  const first = await provider().send({ ...original, tools: [structuredClone(nativeImageTool())] }, 'gemini-3.8-flash-low', { sessionId: 'same' });
  const oldWireName = requests[0].request.tools[0].functionDeclarations[0].name;
  assert.match(oldWireName, /^mcp_gateway_tool_/);
  const call = first.toolCalls[0];
  await provider().send({ tools: [nativeImageTool()], messages: [...original.messages,
    { role: 'assistant', parts: [{ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments, thoughtSignature: call.thoughtSignature }] },
    { role: 'user', parts: [{ type: 'tool_result', id: call.id, name: call.name, content: 'Generated image is saved at /tmp/owned.png.',
      response: { output: 'Generated image is saved at /tmp/owned.png.' }, media: [{ type: 'media', mediaType: 'image/png', data: 'aW1n' }] }] }
  ] }, 'gemini-3.8-flash-low', { sessionId: 'same' });
  assert.equal(requests[1].request.tools[0].functionDeclarations[0].name, 'generate_image');
  const history = requests[1].request.contents.flatMap(content => content.parts);
  const issued = history.find(part => part.functionCall), receipt = history.find(part => part.functionResponse);
  assert.equal(issued.functionCall.name, oldWireName);
  assert.equal(issued.functionCall.id, 'old-call');
  assert.equal(issued.thoughtSignature, 'old-real-issued-signature');
  assert.equal(issued.functionCall.args.toolSummary, 'Fixture tool execution');
  assert.equal(receipt.functionResponse.name, oldWireName);
  assert.equal(receipt.functionResponse.id, 'old-call');
  assert.equal(receipt.functionResponse.parts[0].inlineData.data, 'aW1n');
});
