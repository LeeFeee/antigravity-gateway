'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveModel, runTurn } = require('../antigravity-gateway');
const { normalizeChat } = require('../src/protocol');
const { AccountStore } = require('../src/account-store');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { ARGON_MODEL } = require('../src/robin-provider');

test('an Argon Auto Mode classifier stays on Robin even without any Cloud Code account', async () => {
  assert.equal(await resolveModel(ARGON_MODEL, { preferFast: true }), ARGON_MODEL);
});

test('an auxiliary classifier cannot consume or block the main Argon tool task', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-classifier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  store.save({ id: 'r', accessToken: 'test', providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  const calls = [];
  const pool = new RobinAccountPool({ store, providerFactory: () => ({ send: async (input, model, options) => {
    calls.push({ input, model, options });
    if (input.autoMode) return { text: '<severity>0</severity>', toolCalls: [], usage: {} };
    return options.requireExistingTurn ? { text: 'done', toolCalls: [], usage: {} }
      : { text: '', toolCalls: [{ id: 'read_1', name: 'read_note', arguments: {} }], usage: {} };
  } }) });
  t.after(() => pool.stop());
  const options = { clientId: 'cli', sessionId: 'conversation', routingKey: 'shared-affinity' };
  await pool.send({ messages: [], tools: [] }, ARGON_MODEL, options);
  assert.equal(pool.activeTasks.size, 1);
  const classifier = await pool.send({ autoMode: true, messages: [], tools: [] }, ARGON_MODEL, options);
  assert.equal(classifier.text, '<severity>0</severity>');
  assert.equal(pool.activeTasks.size, 1, 'the main tool task remains active');
  const result = await pool.send({ messages: [], tools: [] }, ARGON_MODEL, options);
  assert.equal(result.text, 'done');
  assert.equal(calls[0].options.sessionId, calls[2].options.sessionId);
  assert.notEqual(calls[0].options.sessionId, calls[1].options.sessionId);
  assert.equal(calls[1].options.requireExistingTurn, false);
  assert.equal(calls[2].options.requireExistingTurn, true);
  assert.ok(calls.every(call => call.options.accountId === 'r'));
});

test('task rejection is isolated by client and auxiliary scope without breaking account affinity', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-rejected-tool-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  store.save({ id: 'r', accessToken: 'test', providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  const started = [], cancelled = [];
  const pool = new RobinAccountPool({ store, providerFactory: () => ({
    send: async (_input, _model, options) => {
      started.push(options.sessionId);
      return { text: '', toolCalls: [{ id: 'read_1', name: 'read_note', arguments: {} }], usage: {} };
    },
    cancelTask: key => cancelled.push(key)
  }) });
  t.after(() => pool.stop());
  const input = { messages: [], tools: [] };
  const options = { clientId: 'cli', sessionId: 'conversation', routingKey: 'affinity' };
  await pool.send(input, ARGON_MODEL, options);
  await pool.send({ ...input, autoMode: true }, ARGON_MODEL, options);
  await pool.send(input, ARGON_MODEL, { ...options, clientId: 'other' });
  assert.equal(pool.cancelTask({ ...input, autoMode: true }, options), true);
  assert.deepEqual(cancelled, [started[1]]);
  assert.equal(pool.activeTasks.size, 2);
  assert.equal(pool.cancelTask(input, options), true);
  assert.deepEqual(cancelled, [started[1], started[0]]);
  assert.equal(pool.activeTasks.size, 1);
  assert.equal(pool.sessions.get('affinity').accountId, 'r');
  assert.equal(pool.cancelTask(input, options), false);
});

test('DSH title and compaction requests cannot consume a pending main tool task and retain its account affinity', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-dsh-scopes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory, directoryName: 'robin-accounts' });
  store.save({ id: 'r', accessToken: 'test', providerType: 'robin', accountType: 'gemini-app', capabilities: [ARGON_MODEL] });
  const calls = [];
  const pool = new RobinAccountPool({ store, providerFactory: () => ({ send: async (_input, _model, options) => {
    calls.push(options);
    return options.auxiliaryScope || options.requireExistingTurn
      ? { text: 'done', toolCalls: [], usageKnown: false }
      : { text: '', toolCalls: [{ id: 'read_1', name: 'read_note', arguments: {} }], usageKnown: false };
  } }) });
  t.after(() => pool.stop());
  const input = { messages: [], tools: [] };
  const options = { clientId: 'dsh-client', sessionId: 'one-conversation', routingKey: 'one-affinity' };
  await pool.send(input, ARGON_MODEL, options);
  await pool.send(input, ARGON_MODEL, { ...options, auxiliaryScope: 'no-client-tools' });
  await pool.send(input, ARGON_MODEL, { ...options, auxiliaryScope: 'compaction' });
  assert.equal(pool.activeTasks.size, 1);
  await pool.send(input, ARGON_MODEL, options);
  assert.equal(calls[0].sessionId, calls[3].sessionId);
  assert.equal(new Set(calls.slice(0, 3).map(call => call.sessionId)).size, 3);
  assert.equal(calls[3].requireExistingTurn, true);
  assert.ok(calls.every(call => call.accountId === 'r'));
  assert.equal(pool.sessions.get('one-affinity').accountId, 'r');
  assert.equal(pool.activeTasks.size, 0);
});

test('shared protocol rejection cancels Robin tool waits before returning the error, but valid calls remain pending', async t => {
  const cancelled = [];
  let invalid = true;
  t.mock.method(RobinAccountPool.prototype, 'listModels', async () => [ARGON_MODEL]);
  t.mock.method(RobinAccountPool.prototype, 'send', async () => ({
    text: '', toolCalls: [{ id: 'call_1', name: 'write_note', arguments: invalid ? { text: 17 } : { text: 'hello' } }], usage: {}
  }));
  t.mock.method(RobinAccountPool.prototype, 'cancelTask', (_normalized, options) => { cancelled.push(options); return true; });
  const input = normalizeChat({ messages: [{ role: 'user', content: '保存笔记。' }], tools: [{ type: 'function', function: {
    name: 'write_note', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  } }] });
  const options = { clientId: 'cli', sessionId: 'conversation', routingKey: 'affinity' };
  await assert.rejects(runTurn(input, ARGON_MODEL, new AbortController().signal, options), { code: 'invalid_tool_call' });
  assert.deepEqual(cancelled, [options]);
  invalid = false;
  const valid = await runTurn(input, ARGON_MODEL, new AbortController().signal, options);
  assert.equal(valid.toolCalls[0].arguments.text, 'hello');
  assert.equal(cancelled.length, 1);
  invalid = true;
  const auxiliary = { ...options, auxiliaryScope: 'compaction' };
  await assert.rejects(runTurn(input, ARGON_MODEL, new AbortController().signal, auxiliary), { code: 'invalid_tool_call' });
  assert.deepEqual(cancelled[1], auxiliary, 'rejection must cancel only the auxiliary task, not the pending main scope');
});
