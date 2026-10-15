'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RobinProvider, RobinProviderError, ARGON_MODEL, GET_CONVERSATION_TURN_PATH } = require('../src/robin-provider');
const { conversationTurnFrames, responseMetadata } = require('../src/robin-response');
const { bytesField, messageField, stringField, intField, decodeFields, firstField, stringValue, protoStruct } = require('../src/robin-proto');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ids = { conversationId: 'c_recovery1234', requestId: 'r_recovery1234' };
const input = { messages: [{ role: 'user', text: '整理便签。', parts: [] }], tools: [] };
const identifiers = value => Buffer.concat([stringField(1, value.conversationId), stringField(2, value.requestId)]);
const status = (goal, conversation = ids.conversationId) => messageField(13, messageField(5,
  Buffer.concat([intField(1, goal), stringField(2, conversation)])));
const model = (text, responseId = 'rc_recovery1234', complete = 2) => Buffer.concat([
  stringField(1, responseId), messageField(2, stringField(1, text)), intField(19, complete)
]);
const running = (value = ids) => bytesField(1003, messageField(1, Buffer.concat([
  messageField(2, identifiers(value)), messageField(6, status(4, value.conversationId))
])));
function saved({ current = ids, goal = 1, goalConversation = current.conversationId, text = '完成',
  selected = 'rc_recovery1234', complete = 2, extra = [], modeCategory } = {}) {
  return messageField(1, Buffer.concat([messageField(1, identifiers(current)), messageField(4, Buffer.concat([
    messageField(1, model(text, selected, complete)), ...extra.map(value => messageField(1, value)),
    stringField(4, selected), messageField(5, status(goal, goalConversation)),
    ...(modeCategory === undefined ? [] : [intField(22, modeCategory)])
  ]))]));
}
function harness(t) {
  const streams = [], reads = [];
  const provider = new RobinProvider({ auth: { account: {}, get: async () => ({ accessToken: 'test', serverToken: 'test' }) },
    transport: { unary: async () => Buffer.alloc(0), request(path, _token, options) {
      let resolve, reject;
      const done = new Promise((yes, no) => { resolve = yes; reject = no; });
      const stream = { path, options, done, resolve, reject, writes: [], ends: [],
        write(bytes) { this.writes.push(bytes); }, end(bytes) { this.ends.push(bytes); }, close() { this.closed = true; } };
      streams.push(stream); return stream;
    } }
  });
  provider.pauseRecovery = async () => {};
  provider.transport.unary = async (path, token, bytes, options) => {
    if (path !== GET_CONVERSATION_TURN_PATH) return Buffer.alloc(0);
    reads.push({ path, token, bytes, options });
    return provider.readSnapshot ? provider.readSnapshot(reads.length, options) : saved();
  };
  t.after(() => provider.stop());
  return { provider, streams, reads };
}

test('saved-turn recovery projects only the selected native response and authoritative status', () => {
  const metadata = responseMetadata(conversationTurnFrames(saved({ extra: [model('not selected', 'rc_alternative1234')] }), ids));
  assert.equal(metadata.goalStatus, 1);
  assert.deepEqual(metadata.models.map(value => value.responseId), ['rc_recovery1234']);
  assert.equal(metadata.models[0].completeness, 2);
  assert.equal(metadata.usageKnown, false);
});

test('saved-turn recovery rejects foreign conversation, request and goal-state identifiers', () => {
  for (const options of [{ current: { ...ids, conversationId: 'c_foreign1234' } },
    { current: { ...ids, requestId: 'r_foreign1234' } }, { goalConversation: 'c_foreign1234' }]) {
    assert.throws(() => conversationTurnFrames(saved(options), ids), { code: 'robin_session_mismatch', status: 409 });
  }
});

test('native RUNNING EOF is recovered by owned read-only RPCs, never a new query', async t => {
  const { provider, streams, reads } = harness(t);
  provider.readSnapshot = count => count === 1 ? saved({ goal: 4, text: '', complete: 1 }) : saved({ text: '已完成' });
  const pending = provider.send(input, ARGON_MODEL, { sessionId: 'recovered' });
  await tick(); streams[0].resolve([running()]);
  const result = await pending;
  assert.equal(result.text, '已完成'); assert.equal(streams.length, 1); assert.equal(reads.length, 2);
  const request = decodeFields(reads[0].bytes);
  assert.equal(stringValue(firstField(request, 1, 2)), ids.conversationId);
  assert.equal(stringValue(firstField(request, 2, 2)), ids.requestId);
  assert.equal(firstField(decodeFields(firstField(request, 4, 2).value), 1, 0).value, 1n, 'native message tree is requested');
  assert.equal(provider.turns.size, 0);
});

test('recovery does not poll client approvals or replay client tools while their results are pending', async t => {
  const { provider, streams, reads } = harness(t);
  const withTools = { ...input, tools: [{ name: 'write_note' }] };
  const first = provider.send(withTools, ARGON_MODEL, { sessionId: 'waiting-client' });
  await tick();
  streams[0].options.onMessage(bytesField(1014, messageField(1, stringField(1, ids.conversationId))));
  streams[1].options.onMessage(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'write_note'), stringField(2, 'write-once'), messageField(3, protoStruct({ text: 'note' }))
  ]))));
  const call = (await first).toolCalls[0];
  streams[0].resolve([running()]); await tick();
  assert.equal(reads.length, 0); assert.notEqual(streams[1].closed, true);
  const next = provider.send({ ...withTools, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: call.id, content: 'saved' }] }] },
    ARGON_MODEL, { sessionId: 'waiting-client' });
  assert.equal((await next).text, '完成');
  assert.equal(streams.length, 2); assert.equal(reads.length, 1);
  assert.equal(streams[1].writes.length, 2, 'one connect and one result, no tool replay');
});

test('cancelled recovery discards late replies and leaves another client intact', async t => {
  const { provider, streams } = harness(t);
  let release;
  provider.readSnapshot = () => new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const cancelled = provider.send(input, ARGON_MODEL, { sessionId: 'cancelled', signal: controller.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const other = provider.send(input, ARGON_MODEL, { sessionId: 'other' });
  await tick(); streams[0].resolve([running()]); await tick();
  controller.abort(); await rejected;
  release(saved({ text: 'must not be delivered' }));
  const response = bytesField(1003, messageField(1, messageField(1, model('other answer'))));
  streams[1].resolve([response]); assert.equal((await other).text, 'other answer');
  assert.equal(provider.turns.size, 0);
});

test('a late recovered snapshot cannot overwrite a newer native query generation', async t => {
  const { provider, streams } = harness(t);
  let release;
  provider.readSnapshot = () => new Promise(resolve => { release = resolve; });
  const pending = provider.send(input, ARGON_MODEL, { sessionId: 'generation' });
  await tick(); streams[0].resolve([running()]); await tick();
  provider.turns.get('generation').start();
  const response = bytesField(1003, messageField(1, messageField(1, model('new answer'))));
  streams[1].resolve([response]); assert.equal((await pending).text, 'new answer');
  release(saved({ current: { ...ids, conversationId: 'c_foreign1234' }, text: 'old answer' }));
  await tick(); assert.equal(provider.turns.size, 0);
});

test('recovery is bounded and never retries malformed or foreign snapshots', async t => {
  for (const kind of ['running', 'foreign', 'malformed']) {
    const { provider, streams, reads } = harness(t);
    provider.readSnapshot = () => kind === 'running' ? saved({ goal: 4, complete: 1 })
      : kind === 'foreign' ? saved({ current: { ...ids, requestId: 'r_foreign1234' } }) : Buffer.alloc(0);
    const pending = provider.send(input, ARGON_MODEL, { sessionId: kind });
    const rejected = assert.rejects(pending, { code: kind === 'running' ? 'robin_incomplete_response'
      : kind === 'foreign' ? 'robin_session_mismatch' : 'robin_recovery_response_error' });
    await tick(); streams[0].resolve([running()]); await rejected;
    const timeout = Number(process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS || 300_000);
    assert.equal(reads.length, kind === 'running' ? Math.ceil(timeout / 2000) : 1); assert.equal(streams.length, 1);
  }
});

test('recovery preserves native mode metadata without fabricating missing fields', () => {
  const actual = responseMetadata(conversationTurnFrames(saved({ modeCategory: 8 }), ids));
  assert.equal(actual.modeCategory, 8);
  const absent = responseMetadata(conversationTurnFrames(saved(), ids));
  assert.equal(absent.modeCategory, undefined);
});

test('response metadata preserves native routing, attribution and downgrade diagnostics', () => {
  const response = bytesField(1003, messageField(1, Buffer.concat([
    messageField(1, model('完成')),
    intField(11, 1), stringField(25, 'bard-mode-argon'), stringField(30, 'Argon'),
    intField(31, 3), intField(32, 1), stringField(39, 'mode-variant'), stringField(40, 'routing-variant')
  ])));
  const metadata = responseMetadata([response]);
  assert.equal(metadata.containsFallbackResponse, true);
  assert.equal(metadata.responseBardModeId, 'bard-mode-argon');
  assert.equal(metadata.modelAttributionName, 'Argon');
  assert.equal(metadata.bardModeDowngradeReason, 3);
  assert.equal(metadata.isConfirmationRequest, true);
  assert.equal(metadata.modeVariantId, 'mode-variant');
  assert.equal(metadata.routingVariantId, 'routing-variant');
});

test('only transient recovery reads are retried; authentication errors retain their real credential attribution', async t => {
  const { provider, streams, reads } = harness(t);
  provider.readSnapshot = count => {
    if (count === 1) throw new RobinProviderError('unavailable', { status: 503 });
    return saved();
  };
  const pending = provider.send(input, ARGON_MODEL, { sessionId: 'retry-read' });
  await tick(); streams[0].resolve([running()]); assert.equal((await pending).text, '完成'); assert.equal(reads.length, 2);
  provider.auth.get = async () => ({ accessToken: 'rotated', serverToken: 'test', credentialFingerprint: 'real-reader-fingerprint' });
  provider.readSnapshot = () => { throw new RobinProviderError('authentication failed', { status: 401 }); };
  const failed = provider.send(input, ARGON_MODEL, { sessionId: 'reader-auth' });
  const rejected = assert.rejects(failed, error => error.status === 401 && error.upstreamAuthFingerprint === 'real-reader-fingerprint');
  await tick(); streams[1].resolve([running()]); await rejected; assert.equal(reads.length, 3);
});

test('a read-API rate limit does not masquerade as exhausted Argon generation quota', async t => {
  const { provider, streams, reads } = harness(t);
  provider.readSnapshot = count => {
    if (count === 1) throw new RobinProviderError('read rate limited', { status: 429, code: 'robin_quota_error' });
    return saved();
  };
  const pending = provider.send(input, ARGON_MODEL, { sessionId: 'read-rate-limit' });
  await tick(); streams[0].resolve([running()]);
  assert.equal((await pending).text, '完成'); assert.equal(reads.length, 2); assert.equal(streams.length, 1);
});
