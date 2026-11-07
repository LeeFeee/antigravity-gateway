'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/gateway-media-inputs/image-fixture.png'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-delivery-test-'));
process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR = directory;
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'direct';
const { AccountPool } = require('../src/account-pool');
const { runTurn } = require('../antigravity-gateway');
const { normalizeChat, normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { buildDirectRequest } = require('../src/direct-provider');
const { AgyImageStore } = require('../src/agy-image-references');
const { newState } = require('../src/agy-session-state');
test('native image continuation gets usable delivery addresses and preserves client tools', async (t) => {
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const nativeToolContext = { trajectoryId: '11111111-2222-3333-4444-555555555555', stepIndex: 2 };
  t.mock.method(AccountPool.prototype, 'send', async (request) => {
    calls++;
    if (calls === 1) return { text: 'Generating.', accountId: 'managed-image-parent', nativeToolContext,
      toolCalls: [{ id: 'call_image', name: 'generate_image', arguments: { Prompt: 'blue circle', ImageName: 'blue_circle' } }], usage: {} };
    assert.equal(request.toolChoice, 'auto');
    assert.deepEqual(request.tools.map(t => t.name), ['save_image']);
    const result = request.messages.at(-1).parts[0];
    const internal = JSON.parse(result.content);
    assert.match(internal.artifact.url, /http:\/\/localhost:9897\/v1\/files\/file_.*\/content/);
    assert.match(internal.artifact.gateway_path, /file_.*\.png$/);
    assert.equal(internal.delivery.handled_by, 'gateway');
    assert.equal(internal.delivery.visible_receipt, 'automatic');
    assert.equal(internal.delivery.repeat_in_assistant_text, false);
    assert.equal(typeof result.response.output, 'string');
    assert.match(result.response.output, /^Created At: [^\n]+\nCompleted At: [^\n]+\nGenerated image is saved at /);
    assert.ok(result.response.output.includes(internal.artifact.url));
    assert.equal(result.media.length, 1);
    assert.equal(result.media[0].type, 'media');
    assert.doesNotMatch(result.content, /Image artifact delivery|Markdown|Deliver it directly|already saved/);
    const wire = buildDirectRequest(request, 'gemini-test', 'project', 'session');
    assert.equal(wire.request.toolConfig, undefined);
    assert.equal(wire.request.contents.at(-1).parts[0].functionResponse.response.output, result.response.output);
    assert.doesNotMatch(JSON.stringify(wire), /"artifact"|"delivery"|"handled_by"|"gateway_path"|"visible_receipt"|"repeat_in_assistant_text"/);
    return { text: 'Done.', toolCalls: [], usage: {} };
  });
  t.mock.method(AccountPool.prototype, 'generateImage', async (_request, options) => {
    assert.deepEqual(options.nativeToolContext, nativeToolContext);
    assert.equal(options.accountId, 'managed-image-parent');
    return { data: png.toString('base64'), mimeType: 'image/png', usage: {} };
  });
  const result = await runTurn(normalizeChat({ model: 'gemini-test', tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'save_image', description: 'Save a delivered image', parameters: { type: 'object', properties: {} } } }], messages: [{ role: 'user', content: 'Draw a blue circle' }] }), 'gemini-test', new AbortController().signal, { sessionId: 'test', publicBaseUrl: 'http://localhost:9897' });
  assert.equal(calls, 2);
  assert.equal(result.images.length, 1);
  assert.equal(result.text, 'Done.');
  assert.equal(result.toolCalls.length, 0);
});

test('native uploaded path resolves to the original bytes for reference-guided generation', async t => {
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const encoded = Buffer.from('reference image').toString('base64'); let call = 0;
  t.mock.method(AccountPool.prototype, 'send', async normalized => {
    if (++call > 1) return { text: 'Edited.', toolCalls: [], usage: {} };
    // Exercise the actual request builder to register the path that the model
    // sees, not a guessed local media ID in the mock tool response.
    const wire = buildDirectRequest(normalized, 'gemini-test', 'p', 's', '', null, {
      state: newState('a', 's'), imageStore: new AgyImageStore({ directory: path.join(directory, 'references') })
    });
    const file = wire.request.contents[0].parts[0].text.match(/The user has uploaded 1 image\(s\):\n- ([^\n]+)/)[1];
    assert.equal(fs.readFileSync(file).toString('base64'), encoded);
    return { text: '', toolCalls: [{ id: 'edit', name: 'generate_image', arguments: { Prompt: 'green', ImageName: 'green', ImagePaths: [file] } }], usage: {} };
  });
  t.mock.method(AccountPool.prototype, 'generateImage', async input => {
    assert.equal(input.images.length, 1); assert.equal(input.images[0].data, encoded);
    return { data: png.toString('base64'), mimeType: 'image/png', usage: {} };
  });
  const result = await runTurn(normalizeChat({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'make it green' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${encoded}` } }
  ] }] }), 'gemini-test', new AbortController().signal, { sessionId: 'image-reference' });
  assert.equal(result.images.length, 1); assert.equal(result.text, 'Edited.'); assert.equal(call, 2);
});

test('built-in image service never intercepts ordinary or same-name client tools in either public protocol', async t => {
  let images = 0;
  t.mock.method(AccountPool.prototype, 'generateImage', async () => { images++; throw new Error('Client tools must not execute in the gateway'); });
  for (const normalize of [normalizeAnthropic, normalizeResponses]) for (const name of ['client_shell', 'generate_image']) {
    const argumentsValue = { command: 'client-owned opaque command' };
    const schema = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
    const request = normalize({ model: 'gemini-test', input: 'Use my client tool.',
      messages: [{ role: 'user', content: 'Use my client tool.' }],
      tools: [{ type: 'function', name, description: 'Client execution only.', input_schema: schema, parameters: schema }] });
    const original = structuredClone(request);
    t.mock.method(AccountPool.prototype, 'send', async prepared => {
      assert.deepEqual(prepared.tools.map(tool => tool.name), name === 'generate_image' ? [name] : [name, 'generate_image']);
      return { text: '', toolCalls: [{ id: 'owned-call', name, arguments: argumentsValue }], usage: {} };
    });
    const result = await runTurn(request, 'gemini-test', new AbortController().signal, { sessionId: `owned-${name}` });
    assert.deepEqual(result.toolCalls, [{ id: 'owned-call', name, arguments: argumentsValue }]);
    assert.equal(result.images, undefined);
    assert.deepEqual(request, original);
  }
  assert.equal(images, 0);
});

test('a stale legacy disable value cannot hide the built-in service or force image generation', async t => {
  const original = process.env.ANTIGRAVITY_ENABLE_IMAGE_TOOL;
  process.env.ANTIGRAVITY_ENABLE_IMAGE_TOOL = '0';
  t.after(() => original === undefined ? delete process.env.ANTIGRAVITY_ENABLE_IMAGE_TOOL : process.env.ANTIGRAVITY_ENABLE_IMAGE_TOOL = original);
  let sends = 0, images = 0;
  t.mock.method(AccountPool.prototype, 'send', async request => {
    sends++;
    assert.deepEqual(request.tools.map(tool => [tool.name, tool.internal]), [['generate_image', true]]);
    return { text: 'A normal text answer.', toolCalls: [], usage: {} };
  });
  t.mock.method(AccountPool.prototype, 'generateImage', async () => { images++; throw new Error('No image was requested by the model'); });
  const result = await runTurn(normalizeAnthropic({ messages: [{ role: 'user', content: 'Explain a normal concept.' }] }),
    'gemini-test', new AbortController().signal, { sessionId: 'legacy-image-switch' });
  assert.equal(result.text, 'A normal text answer.');
  assert.equal(result.images, undefined);
  assert.equal(sends, 1);
  assert.equal(images, 0);
});
