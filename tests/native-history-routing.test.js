'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountPool, SESSION_TTL_MS } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const { normalizeResponses } = require('../src/protocol');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');

const MODEL = 'gemini-3.8-flash-high';
const SESSION = 'synthetic-dsh-session';
const OPTIONS = { sessionId: SESSION, routingKey: 'synthetic-affinity', reuseConversation: true };
const tool = { type: 'function', name: 'read', description: 'Read a fixture file.', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false
} };
const initial = [{ role: 'user', content: 'Read the fixture.' }];
const normalize = input => normalizeResponses({ model: MODEL, tools: [tool], input });
const first = normalize(initial);
const issued = prepareAntigravityTools(first).toProvider({ id: 'read-1', name: 'read', arguments: { path: 'fixture.txt' } });
const followInput = [...initial,
  { type: 'function_call', call_id: 'read-1', name: 'read', arguments: JSON.stringify({ path: 'fixture.txt' }) },
  { type: 'function_call_output', call_id: 'read-1', output: 'fixture text' }];
const edit = normalize([...followInput, { role: 'assistant', content: 'Read complete.' },
  { role: 'user', content: 'Now edit the fixture.' }]);

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-history-routing-'));
  const stateDirectory = path.join(directory, 'native');
  const store = new AccountStore({ configDir: directory });
  const accounts = ['a', 'b'].map(id => store.save({ id, email: `${id}@example.com`, subjectId: `google-${id}`,
    accessToken: `access-${id}`, refreshToken: `refresh-${id}`, projectId: `project-${id}`, expiresAt: '2099-01-01T00:00:00Z' }));
  let now = Date.now();
  const failures = new Map();
  const requests = [], diagnostics = [];
  const providers = new Map();
  for (const account of accounts) {
    const provider = new DirectAntigravityProvider({
      localAuth: new ManagedAccountAuthProvider({ account, store }),
      sessionStore: new AgySessionStore({ directory: stateDirectory, now: () => now }),
      baseUrl: 'https://synthetic.invalid', maxRetries: 0, retryPolicy: 'legacy',
      fetchImpl: async (_url, options) => {
        requests.push({ account: account.id, body: JSON.parse(options.body) });
        const failure = failures.get(account.id);
        if (failure) return new Response(JSON.stringify({ error: { code: failure.status,
          message: failure.message, ...(failure.status === 429 ? { details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${failure.retrySeconds}s` }
          ] } : {}) } }), { status: failure.status });
        const isFirst = requests.filter(request => request.account === account.id).length === 1;
        return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts:
          isFirst && account.id === 'a' ? [{ functionCall: { id: issued.id, name: issued.name, args: issued.arguments },
            thoughtSignature: 'issued-account-a-signature' }] : [{ text: 'Read complete.' }]
        } }] }), { headers: { 'content-type': 'application/json' } });
      }
    });
    provider.listModels = async () => [MODEL];
    providers.set(account.id, provider);
  }
  const pool = new AccountPool({ store, now: () => now, providerFactory: account => providers.get(account.id),
    diagnosticReporter: (event, fields) => diagnostics.push({ event, ...fields }) });
  t.after(() => { pool.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await providers.get('a').send(first, MODEL, OPTIONS);
  await providers.get('a').send(normalize(followInput), MODEL, OPTIONS);
  await pool.ensureModelCatalogs();
  pool.bindSession(OPTIONS.routingKey, 'a');
  return { directory, stateDirectory, accounts, pool, providers, requests, diagnostics,
    now: () => now, advance: milliseconds => { now += milliseconds; },
    fail: (id, status = 429, message = 'Resource has been exhausted (e.g. check quota).', retrySeconds = 30) => {
      if (status) failures.set(id, { status, message, retrySeconds }); else failures.delete(id);
    } };
}

function assertToolHistory(request) {
  const parts = request.body.request.contents.flatMap(content => content.parts || []);
  const calls = parts.filter(part => part.functionCall).map(part => part.functionCall);
  const results = parts.filter(part => part.functionResponse).map(part => part.functionResponse);
  assert.equal(calls.length, 1, 'the client tool call remains a function call');
  assert.equal(results.length, 1, 'the completed tool result remains a function response');
  assert.equal(calls[0].id, issued.id);
  assert.equal(calls[0].name, issued.name);
  assert.deepEqual(calls[0].args, issued.arguments);
  assert.equal(results[0].id, calls[0].id);
  assert.equal(results[0].name, calls[0].name);
  assert.match(JSON.stringify(results[0].response), /fixture text/);
}

test('tool history follows ordinary account failover when its original account is rate limited', async t => {
  const f = await fixture(t);
  const inputBefore = structuredClone(edit);
  f.advance(1000); f.fail('a');
  const result = await f.pool.send(edit, MODEL, OPTIONS);
  assert.equal(result.accountId, 'b');
  assert.deepEqual(f.requests.slice(2).map(request => request.account), ['a', 'b']);
  assertToolHistory(f.requests.at(-1));
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body), /issued-account-a-signature/,
    'account failover does not copy another account\'s opaque native cache');
  assert.deepEqual(edit, inputBefore, 'account failover does not rewrite the agent\'s submitted history');
  assert.equal(f.pool.sessions.get(OPTIONS.routingKey).accountId, 'b');
  assert.equal(f.pool.entries.get('a').modelCooldowns.get(MODEL), f.now() + 30000);
  const failure = f.diagnostics.find(event => event.event === 'account_model_attempt_failed');
  assert.equal(failure.code, 'direct_upstream_error'); assert.equal(failure.status, 429);
  assert.equal(Object.hasOwn(failure, 'details'), false); assert.equal(Object.hasOwn(failure, 'message'), false);
  const b = f.pool.entries.get('b');
  assert.equal(b.lastFailureAt, ''); assert.equal(b.lastError, '');
});

test('cooldown and expired affinity do not pin tool history; recovery does not force a return to the old account', async t => {
  const f = await fixture(t);
  f.advance(SESSION_TTL_MS + 1);
  f.pool.entries.get('a').modelCooldowns.set(MODEL, f.now() + 2000);
  assert.equal((await f.pool.send(edit, MODEL, OPTIONS)).accountId, 'b');
  assertToolHistory(f.requests.at(-1));
  const bindingAt = f.pool.sessions.get(OPTIONS.routingKey).at;
  f.advance(1000);
  assert.equal((await f.pool.send(edit, MODEL, OPTIONS)).accountId, 'b');
  f.advance(2000);
  assert.equal((await f.pool.send(edit, MODEL, OPTIONS)).accountId, 'b');
  assert.deepEqual(f.requests.slice(2).map(request => request.account), ['b', 'b', 'b']);
  assert.equal(f.pool.sessions.get(OPTIONS.routingKey).at, bindingAt, 'successful requests retain the original fixed affinity window');
});

test('valid client tool history is forwarded even when no account has matching local session history', async t => {
  const f = await fixture(t);
  const result = await f.pool.send(edit, MODEL, { ...OPTIONS, sessionId: 'different-session' });
  assert.equal(result.accountId, 'a');
  assert.equal(f.requests.length, 3);
  assertToolHistory(f.requests.at(-1));
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body), /issued-account-a-signature/);
});

test('a replacement account\'s real upstream rejection is returned to the agent', async t => {
  const f = await fixture(t);
  f.fail('a'); f.fail('b', 400, 'Upstream rejected this submitted history.');
  await assert.rejects(f.pool.send(edit, MODEL, OPTIONS), error => {
    assert.equal(error.code, 'direct_upstream_error');
    assert.equal(error.status, 400);
    assert.match(error.details, /Upstream rejected this submitted history/);
    return true;
  });
  assert.deepEqual(f.requests.slice(2).map(request => request.account), ['a', 'b']);
  assertToolHistory(f.requests.at(-1));
  assert.equal(f.diagnostics.some(event => event.code === 'native_history_missing'), false);
});

test('ordinary requests retain the same multi-account fallback', async t => {
  const f = await fixture(t); f.fail('a');
  const result = await f.pool.send(normalize([{ role: 'user', content: 'A new standalone question.' }]), MODEL, OPTIONS);
  assert.equal(result.accountId, 'b');
  assert.deepEqual(f.requests.slice(2).map(request => request.account), ['a', 'b']);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body), /issued-account-a-signature/);
});

test('tool-history requests use the full pool when calculating retry time after all accounts cool down', async t => {
  const f = await fixture(t);
  f.fail('a', 429, 'Resource has been exhausted.', 30);
  f.fail('b', 429, 'Resource has been exhausted.', 10);
  await assert.rejects(f.pool.send(edit, MODEL, OPTIONS), { code: 'direct_upstream_error', status: 429 });
  assert.deepEqual(f.requests.slice(2).map(request => request.account), ['a', 'b']);
  const count = f.requests.length;
  await assert.rejects(f.pool.send(edit, MODEL, OPTIONS), error => error.status === 429 && error.retryAfterSeconds === 10);
  assert.equal(f.requests.length, count, 'cooling accounts are not contacted again');
  f.advance(10000); f.fail('b', 0);
  assert.equal((await f.pool.send(edit, MODEL, OPTIONS)).accountId, 'b');
  assertToolHistory(f.requests.at(-1));
});

test('invalid tool choices still fail normal request validation before transport', async t => {
  const f = await fixture(t), count = f.requests.length;
  const invalid = { ...edit, toolChoice: { type: 'function', function: { name: 'undeclared' } } };
  await assert.rejects(f.pool.send(invalid, MODEL, OPTIONS), { code: 'invalid_tool_choice', status: 400 });
  assert.equal(f.requests.length, count);
  assert.equal(f.diagnostics.some(event => event.event === 'account_history_inspection_failed'), false);
});

test('orphan, duplicate, out-of-order and mismatched receipts fail closed at every history position', async t => {
  const f = await fixture(t), count = f.requests.length;
  const call = { role: 'assistant', parts: [{ type: 'tool_call', id: 'read-1', name: 'read', arguments: { path: 'fixture.txt' } }] };
  const result = { role: 'user', parts: [{ type: 'tool_result', id: 'read-1', content: 'fixture text' }] };
  const later = { role: 'user', parts: [{ type: 'text', text: 'Continue.' }] };
  for (const messages of [
    [result], [result, later], [result, call], [call, result, result, later], [call, call, result],
    [call, { ...result, parts: [{ ...result.parts[0], name: 'different' }] }],
    [call, { ...result, role: 'assistant' }], [{ ...call, role: 'user' }, result],
    [{ ...result, parts: [{ ...result.parts[0], id: '' }] }]
  ]) {
    await assert.rejects(f.pool.send({ ...first, messages }, MODEL, OPTIONS), { code: 'invalid_tool_history', status: 400 });
  }
  assert.equal(f.requests.length, count, 'invalid receipts are never downgraded to text or sent upstream');
});

test('Responses previous-response reconstruction retains the call and receipt across account failover', async t => {
  const f = await fixture(t);
  const previous = normalize([...initial, followInput[1]]);
  const resumed = normalizeResponses({ model: MODEL, tools: [tool], previous_response_id: 'resp_synthetic',
    input: [followInput[2]] }, previous);
  f.fail('a');
  assert.equal((await f.pool.send(resumed, MODEL, OPTIONS)).accountId, 'b');
  assert.deepEqual(f.requests.slice(2).map(request => request.account), ['a', 'b']);
  assertToolHistory(f.requests.at(-1));
});

test('tool-history requests skip quota-protected accounts and preserve the all-protected error', async t => {
  const f = await fixture(t);
  f.pool.quotaManager = { isQuotaProtected: id => id === 'a', get: () => null };
  assert.equal((await f.pool.send(edit, MODEL, OPTIONS)).accountId, 'b');
  assert.deepEqual(f.requests.slice(2).map(request => request.account), ['b']);
  assertToolHistory(f.requests.at(-1));
  const count = f.requests.length;
  f.pool.quotaManager = { isQuotaProtected: () => true, get: () => null };
  await assert.rejects(f.pool.send(edit, MODEL, OPTIONS), { code: 'account_quota_protected', status: 429 });
  assert.equal(f.requests.length, count);
});
