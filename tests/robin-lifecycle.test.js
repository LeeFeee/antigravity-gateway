'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { RobinAccountPool, ROBIN_SESSION_TTL_MS } = require('../src/robin-account-pool');
const { RobinProvider, ARGON_MODEL } = require('../src/robin-provider');
const { robinCredentialFingerprint } = require('../src/robin-auth');
const { bytesField, messageField, stringField, protoStruct, decodeFields, decodeProtoStruct } = require('../src/robin-proto');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const answer = (text, id = 'rc_answer') => bytesField(1003, messageField(1, messageField(1, Buffer.concat([
  stringField(1, id), messageField(2, stringField(1, text))
]))));
const normalized = { messages: [{ role: 'user', text: '整理一份笔记。', parts: [] }], tools: [] };

function harness(t) {
  const streams = [];
  let authCalls = 0;
  const provider = new RobinProvider({
    auth: { account: {}, get: async () => { authCalls++; return { accessToken: 'test', serverToken: 'test' }; } },
    transport: {
      unary: async () => Buffer.alloc(0),
      request(_path, _token, options) {
        let resolve, reject;
        const done = new Promise((yes, no) => { resolve = yes; reject = no; });
        const stream = { options, done, resolve, reject, writes: [], ends: [],
          write(message) { this.writes.push(message); }, end(message) { this.ends.push(message); }, close() { this.closed = true; } };
        streams.push(stream);
        return stream;
      }
    }
  });
  t.after(() => provider.stop());
  return { provider, streams, authCalls: () => authCalls };
}

test('cancelling one client does not abort another client\'s shared device registration', async t => {
  const { provider } = harness(t);
  let finish, registrationSignal;
  provider.transport.unary = (_path, _token, _message, { signal }) => {
    registrationSignal = signal;
    return new Promise((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const firstController = new AbortController();
  const first = provider.ensureDeviceRegistered({ accessToken: 'shared-token' }, firstController.signal);
  const firstRejected = assert.rejects(first, /first client cancelled/);
  await tick();
  const second = provider.ensureDeviceRegistered({ accessToken: 'shared-token' });
  const secondOutcome = second.then(value => ({ value }), error => ({ error }));
  firstController.abort(new Error('first client cancelled'));
  await tick();
  assert.equal(registrationSignal.aborted, false, 'registration belongs to the account, not its first caller');
  finish(Buffer.alloc(0));
  await firstRejected;
  const outcome = await secondOutcome;
  assert.equal(outcome.error, undefined);
  assert.ok(outcome.value.deviceId);
});

test('a refreshed token never joins a registration started with an older token', async t => {
  const { provider } = harness(t);
  const registrations = [];
  provider.transport.unary = (_path, token, _message, { signal }) => new Promise((resolve, reject) => {
    registrations.push({ token, resolve });
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const oldPending = provider.ensureDeviceRegistered({ accessToken: 'old-token' });
  const newPending = provider.ensureDeviceRegistered({ accessToken: 'new-token' });
  const both = Promise.all([oldPending, newPending]);
  both.catch(() => {});
  await tick();
  const tokens = registrations.map(call => call.token);
  for (const call of registrations) call.resolve(Buffer.alloc(0));
  await both;
  assert.deepEqual(tokens, ['old-token', 'new-token']);
});

test('stopping a provider during attachment preparation cannot start a late upstream task', async t => {
  const { provider, streams } = harness(t);
  let finishPreparation, preparationSignal;
  provider.prepareNormalized = (input, _record, signal) => new Promise(resolve => {
    preparationSignal = signal;
    finishPreparation = () => resolve(input);
  });
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'uploading' });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await tick();
  provider.stop();
  const wasAborted = preparationSignal?.aborted;
  finishPreparation();
  await tick();
  // Complete any incorrectly started stream so a failing regression never hangs.
  if (streams[0]) streams[0].resolve([answer('late answer')]);
  const result = await outcome;
  assert.equal(wasAborted, true);
  assert.equal(streams.length, 0, 'no query can begin after the account provider is stopped');
  assert.equal(result.error?.code, 'request_aborted');
  assert.equal(provider.turns.size, 0);
  assert.equal(provider.activeRequests.size, 0);
});

test('stopping a provider cancels shared registration and ignores an adapter\'s late success', async t => {
  const { provider } = harness(t);
  let finish, registrationSignal;
  provider.transport.unary = (_path, _token, _message, { signal }) => new Promise(resolve => {
    registrationSignal = signal;
    finish = resolve;
  });
  const pending = provider.ensureDeviceRegistered({ accessToken: 'registration-token' });
  const rejected = assert.rejects(pending, { code: 'request_aborted' });
  await tick();
  provider.stop();
  assert.equal(registrationSignal.aborted, true);
  finish(Buffer.alloc(0));
  await rejected;
  assert.equal(provider.registrationToken, '');
  assert.equal(provider.registrationPending.size, 0);
});

test('Robin emits incremental model text before EOF and preserves whitespace without replay', async (t) => {
  const { provider, streams } = harness(t);
  const deltas = [];
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'one', onDelta: (s) => deltas.push(s) });
  await tick();
  streams[0].options.onMessage(answer('第一行\n'));
  await tick();
  assert.deepEqual(deltas, ['第一行\n']);
  const complete = '第一行\n\n  第二行\n';
  streams[0].options.onMessage(answer(complete));
  streams[0].options.onMessage(answer(complete));
  streams[0].resolve([answer(complete)]);
  assert.equal((await pending).text, complete);
  assert.equal(deltas.join(''), complete);
});

test('Robin retains the final authoritative snapshot for non-streaming replies', async (t) => {
  const { provider, streams } = harness(t);
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'revised' });
  await tick();
  streams[0].options.onMessage(answer('草稿内容'));
  streams[0].options.onMessage(answer('最终内容'));
  streams[0].resolve([answer('最终内容')]);
  assert.equal((await pending).text, '最终内容');
});

function nativeResponse({ text = '完成', complete, treeComplete, thinking } = {}) {
  const { intField } = require('../src/robin-proto');
  const model = Buffer.concat([
    stringField(1, 'rc_native'), messageField(2, stringField(1, text)),
    ...(complete === undefined ? [] : [intField(19, complete)]),
    ...(thinking === undefined ? [] : [messageField(12, messageField(1, stringField(1, thinking)))])
  ]);
  return bytesField(1003, messageField(1, Buffer.concat([
    messageField(1, model), intField(41, 8),
    ...(treeComplete === undefined ? [] : [intField(9, treeComplete ? 1 : 0)])
  ])));
}

test('Robin rejects an explicitly partial response at a clean transport EOF', async t => {
  for (const marker of [{ complete: 1 }, { treeComplete: false }]) {
    const { provider, streams } = harness(t);
    const pending = provider.send(normalized, ARGON_MODEL, { sessionId: JSON.stringify(marker) });
    const rejected = assert.rejects(pending, { code: 'robin_incomplete_response', status: 502 });
    await tick();
    const partial = nativeResponse({ text: '只返回了一半', ...marker });
    streams[0].options.onMessage(partial);
    streams[0].resolve([partial]);
    await rejected;
    assert.equal(provider.turns.size, 0);
    assert.equal(streams[0].closed, true);
  }
});

test('Robin preserves native thoughts and mode metadata without inventing token usage', async t => {
  const { provider, streams } = harness(t);
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'native-metadata' });
  await tick();
  const first = nativeResponse({ thinking: '已核对条件。', complete: 1, treeComplete: false });
  const final = nativeResponse({ thinking: '已核对条件，结果一致。', complete: 2, treeComplete: true });
  streams[0].options.onMessage(first); streams[0].options.onMessage(final); streams[0].resolve([first, final]);
  const result = await pending;
  assert.equal(result.thinking, '已核对条件，结果一致。');
  assert.equal(result.upstreamMetadata.modeCategory, 8);
  assert.equal(result.upstreamMetadata.messageTreeCompleted, true);
  assert.equal(result.upstreamMetadata.usageKnown, false);
  assert.equal(result.usageKnown, false);
  assert.equal(result.usage, null, 'unknown native token usage is not a zero-token measurement');
  assert.equal(result.finishReason, 'stop');
});

test('Robin streams cumulative thought snapshots before completion and does not replay them', async t => {
  const { provider, streams } = harness(t);
  const deltas = [];
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'thought-stream', onThinkingDelta: d => deltas.push(d) });
  await tick();
  const first = nativeResponse({ text: '', thinking: '检查', complete: 1 });
  streams[0].options.onMessage(first); await tick();
  assert.deepEqual(deltas, ['检查']);
  const final = nativeResponse({ thinking: '检查完成', complete: 2, treeComplete: true });
  streams[0].options.onMessage(final); streams[0].options.onMessage(final); streams[0].resolve([first, final]);
  const result = await pending;
  assert.equal(deltas.join(''), '检查完成'); assert.equal(result.thinking, '检查完成');
});

test('Robin preserves authoritative native failure details instead of only reporting an empty answer', async t => {
  const { provider, streams } = harness(t);
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'native-punt' });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'robin_empty_response');
    assert.equal(error.message, '暂时不可用\n请稍后重试。');
    assert.equal(JSON.parse(error.details).puntCategory, 'native-category');
    return true;
  });
  await tick();
  const failure = bytesField(1003, messageField(1, messageField(17, Buffer.concat([
    stringField(1, '暂时不可用'), stringField(2, '请稍后重试。'), stringField(7, 'native-category')
  ]))));
  streams[0].resolve([failure]); await rejected;
});

function confirmationResponse({ name = 'write_note', args = { text: 'note' }, status = 2, details,
  header = `Run ${name}?`, body = `Allow Gemini to run ${name} on your machine?`, allow = 'Allow', cancel = 'Cancel', nativeType } = {}) {
  const { intField } = require('../src/robin-proto');
  const card = Buffer.concat([
    stringField(2, header), stringField(3, body),
    ...(allow ? [messageField(7, messageField(2, stringField(4, allow)))] : []),
    ...(cancel ? [messageField(9, messageField(2, stringField(4, cancel)))] : []),
    ...(details || [{ name: 'terminal', json: JSON.stringify(args) }]).map(detail => messageField(12,
      Buffer.concat([stringField(1, detail.name), stringField(3, detail.json)])))
  ]);
  const rich = messageField(1, messageField(24, messageField(1, Buffer.concat([
    messageField(154, card), ...(nativeType === undefined ? [] : [messageField(166, intField(1, nativeType))])
  ]))));
  return bytesField(1003, messageField(1, Buffer.concat([
    messageField(1, Buffer.concat([stringField(1, 'rc_confirmation1234'),
      messageField(2, stringField(1, 'http://googleusercontent.com/action_card_content/test')),
      messageField(5, rich), intField(19, 2)])),
    messageField(2, Buffer.concat([stringField(1, 'c_conversation1234'), stringField(2, 'r_request1234')])),
    messageField(6, messageField(13, messageField(5, intField(1, status)))), intField(9, 1)
  ])));
}

test('unknown and non-MCP confirmation cards fail without choosing or approving a client tool', async t => {
  for (const options of [{}, { name: 'undeclared' }, { args: [] }, { header: '执行工具？' },
    { details: [{ name: 'terminal', json: 'not JSON' }] }, ...[0, 1, 2, 3, 5, 6, 7].map(nativeType => ({ nativeType }))]) {
    const { provider, streams, authCalls } = harness(t);
    const deltas = [];
    const pending = provider.send({ ...normalized, tools: [{ name: 'write_note' }, { name: 'terminal' }] }, ARGON_MODEL,
      { sessionId: 'native-confirmation', onDelta: d => deltas.push(d) });
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, 'robin_confirmation_required'); assert.equal(error.status, 409);
      assert.equal(JSON.parse(error.details).goalStatus, 2); return true;
    });
    await tick();
    const card = confirmationResponse(options); streams[0].options.onMessage(card); streams[0].resolve([card]);
    await rejected;
    assert.deepEqual(deltas, [], 'the action-card URL must not be delivered as a finished answer');
    assert.equal(streams.length, 1, 'no confirmation request or tool execution is started');
    assert.equal(streams[0].closed, true); assert.equal(provider.turns.size, 0); assert.equal(authCalls(), 1);
    assert.equal(provider.conversations.get('native-confirmation'), null);
  }
});

const nativeRouting = (conversation = 'c_conversation1234') => bytesField(1014, messageField(1, stringField(1, conversation)));
const nativeTool = (name, args, id) => messageField(2, messageField(1, Buffer.concat([
  stringField(1, name), stringField(2, id), messageField(3, protoStruct(args))
])));
const nativeGenerateFields = stream => {
  const initial = decodeFields(stream.writes[0]).find(f => f.number === 1000);
  const generated = decodeFields(initial.value).find(f => f.number === 1001);
  return decodeFields(decodeFields(generated.value).find(f => f.number === 1).value);
};

test('typed MCP confirmation obtains real calls without caption routing and replies on each source channel', async t => {
  const { provider, streams } = harness(t);
  const input = { ...normalized, system: 'Do not replay this system text.', tools: [{ name: 'write_note' }, { name: 'read_note' }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'mcp-confirmation' });
  let delivered = false; first.then(() => { delivered = true; });
  await tick(); streams[0].options.onMessage(nativeRouting());
  const card = confirmationResponse({ nativeType: 4, allow: '允许', header: '不同语言的标题',
    body: '界面文字不是工具路由信息', details: [{ name: 'terminal', json: 'not tool arguments' }] });
  streams[0].options.onMessage(card); streams[0].resolve([card]); await tick(); await tick();
  assert.equal(streams.length, 3); assert.equal(delivered, false, 'no tool may be invented from the card');
  assert.notEqual(streams[1].closed, true);
  const fields = nativeGenerateFields(streams[2]);
  assert.equal(fields.find(f => f.number === 45).value, 1n);
  assert.equal(decodeFields(fields.find(f => f.number === 30).value)[0].value, 5n);
  assert.equal(decodeFields(fields.find(f => f.number === 1).value)[0].value.toString(), '允许');
  assert.equal(streams[2].writes[0].includes(Buffer.from(input.system)), false);
  assert.deepEqual(decodeFields(fields.find(f => f.number === 4).value).map(f => f.value.toString()),
    ['c_conversation1234', 'r_request1234', 'rc_confirmation1234']);
  streams[2].options.onMessage(nativeRouting()); assert.equal(streams.length, 4);
  streams[0].options.onMessage(answer('late query text'));
  // The service may still deliver the call on the first connection.
  streams[1].options.onMessage(nativeTool('execute_mcp', { ServerName: 'external_client', ToolName: 'write_note', Arguments: { text: 'actual' } }, 'write-call'));
  const write = (await first).toolCalls[0]; assert.equal(write.name, 'write_note'); assert.deepEqual(write.arguments, { text: 'actual' });
  const second = provider.send({ ...input, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: write.id, content: 'saved' }] }] },
    ARGON_MODEL, { sessionId: 'mcp-confirmation' });
  await tick();
  const resultEnvelope = decodeFields(streams[1].writes.at(-1)).find(f => f.number === 2);
  const reply = decodeFields(decodeFields(resultEnvelope.value)[0].value);
  assert.equal(reply.find(f => f.number === 2).value.toString(), 'write-call');
  assert.deepEqual(decodeProtoStruct(reply.find(f => f.number === 3).value), { result: 'saved' });
  assert.equal(streams[3].writes.length, 1, 'the reply must not leak to the newer channel');
  streams[3].options.onMessage(nativeTool('read_note', {}, 'read-call'));
  const read = (await second).toolCalls[0];
  const third = provider.send({ ...input, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: read.id, content: 'actual' }] }] },
    ARGON_MODEL, { sessionId: 'mcp-confirmation' });
  await tick(); assert.equal(streams[3].writes.length, 2);
  const final = nativeResponse({ text: 'actual', complete: 2, treeComplete: true });
  streams[2].options.onMessage(final); streams[2].resolve([final]);
  const result = await third; assert.equal(result.text, 'actual'); assert.deepEqual(result.toolCalls, []);
  assert.ok(result.upstreamMetadata.models.some(m => m.confirmations?.[0]?.confirmationType === 4));
});

test('MCP confirmation respects tool_choice none and requires a declared client tool', async t => {
  for (const input of [{ ...normalized, tools: [] }, { ...normalized, tools: [{ name: 'write_note' }], toolChoice: 'none' },
    { ...normalized, tools: [{ name: 'write_note' }], toolChoice: { type: 'none' } }]) {
    const { provider, streams } = harness(t);
    const pending = provider.send(input, ARGON_MODEL, { sessionId: 'not-allowed' });
    const rejected = assert.rejects(pending, { code: 'robin_confirmation_required' });
    await tick(); streams[0].resolve([confirmationResponse({ nativeType: 4 })]); await rejected;
    assert.equal(streams.length, 1);
  }
});

test('cancelling a resumed MCP task closes every connection and never cancels another client', async t => {
  const { provider, streams } = harness(t);
  const input = { ...normalized, tools: [{ name: 'write_note' }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'cancel-confirmation' });
  const rejected = assert.rejects(first, { code: 'robin_turn_expired' });
  await tick(); streams[0].options.onMessage(nativeRouting()); streams[0].resolve([confirmationResponse({ nativeType: 4 })]);
  await tick(); await tick(); streams[2].options.onMessage(nativeRouting());
  const other = provider.send(normalized, ARGON_MODEL, { sessionId: 'unrelated' }); await tick();
  assert.equal(provider.cancelTask('cancel-confirmation'), true); await rejected;
  assert.ok([1, 2, 3].every(i => streams[i].closed));
  assert.equal(streams[0].options.signal.aborted, true, 'the completed first query shares only its own task cancellation');
  assert.notEqual(streams[4].closed, true);
  streams[4].resolve([answer('unrelated completed')]); assert.equal((await other).text, 'unrelated completed');
});

test('resumed MCP task cannot accept a different native conversation or repeat one confirmation', async t => {
  for (const mismatch of [true, false]) {
    const { provider, streams } = harness(t);
    const pending = provider.send({ ...normalized, tools: [{ name: 'write_note' }] }, ARGON_MODEL, { sessionId: 'control-conflict' });
    const rejected = assert.rejects(pending, { code: mismatch ? 'robin_session_mismatch' : 'robin_confirmation_loop' });
    await tick(); streams[0].options.onMessage(nativeRouting());
    const card = confirmationResponse({ nativeType: 4 }); streams[0].resolve([card]); await tick(); await tick();
    if (mismatch) streams[2].options.onMessage(nativeRouting('c_otherconversation1234'));
    else streams[2].resolve([card]);
    await rejected; assert.equal(provider.turns.size, 0);
  }
});

test('client tool rejection after native MCP acknowledgement stays on the original source and is not executed again', async t => {
  const { provider, streams } = harness(t);
  const input = { ...normalized, tools: [{ name: 'write_note' }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'reject-real-call' });
  await tick(); streams[0].options.onMessage(nativeRouting()); streams[0].resolve([confirmationResponse({ nativeType: 4 })]);
  await tick(); await tick(); streams[2].options.onMessage(nativeRouting());
  streams[1].options.onMessage(nativeTool('write_note', {}, 'client-reject'));
  const call = (await first).toolCalls[0];
  const second = provider.send({ ...input, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: call.id, isError: true, content: 'user declined' }] }] },
    ARGON_MODEL, { sessionId: 'reject-real-call' });
  await tick(); const failure = decodeFields(streams[1].writes.at(-1)).find(f => f.number === 3);
  assert.equal(decodeFields(failure.value).find(f => f.number === 3).value.toString(), 'user declined');
  assert.equal(streams[3].writes.length, 1);
  streams[2].resolve([answer('cancelled by client')]); assert.equal((await second).text, 'cancelled by client');
});

test('an old channel authentication failure remains attributed to its old credential after confirmation refresh', async t => {
  const { provider, streams } = harness(t);
  provider.auth.account = { accessToken: 'old', refreshToken: 'same' };
  provider.auth.get = async () => ({ accessToken: provider.auth.account.accessToken, serverToken: 'test',
    credentialFingerprint: robinCredentialFingerprint(provider.auth.account) });
  const old = robinCredentialFingerprint(provider.auth.account);
  const pending = provider.send({ ...normalized, tools: [{ name: 'write_note' }] }, ARGON_MODEL, { sessionId: 'old-channel-auth' });
  const rejected = assert.rejects(pending, error => error.status === 401 && error.upstreamAuthFingerprint === old);
  await tick(); streams[0].options.onMessage(nativeRouting());
  provider.auth.account = { ...provider.auth.account, accessToken: 'fresh' };
  streams[0].resolve([confirmationResponse({ nativeType: 4 })]); await tick(); await tick();
  assert.notEqual(provider.turns.get('old-channel-auth').authFingerprint, old);
  streams[1].reject(Object.assign(new Error('old stream unauthorized'), { status: 401 })); await rejected;
});

test('MCP confirmation waits for already dispatched client results without replaying their calls', async t => {
  const { provider, streams } = harness(t);
  const input = { ...normalized, tools: [{ name: 'write_note' }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'deferred-control' });
  await tick(); streams[0].options.onMessage(nativeRouting());
  streams[1].options.onMessage(nativeTool('write_note', { text: 'first' }, 'already-sent'));
  const call = (await first).toolCalls[0];
  streams[0].resolve([confirmationResponse({ nativeType: 4 })]); await tick();
  assert.equal(streams.length, 2, 'no new permission query while a client call is still pending');
  const second = provider.send({ ...input, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: call.id, content: 'saved' }] }] },
    ARGON_MODEL, { sessionId: 'deferred-control' });
  await tick(); await tick(); assert.equal(streams.length, 3);
  assert.equal(streams[1].writes.length, 2, 'the already executed result returns to its original channel');
  streams[2].resolve([answer('completed after result')]); assert.equal((await second).text, 'completed after result');
});

test('a ended source channel cannot receive an executed client result on a different channel', async t => {
  const { provider, streams } = harness(t);
  const input = { ...normalized, tools: [{ name: 'write_note' }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'closed-source' });
  await tick(); streams[0].options.onMessage(nativeRouting());
  streams[1].options.onMessage(nativeTool('write_note', {}, 'source-ended'));
  const call = (await first).toolCalls[0];
  streams[1].resolve([]); await tick();
  await assert.rejects(provider.send({ ...input, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: call.id, content: 'already executed' }] }] },
    ARGON_MODEL, { sessionId: 'closed-source' }), { code: 'robin_tool_channel_closed' });
  assert.equal(streams[1].writes.length, 1); assert.equal(provider.turns.size, 0);
});

test('native conversation checks reject foreign connection acknowledgements, calls and answer frames', async t => {
  const { intField } = require('../src/robin-proto');
  for (const kind of ['ack', 'call', 'answer', 'eof-answer']) {
    const { provider, streams } = harness(t);
    const pending = provider.send({ ...normalized, tools: [{ name: 'write_note' }] }, ARGON_MODEL, { sessionId: 'foreign-' + kind });
    const rejected = assert.rejects(pending, { code: 'robin_session_mismatch', status: 409 });
    await tick(); streams[0].options.onMessage(nativeRouting());
    if (kind === 'ack') streams[1].options.onMessage(messageField(1, Buffer.concat([
      intField(1, 1), stringField(2, 'c_foreignconversation1234')
    ])));
    else if (kind === 'call') streams[1].options.onMessage(Buffer.concat([
      nativeTool('write_note', {}, 'foreign-call'), stringField(5, 'c_foreignconversation1234')
    ]));
    else {
      const foreign = bytesField(1003, messageField(1, Buffer.concat([
        messageField(1, Buffer.concat([stringField(1, 'rc_foreign'), messageField(2, stringField(1, 'another client secret'))])),
        messageField(2, Buffer.concat([stringField(1, 'c_foreignconversation1234'), stringField(2, 'r_foreignrequest1234')]))
      ])));
      if (kind === 'eof-answer') streams[0].resolve([foreign]);
      else streams[0].options.onMessage(foreign);
    }
    await rejected; assert.equal(provider.turns.size, 0); assert.equal(streams[1].writes.length, 1);
  }
});

test('native RUNNING EOF without verified ownership identifiers fails instead of guessing a task to resume', async t => {
  const { intField } = require('../src/robin-proto');
  const { provider, streams } = harness(t);
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'running-eof' });
  const rejected = assert.rejects(pending, error => error.code === 'robin_incomplete_response'
    && JSON.parse(error.details).goalStatus === 4);
  await tick();
  streams[0].resolve([bytesField(1003, messageField(1, messageField(6, messageField(13, messageField(5, intField(1, 4))))))]);
  await rejected;
});

test('ordinary model text mentioning approvals is not interpreted as a native confirmation', async t => {
  const { provider, streams } = harness(t);
  const text = 'Run tool? Allow this operation? http://googleusercontent.com/action_card_content/example';
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'ordinary-approval-text' });
  await tick(); streams[0].resolve([answer(text)]);
  assert.equal((await pending).text, text); assert.equal(streams.length, 1);
});

test('Robin uses only its own successful native cursor on the next ordinary turn', async t => {
  const { provider, streams } = harness(t);
  const { intField } = require('../src/robin-proto');
  const complete = bytesField(1003, messageField(1, Buffer.concat([
    messageField(1, Buffer.concat([stringField(1, 'rc_response123456'), messageField(2, stringField(1, 'done')), intField(19, 2)])),
    messageField(2, Buffer.concat([stringField(1, 'c_conversation123456'), stringField(2, 'r_request123456')])), intField(9, 1)
  ])));
  const initialIdentifiers = stream => {
    const envelope = decodeFields(stream.writes[0]).find(f => f.number === 1000);
    const generated = decodeFields(envelope.value).find(f => f.number === 1001);
    const request = decodeFields(generated.value).find(f => f.number === 1);
    return decodeFields(decodeFields(request.value).find(f => f.number === 4).value).map(f => f.value.toString());
  };
  const first = provider.send(normalized, ARGON_MODEL, { sessionId: 'client-one' });
  await tick(); assert.deepEqual(initialIdentifiers(streams[0]), ['', '', '']);
  streams[0].resolve([complete]); await first;
  const second = provider.send(normalized, ARGON_MODEL, { sessionId: 'client-one' });
  await tick();
  assert.deepEqual(initialIdentifiers(streams[1]), ['c_conversation123456', 'r_request123456', 'rc_response123456']);
  streams[1].resolve([complete]); await second;
  const other = provider.send(normalized, ARGON_MODEL, { sessionId: 'client-two' });
  await tick(); assert.deepEqual(initialIdentifiers(streams[2]), ['', '', '']);
  streams[2].resolve([complete]); await other;
  const uncertain = provider.send(normalized, ARGON_MODEL, { sessionId: 'client-one', reuseConversation: false });
  await tick(); assert.deepEqual(initialIdentifiers(streams[3]), ['', '', '']);
  streams[3].resolve([complete]); await uncertain;
});

test('Robin receives shared protocol repair instructions without mutating the client request', async t => {
  const { provider, streams } = harness(t);
  const input = { ...normalized, system: 'Original instruction.' };
  const pending = provider.send(input, ARGON_MODEL, { sessionId: 'repair', repairInstruction: 'Return valid JSON only.' });
  await tick();
  assert.ok(streams[0].writes[0].includes(Buffer.from('Return valid JSON only.')));
  assert.equal(input.system, 'Original instruction.');
  streams[0].resolve([answer('{"ok":true}')]); await pending;
});

test('Robin surfaces a rewritten streamed snapshot instead of silently corrupting output', async (t) => {
  const { provider, streams } = harness(t);
  const pending = provider.send(normalized, ARGON_MODEL, { sessionId: 'revised-stream', onDelta() {} });
  const rejected = assert.rejects(pending, { code: 'robin_text_snapshot_conflict' });
  await tick();
  streams[0].options.onMessage(answer('第一版'));
  await tick();
  streams[0].options.onMessage(answer('第二版'));
  await rejected;
  assert.equal(streams[0].closed, true);
  assert.equal(provider.turns.size, 0);
});

test('Robin rejects concurrent requests for one session before duplicate upstream starts', async (t) => {
  const { provider, streams } = harness(t);
  const first = provider.send(normalized, ARGON_MODEL, { sessionId: 'same' });
  await assert.rejects(provider.send(normalized, ARGON_MODEL, { sessionId: 'same' }), { code: 'robin_session_busy' });
  await tick();
  assert.equal(streams.length, 1);
  streams[0].resolve([answer('完成')]);
  await first;
});

test('Robin refuses a lost tool continuation without authentication or upstream replay', async (t) => {
  const { provider, streams, authCalls } = harness(t);
  const continuation = { ...normalized, messages: [{ role: 'user', parts: [
    { type: 'tool_result', id: 'call_1', content: '已保存文件' }
  ] }] };
  await assert.rejects(provider.send(continuation, ARGON_MODEL, { sessionId: 'expired' }), { code: 'robin_task_not_found' });
  await assert.rejects(provider.send(normalized, ARGON_MODEL, { sessionId: 'expired', requireExistingTurn: true }), { code: 'robin_task_not_found' });
  assert.equal(streams.length, 0);
  assert.equal(authCalls(), 0);
});

test('Robin does not advertise Argon when upstream status has no model capability', async (t) => {
  const { provider } = harness(t);
  assert.deepEqual(await provider.listModels(), []);
});

test('Robin does not repeat text snapshots across a client tool round trip', async (t) => {
  const { provider, streams } = harness(t);
  const input = { ...normalized, tools: [{ name: 'write_note', schema: { type: 'object' } }] };
  const deltas = [];
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'text-tools', onDelta: (s) => deltas.push(s) });
  await tick();
  streams[0].options.onMessage(answer('正在保存。'));
  streams[0].options.onMessage(bytesField(1014, messageField(1, Buffer.concat([
    stringField(1, 'c_conversation1234'), bytesField(2, Buffer.from('routing'))
  ]))));
  streams[1].options.onMessage(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'write_note'), stringField(2, 'call_1234'), messageField(3, protoStruct({ text: '笔记' }))
  ]))));
  assert.equal((await first).text, '正在保存。');
  const second = provider.send({ ...input, messages: [{ role: 'user', parts: [
    { type: 'tool_result', id: 'call_1234', content: '已保存' }
  ] }] }, ARGON_MODEL, { sessionId: 'text-tools', onDelta: (s) => deltas.push(s) });
  await tick();
  streams[0].options.onMessage(answer('正在保存。\n已完成。'));
  streams[0].resolve([answer('正在保存。\n已完成。')]);
  assert.equal((await second).text, '\n已完成。');
  assert.equal(deltas.join(''), '正在保存。\n已完成。');
});

test('Robin health attribution follows the actual stream credential across access-token refresh', async t => {
  const { provider, streams } = harness(t);
  provider.auth.account = { accessToken: 'old-token', refreshToken: 'same-grant' };
  provider.auth.get = async () => ({ accessToken: provider.auth.account.accessToken, serverToken: 'test',
    credentialFingerprint: robinCredentialFingerprint(provider.auth.account) });
  const oldFingerprint = robinCredentialFingerprint(provider.auth.account);
  const input = { ...normalized, tools: [{ name: 'write_note', schema: { type: 'object' } }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'token-rotation' });
  await tick();
  assert.equal(streams[0].writes[0].includes(Buffer.from(oldFingerprint)), false,
    'a local health fingerprint must never enter the native prompt/request');
  streams[0].options.onMessage(bytesField(1014, messageField(1, Buffer.concat([
    stringField(1, 'c_conversation1234'), bytesField(2, Buffer.from('routing'))
  ]))));
  streams[1].options.onMessage(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'write_note'), stringField(2, 'call_1234'), messageField(3, protoStruct({ text: '笔记' }))
  ]))));
  assert.equal((await first).upstreamAuthFingerprint, oldFingerprint);
  provider.auth.account = { ...provider.auth.account, accessToken: 'new-token' };
  const second = provider.send({ ...input, messages: [{ role: 'user', parts: [
    { type: 'tool_result', id: 'call_1234', content: '已保存' }
  ] }] }, ARGON_MODEL, { sessionId: 'token-rotation' });
  await tick(); streams[0].resolve([answer('done')]);
  assert.equal((await second).upstreamAuthFingerprint, oldFingerprint,
    'the already established stream still used the old credential');
  const fresh = provider.send(normalized, ARGON_MODEL, { sessionId: 'next-task' });
  await tick(); streams[2].resolve([answer('done')]);
  assert.equal((await fresh).upstreamAuthFingerprint, robinCredentialFingerprint(provider.auth.account));
});

test('Robin keeps both streams across HTTP tool turns and cancels them on the current request', async (t) => {
  const { provider, streams, authCalls } = harness(t);
  const firstSignal = new AbortController();
  const input = { ...normalized, tools: [{ name: 'write_note', schema: { type: 'object' } }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'same', signal: firstSignal.signal });
  await tick();
  streams[0].options.onMessage(bytesField(1014, messageField(1, Buffer.concat([
    stringField(1, 'c_conversation1234'), bytesField(2, Buffer.from('routing'))
  ]))));
  streams[1].options.onMessage(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'write_note'), stringField(2, 'call_1234'), messageField(3, protoStruct({ text: '笔记' }))
  ]))));
  assert.equal((await first).toolCalls[0].id, 'call_1234');
  firstSignal.abort();
  assert.equal(streams[0].options.signal.aborted, false);
  const secondSignal = new AbortController();
  const second = provider.send({ ...input, messages: [{ role: 'user', parts: [
    { type: 'tool_result', id: 'call_1234', content: '已保存' }
  ] }] }, ARGON_MODEL, { sessionId: 'same', signal: secondSignal.signal });
  await tick();
  assert.equal(authCalls(), 1, 'continuing an open task must not depend on refreshing credentials');
  const cancelled = assert.rejects(second, { name: 'AbortError' });
  secondSignal.abort();
  await cancelled;
  assert.equal(streams[0].options.signal.aborted, true);
  assert.equal(streams[1].options.signal.aborted, true);
  assert.equal(streams[0].closed, true);
  assert.equal(streams[1].closed, true);
});

test('rejecting one client tool contract closes only that task and preserves completed cursors', async t => {
  const { provider, streams } = harness(t);
  const cursor = { conversationId: 'c_completed123456', parentRequestId: 'r_request123456', parentResponseId: 'rc_response123456' };
  provider.conversations.set('rejected', cursor);
  const input = { ...normalized, tools: [{ name: 'write_note', schema: { type: 'object' } }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'rejected' });
  await tick();
  streams[0].options.onMessage(bytesField(1014, messageField(1, Buffer.concat([
    stringField(1, 'c_conversation1234'), bytesField(2, Buffer.from('routing'))
  ]))));
  streams[1].options.onMessage(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'write_note'), stringField(2, 'call_1234'), messageField(3, protoStruct({ text: '笔记' }))
  ]))));
  await first;
  const other = provider.send(normalized, ARGON_MODEL, { sessionId: 'other' });
  await tick();
  assert.equal(provider.cancelTask('rejected'), true);
  assert.equal(provider.cancelTask('missing'), false);
  assert.equal(streams[0].closed, true); assert.equal(streams[1].closed, true);
  assert.notEqual(streams[2].closed, true);
  assert.deepEqual(provider.conversations.get('rejected'), cursor);
  streams[2].resolve([answer('另一会话正常完成')]);
  assert.equal((await other).text, '另一会话正常完成');
  const retry = provider.send(normalized, ARGON_MODEL, { sessionId: 'rejected' });
  await tick();
  streams[3].resolve([answer('新任务完成')]);
  assert.equal((await retry).text, '新任务完成');
});

function poolHarness(t, send) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-lifecycle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  for (const id of ['a', 'b']) store.save({ id, accessToken: id, providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  let now = Date.now();
  const pool = new RobinAccountPool({ store, now: () => now, providerFactory: (account) => ({ send: (...args) => send(account.id, ...args) }) });
  t.after(() => pool.stop());
  return { pool, store, advance: (ms) => { now += ms; } };
}

test('Robin quarantines terms-pending accounts, fails over, and persists the account state', async (t) => {
  const attempts = [];
  const { pool, store } = poolHarness(t, async (id) => {
    attempts.push(id);
    if (id === 'a') {
      throw Object.assign(new Error('Before proceeding, please accept our terms of service.'), { status: 412 });
    }
    return { text: '完成', toolCalls: [], usageKnown: false };
  });

  const result = await pool.send(normalized, ARGON_MODEL, { sessionId: 'terms-failover' });
  assert.equal(result.accountId, 'b');
  assert.deepEqual(attempts, ['a', 'b']);
  assert.equal(pool.status().find((account) => account.id === 'a').state, 'terms_acceptance_required');

  const restored = new RobinAccountPool({ store, providerFactory: pool.providerFactory, now: pool.now });
  t.after(() => restored.stop());
  assert.deepEqual(restored.eligible(ARGON_MODEL).map((entry) => entry.account.id), ['b']);
  assert.equal(restored.status().find((account) => account.id === 'a').state, 'terms_acceptance_required');
});

test('Robin sends only pending tool-result attachments over the existing remote tool stream', async (t) => {
  const { provider, streams } = harness(t);
  const uploads = [];
  provider.uploadMedia = async (part) => {
    uploads.push(part);
    return { blobId: '/contrib_service/ttl_1d/scene', cacheKey: 'scene-key' };
  };
  const input = { ...normalized, tools: [{ name: 'get_scene', schema: { type: 'object' } }] };
  const first = provider.send(input, ARGON_MODEL, { sessionId: 'media-tools' });
  await tick();
  streams[0].options.onMessage(bytesField(1014, messageField(1, Buffer.concat([
    stringField(1, 'c_conversation1234'), bytesField(2, Buffer.from('routing'))
  ]))));
  streams[1].options.onMessage(messageField(2, messageField(1, Buffer.concat([
    stringField(1, 'execute_mcp'), stringField(2, 'remote-call'),
    messageField(3, protoStruct({ server_name: 'external_client', tool_name: 'get_scene', arguments: {} }))
  ]))));
  const call = (await first).toolCalls[0];
  const image = { type: 'media', filename: 'scene.png', mediaType: 'image/png', data: 'aW1hZ2U=' };
  const second = provider.send({ ...input, messages: [{ role: 'user', parts: [
    { type: 'tool_result', id: 'old-call', content: 'historical', media: [{ ...image, filename: 'old.png' }] },
    { type: 'tool_result', id: call.id, content: 'Here is the image.', media: [image] }
  ] }] }, ARGON_MODEL, { sessionId: 'media-tools' });
  await tick();
  assert.deepEqual(uploads, [image], 'historical or unrelated tool images must not be uploaded/replayed');
  assert.equal(streams.length, 2, 'media must continue the original task, not start a new query');
  const wrapper = decodeFields(streams[1].writes.at(-1)).find(f => f.number === 2);
  const result = decodeFields(decodeFields(wrapper.value)[0].value);
  assert.equal(result.find(f => f.number === 1).value.toString(), 'execute_mcp');
  assert.equal(result.find(f => f.number === 2).value.toString(), 'remote-call');
  assert.deepEqual(decodeProtoStruct(result.find(f => f.number === 3).value), { result: 'Here is the image.' });
  const attachment = decodeFields(result.find(f => f.number === 4).value);
  assert.equal(attachment.find(f => f.number === 2).value.toString(), 'scene.png');
  const blob = decodeFields(attachment.find(f => f.number === 1).value);
  assert.equal(blob.find(f => f.number === 5).value.toString(), 'scene-key');
  streams[0].resolve([answer('已看到图片。')]);
  assert.equal((await second).text, '已看到图片。');
});

test('Robin account health survives restart and clears only with new credentials or a successful check', async (t) => {
  let succeeds = false;
  const { pool, store } = poolHarness(t, async () => {
    if (!succeeds) throw Object.assign(new Error('Verify your account to continue'), { status: 403 });
    return { text: '完成', toolCalls: [], usage: {} };
  });
  await assert.rejects(pool.send(normalized, ARGON_MODEL, { sessionId: 'first' }));
  assert.ok(pool.status().every((account) => account.state === 'verification_required'));
  const restored = new RobinAccountPool({ store, providerFactory: pool.providerFactory, now: pool.now });
  t.after(() => restored.stop());
  assert.equal(restored.eligible(ARGON_MODEL).length, 0);
  store.update('a', { accessToken: 'new-authorization' });
  assert.deepEqual(restored.eligible(ARGON_MODEL).map((entry) => entry.account.id), ['a']);
  succeeds = true;
  assert.equal((await restored.send(normalized, ARGON_MODEL, { sessionId: 'new' })).accountId, 'a');
  assert.equal(restored.status().find((account) => account.id === 'a').healthMessage, '');
  assert.equal(restored.status().find((account) => account.id === 'b').state, 'verification_required');
});

test('an obsolete authorization cannot deliver pending tools or quarantine the new Robin grant', async t => {
  for (const failure of [false, true]) {
    let resolve, reject, requests = 0, stopped = 0, disabled = 0;
    const { pool, store } = poolHarness(t, async () => {
      requests++;
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    });
    pool.bind('affinity', 'a');
    const old = pool.entries.get('a');
    old.provider.stop = () => { stopped++; };
    old.provider.auth = { disable: () => { disabled++; } };
    const cancelled = [];
    old.provider.cancelTask = key => cancelled.push(key);
    const request = pool.send(normalized, ARGON_MODEL, { clientId: 'client', sessionId: 'task', routingKey: 'affinity' });
    const rejection = assert.rejects(request, failure ? { status: 403 } : { code: 'robin_credentials_changed', status: 409 });
    store.update('a', { refreshToken: 'new-grant' });
    pool.reload();
    if (failure) reject(Object.assign(new Error('Verify your account'), { status: 403 }));
    else resolve({ text: '', toolCalls: [{ id: 'call_1', name: 'write_note', arguments: {} }], usage: {} });
    await rejection;
    assert.equal(stopped, 1); assert.equal(disabled, 1);
    assert.equal(requests, 1, 'an obsolete task is never replayed on another account');
    assert.equal(pool.activeTasks.size, 0);
    assert.equal(cancelled.length, failure ? 0 : 1);
    assert.equal(pool.status().find(a => a.id === 'a').state, 'available');
    assert.equal(store.list().find(a => a.id === 'a').providerMetadata.robinHealth, undefined);
  }
});

test('normal access-token refresh preserves Robin task ownership and account affinity', async t => {
  let store, pool;
  ({ store, pool } = poolHarness(t, async id => {
    store.update(id, { accessToken: 'rotated-access-token' });
    pool.reload();
    return { text: 'done', toolCalls: [], usage: {} };
  }));
  pool.bind('affinity', 'a');
  const original = pool.entries.get('a');
  const result = await pool.send(normalized, ARGON_MODEL, { sessionId: 'task', routingKey: 'affinity' });
  assert.equal(result.text, 'done'); assert.equal(result.accountId, 'a');
  assert.equal(pool.entries.get('a'), original);
  assert.equal(pool.sessions.get('affinity').accountId, 'a');
  assert.equal(store.list().find(a => a.id === 'a').accessToken, 'rotated-access-token');
});

test('a late old-token authentication failure cannot quarantine the current Robin token', async t => {
  let reject, requests = [];
  const { pool, store } = poolHarness(t, async id => {
    requests.push(id);
    if (id === 'b') return { text: 'fallback', toolCalls: [], usage: {} };
    return new Promise((_resolve, no) => { reject = no; });
  });
  pool.bind('affinity', 'a');
  const oldFingerprint = robinCredentialFingerprint(store.list().find(a => a.id === 'a'));
  const pending = pool.send(normalized, ARGON_MODEL, { sessionId: 'request', routingKey: 'affinity' });
  store.update('a', { accessToken: 'new-token' }); pool.reload();
  reject(Object.assign(new Error('expired old token'), { status: 401, upstreamAuthFingerprint: oldFingerprint }));
  const result = await pending;
  assert.equal(result.accountId, 'b');
  assert.deepEqual(requests, ['a', 'b']);
  assert.equal(pool.status().find(a => a.id === 'a').state, 'available');
  assert.equal(store.list().find(a => a.id === 'a').providerMetadata.robinHealth, undefined);
});

test('a late old-token success cannot clear an authoritative failure for the current Robin token', async t => {
  let resolve;
  const { pool, store } = poolHarness(t, async () => new Promise(yes => { resolve = yes; }));
  pool.bind('affinity', 'a');
  const oldFingerprint = robinCredentialFingerprint(store.list().find(a => a.id === 'a'));
  const pending = pool.send(normalized, ARGON_MODEL, { sessionId: 'request', routingKey: 'affinity' });
  store.update('a', { accessToken: 'new-token' }); pool.reload();
  pool.saveHealth(pool.entries.get('a'), 'account', 'authentication_error', 'current-token failure', Infinity);
  resolve({ text: 'completed old task', toolCalls: [], usage: {}, upstreamAuthFingerprint: oldFingerprint });
  assert.equal((await pending).text, 'completed old task');
  assert.equal(pool.status().find(a => a.id === 'a').state, 'authentication_error');
  assert.equal(store.list().find(a => a.id === 'a').providerMetadata.robinHealth.message, 'current-token failure');
});

test('internal credential attribution is not exposed by any client response protocol', () => {
  const { anthropicResponse, chatResponse, responsesResponse } = require('../src/protocol');
  const fingerprint = robinCredentialFingerprint({ accessToken: 'private-token' });
  const raw = { text: 'done', toolCalls: [], usage: {}, upstreamAuthFingerprint: fingerprint };
  for (const response of [anthropicResponse('model', raw), chatResponse('model', raw), responsesResponse('model', raw, 'resp_1')]) {
    assert.equal(JSON.stringify(response).includes(fingerprint), false);
    assert.equal(JSON.stringify(response).includes('upstreamAuthFingerprint'), false);
  }
});

test('imported Robin credentials without a stored creation timestamp do not look like a replaced grant', async t => {
  const { pool, store } = poolHarness(t, async () => ({ text: 'done', toolCalls: [], usage: {} }));
  for (const filename of fs.readdirSync(store.directory)) {
    const file = path.join(store.directory, filename);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.createdAt;
    fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  }
  const entry = pool.entries.get('a');
  pool.reload();
  assert.equal(pool.entries.get('a'), entry);
  pool.bind('affinity', 'a');
  const result = await pool.send(normalized, ARGON_MODEL, { sessionId: 'imported', routingKey: 'affinity' });
  assert.equal(result.text, 'done');
});

test('late catalog and recheck replies cannot update a newly authorized Robin account', async t => {
  for (const operation of ['catalog', 'recheck']) {
    let resolve, queries = 0;
    const { pool, store } = poolHarness(t, async () => ({ text: 'done', toolCalls: [] }));
    const entry = pool.entries.get('a');
    entry.provider.auth = { get: async () => ({}) };
    entry.provider.listModels = async () => new Promise(done => { queries++; resolve = done; });
    // Keep the fixture's other account out of this catalog refresh.
    store.update('b', { enabled: false });
    const result = operation === 'catalog' ? pool.listModels(undefined, { force: true }) : pool.recheckAccount('a');
    const rejected = operation === 'recheck' ? assert.rejects(result, { code: 'robin_credentials_changed' }) : null;
    await tick(); assert.equal(queries, 1);
    store.update('a', { refreshToken: 'new-grant', capabilities: [] });
    // Do not reload until the pending result returns: disk checks must suffice.
    resolve([ARGON_MODEL]);
    if (rejected) await rejected;
    else assert.deepEqual(await result, []);
    const saved = store.list().find(a => a.id === 'a');
    assert.deepEqual(saved.capabilities, []);
    assert.equal(saved.providerMetadata.robinHealth, undefined);
  }
});

test('Robin quota cooldown remains independent, survives reload and expires', async (t) => {
  const { pool, advance } = poolHarness(t, async () => { throw Object.assign(new Error('quota exhausted'), { status: 429 }); });
  await assert.rejects(pool.send(normalized, ARGON_MODEL, { sessionId: 'quota' }));
  assert.ok(pool.status().every((account) => account.state === 'quota_exhausted'));
  assert.equal(pool.eligible(ARGON_MODEL).length, 0);
  advance(5 * 60_000 + 1);
  assert.equal(pool.eligible(ARGON_MODEL).length, 2);
  assert.ok(pool.status().every((account) => account.state === 'available'));
});

test('Robin affinity is a fixed window, while an open client tool task survives its expiry', async (t) => {
  const calls = [];
  const { pool, advance } = poolHarness(t, async (id, _input, _model, options) => {
    calls.push({ id, session: options.sessionId });
    return { text: '', toolCalls: calls.length === 1 ? [{ id: 'call_1', name: 'write_note' }] : [], usage: {} };
  });
  const options = { clientId: 'pi', sessionId: 'chat', routingKey: 'affinity' };
  await pool.send(normalized, ARGON_MODEL, options);
  const boundAt = pool.sessions.get('affinity').at;
  advance(1000);
  pool.bind('affinity', calls[0].id);
  assert.equal(pool.sessions.get('affinity').at, boundAt);
  advance(ROBIN_SESSION_TTL_MS);
  await pool.send({ ...normalized, messages: [{ parts: [{ type: 'tool_result', id: 'call_1', content: 'saved' }] }] }, ARGON_MODEL, options);
  assert.equal(calls[1].id, calls[0].id);
  assert.equal(calls[1].session, calls[0].session);
  assert.equal(pool.activeTasks.size, 0);
});

test('Robin never retries another account after streamed text, a client tool, or cancellation', async (t) => {
  for (const kind of ['text', 'tool', 'abort']) {
    const calls = [];
    const controller = new AbortController();
    const { pool } = poolHarness(t, async (id, _input, _model, options) => {
      calls.push(id);
      if (kind === 'tool' && calls.length === 1) return { toolCalls: [{ id: 'call', name: 'write_note' }] };
      if (kind === 'text') options.onDelta('开始');
      if (kind === 'abort') { controller.abort(); throw controller.signal.reason; }
      throw Object.assign(new Error('upstream unavailable'), { status: 503 });
    });
    const options = { sessionId: kind, routingKey: kind, signal: controller.signal, onDelta() {} };
    if (kind === 'tool') await pool.send(normalized, ARGON_MODEL, options);
    await assert.rejects(pool.send(normalized, ARGON_MODEL, options));
    assert.equal(new Set(calls).size, 1);
    assert.equal(calls.length, kind === 'tool' ? 2 : 1);
    if (kind === 'abort') assert.ok(pool.status().every((entry) => entry.available));
  }
});
