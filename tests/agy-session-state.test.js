'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { AgySessionStore, recordResponse, restoreHistory, newState } = require('../src/agy-session-state');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { nativeCloudCodeFetch } = require('../src/agy-native-transport');
const { AccountPool } = require('../src/account-pool');
const { prepareNativeMultimodal } = require('../src/protocol');

const model = 'gemini-3.8-flash-high';
const input = text => ({ system: 'Use the client tools.', messages: [{ role: 'user', text }], tools: [] });
const reply = parts => new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), {
  status: 200, headers: { 'content-type': 'application/json' }
});
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function provider(store, fetchImpl, account = 'account-one') {
  return new DirectAntigravityProvider({ sessionStore: store, fetchImpl, accessToken: 'test-token', projectId: 'test-project',
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: `managed-account:${account}` }) }, maxRetries: 0 });
}

test('managed Cloud Code providers use native transport without changing OAuth origin dispatch', t => {
  const pool = new AccountPool({ store: { directory: path.join(directory(t), 'accounts'), list: () => [] } });
  t.after(() => pool.stop());
  assert.equal(pool.fetchImpl, nativeCloudCodeFetch);
  assert.equal(pool.providerFactory({ id: 'example' }).fetchImpl, nativeCloudCodeFetch);
});

test('captured agent envelope ordering, labels and generation profile replace private routing fields', () => {
  const state = newState('private-account', 'private-session');
  const request = buildDirectRequest({ ...input('hello'), tools: [{ name: 'read_file', schema: { type: 'object' } }] },
    model, 'project', 'client-secret-id', '', null, { state, now: 1792389181738 });
  assert.deepEqual(Object.keys(request), ['project', 'requestId', 'request', 'model', 'userAgent', 'requestType']);
  assert.deepEqual(Object.keys(request.request), ['contents', 'systemInstruction', 'tools', 'labels', 'generationConfig', 'sessionId']);
  assert.equal(request.requestId, `agent/${state.cascadeId}/1792389181738/${state.trajectoryId}/1`);
  assert.deepEqual(Object.keys(request.request.labels), ['cascade_id', 'last_step_index', 'model_enum', 'request_id',
    'root_cascade_id', 'trajectory_id', 'used_claude', 'used_claude_conservative', 'used_non_gemini_model']);
  assert.equal(request.request.labels.model_enum, 'MODEL_PLACEHOLDER_M318');
  assert.deepEqual(request.request.generationConfig, { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } });
  assert.equal(request.request.sessionId, '-3750763034362895579');
  assert.doesNotMatch(JSON.stringify(request), /private-account|private-session|client-secret-id/);
  assert.equal(request.request.toolConfig, undefined);
});

test('explicit client output and tool constraints remain native fields; catalog wins over captured fallback', () => {
  const request = buildDirectRequest({ ...input('hello'), generationConfig: { maxOutputTokens: 2048, temperature: 0.2 },
    tools: [{ name: 'read_file' }], toolChoice: { type: 'tool', name: 'read_file' } }, model, 'p', 's', '', null,
  { modelInfo: { model: 'MODEL_UPDATED', supportsThinking: true, thinkingBudget: 4096, maxOutputTokens: 32768 } });
  assert.equal(request.request.labels.model_enum, 'MODEL_UPDATED');
  assert.deepEqual(request.request.generationConfig, { maxOutputTokens: 2048, temperature: 0.2,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 } });
  assert.deepEqual(request.request.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } });
});

test('native preparation preserves the entire caller system prompt and confines image instructions to its tool', () => {
  const source = input('hello'), prepared = prepareNativeMultimodal(source);
  assert.equal(prepared.normalized.system, source.system);
  assert.equal(prepared.normalized.tools.length, 1);
  assert.equal(prepared.normalized.tools[0].name, 'generate_image');
  assert.match(prepared.normalized.tools[0].description, /delivered automatically once/);
  const constrained = { ...source, toolChoice: 'none' };
  assert.equal(prepareNativeMultimodal(constrained).normalized, constrained);
});

test('catalog and read-only authentication requests use the captured project body when known', async () => {
  const seen = [];
  const p = provider(new AgySessionStore({ directory: '' }), async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ models: { [model]: { model: 'MODEL_PLACEHOLDER_M318', supportsThinking: true, thinkingBudget: -1 } } }),
      { headers: { 'content-type': 'application/json' } });
  });
  await p.listModels(); await p.probeAuthentication();
  assert.equal(seen.length, 2);
  for (const item of seen) assert.deepEqual(item.body, { project: 'test-project' });
  assert.equal(p.modelInfo(model).thinkingBudget, -1);
  assert.equal(p.modelInfo(model).model, 'MODEL_PLACEHOLDER_M318');
});

test('ordinary answer signatures and summaries survive restart without leaking thinking to visible text', async t => {
  const dir = directory(t), sent = [], visible = [], thinking = [];
  const firstProvider = provider(new AgySessionStore({ directory: dir }), async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response([
      { parts: [{ thought: true, text: 'A short upstream summary.' }] },
      { parts: [{ text: 'READY' }] },
      { parts: [{ text: '', thoughtSignature: 'native-answer-signature' }] }
    ].map(content => `data: ${JSON.stringify({ response: { candidates: [{ content }] } })}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' }
    });
  });
  const result = await firstProvider.send(input('Remember amber.'), model, { sessionId: 'conversation',
    onDelta: x => visible.push(x), onThinkingDelta: x => thinking.push(x) });
  assert.equal(result.text, 'READY');
  assert.deepEqual(visible, ['READY']);
  assert.deepEqual(thinking, ['A short upstream summary.']);
  const secondProvider = provider(new AgySessionStore({ directory: dir }), async (_url, options) => {
    sent.push(JSON.parse(options.body)); return reply([{ text: 'amber' }]);
  });
  await secondProvider.send({ ...input('Remember amber.'), messages: [
    ...input('Remember amber.').messages, { role: 'assistant', text: 'READY\n' }, { role: 'user', text: 'Recall it.' }
  ] }, model, { sessionId: 'conversation' });
  assert.equal(sent[0].request.labels.cascade_id, sent[1].request.labels.cascade_id);
  assert.equal(sent[0].request.labels.trajectory_id, sent[1].request.labels.trajectory_id);
  assert.match(sent[1].request.labels.request_id, /-1$/);
  assert.match(sent[1].request.labels.last_execution_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(sent[1].request.contents[1], { role: 'model', parts: [
    { text: 'A short upstream summary.', thought: true }, { text: 'READY', thoughtSignature: 'native-answer-signature' }
  ] });
  assert.equal(sent[1].request.labels.last_step_index, '2');
  const files = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  assert.equal(files.length, 1);
  const saved = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.doesNotMatch(saved, /test-token|Remember amber|client-secret/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
});

test('tool history restores exact signature after restart and returns result as model/functionResponse/output', async t => {
  const dir = directory(t), requests = [], tool = { id: 'call_123', name: 'read_file', args: { path: 'probe' } };
  await provider(new AgySessionStore({ directory: dir }), async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return reply([{ thought: true, text: 'Read the file.' }, { functionCall: tool, thoughtSignature: 'call-signature' }]);
  }).send(input('Read a file.'), model, { sessionId: 'tool-session' });
  await provider(new AgySessionStore({ directory: dir }), async (_url, options) => {
    requests.push(JSON.parse(options.body)); return reply([{ text: 'coral' }]);
  }).send({ ...input('Read a file.'), messages: [...input('Read a file.').messages,
    { role: 'assistant', parts: [{ type: 'tool_call', id: tool.id, name: tool.name, arguments: tool.args }] },
    { role: 'user', parts: [{ type: 'tool_result', id: tool.id, content: 'coral' }, { type: 'text', text: 'Summarize.' }] }
  ] }, model, { sessionId: 'tool-session' });
  assert.deepEqual(requests[1].request.contents[1], { role: 'model', parts: [{ functionCall: tool, thoughtSignature: 'call-signature' }] });
  assert.deepEqual(requests[1].request.contents[2], { role: 'model', parts: [{ functionResponse: {
    id: tool.id, name: tool.name, response: { output: 'coral' }
  } }] });
  assert.equal(requests[1].request.contents[3].role, 'user');
  assert.equal(requests[1].request.labels.last_execution_id, undefined);
});

test('different accounts, unverified model combinations and diverged prefixes never restore another answer signature', async t => {
  const dir = directory(t), observed = [];
  const store = new AgySessionStore({ directory: dir });
  const native = { role: 'model', parts: [{ text: 'same', thoughtSignature: 'secret-signature' }] };
  const start = [{ role: 'user', parts: [{ text: 'original' }] }];
  await store.transact('A', 'S', null, (state, checkpoint) => {
    recordResponse(state, start, model, native); checkpoint();
    assert.equal(restoreHistory(state, [...start, { role: 'model', parts: [{ text: 'same' }] }], model)[1].parts[0].thoughtSignature, 'secret-signature');
    assert.equal(restoreHistory(state, [...start, { role: 'model', parts: [{ text: 'same' }] }], 'different-model')[1].parts[0].thoughtSignature, undefined);
    assert.equal(restoreHistory(state, [{ role: 'user', parts: [{ text: 'rewritten' }] }, { role: 'model', parts: [{ text: 'same' }] }], model)[1].parts[0].thoughtSignature, undefined);
    observed.push(state.cascadeId);
  });
  for (const [account, session] of [['B', 'S'], ['A', 'other-session']]) await store.transact(account, session, null, state => {
    assert.deepEqual(state.responses, {}); observed.push(state.cascadeId);
  });
  assert.equal(new Set(observed).size, 3);
});

test('captured HTTP 503 retry advances the error step but not the logical request counter', async t => {
  const dir = directory(t), bodies = [];
  const p = provider(new AgySessionStore({ directory: dir }), async (_url, options) => {
    bodies.push(options.body);
    return bodies.length === 1 ? new Response('temporarily unavailable', { status: 503 }) : reply([{ text: 'ok' }]);
  });
  await p.send(input('retry me'), model, { sessionId: 'retry-session' });
  assert.equal(bodies.length, 2);
  const first = JSON.parse(bodies[0]), retried = JSON.parse(bodies[1]);
  assert.match(first.requestId, /\/1$/);
  assert.match(retried.requestId, /\/2$/);
  assert.equal(retried.request.labels.last_step_index, '1');
  assert.equal(first.request.labels.request_id, retried.request.labels.request_id);
  retried.requestId = first.requestId;
  retried.request.labels.last_step_index = first.request.labels.last_step_index;
  assert.deepEqual(retried, first);
  await p.send(input('next'), model, { sessionId: 'retry-session' });
  assert.match(JSON.parse(bodies[2]).request.labels.request_id, /-1$/);
});

test('session serialization works across store instances; cancelled waiters do not unlock active requests', async t => {
  const dir = directory(t), a = new AgySessionStore({ directory: dir }), b = new AgySessionStore({ directory: dir });
  let release, entered;
  const enteredPromise = new Promise(r => { entered = r; });
  const hold = new Promise(r => { release = r; });
  const first = a.transact('A', 'S', null, async (state, save) => { entered(); await hold; state.requestIndex++; save(); });
  await enteredPromise;
  const controller = new AbortController();
  const cancelled = b.transact('A', 'S', controller.signal, () => assert.fail('cancelled lease entered'));
  const assertion = assert.rejects(cancelled, { name: 'AbortError' }); controller.abort(); await assertion;
  let thirdEntered = false;
  const third = b.transact('A', 'S', null, (state, save) => { thirdEntered = true; assert.equal(state.requestIndex, 1); state.requestIndex++; save(); });
  await new Promise(r => setTimeout(r, 30)); assert.equal(thirdEntered, false);
  release(); await Promise.all([first, third]);
  await a.transact('A', 'S', null, state => assert.equal(state.requestIndex, 2));
  assert.equal(fs.readdirSync(dir).some(n => n.endsWith('.lock')), false);
});

test('expired state starts fresh and lock is released after callback failure', async t => {
  const dir = directory(t); let now = Date.now(), original;
  const store = new AgySessionStore({ directory: dir, now: () => now, ttlMs: 100 });
  await store.transact('A', 'S', null, (state, save) => { original = state.cascadeId; save(); });
  now += 101;
  await store.transact('A', 'S', null, state => assert.notEqual(state.cascadeId, original));
  await assert.rejects(store.transact('A', 'S', null, () => { throw Error('failure'); }), /failure/);
  await store.transact('A', 'S', null, () => {});
});

test('a terminated process cannot leave a permanent authorization-style session lock', async t => {
  const dir = directory(t);
  const child = spawn(process.execPath, ['-e', `
    const {AgySessionStore} = require(${JSON.stringify(require.resolve('../src/agy-session-state'))});
    const store = new AgySessionStore({directory: ${JSON.stringify(dir)}});
    store.transact('A','S',null,(state,save) => { state.requestIndex=7; save(); process.exit(0); });
  `], { stdio: 'pipe' });
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.lock')).length, 1);
  const store = new AgySessionStore({ directory: dir });
  await store.transact('A', 'S', AbortSignal.timeout(2000), state => assert.equal(state.requestIndex, 7));
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.lock')).length, 0);
});
