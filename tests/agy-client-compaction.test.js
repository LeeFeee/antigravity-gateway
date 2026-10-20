'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { detectNativeCompaction, capturedSummaryReplacement, CLAUDE_COMPACTION_PROFILE } = require('../src/agy-client-compaction');
const { prepareNativeContext, completeNativeContext } = require('../src/agy-context-state');
const { newState, AgySessionStore } = require('../src/agy-session-state');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const model = 'gemini-3.8-flash-high';
const user = text => ({ role: 'user', parts: [{ text }] });
const answer = text => ({ role: 'model', parts: [{ text }] });
const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n- Summary:\nKeep the original facts and constraints.\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /owned/transcript.jsonl\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';

test('instruction fingerprint gate requires exact version, session, protocol and terminal text block', () => {
  // Synthetic profile exercises the gate without publishing the vendor's long
  // private prompt. The real captured digest is verified in installed-CLI tests.
  const text = 'synthetic exact compaction fixture';
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const req = { headers: { 'user-agent': 'claude-cli/2.1.285 (external, sdk-cli)', 'x-claude-code-session-id': 'session' } };
  const normalized = { protocol: 'anthropic', messages: [{ role: 'user', parts: [{ type: 'tool_result', id: 'a' }, { type: 'text', text }] }] };
  assert.equal(detectNativeCompaction(req, normalized, hash), CLAUDE_COMPACTION_PROFILE);
  assert.equal(detectNativeCompaction(req, normalized), '');
  for (const headers of [{}, { ...req.headers, 'user-agent': 'claude-cli/2.1.286' }, { ...req.headers, 'x-claude-code-session-id': '' }]) {
    assert.equal(detectNativeCompaction({ headers }, normalized, hash), '');
  }
  assert.equal(detectNativeCompaction(req, { ...normalized, protocol: 'openai' }, hash), '');
  for (const parts of [[{ type: 'text', text: text + ' ' }], [{ type: 'text', text }, { type: 'media' }],
    [{ type: 'text', text: 'other' }, { type: 'text', text }]]) {
    assert.equal(detectNativeCompaction(req, { ...normalized, messages: [{ role: 'user', parts }] }, hash), '');
  }
});

test('ordinary summarize language and copied summary wrappers do not start checkpoints', () => {
  const req = { headers: { 'user-agent': 'claude-cli/2.1.285', 'x-claude-code-session-id': 'session' } };
  for (const text of ['Summarize the conversation.', '/compact', summary, 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.']) {
    assert.equal(detectNativeCompaction(req, { protocol: 'anthropic', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }), '');
  }
});

test('captured summary envelope needs a matching pending checkpoint and remains text-only', () => {
  assert.equal(capturedSummaryReplacement(user(summary), { profile: CLAUDE_COMPACTION_PROFILE }), true);
  assert.equal(capturedSummaryReplacement(user(summary.replace('\n- Summary:\n', '\nSummary:\n')), { profile: CLAUDE_COMPACTION_PROFILE }), true);
  assert.equal(capturedSummaryReplacement(user(summary), undefined), false);
  assert.equal(capturedSummaryReplacement(user(summary), { profile: 'unknown' }), false);
  assert.equal(capturedSummaryReplacement(answer(summary), { profile: CLAUDE_COMPACTION_PROFILE }), false);
  assert.equal(capturedSummaryReplacement(user(summary + '\nextra'), { profile: CLAUDE_COMPACTION_PROFILE }), false);
  assert.equal(capturedSummaryReplacement({ ...user(summary), parts: [{ text: summary }, { inlineData: {} }] }, { profile: CLAUDE_COMPACTION_PROFILE }), false);
});

test('Claude omitted answer stays a timeline anchor, never restored content or signatures', () => {
  let state = newState('a', 's');
  const first = prepareNativeContext(state, [user('keep original')], model);
  completeNativeContext(state, first, model, answer('previous answer'));
  const compact = prepareNativeContext(state, [user('keep original'), user('exact compact instruction')], model,
    { checkpoint: true, compactionProfile: CLAUDE_COMPACTION_PROFILE });
  assert.equal(compact.step, 2);
  assert.equal(compact.contents.length, 2);
  assert.equal(compact.contents.at(-1).parts[0].text, 'exact compact instruction');
  completeNativeContext(state, compact, model, answer('different formatting in generated summary'));
  assert.equal(state.pendingCompaction.retainedTimeline.length, 1);
  state = JSON.parse(JSON.stringify(state));
  const resumed = prepareNativeContext(state, [user(summary), answer('previous answer'), user('next')], model);
  assert.equal(resumed.step, 4);
  assert.equal(resumed.contents[0].parts[0].text, `<CONTEXT_SUMMARY>\n${summary}\n</CONTEXT_SUMMARY>`);
  assert.deepEqual(resumed.contents[1], answer('previous answer'));
  assert.doesNotMatch(JSON.stringify(resumed.contents), /keep original|exact compact instruction|different formatting/);
  assert.equal(state.pendingCompaction, undefined);
  completeNativeContext(state, resumed, model, answer('new answer'));
  state = JSON.parse(JSON.stringify(state));
  const next = prepareNativeContext(state, [user(summary), answer('previous answer'), user('next'), answer('new answer'), user('last')], model);
  assert.equal(next.step, 6);
  assert.equal(next.contents[0].parts[0].text, resumed.contents[0].parts[0].text);
  assert.doesNotMatch(JSON.stringify(state), /Keep the original facts|owned\/transcript|keep original/);
  assert.doesNotMatch(JSON.stringify(state.timeline), /previous answer|new answer/);
});

test('unobserved summary banner without a pending checkpoint keeps ordinary user semantics', () => {
  const state = newState('a', 's');
  const context = prepareNativeContext(state, [user(summary)], model);
  assert.match(context.contents[0].parts[0].text, /^<USER_REQUEST>/);
  assert.equal(context.step, 1);
});

test('an unknown continuation does not reuse omitted anchors or leave a stale Claude profile', () => {
  const state = newState('a', 's');
  const first = prepareNativeContext(state, [user('first')], model);
  completeNativeContext(state, first, model, answer('old answer'));
  const compact = prepareNativeContext(state, [user('first'), user('instruction')], model,
    { checkpoint: true, compactionProfile: CLAUDE_COMPACTION_PROFILE });
  completeNativeContext(state, compact, model, answer('summary'));
  const changed = prepareNativeContext(state, [user('unknown rewritten prefix'), answer('old answer'), user('new')], model);
  assert.equal(changed.step, 6);
  completeNativeContext(state, changed, model, answer('done'));
  assert.equal(state.pendingCompaction, undefined);
  const later = prepareNativeContext(state, [user(summary)], model);
  assert.match(later.contents[0].parts[0].text, /^<USER_REQUEST>/);
});

test('native client checkpoints share persistent state without changing auxiliary routing or leaking profile', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-client-compaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [], replies = ['previous answer', 'checkpoint summary', 'new answer'];
  async function send(messages, options = {}) {
    const provider = new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory: dir }), accessToken: 'token', projectId: 'p', maxRetries: 0,
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:account' }) },
      fetchImpl: async (_url, opts) => { requests.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: replies.shift() }] } }] }), { headers: { 'content-type': 'application/json' } }); } });
    return provider.send({ messages, generationConfig: { maxOutputTokens: 32000 } }, model, { sessionId: 's', ...options });
  }
  await send([{ role: 'user', text: 'keep' }]);
  await send([{ role: 'user', text: 'keep' }, { role: 'user', text: 'exact compact instruction' }], { nativeCompaction: CLAUDE_COMPACTION_PROFILE });
  await send([{ role: 'user', text: summary }, { role: 'assistant', text: 'previous answer' }, { role: 'user', text: 'next' }]);
  assert.deepEqual(requests.map(r => r.requestType), ['agent', 'checkpoint', 'agent']);
  assert.deepEqual(requests.map(r => r.requestId.split('/').at(-1)), ['1', '2', '4']);
  assert.deepEqual(requests.map(r => r.request.labels.request_id.split('-').at(-1)), ['0', '1', '1']);
  assert.equal(new Set(requests.map(r => r.request.labels.cascade_id)).size, 1);
  assert.equal(requests[1].request.generationConfig.maxOutputTokens, 16384);
  assert.equal(requests[1].request.labels.last_execution_id, requests[2].request.labels.last_execution_id);
  assert.equal(requests[2].request.contents[0].parts[0].text, `<CONTEXT_SUMMARY>\n${summary}\n</CONTEXT_SUMMARY>`);
  assert.doesNotMatch(JSON.stringify(requests), /nativeCompaction|compactionProfile|claude-code-2\.1\.285|contextSummary|retainedTimeline/);
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.json')).length, 1);
});
