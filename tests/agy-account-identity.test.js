'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');

const model = 'gemini-3.8-flash-high';
const account = { id: 'retained-record', subjectId: 'google-A', email: 'a@example.com', accessToken: 'access-A',
  refreshToken: 'refresh-A', projectId: 'project-A', expiresAt: '2099-01-01T00:00:00.000Z' };
const auth = changes => new ManagedAccountAuthProvider({ account: { ...account, ...changes }, store: { save: value => value } });
const namespace = changes => auth(changes).load().sourcePath;
const first = { messages: [{ role: 'user', text: 'Remember amber.' }] };
const follow = { messages: [...first.messages, { role: 'assistant', text: 'READY' }, { role: 'user', text: 'Recall it.' }] };

test('managed private namespace follows Google subject rather than a reused local record ID', () => {
  assert.notEqual(namespace({}), namespace({ subjectId: 'google-B', email: 'b@example.com', accessToken: 'access-B', refreshToken: 'refresh-B' }));
  assert.equal(namespace({}), namespace({ accessToken: 'new-access', refreshToken: 'rotated-refresh', email: 'renamed@example.com' }));
  assert.notEqual(namespace({}), namespace({ id: 'other-record' }));
  assert.match(namespace({}), /^managed-account:retained-record:identity:[a-f0-9]{64}$/);
  assert.doesNotMatch(namespace({}), /google-A|a@example|access-A|refresh-A/);
});

test('email fallback is normalized; missing identities are isolated by grant rather than project', () => {
  assert.equal(namespace({ subjectId: '', email: ' A@Example.COM ' }), namespace({ subjectId: '', email: 'a@example.com', accessToken: 'other', refreshToken: 'rotated' }));
  assert.notEqual(namespace({ subjectId: '' }), namespace({ subjectId: '', email: 'b@example.com' }));
  assert.equal(namespace({ subjectId: '', email: '' }), namespace({ subjectId: '', email: '', accessToken: 'refreshed-access' }));
  assert.notEqual(namespace({ subjectId: '', email: '' }), namespace({ subjectId: '', email: '', refreshToken: 'other-grant' }));
  assert.notEqual(namespace({ subjectId: '', email: '', refreshToken: '' }), namespace({ subjectId: '', email: '', refreshToken: '', accessToken: 'other-access' }));
  assert.notEqual(namespace({ subjectId: '', email: '', accessToken: '', refreshToken: '' }), namespace({ subjectId: '', email: '', accessToken: '', refreshToken: '' }));
});

test('managed auth refresh preserves known identity namespace and its restarted representation', async () => {
  let saved;
  const provider = new ManagedAccountAuthProvider({ account: { ...account, expiresAt: '2000-01-01', clientId: 'client', clientSecret: 'secret' },
    store: { save: value => (saved = value) },
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })) });
  const before = provider.load().sourcePath;
  const record = await provider.get();
  assert.equal(record.sourcePath, before);
  assert.equal(new ManagedAccountAuthProvider({ account: saved, store: {} }).load().sourcePath, before);
  assert.equal(saved.refreshToken, 'new-refresh');
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-identity-tests-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const send = (changes, normalized, parts, localAuth = auth(changes)) => new DirectAntigravityProvider({
    localAuth, sessionStore: new AgySessionStore({ directory }), maxRetries: 0,
    accessToken: account.accessToken, projectId: account.projectId,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { headers: { 'content-type': 'application/json' } });
    }
  }).send(normalized, model, { sessionId: 'same-client-session' });
  return { directory, requests, send };
}

test('same record replacement cannot restore private answer signatures or native trajectory', async t => {
  const f = fixture(t);
  await f.send({}, first, [{ text: 'READY', thoughtSignature: 'private-A' }]);
  await f.send({ accessToken: 'refreshed-access', refreshToken: 'rotated-refresh' }, follow, [{ text: 'amber', thoughtSignature: 'private-A-2' }]);
  assert.equal(f.requests[1].request.labels.cascade_id, f.requests[0].request.labels.cascade_id);
  assert.match(JSON.stringify(f.requests[1]), /private-A/);
  await f.send({ subjectId: 'google-B', email: 'b@example.com', accessToken: 'access-B', refreshToken: 'refresh-B' }, follow, [{ text: 'amber', thoughtSignature: 'private-B' }]);
  assert.notEqual(f.requests[2].request.labels.cascade_id, f.requests[0].request.labels.cascade_id);
  assert.doesNotMatch(JSON.stringify(f.requests[2]), /private-A|google-A|google-B|managed-account|same-client-session/);
  const after = { messages: [...follow.messages, { role: 'assistant', text: 'amber' }, { role: 'user', text: 'Again.' }] };
  await f.send({ subjectId: 'google-B', email: 'b@example.com' }, after, [{ text: 'amber' }]);
  assert.equal(f.requests[3].request.labels.cascade_id, f.requests[2].request.labels.cascade_id);
  assert.match(JSON.stringify(f.requests[3]), /private-B/);
  assert.doesNotMatch(JSON.stringify(f.requests[3]), /private-A/);
});

test('unbound legacy private cache is not silently adopted after upgrade', async t => {
  const f = fixture(t);
  const legacyAuth = { load: () => ({ accessToken: account.accessToken, projectId: account.projectId, sourcePath: 'managed-account:retained-record' }), isConfigured: () => false };
  await f.send({}, first, [{ text: 'READY', thoughtSignature: 'unbound-legacy-signature' }], legacyAuth);
  await f.send({}, follow, [{ text: 'amber' }]);
  assert.notEqual(f.requests[1].request.labels.cascade_id, f.requests[0].request.labels.cascade_id);
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /unbound-legacy-signature/);
  assert.equal(fs.readdirSync(f.directory).filter(n => n.endsWith('.json')).length, 2, 'old state remains recoverable until normal cleanup');
});

test('client supplied tool signatures remain intact when the Google identity changes', async t => {
  const f = fixture(t);
  const history = { messages: [{ role: 'user', text: 'Read.' },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'read-1', name: 'Read', arguments: { path: 'owned.txt' }, thoughtSignature: 'client-owned-signature' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'read-1', content: 'amber' }] }] };
  await f.send({}, history, [{ text: 'amber' }]);
  await f.send({ subjectId: 'google-B' }, history, [{ text: 'amber' }]);
  for (const r of f.requests)assert.equal(r.request.contents[1].parts.find(p => p.functionCall).thoughtSignature, 'client-owned-signature');
});
