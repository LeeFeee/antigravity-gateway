'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { newState, recordResponse, restoreHistory, recordClientProjection, restoreClientProjections, AgySessionStore } = require('../src/agy-session-state');
const { compatibleHistoryModels, generationProfile, CAPTURED_MODELS } = require('../src/agy-request-profile');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const models = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'];
const user = text => ({ role: 'user', parts: [{ text }] });
const answer = text => ({ role: 'model', parts: [{ text }] });

test('only the captured Gemini 3.8 Flash model set shares signed native history', () => {
  for (const source of models) for (const target of models) assert.equal(compatibleHistoryModels(source, target), true);
  for (const other of ['gemini-3.8-flash-tiered', 'gemini-3.9-flash-high', 'gemini-2.5-pro', 'gemini-4-argon', 'claude-sonnet-4-6', '', null, undefined]) {
    assert.equal(compatibleHistoryModels(models[0], other), false);
    assert.equal(compatibleHistoryModels(other, models[0]), false);
  }
  assert.equal(compatibleHistoryModels('same-unknown-model', 'same-unknown-model'), true);
});

test('all captured model switches retain exact text and tool signatures without weakening prefix isolation', () => {
  for (const source of models) for (const target of models) {
    for (const content of [
      { role: 'model', parts: [{ text: 'summary', thought: true }, { text: 'READY', thoughtSignature: 'actual-response-signature' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', id: 'call', args: { path: 'fixture' } }, thoughtSignature: 'actual-call-signature' }] }
    ]) {
      const state = newState('account', 'session'), prefix = [user('original')];
      recordResponse(state, prefix, source, content);
      const visible = structuredClone(content); visible.parts = visible.parts.filter(p => !p.thought).map(({ thoughtSignature, ...part }) => part);
      assert.deepEqual(restoreHistory(state, [...prefix, visible], target)[1], content);
      assert.deepEqual(restoreHistory(state, [user('changed'), visible], target)[1], visible);
      assert.deepEqual(restoreHistory(state, [...prefix, visible], 'gemini-4-argon')[1], visible);
      assert.deepEqual(restoreHistory(newState('different-account', 'session'), [...prefix, visible], target)[1], visible);
    }
  }
});

test('image client projections remain restricted to the original model until cross-model captures exist', () => {
  const state = newState('a', 's'), prefix = [user('image task')], receipt = answer('issued receipt');
  const native = [answer('native call'), answer('native image output'), answer('native answer')];
  recordClientProjection(state, prefix, receipt, models[0], native);
  assert.deepEqual(restoreClientProjections(state, [...prefix, receipt], models[0]), [...prefix, ...native]);
  for (const model of models.slice(1)) assert.deepEqual(restoreClientProjections(state, [...prefix, receipt], model), [...prefix, receipt]);
  assert.deepEqual(restoreClientProjections(state, [user('changed'), receipt], models[1]), [user('changed'), receipt]);
  assert.deepEqual(restoreClientProjections(state, [...prefix, answer('edited')], models[2]), [...prefix, answer('edited')]);
  assert.deepEqual(restoreClientProjections(state, [...prefix, receipt], 'other-model'), [...prefix, receipt]);
});

test('captured generation defaults use -1/4000/1000; live metadata and explicit client caps retain priority', () => {
  for (const [i, model] of models.entries()) {
    assert.deepEqual(generationProfile({}, model), { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: [-1, 4000, 1000][i] } });
    assert.equal(CAPTURED_MODELS[model].model, `MODEL_PLACEHOLDER_M${318 + i}`);
    assert.deepEqual(generationProfile({ generationConfig: { maxOutputTokens: 2048 } }, model,
      { maxOutputTokens: 32768, supportsThinking: true, thinkingBudget: 1200 }),
    { maxOutputTokens: 2048, thinkingConfig: { includeThoughts: true, thinkingBudget: 1200 } });
  }
});

test('signed text and tool history survive disk restarts through all captured variants', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-model-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const seen = [], calls = { id: 'read-1', name: 'read_file', args: { path: 'fixture' } };
  const replies = [[{ functionCall: calls, thoughtSignature: 'signed-high-call' }],
    [{ text: 'READY', thoughtSignature: 'signed-high-answer' }], [{ text: 'code', thoughtSignature: 'signed-low-answer' }],
    [{ text: 'again', thoughtSignature: 'signed-medium-answer' }], [{ text: 'done' }]];
  async function send(model, messages) {
    const provider = new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'token', projectId: 'p', maxRetries: 0,
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:a' }) },
      fetchImpl: async (_url, options) => { seen.push(JSON.parse(options.body)); return new Response(JSON.stringify({ candidates: [{ content: { parts: replies.shift() } }] }), { headers: { 'content-type': 'application/json' } }); } });
    return provider.send({ messages }, model, { sessionId: 'same-session' });
  }
  const messages = [{ role: 'user', text: 'read file' }];
  await send(models[0], messages);
  messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: calls.id, name: calls.name, arguments: calls.args }] },
    { role: 'user', parts: [{ type: 'tool_result', id: calls.id, name: calls.name, content: 'code' }] });
  await send(models[0], messages);
  messages.push({ role: 'assistant', text: 'READY' }, { role: 'user', text: 'recall' }); await send(models[2], messages);
  messages.push({ role: 'assistant', text: 'code' }, { role: 'user', text: 'again' }); await send(models[1], messages);
  messages.push({ role: 'assistant', text: 'again' }, { role: 'user', text: 'last' }); await send(models[0], messages);
  assert.deepEqual(seen.map(r => Number(r.requestId.split('/').at(-1))), [1, 3, 5, 7, 9]);
  assert.equal(new Set(seen.map(r => r.request.labels.cascade_id)).size, 1);
  for (const r of seen.slice(1)) assert.equal(r.request.contents[1].parts[0].thoughtSignature, 'signed-high-call');
  for (const r of seen.slice(2)) assert.equal(r.request.contents[3].parts[0].thoughtSignature, 'signed-high-answer');
  assert.equal(seen[3].request.contents[5].parts[0].thoughtSignature, 'signed-low-answer');
  assert.equal(seen[4].request.contents[5].parts[0].thoughtSignature, 'signed-low-answer');
  assert.equal(seen[4].request.contents[7].parts[0].thoughtSignature, 'signed-medium-answer');
  assert.doesNotMatch(JSON.stringify(seen), /skip_thought_signature_validator/);
  assert.match(seen[2].request.contents.at(-1).parts[0].text, /from Gemini 3\.8 Flash \(High\) to Gemini 3\.8 Flash \(Low\)/);
  assert.match(seen[3].request.contents.at(-1).parts[0].text, /from Gemini 3\.8 Flash \(Low\) to Gemini 3\.8 Flash \(Medium\)/);
});
