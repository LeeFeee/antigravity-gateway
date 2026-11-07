'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgySessionStore, newState, recordResponse, restoreHistory, recordClientProjection, recordStreamProjection,
  recordStreamRecovery, restoreClientProjections } = require('../src/agy-session-state');
const { prepareNativeContext, continueInterruptedStream } = require('../src/agy-context-state');
const { streamErrorContent } = require('../src/agy-stream-recovery');

const model = 'gemini-3.8-flash-high';
const user = text => ({ role: 'user', parts: [{ text }] });
const answer = text => ({ role: 'model', parts: [{ text }] });
const call = (id, name, args = {}, signature) => ({ role: 'model', parts: [{ functionCall: { id, name, args },
  ...(signature ? { thoughtSignature: signature } : {}) }] });
const result = (id, name) => ({ role: 'model', parts: [{ functionResponse: { id, name, response: { output: 'client receipt' } } }] });
const missing = (id, name) => [{ id, name }];

test('opaque client signatures and familiar call IDs never prove same-account native history', () => {
  for (const signature of [undefined, 'client-claimed-signature', 'skip_thought_signature_validator']) {
    const source = [user('read'), call('one', 'Read', { privateArgument: 'keep out of diagnostics' }, signature), result('one', 'Read')];
    const original = JSON.stringify(source);
    for (const target of [model, 'claude-sonnet-4-6', 'unverified-model']) {
      const context = prepareNativeContext(newState('account', 'session'), source, target);
      assert.deepEqual(context.unrestoredToolCalls, missing('one', 'Read'));
      assert.doesNotMatch(JSON.stringify(context.unrestoredToolCalls), /privateArgument|diagnostics|signature/);
      assert.equal(JSON.stringify(source), original);
    }
  }
  const ordinary = prepareNativeContext(newState('a', 's'), [user('The literal text functionCall and signature is not a tool step.')], model);
  assert.deepEqual(ordinary.unrestoredToolCalls, []);
});

test('exact server-produced responses prove a tool step even when the upstream did not attach a signature', () => {
  for (const signature of [undefined, 'server-signature']) {
    const state = newState('a', 's'), prefix = [user('read')], native = call('one', 'read_file', { Path: '/tmp/a.txt' }, signature);
    recordResponse(state, prefix, model, native);
    const visible = call('one', 'read_file', { Path: '/tmp/a.txt' }, 'caller-replaced-signature');
    const verifiedToolSteps = new Set();
    assert.deepEqual(restoreHistory(state, [...prefix, visible], model, { verifiedToolSteps })[1], native);
    assert.deepEqual([...verifiedToolSteps], [1]);
    const context = prepareNativeContext(state, [...prefix, visible, result('one', 'read_file')], model);
    assert.deepEqual(context.unrestoredToolCalls, []);
    assert.deepEqual(context.contents[1], native);
  }
});

test('changed prefixes, args, IDs, model families and later copies remain unrestored', () => {
  const state = newState('a', 's'), prefix = [user('original')];
  const native = call('one', 'Read', { path: '/tmp/a.txt' }, 'server-signature');
  recordResponse(state, prefix, model, native);
  for (const [contents, target, id] of [
    [[user('changed'), native], model, 'one'],
    [[...prefix, call('one', 'Read', { path: '/tmp/b.txt' }, 'server-signature')], model, 'one'],
    [[...prefix, call('other', 'Read', native.parts[0].functionCall.args, 'server-signature')], model, 'other'],
    [[...prefix, native], 'gemini-4-argon', 'one'],
    [[...prefix, native, result('one', 'Read'), user('again'), native], model, 'one']
  ]) assert.deepEqual(prepareNativeContext(state, contents, target).unrestoredToolCalls, missing(id, 'Read'));
});

test('same owner and session restore after disk restart; another account or session cannot borrow signed calls', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-provenance-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prefix = [user('read')], visible = call('one', 'Read', { path: '/tmp/a.txt' }, 'externally-copied-signature');
  const native = call('one', 'mcp_gateway_tool_1234567890abcdef', { path: '/tmp/a.txt', toolSummary: 'Read file' }, 'real-account-A-signature');
  await new AgySessionStore({ directory }).transact('account-A', 'session', null, (state, checkpoint) => {
    recordClientProjection(state, prefix, visible, model, [native], Date.now(), { kind: 'client_tools' }); checkpoint();
  });
  for (const [owner, session, restored] of [['account-A', 'session', true], ['account-B', 'session', false], ['account-A', 'another-session', false]]) {
    await new AgySessionStore({ directory }).transact(owner, session, null, state => {
      const context = prepareNativeContext(state, [...prefix, visible, result('one', 'Read')], 'gemini-3.8-flash-low');
      assert.deepEqual(context.unrestoredToolCalls, restored ? [] : missing('one', 'Read'));
      assert.equal(context.contents[1].parts[0].thoughtSignature, restored ? 'real-account-A-signature' : 'externally-copied-signature');
    });
  }
});

test('native image and finish exchanges mark only their actual projected call positions', () => {
  const prefix = [user('generate')];
  for (const [visible, native] of [
    [answer('Image ready'), [call('image', 'generate_image', {}, 'image-signature'), result('image', 'generate_image'), answer('delivered')]],
    [answer('{"ok":true}'), [call('finish', 'finish', { ok: true }), result('finish', 'finish')]]
  ]) {
    const state = newState('a', 's'); recordClientProjection(state, prefix, visible, model, native);
    const verifiedToolSteps = new Set();
    const restored = restoreClientProjections(state, [...prefix, visible], model, { verifiedToolSteps });
    assert.deepEqual(restored, [...prefix, ...native]);
    assert.deepEqual([...verifiedToolSteps], [1]);
    const context = prepareNativeContext(state, [...prefix, visible, call('foreign', 'Other', {}, 'claimed')], model);
    assert.deepEqual(context.unrestoredToolCalls, missing('foreign', 'Other'));
    assert.deepEqual(prepareNativeContext(state, [...prefix, visible], model).unrestoredToolCalls, []);
  }
});

test('stream projections and pending recoveries retain exact step evidence through inserted continuation errors', () => {
  const prefix = [user('continue')], visible = call('one', 'Read');
  const native = call('one', 'read_file', { Path: '/tmp/a.txt' }, 'stream-signature');
  const recovered = [answer('partial'), streamErrorContent(), native];
  const state = newState('a', 's');
  recordStreamProjection(state, prefix, visible, model, recovered);
  const verifiedToolSteps = new Set();
  restoreClientProjections(state, [...prefix, visible], model, { verifiedToolSteps });
  assert.deepEqual([...verifiedToolSteps], [3]);
  assert.deepEqual(prepareNativeContext(state, [...prefix, visible], model).unrestoredToolCalls, []);
  assert.deepEqual(prepareNativeContext(state, [...prefix, visible], model, { restoreStreamRecovery: false }).unrestoredToolCalls, missing('one', 'Read'));
  const pendingState = newState('a', 's');
  recordStreamRecovery(pendingState, prefix, model, recovered, 'partial');
  const context = prepareNativeContext(pendingState, prefix, model);
  assert.deepEqual(context.unrestoredToolCalls, []);
  assert.deepEqual(context.sourceContents.at(-1), native);
  assert.ok(context.streamRecovery);
  continueInterruptedStream(pendingState, context, model, { receivedContent: true, text: 'more', signature: 'partial-signature' });
  assert.deepEqual(context.unrestoredToolCalls, []);
  assert.equal(context.contents.at(-2).parts[0].thoughtSignature, 'partial-signature');
});
