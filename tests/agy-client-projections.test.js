'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { newState, AgySessionStore, recordClientProjection, restoreClientProjections } = require('../src/agy-session-state');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { deliveryText, streamTextRemainder } = require('../src/artifacts');
const model = 'gemini-3.8-flash-high';
const user = text => ({ role: 'user', parts: [{ text }] });
const answer = text => ({ role: 'model', parts: [{ text }] });

test('only a matching model, complete prefix and issued visible content restores private native exchanges', () => {
  const state = newState('account', 'session'), prefix = [user('private user prefix')], visible = answer('client-only receipt');
  const contents = [answer('native call'), answer('native result'), answer('native answer')];
  recordClientProjection(state, prefix, visible, model, contents);
  assert.deepEqual(restoreClientProjections(state, [...prefix, visible], model), [...prefix, ...contents]);
  for (const [input, target] of [
    [[user('rewritten prefix'), visible], model], [[...prefix, answer('edited receipt')], model], [[...prefix, visible], 'other-model']
  ]) assert.deepEqual(restoreClientProjections(state, input, target), input);
  assert.deepEqual(restoreClientProjections(newState('other', 'session'), [...prefix, visible], model), [...prefix, visible]);
  assert.ok(!JSON.stringify(state).includes('private user prefix'));
  assert.ok(!JSON.stringify(state).includes('client-only receipt'));
});

test('projection cache shares the bounded private response budget', () => {
  const state = newState('a', 's');
  for (let i = 0; i < 520; i++) recordClientProjection(state, [user('prefix')], answer(`receipt-${i}`), model, [answer('native')], i);
  assert.equal(Object.keys(state.projections).length, 512);
  recordClientProjection(state, [], answer('oversized'), model, [answer('x'.repeat(17 * 1024 * 1024))], 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 16 * 1024 * 1024);
});

for (const streamed of [false, true]) test(`image-to-client-tool history survives restart without receipt leakage (${streamed ? 'streamed' : 'buffered'})`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-projection-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], image = { id: 'file_generated', mimeType: 'image/png', filename: 'test.png', bytes: 3, gatewayLocalPath: '/private/image.png', url: 'http://local/image' };
  const gen = { id: 'generate', name: 'generate_image', args: { Prompt: 'quadrants' } };
  const read = { id: 'read', name: 'Read', args: { file_path: '/private/image.png' } };
  const replies = [
    [{ text: 'Generating.' }, { functionCall: gen, thoughtSignature: 'gen-signature' }],
    [{ text: 'Inspecting.' }, { functionCall: read, thoughtSignature: 'read-signature' }],
    [{ text: 'DONE', thoughtSignature: 'done-signature' }], [{ text: 'Remembered.' }]
  ];
  const send = async (source, options = {}) => {
    const provider = new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'token', projectId: 'project', maxRetries: 0,
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:a' }) },
      fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ candidates: [{ content: { parts: replies.shift() } }] }), { headers: { 'content-type': 'application/json' } }); }
    });
    return provider.send(source, model, { sessionId: 'same', ...options });
  };
  const source = { messages: [{ role: 'user', text: 'Create image and inspect it.' }] };
  await send(source);
  const continuation = { messages: [...source.messages,
    { role: 'assistant', parts: [{ type: 'text', text: 'Generating.' }, { type: 'tool_call', id: gen.id, name: gen.name, arguments: gen.args }] },
    { role: 'user', parts: [{ type: 'tool_result', id: gen.id, name: gen.name, content: 'local-only-data', response: { output: 'Created file file:///private/image.png with requested content.' }, media: [{ type: 'media', mediaType: 'image/png', data: 'aW1n' }] }] }
  ] };
  const generated = await send(continuation, { clientProjection: { source, images: [image], streamedPrefix: streamed ? 'Generating.' : '' } });
  const finalText = deliveryText({ ...generated, images: [image] }), emitted = streamed ? 'Generating.' : '';
  const clientHistory = [...source.messages,
    { role: 'assistant', parts: [{ type: 'text', text: emitted + streamTextRemainder(emitted, finalText) }, { type: 'tool_call', id: read.id, name: read.name, arguments: read.args }] },
    { role: 'user', parts: [{ type: 'tool_result', id: read.id, name: read.name, content: 'colors' }] }
  ];
  await send({ messages: clientHistory });
  await send({ messages: [...clientHistory, { role: 'assistant', text: 'DONE' }, { role: 'user', text: 'recall' }] });
  assert.deepEqual(requests.map(r => r.requestId.split('/').at(-1)), ['1', '3', '5', '7']);
  for (const r of requests.slice(2)) {
    assert.doesNotMatch(JSON.stringify(r), /Image artifact delivery:|Gateway local path:|local-only-data/);
    assert.deepEqual(r.request.contents.filter(c => c.parts.some(p => p.functionCall)).flatMap(c => c.parts.filter(p => p.functionCall).map(p => p.functionCall.name)), ['generate_image', 'Read']);
    assert.equal(r.request.contents[3].parts.find(p => p.functionCall).thoughtSignature, 'read-signature');
    assert.equal(r.request.contents[2].parts[0].functionResponse.parts[0].inlineData.data, 'aW1n');
  }
  assert.equal(requests[3].request.contents[5].parts.find(p => p.text === 'DONE').thoughtSignature, 'done-signature');
  assert.equal(fs.readdirSync(directory).filter(n => n.endsWith('.json')).length, 1);
});
