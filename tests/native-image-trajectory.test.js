'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { declaredParts } = require('./helpers/declared-tool-fixture');
const { nativeImageTool } = require('../src/protocol');

test('native agent, image subrequest and receipt continuation retain the captured 1/2/3 trajectory', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-image-trajectory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], imageData = Buffer.from('synthetic-image').toString('base64');
  let agentCalls = 0;
  const provider = new DirectAntigravityProvider({
    accessToken: 'synthetic-token', projectId: 'synthetic-project', maxRetries: 0,
    sessionStore: new AgySessionStore({ directory }),
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:synthetic-image' }) },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (url.includes(':generateContent')) return Response.json({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'image/png', data: imageData } }
      ] } }] });
      const parts = ++agentCalls === 1 ? declaredParts(body, [{ functionCall: {
        id: 'image-call', name: 'generate_image', args: { Prompt: 'Blue circle', ImageName: 'circle' }
      }, thoughtSignature: 'synthetic-issued-signature' }]) : [{ text: 'Done.' }];
      return Response.json({ candidates: [{ content: { parts }, finishReason: 'STOP' }] });
    }
  });
  const normalized = { messages: [{ role: 'user', text: 'Draw a blue circle' }], tools: [nativeImageTool()] };
  const first = await provider.send(normalized, 'gemini-3.8-flash-high', { sessionId: 'image-task' });
  const trajectory = requests[0].request.labels.trajectory_id;
  assert.equal(requests[0].request.tools[0].functionDeclarations[0].name, 'generate_image');
  assert.equal(requests[0].request.tools[0].functionDeclarations[0].parameters.properties.toolSummary, undefined);
  assert.deepEqual(first.nativeToolContext, { trajectoryId: trajectory, stepIndex: 2 });
  const generated = await provider.generateImage({ prompt: 'Blue circle' }, { nativeToolContext: first.nativeToolContext });
  const call = first.toolCalls[0];
  const last = await provider.send({ ...normalized, messages: [...normalized.messages,
    { role: 'assistant', parts: [{ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments, thoughtSignature: call.thoughtSignature }] },
    { role: 'user', parts: [{ type: 'tool_result', id: call.id, name: call.name, content: 'Generated image.',
      media: [{ type: 'media', mediaType: generated.mimeType, data: generated.data }] }] }
  ] }, 'gemini-3.8-flash-high', { sessionId: 'image-task' });
  assert.equal(last.text, 'Done.');
  assert.deepEqual(requests.map(value => value.requestId.split('/').at(-1)), ['1', '2', '3']);
  assert.ok(requests.every(value => value.requestId.split('/').at(-2) === trajectory));
  assert.equal(requests[2].request.labels.trajectory_id, trajectory);
  assert.equal(requests[2].request.contents.at(-1).parts[0].functionResponse.parts[0].inlineData.data, imageData);
  await provider.generateImage({ prompt: 'Independent image' });
  assert.notEqual(requests[3].requestId.split('/').at(-2), trajectory);
  assert.equal(requests[3].requestId.split('/').at(-1), '1');
  const before = requests.length;
  await assert.rejects(provider.generateImage({ prompt: 'Invalid context' }, {
    nativeToolContext: { trajectoryId: 'client-session-is-not-a-native-trajectory', stepIndex: 2 }
  }), { code: 'invalid_native_image_context' });
  assert.equal(requests.length, before);
});
