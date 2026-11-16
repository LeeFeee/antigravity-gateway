'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiGeneration } = require('../src/gemini-generation');
const { messageField: m, stringField: s } = require('../src/gemini-wire');

// Transport lifecycle checks only. These do not simulate an upstream answer
// or establish real-client compatibility; the installed-package tests do that.
function fixture() {
  const calls = [];
  const transport = { async open(method) {
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const stream = { method, done, resolve, reject, writes: [], write(bytes) { this.writes.push(bytes); },
      end() {}, cancel() { resolve({}); } };
    calls.push(stream);
    return stream;
  } };
  const generation = new GeminiGeneration({ transport, prompt: 'Lifecycle fixture',
    model: { provider: 'gemini', upstreamId: 'argon', modeVariantId: 'argon', modeCategory: 8,
      thinkingLevel: 1, taskThinkingLevels: [1] },
    tools: [{ name: 'write', inputSchema: { type: 'object' } }] });
  return { generation, calls };
}

async function offerConfirmation(generation) {
  generation.started = true;
  generation.streamEpoch = 1;
  await generation.connectTools('conversation');
  generation.metadata = { complete: true, goalStatus: 2 };
  generation.identifiers = { conversationId: 'conversation', requestId: 'request' };
  generation.confirmationCard = { name: 'write', arguments: {}, responseId: 'response', allowQuery: 'Allow', cancelQuery: 'Cancel' };
  generation.complete({});
  return (await generation.next()).value.toolCalls[0];
}

test('a native confirmation waits for outstanding client results and is offered only once', async () => {
  const { generation, calls } = fixture();
  generation.started = true;
  generation.streamEpoch = 1;
  await generation.connectTools('conversation');
  generation.pending.set('read-a', { nativeName: 'execute_mcp', nativeId: 'native-a', remote: calls[0] });
  generation.pending.set('read-b', { nativeName: 'execute_mcp', nativeId: 'native-b', remote: calls[0] });
  generation.metadata = { complete: true, goalStatus: 2 };
  generation.identifiers = { conversationId: 'conversation', requestId: 'request' };
  generation.confirmationCard = { name: 'write', arguments: {}, responseId: 'response', allowQuery: 'Allow', cancelQuery: 'Cancel' };
  generation.complete({});
  assert.equal(generation.finished, false);
  assert.equal(generation.queue.length, 0);
  assert.equal(generation.waitingConfirmation, undefined);
  await generation.submitToolResults([{ id: 'read-a', result: { content: [{ type: 'text', text: 'Actual client result A' }] } }]);
  assert.equal(generation.queue.length, 0);
  await generation.submitToolResults([{ id: 'read-b', result: { content: [{ type: 'text', text: 'Actual client result B' }] } }]);
  const event = await generation.next();
  assert.equal(event.value.type, 'tool_calls');
  assert.equal(event.value.toolCalls[0].name, 'write');
  generation.complete({});
  assert.equal(generation.queue.length, 0);
  assert.equal(calls[0].writes.length, 3); // Connect plus both real client results; no approval sent.
  generation.cancel();
});

test('confirmation continuation reuses the live task channel and observes its later failure', async () => {
  const { generation, calls } = fixture();
  const call = await offerConfirmation(generation);
  const remote = calls[0];
  await generation.submitToolResults([{ id: call.id, result: { content: [{ type: 'text', text: 'Written by client' }] } }]);
  assert.equal(generation.streamEpoch, 2);
  await generation.consume(m(1014, m(1, s(1, 'conversation'))));
  assert.equal(calls.filter(call => call.method === 'ExecuteRemoteTools').length, 1);
  const error = new Error('Real channel failure marker');
  remote.reject(error);
  const event = await generation.next();
  assert.equal(event.value.type, 'error');
  assert.equal(event.value.error, error);
});

test('a channel that actually closes at the confirmation boundary can reconnect', async () => {
  const { generation, calls } = fixture();
  const call = await offerConfirmation(generation);
  calls[0].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(generation.finished, false);
  assert.equal(generation.remoteConnecting, null);
  await generation.submitToolResults([{ id: call.id, result: { content: [{ type: 'text', text: 'Written by client' }] } }]);
  await generation.consume(m(1014, m(1, s(1, 'conversation'))));
  assert.equal(calls.filter(call => call.method === 'ExecuteRemoteTools').length, 2);
  generation.cancel();
});

for (const completionFirst of [false, true]) {
  test(`native sessionComplete retires the old round ${completionFirst ? 'before' : 'after'} continuation announcement`, async () => {
    const { generation, calls } = fixture();
    const call = await offerConfirmation(generation);
    const remote = calls[0];
    await generation.submitToolResults([{ id: call.id, result: { content: [{ type: 'text', text: 'Written by client' }] } }]);
    const announce = () => generation.consume(m(1014, m(1, s(1, 'conversation'))));
    const finish = () => generation.consumeTools(m(3, Buffer.alloc(0)), remote);
    if (completionFirst) { finish(); await announce(); }
    else {
      await announce();
      assert.equal(calls.filter(call => call.method === 'ExecuteRemoteTools').length, 1);
      finish();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(generation.finished, false);
    assert.equal(calls.filter(call => call.method === 'ExecuteRemoteTools').length, 2);
    assert.notEqual(generation.remote, remote);
    generation.cancel();
  });
}
