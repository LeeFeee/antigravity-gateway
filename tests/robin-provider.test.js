'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccountStore } = require('../src/account-store');
const { ProviderRouter } = require('../src/provider-router');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { RobinOAuthFlow, SCOPES } = require('../src/robin-oauth-flow');
const { RobinAccountAuthProvider } = require('../src/robin-auth');
const {
  ROBIN_PHENOTYPE_PACKAGE,
  fetchRobinServerToken,
  phenotypeRequest,
  phenotypeServerToken,
  phenotypeVersion
} = require('../src/robin-phenotype');
const {
  GrpcFrameDecoder,
  bytesField,
  decodeFields,
  decodeProtoStruct,
  grpcFrame,
  intField,
  messageField,
  protoStruct,
  stringField
} = require('../src/robin-proto');
const {
  ARGON_MODEL,
  EXECUTE_REMOTE_TOOLS_PATH,
  PROCESS_QUERY_PATH,
  RobinProvider,
  clientGenerateRequest,
  clientFunctionResult,
  continuationIdentifiers,
  discoveredArgonModels,
  ARGON_MODE_VARIANT_ID,
  processQueryInitial,
  processQueryPrefetch,
  projectedClientCall,
  remoteToolEvent,
  responseText,
  robinTaskText,
  robinUserStatus
} = require('../src/robin-provider');

function tempStores(t) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-robin-test-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  return {
    cloudcode: new AccountStore({ configDir }),
    robin: new AccountStore({ configDir, directoryName: 'robin-accounts' })
  };
}

test('account stores keep Cloud Code and Robin credentials physically isolated', (t) => {
  const stores = tempStores(t);
  const cloud = stores.cloudcode.save({ subjectId: 'shared-google-subject', email: 'same@example.com', accessToken: 'cloud', providerType: 'cloudcode' });
  const robin = stores.robin.save({
    subjectId: 'shared-google-subject', email: 'same@example.com', accessToken: 'robin', refreshToken: 'refresh',
    providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL]
  });
  assert.deepEqual(stores.cloudcode.list().map((account) => account.email), ['same@example.com']);
  assert.deepEqual(stores.robin.list().map((account) => account.email), ['same@example.com']);
  assert.notEqual(cloud.id, robin.id, 'the same Google identity must remain distinct across providers');
  assert.notEqual(stores.cloudcode.directory, stores.robin.directory);
});

test('protobuf codec round-trips fields and fragmented gRPC frames', () => {
  const message = Buffer.concat([intField(1, 37), stringField(2, 'Argon'), bytesField(1000, Buffer.from([1, 2, 3]))]);
  const fields = decodeFields(message);
  assert.equal(fields[0].value, 37n);
  assert.equal(fields[1].value.toString(), 'Argon');
  assert.deepEqual([...fields[2].value], [1, 2, 3]);
  const framed = grpcFrame(message);
  const decoder = new GrpcFrameDecoder();
  assert.deepEqual(decoder.push(framed.subarray(0, 3)), []);
  const decoded = decoder.push(framed.subarray(3));
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0].data, message);
  const structured = { title: '安排', count: 3, ready: true, items: ['核对', null], nested: { owner: '同事' } };
  assert.deepEqual(decodeProtoStruct(protoStruct(structured)), structured);
});

test('Robin remote tool wire messages preserve function IDs, names and JSON arguments', () => {
  const args = { path: '/workspace/notes.md', options: { line: 12 }, tags: ['draft'] };
  const functionCall = Buffer.concat([
    stringField(1, 'read_file'),
    stringField(2, 'call_remote_1'),
    messageField(3, protoStruct(args))
  ]);
  const event = remoteToolEvent(messageField(2, messageField(1, functionCall)));
  assert.deepEqual(event, {
    type: 'tool_call',
    calls: [{ id: 'call_remote_1', name: 'read_file', arguments: args }]
  });

  const encoded = decodeFields(clientFunctionResult([{
    id: 'call_remote_1', name: 'read_file', response: { result: 'done' }
  }]));
  assert.equal(encoded[0].number, 2);
  const result = decodeFields(encoded[0].value);
  const response = decodeFields(result[0].value);
  assert.equal(response.find((field) => field.number === 1).value.toString(), 'read_file');
  assert.equal(response.find((field) => field.number === 2).value.toString(), 'call_remote_1');
  assert.deepEqual(decodeProtoStruct(response.find((field) => field.number === 3).value), { result: 'done' });

  const listEvent = remoteToolEvent(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'list_mcp'),
    messageField(2, protoStruct({}))
  ]))));
  assert.deepEqual(listEvent, {
    type: 'tool_call',
    calls: [{ id: '', name: 'list_mcp', arguments: {} }]
  });

  const mcpEvent = remoteToolEvent(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'execute_mcp'),
    messageField(2, protoStruct({
      ServerName: 'external_client',
      ToolName: 'save_note',
      Arguments: { location: '/workspace/note.txt', body: 'done' }
    }))
  ]))));
  assert.equal(mcpEvent.calls[0].id, '');
  assert.equal(mcpEvent.calls[0].name, 'execute_mcp');
  assert.deepEqual(mcpEvent.calls[0].arguments.Arguments, {
    location: '/workspace/note.txt', body: 'done'
  });
});

test('Robin projects execute_mcp wrappers back to the exact client tool', () => {
  const tools = [{
    name: 'record_note_3311',
    description: 'Write a note.',
    schema: { type: 'object', properties: { location: { type: 'string' }, body: { type: 'string' } } }
  }];
  const projected = projectedClientCall({
    id: '',
    name: 'execute_mcp',
    arguments: {
      ServerName: 'external_client',
      ToolName: 'record_note_3311',
      Arguments: { location: '/tmp/note.txt', body: 'custom-tool-ok' }
    }
  }, tools);
  assert.equal(projected.name, 'record_note_3311');
  assert.match(projected.id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(projected.arguments, { location: '/tmp/note.txt', body: 'custom-tool-ok' });
});

test('MCP projection rejects foreign servers and disambiguates a client tool named execute_mcp', () => {
  const tools = [{ name: 'write_note' }, { name: 'execute_mcp' }];
  assert.equal(projectedClientCall({ name: 'execute_mcp', arguments: {
    ServerName: 'another_server', ToolName: 'write_note', Arguments: {}
  } }, tools), null);
  const projected = projectedClientCall({ name: 'execute_mcp', id: 'outer-call', arguments: {
    ServerName: 'external_client', ToolName: 'execute_mcp', Arguments: { nested: 'client input' }
  } }, tools);
  assert.equal(projected.name, 'execute_mcp'); assert.deepEqual(projected.arguments, { nested: 'client input' });
  const direct = projectedClientCall({ name: 'execute_mcp', id: 'direct', arguments: { input: 'direct client input' } }, tools);
  assert.deepEqual(direct.arguments, { input: 'direct client input' });
});

test('Robin task mode bridges a remote tool call across two client HTTP turns', async () => {
  const streams = [];
  const transport = {
    request(path, _token, options = {}) {
      let resolveDone;
      let rejectDone;
      const stream = {
        path,
        options,
        writes: [],
        done: new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }),
        write(message) { this.writes.push(message); },
        end(message) { if (message) this.writes.push(message); },
        close() {},
        resolve: resolveDone,
        reject: rejectDone
      };
      streams.push(stream);
      return stream;
    },
    unary: async () => Buffer.alloc(0)
  };
  const provider = new RobinProvider({
    auth: { account: { modeVariantId: '95a4c0abcba24364' }, get: async () => ({ accessToken: 'token', serverToken: 'server-token' }) },
    transport
  });
  const normalized = {
    system: '',
    messages: [{ role: 'user', text: '请读取项目说明并概括重点。', parts: [{ type: 'text', text: '请读取项目说明并概括重点。' }] }],
    tools: [{ name: 'read_file', description: 'Read a workspace file.', schema: { type: 'object' } }],
    toolChoice: null
  };
  const first = provider.send(normalized, ARGON_MODEL, { sessionId: 'pi:conversation-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streams[0].path, PROCESS_QUERY_PATH);
  const initialEnvelope = decodeFields(streams[0].writes[0]);
  const initial = decodeFields(initialEnvelope.find((field) => field.number === 1000).value);
  const clientResponseEnvelope = decodeFields(initial.find((field) => field.number === 1001).value);
  const clientRequest = decodeFields(clientResponseEnvelope.find((field) => field.number === 1).value);
  const identifiers = decodeFields(clientRequest.find((field) => field.number === 4).value);
  assert.deepEqual(identifiers.map((field) => [field.number, field.value.length]), [[1, 0], [2, 0], [3, 0]]);
  streams[0].options.onMessage(Buffer.alloc(40, 1));
  assert.equal(streams.length, 1, 'unrelated ProcessQuery data must not start the remote tool stream');
  const routingToken = Buffer.from([9, 8, 7]);
  const continuation = bytesField(1014, messageField(1, Buffer.concat([
    stringField(1, 'c_server_conversation_1'),
    bytesField(2, routingToken)
  ])));
  streams[0].options.onMessage(continuation);
  assert.equal(streams[1].path, EXECUTE_REMOTE_TOOLS_PATH);
  const connectEnvelope = decodeFields(streams[1].writes[0]);
  const connect = decodeFields(connectEnvelope.find((field) => field.number === 1).value);
  assert.equal(connect.find((field) => field.number === 1).value.toString(), 'c_server_conversation_1');
  assert.deepEqual(connect.find((field) => field.number === 3).value, routingToken);
  const call = messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'read_file'),
    stringField(2, 'remote-call-1'),
    messageField(3, protoStruct({ path: '/workspace/README.md' }))
  ])));
  streams[1].options.onMessage(call);
  const requested = await first;
  assert.deepEqual(requested.toolCalls, [{
    id: 'remote-call-1', name: 'read_file', arguments: { path: '/workspace/README.md' }
  }]);

  const continuedRequest = {
    ...normalized,
    messages: [...normalized.messages, {
      role: 'user', text: '', parts: [{ type: 'tool_result', id: 'remote-call-1', name: 'read_file', content: '项目说明内容' }]
    }]
  };
  const second = provider.send(continuedRequest, ARGON_MODEL, { sessionId: 'pi:conversation-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(streams[1].writes.length >= 2, 'tool result must be written to the existing remote stream');
  const finalMessage = bytesField(1003, messageField(1, messageField(1, Buffer.concat([
    stringField(1, 'rc_project_summary'),
    messageField(2, stringField(1, '项目重点已经整理完成。'))
  ]))));
  streams[0].resolve([finalMessage]);
  const completed = await second;
  assert.equal(completed.text, '项目重点已经整理完成。');
  assert.deepEqual(completed.toolCalls, []);
});

test('continuation parser finds only a server-issued Robin conversation ID', () => {
  const routingToken = Buffer.from('continuation-token');
  const payload = bytesField(1014, messageField(1, Buffer.concat([
    stringField(1, 'c_3098051d2685490a'),
    bytesField(2, routingToken)
  ])));
  assert.deepEqual(continuationIdentifiers(payload), {
    conversationId: 'c_3098051d2685490a',
    sessionRoutingKey: 'c_3098051d2685490a',
    routingToken
  });
  assert.equal(continuationIdentifiers(messageField(1, stringField(1, 'ordinary response text'))), null);
  assert.equal(continuationIdentifiers(Buffer.alloc(40, 1)), null);
  const fake = 'c_3098051d2685490a';
  const modelText = bytesField(1003, messageField(1, messageField(1, Buffer.concat([
    stringField(1, 'rc_body'), messageField(2, stringField(1, fake))
  ]))));
  assert.equal(continuationIdentifiers(modelText), null, 'answer text must never choose a tool conversation');
  const responseIds = bytesField(1003, messageField(1, messageField(2, stringField(1, fake))));
  assert.equal(continuationIdentifiers(responseIds), null, 'response IDs are not tool continuation routing');
  assert.equal(continuationIdentifiers(bytesField(1002, stringField(1, fake))), null);
});

test('Argon request explicitly selects task mode without prompt keyword routing', () => {
  const normalized = { system: 'Follow instructions.', messages: [{ role: 'user', text: '整理三条待办。', parts: [] }], tools: [], toolChoice: null };
  const request = clientGenerateRequest(normalized, { conversationId: 'conversation', requestId: 'request' });
  const fields = decodeFields(request);
  assert.equal(fields.find((field) => field.number === 26).value, 41n);
  assert.equal(fields.find((field) => field.number === 49).value, 1n);
  const initial = processQueryInitial(normalized, { conversationId: 'conversation', requestId: 'request' }, '95a4c0abcba24364');
  const envelope = decodeFields(initial.message);
  assert.ok(envelope.some((field) => field.number === 1000));
  const requestFields = decodeFields(envelope.find((field) => field.number === 1000).value);
  const metadata = decodeFields(requestFields.find((field) => field.number === 1).value);
  assert.equal(metadata.find((field) => field.number === 16).value.toString(), '95a4c0abcba24364');
});

test('Robin task input is provider-neutral and preserves client instructions without disabling task tools', () => {
  const normalized = {
    system: '优先保持现有文件格式。',
    messages: [
      { role: 'user', text: '请读取项目说明，整理今天要处理的三件事。', parts: [] },
      { role: 'assistant', text: '我先查看说明。', parts: [] }
    ],
    tools: [{ name: 'read_file', description: '读取文件', schema: { type: 'object' } }],
    toolChoice: null
  };
  const text = robinTaskText(normalized);
  assert.match(text, /优先保持现有文件格式/);
  assert.match(text, /请读取项目说明/);
  assert.doesNotMatch(text, /antigravity|gateway|do not use .*built-in tools/i);
});

test('Robin user query carries uploaded image, video and PDF references as native attachments', () => {
  const normalized = {
    system: '',
    messages: [{
      role: 'user',
      text: '请概括这些资料。',
      parts: [
        { type: 'text', text: '请概括这些资料。' },
        { type: 'media', id: 'image-1', filename: 'scene.png', mediaType: 'image/png', robinBlobId: '/contrib_service/ttl_1d/image', robinCacheKey: 'image-cache' },
        { type: 'media', id: 'video-1', filename: 'clip.mp4', mediaType: 'video/mp4', robinBlobId: '/contrib_service/ttl_1d/video', robinCacheKey: 'video-cache' },
        { type: 'media', id: 'pdf-1', filename: 'notes.pdf', mediaType: 'application/pdf', robinBlobId: '/contrib_service/ttl_1d/pdf', robinCacheKey: 'pdf-cache' }
      ]
    }],
    tools: [],
    toolChoice: null
  };
  const request = decodeFields(clientGenerateRequest(normalized, { conversationId: 'conversation', requestId: 'request' }));
  const query = decodeFields(request.find((field) => field.number === 1).value);
  const attachments = query.filter((field) => field.number === 3).map((field) => decodeFields(field.value));
  assert.equal(attachments.length, 3);
  assert.deepEqual(attachments.map((fields) => fields.find((field) => field.number === 2).value.toString()), ['scene.png', 'clip.mp4', 'notes.pdf']);
  const blobs = attachments.map((fields) => decodeFields(fields.find((field) => field.number === 1).value));
  assert.deepEqual(blobs.map((fields) => fields.find((field) => field.number === 1).value.toString()), [
    '/contrib_service/ttl_1d/image', '/contrib_service/ttl_1d/video', '/contrib_service/ttl_1d/pdf'
  ]);
  assert.deepEqual(blobs.map((fields) => fields.find((field) => field.number === 2).value), [1n, 2n, 11n]);
  assert.deepEqual(blobs.map((fields) => fields.find((field) => field.number === 3).value.toString()), ['image/png', 'video/mp4', 'application/pdf']);
  assert.ok(blobs.every((fields) => fields.find((field) => field.number === 4).value === 1n));
  assert.deepEqual(blobs.map((fields) => fields.find((field) => field.number === 5).value.toString()), ['image-cache', 'video-cache', 'pdf-cache']);
});

test('Robin uploads media with the Gemini desktop resumable flow and caches the blob reference', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response('', {
      status: 200,
      headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=test' }
    });
    return new Response('/contrib_service/ttl_1d/blob123', { status: 200 });
  };
  const transportCalls = [];
  const transport = {
    unary: async (path, token, message, options) => {
      transportCalls.push({ path, token, message, options });
      return Buffer.concat([intField(2, 1), messageField(3, stringField(1, 'processed-cache-key'))]);
    }
  };
  const provider = new RobinProvider({ auth: {}, fetchImpl, transport });
  const normalized = {
    messages: [{ role: 'user', text: '查看图片。', parts: [{
      type: 'media', filename: 'scene.png', mediaType: 'image/png', data: Buffer.from('image-data').toString('base64')
    }] }]
  };
  const record = { accessToken: 'access-token', serverToken: 'server-token' };
  const first = await provider.prepareNormalized(normalized, record);
  const second = await provider.prepareNormalized(normalized, record);
  assert.equal(first.messages[0].parts[0].robinBlobId, '/contrib_service/ttl_1d/blob123');
  assert.equal(first.messages[0].parts[0].robinCacheKey, 'processed-cache-key');
  assert.equal(second.messages[0].parts[0].robinBlobId, '/contrib_service/ttl_1d/blob123');
  assert.equal(second.messages[0].parts[0].robinCacheKey, 'processed-cache-key');
  assert.equal(calls.length, 2, 'the second preparation should reuse the uploaded blob');
  assert.equal(transportCalls.length, 1, 'the second preparation should reuse the processed cache key');
  assert.equal(calls[0].options.headers['push-id'], 'feeds/mcudyrk2a4khkz');
  assert.equal(calls[0].options.headers['x-goog-upload-command'], 'start');
  assert.equal(calls[1].options.headers['x-goog-upload-command'], 'upload, finalize');
  assert.deepEqual(Buffer.from(calls[1].options.body), Buffer.from('image-data'));
});

test('Robin media cache separates native file types when clients send a generic MIME type', async () => {
  let uploaded = 0;
  const processedTypes = [];
  const provider = new RobinProvider({ auth: {},
    fetchImpl: async (_url, options) => options.headers['x-goog-upload-command'] === 'start'
      ? new Response('', { headers: { 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=test' } })
      : new Response(`/contrib_service/ttl_1d/file-${++uploaded}`),
    transport: { unary: async (_rpc, _token, message) => {
      const attachment = decodeFields(decodeFields(message)[0].value);
      const blob = decodeFields(attachment.find(field => field.number === 1).value);
      processedTypes.push(Number(blob.find(field => field.number === 2).value));
      return Buffer.concat([intField(2, 1), messageField(3, stringField(1, `cache-${uploaded}`))]);
    } }
  });
  const part = { type: 'media', mediaType: 'application/octet-stream', data: Buffer.from('same payload').toString('base64') };
  const record = { accessToken: 'test', serverToken: 'test' };
  const pdf = await provider.uploadMedia({ ...part, filename: 'note.pdf' }, record);
  const text = await provider.uploadMedia({ ...part, filename: 'note.txt' }, record);
  const renamedPdf = await provider.uploadMedia({ ...part, filename: 'renamed.pdf' }, record);
  assert.notEqual(pdf.blobId, text.blobId, 'processing a document must not reuse a text-file cache entry');
  assert.equal(renamedPdf.blobId, pdf.blobId, 'renaming a file does not change its native media type');
  assert.deepEqual(processedTypes, [11, 3]);
});

test('Robin response parser prefers the structured model response text', () => {
  const modelResponse = Buffer.concat([
    stringField(1, 'rc_response123'),
    messageField(2, stringField(1, '已根据现有资料整理出三项安排。'))
  ]);
  const clientGenerateResponse = messageField(1, modelResponse);
  const envelope = bytesField(1003, messageField(1, clientGenerateResponse));
  const statusNoise = bytesField(1001, Buffer.concat([
    stringField(1, 'https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded/refresh/default/24px.svg'),
    stringField(2, 'CONNECTED CLIENT')
  ]));
  assert.equal(responseText([statusNoise, envelope]), '已根据现有资料整理出三项安排。');
  assert.equal(responseText([statusNoise]), '', 'status cards must never become assistant output');
});

test('Robin preserves historical nested tool media in the initial query, never in prefetch', async () => {
  const provider = new RobinProvider({ auth: {} });
  const image = { type: 'media', mediaType: 'image/png', filename: 'tool.png', data: 'aW1hZ2U=' };
  const input = { messages: [{ role: 'user', text: 'Compare the previous image.', parts: [
    { type: 'tool_result', id: 'previous', content: 'Image loaded.', media: [image] }
  ] }], tools: [] };
  provider.uploadMedia = async () => ({ blobId: '/contrib_service/ttl_1d/image', cacheKey: 'processed' });
  const prepared = await provider.prepareNormalized(input, {});
  assert.equal(prepared.messages[0].parts[0].media[0].robinCacheKey, 'processed');
  assert.equal(image.robinCacheKey, undefined, 'normalization must not mutate client input');
  const request = decodeFields(clientGenerateRequest(prepared));
  const query = decodeFields(request.find(f => f.number === 1).value);
  assert.equal(query.filter(f => f.number === 3).length, 1);
  const prefetch = decodeFields(decodeFields(processQueryPrefetch(prepared))[0].value);
  assert.equal(prefetch.filter(f => f.number === 3).length, 0);
});

test('Robin prefetch repeats only text and never re-sends uploaded media', () => {
  const normalized = {
    messages: [{
      role: 'user',
      text: '请描述附件内容。',
      parts: [
        { type: 'text', text: '请描述附件内容。' },
        { type: 'media', filename: 'scene.png', mediaType: 'image/png', robinBlobId: '/contrib_service/ttl_1d/image', robinCacheKey: 'cache-key' }
      ]
    }],
    tools: []
  };
  const prefetch = decodeFields(processQueryPrefetch(normalized));
  const query = decodeFields(prefetch.find((field) => field.number === 1007).value);
  assert.equal(query.filter((field) => field.number === 3).length, 0);
  assert.match(query.find((field) => field.number === 1).value.toString(), /请描述附件内容/);
});

test('provider router exposes a union but never falls back Argon to Cloud Code', async () => {
  const calls = [];
  const cloudcodePool = {
    listModels: async () => ['gemini-3.8-flash-high'],
    send: async () => { calls.push('cloudcode'); return { text: 'cloud' }; }
  };
  const robinPool = {
    listModels: async () => [ARGON_MODEL],
    supportsModel: (model) => model === ARGON_MODEL,
    send: async () => { calls.push('robin'); return { text: 'robin' }; }
  };
  const router = new ProviderRouter({ cloudcodePool, robinPool });
  assert.deepEqual(await router.refreshModels(), ['gemini-3.8-flash-high', ARGON_MODEL]);
  assert.equal((await router.send({}, ARGON_MODEL)).text, 'robin');
  assert.equal((await router.send({}, 'gemini-3.8-flash-high')).text, 'cloud');
  assert.deepEqual(calls, ['robin', 'cloudcode']);
  assert.equal((await router.send({}, 'gemini-unknown')).text, 'cloud');
  assert.deepEqual(calls, ['robin', 'cloudcode', 'cloudcode']);

  robinPool.send = async () => {
    calls.push('robin-failed');
    throw new Error('Robin unavailable');
  };
  await assert.rejects(router.send({}, ARGON_MODEL), /Robin unavailable/);
  assert.deepEqual(calls, ['robin', 'cloudcode', 'cloudcode', 'robin-failed']);
});

test('provider router keeps a Robin-owned model on Robin even when no Robin account is currently healthy', async () => {
  const calls = [];
  const router = new ProviderRouter({
    cloudcodePool: {
      listModels: async () => ['gemini-3.8-flash-high'],
      send: async () => { calls.push('cloudcode'); return { text: 'wrong provider' }; }
    },
    robinPool: {
      listModels: async () => [],
      ownsModel: (model) => model === ARGON_MODEL,
      supportsModel: () => false,
      send: async () => {
        calls.push('robin');
        throw new Error('Gemini account unavailable');
      }
    }
  });
  await assert.rejects(router.send({}, ARGON_MODEL), /Gemini account unavailable/);
  assert.deepEqual(calls, ['robin']);
});

test('first Robin request discovers only its own catalog, without touching Cloud Code credentials', async () => {
  let robinDiscoveries = 0;
  const router = new ProviderRouter({
    cloudcodePool: {
      listModels: async () => { assert.fail('Argon must not query Cloud Code'); },
      send: async () => { assert.fail('Argon must not fall back to Cloud Code'); }
    },
    robinPool: {
      ownsModel: (model) => model === ARGON_MODEL,
      supportsModel: () => true,
      listModels: async () => { robinDiscoveries++; return [ARGON_MODEL]; },
      send: async () => ({ text: 'Argon' })
    }
  });
  assert.equal((await router.send({}, ARGON_MODEL)).text, 'Argon');
  assert.equal((await router.send({}, ARGON_MODEL)).text, 'Argon');
  assert.equal(robinDiscoveries, 1);
  router.catalog.cloudcode.add(ARGON_MODEL);
  await assert.rejects(router.send({}, ARGON_MODEL), { code: 'ambiguous_model_provider' });
});

test('first Cloud Code request does not refresh Robin or duplicate its own pool capability discovery', async () => {
  const models = [], normalized = { messages: [{ role: 'user', text: '你好。' }] };
  const router = new ProviderRouter({
    cloudcodePool: {
      listModels: async () => { assert.fail('inference routing must not perform union catalog discovery'); },
      send: async (input, model, options) => {
        assert.equal(input, normalized);
        assert.equal(options.providerType, 'cloudcode');
        models.push(model);
        return { text: 'cloud' };
      }
    },
    robinPool: {
      ownsModel: model => model === ARGON_MODEL,
      supportsModel: () => false,
      listModels: async () => { assert.fail('Cloud Code must not wait for Robin credentials'); },
      send: async () => { assert.fail('wrong provider'); }
    }
  });
  assert.equal((await router.send(normalized, 'claude-opus-5-5-high')).text, 'cloud');
  assert.equal((await router.send(normalized, 'new-cloud-model')).text, 'cloud');
  assert.deepEqual(models, ['claude-opus-5-5-high', 'new-cloud-model']);
});

test('a pending unified Robin catalog refresh does not block Cloud Code inference', async t => {
  let releaseRobin;
  const router = new ProviderRouter({
    cloudcodePool: { listModels: async () => ['claude-opus-5-5-high'], send: async () => ({ text: 'cloud' }) },
    robinPool: {
      ownsModel: model => model === ARGON_MODEL,
      supportsModel: () => false,
      listModels: () => new Promise(resolve => { releaseRobin = resolve; }),
      send: async () => { assert.fail('wrong provider'); }
    }
  });
  const pendingCatalog = router.refreshModels();
  t.after(() => releaseRobin?.([ARGON_MODEL]));
  const result = await Promise.race([
    router.send({}, 'claude-opus-5-5-high'),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('unrelated Robin blocked inference')), 200); timer.unref(); })
  ]);
  assert.equal(result.text, 'cloud');
  releaseRobin([ARGON_MODEL]);
  assert.deepEqual(await pendingCatalog, ['claude-opus-5-5-high', ARGON_MODEL]);
});

test('cached Robin model ownership survives unhealthy accounts and cancelled routing does not contact either provider', async () => {
  const sent = [], router = new ProviderRouter({
    cloudcodePool: { listModels: async () => { assert.fail('unexpected discovery'); }, send: async () => { assert.fail('no Cloud Code fallback'); } },
    robinPool: {
      ownsModel: () => false, supportsModel: () => false,
      listModels: async () => { assert.fail('cached ownership does not require a new catalog'); },
      send: async (_input, model) => { sent.push(model); throw new Error('Gemini account quota exhausted'); }
    }
  });
  router.catalog.robin.add(ARGON_MODEL);
  await assert.rejects(router.send({}, ARGON_MODEL), /quota exhausted/);
  const controller = new AbortController();
  controller.abort(new Error('caller stopped'));
  await assert.rejects(router.send({}, ARGON_MODEL, { signal: controller.signal }), /caller stopped/);
  assert.deepEqual(sent, [ARGON_MODEL]);
});

test('Robin discovery requires an exact mode definition and account-selectable mode ID', () => {
  const definition = messageField(17, Buffer.concat([
    stringField(1, ARGON_MODE_VARIANT_ID), stringField(2, 'Argon')
  ]));
  const enabled = messageField(18, stringField(1, ARGON_MODE_VARIANT_ID));
  assert.deepEqual(discoveredArgonModels(Buffer.concat([definition, enabled])), [ARGON_MODEL]);
  assert.deepEqual(discoveredArgonModels(definition), []);
  assert.deepEqual(discoveredArgonModels(enabled), []);
  assert.deepEqual(discoveredArgonModels(stringField(34, `Argon Argon4p0 ${ARGON_MODE_VARIANT_ID}`)), []);
  assert.deepEqual(discoveredArgonModels(Buffer.concat([definition, messageField(18, stringField(1, 'other-mode'))])), []);
  assert.deepEqual(discoveredArgonModels(Buffer.from([0xff])), []);
});

test('Robin ignores experimental status policy records when discovering Argon entitlement', () => {
  const entitlement = Buffer.concat([
    messageField(17, Buffer.concat([stringField(1, ARGON_MODE_VARIANT_ID), stringField(2, 'Argon')])),
    messageField(18, stringField(1, ARGON_MODE_VARIANT_ID))
  ]);
  const policy = messageField(34, Buffer.concat([stringField(1, 'unused-experimental-policy'), intField(48, 2)]));
  assert.deepEqual(robinUserStatus(Buffer.concat([entitlement, policy])), { models: [ARGON_MODEL] });
  assert.deepEqual(robinUserStatus(policy), { models: [] }, 'policy data alone is not entitlement');
});

test('Argon ignores client reasoning controls that Gemini App does not expose', () => {
  for (const reasoningEffort of ['none', 'low', 'medium', 'high', 'unsupported']) {
    const fields = decodeFields(clientGenerateRequest({ messages: [], reasoningEffort }));
    assert.equal(fields.some(field => field.number === 48), false);
    assert.equal(fields.some(field => field.number === 38), false);
  }
});

test('Robin pool rotates only Gemini accounts and keeps separate affinity', async (t) => {
  const { robin } = tempStores(t);
  const first = robin.save({ email: 'one@example.com', accessToken: 'one', providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  const second = robin.save({ email: 'two@example.com', accessToken: 'two', providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  const calls = [];
  const pool = new RobinAccountPool({
    store: robin,
    providerFactory: (account) => ({
      auth: { disable() {} },
      send: async (_normalized, model, options) => {
        calls.push({ id: account.id, model, sessionId: options.sessionId });
        return { text: account.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [ARGON_MODEL]
    })
  });
  const a = await pool.send({}, ARGON_MODEL, { routingKey: 'client-conversation', sessionId: 'conversation', clientId: 'pi' });
  const b = await pool.send({}, ARGON_MODEL, { routingKey: 'client-conversation', sessionId: 'conversation', clientId: 'pi' });
  const c = await pool.send({}, ARGON_MODEL, { routingKey: 'other-conversation', sessionId: 'conversation', clientId: 'hermes' });
  assert.equal(a.accountId, b.accountId);
  assert.notEqual(a.accountId, c.accountId);
  assert.deepEqual(JSON.parse(calls[0].sessionId), ['pi', 'conversation', 'robin', a.accountId]);
});

test('Gemini OAuth uses independent scopes and stores provider identity', async () => {
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/gemini'));
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/flexible-api'));
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/experimentsandconfigs'));
  const phenotypeResponse = messageField(1, Buffer.concat([
    messageField(1, stringField(1, ROBIN_PHENOTYPE_PACKAGE)),
    stringField(4, 'server-token')
  ]));
  const responses = [
    new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 }),
    new Response(JSON.stringify({ id: 'subject', email: 'user@example.com' }), { status: 200 }),
    new Response(phenotypeResponse, { status: 200 })
  ];
  const flow = new RobinOAuthFlow({ fetchImpl: async () => responses.shift(), openBrowserImpl: async () => false });
  const account = await flow.exchange('code', 'http://127.0.0.1/callback', 'verifier', { clientId: 'client', clientSecret: 'secret' });
  assert.equal(account.providerType, 'robin');
  assert.equal(account.accountType, 'gemini-app');
  assert.deepEqual(account.capabilities, [], 'authorization alone does not establish model entitlement');
  assert.equal(account.providerMetadata.robinServerToken, 'server-token');
});

test('Robin Phenotype request and response provide a server token without a local Gemini cache', () => {
  assert.equal(phenotypeVersion('1.128.14.1166'), 1_000_128_000_014n);
  const request = decodeFields(phenotypeRequest());
  const data = decodeFields(request.find((field) => field.number === 2).value);
  const details = decodeFields(data.find((field) => field.number === 1).value);
  assert.equal(details.find((field) => field.number === 1).value.toString(), ROBIN_PHENOTYPE_PACKAGE);
  assert.equal(details.find((field) => field.number === 2).value, 1_000_128_000_014n);
  const response = messageField(1, Buffer.concat([
    messageField(1, stringField(1, ROBIN_PHENOTYPE_PACKAGE)),
    stringField(4, 'independent-server-token')
  ]));
  assert.equal(phenotypeServerToken(response), 'independent-server-token');
});

test('Robin Phenotype failures never reflect an HTML response body', async () => {
  await assert.rejects(
    fetchRobinServerToken('access-token', {
      fetchImpl: async () => new Response('<html><body>upstream diagnostic detail</body></html>', {
        status: 401,
        headers: { 'content-type': 'text/html' }
      })
    }),
    (error) => error.code === 'robin_reauthorization_required'
      && error.status === 401
      && /HTTP 401/.test(error.message)
      && !/diagnostic detail/.test(error.message)
  );
});

test('Robin auth lazily obtains and persists a missing server token', async (t) => {
  const { robin } = tempStores(t);
  const saved = robin.save({
    email: 'user@example.com',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    providerType: 'robin',
    accountType: 'gemini-app'
  });
  const response = messageField(1, Buffer.concat([
    messageField(1, stringField(1, ROBIN_PHENOTYPE_PACKAGE)),
    stringField(4, 'loaded-server-token')
  ]));
  let requests = 0;
  const auth = new RobinAccountAuthProvider({
    account: saved,
    store: robin,
    fetchImpl: async () => {
      requests += 1;
      return new Response(response, { status: 200 });
    }
  });
  const first = await auth.get();
  const second = await auth.get();
  assert.equal(first.serverToken, 'loaded-server-token');
  assert.equal(second.serverToken, 'loaded-server-token');
  assert.equal(requests, 1);
  assert.equal(robin.list()[0].providerMetadata.robinServerToken, 'loaded-server-token');
});
