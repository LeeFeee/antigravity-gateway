'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RobinConversationStore } = require('../src/robin-conversations');
const { SessionManager } = require('../src/session-manager');

const cursor = { conversationId: 'c_conversation1234', parentRequestId: 'r_request1234', parentResponseId: 'rc_response1234' };

test('Robin cursors survive restart without persisting client IDs, prompts or answers', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-cursors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const options = { account: { id: 'r', subjectId: 's' }, directory, ttlMs: 10000, now: () => now };
  const first = new RobinConversationStore(options);
  first.set('private-client-conversation', cursor);
  const stored = fs.readFileSync(first.file, 'utf8');
  assert.ok(!stored.includes('private-client-conversation'));
  assert.deepEqual(Object.keys(Object.values(JSON.parse(stored).cursors)[0]).sort(),
    ['at', 'conversationId', 'parentRequestId', 'parentResponseId']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  const restarted = new RobinConversationStore(options);
  assert.deepEqual(restarted.get('private-client-conversation'), cursor);
  assert.equal(restarted.get('another-client-conversation'), null);
  const otherAccount = new RobinConversationStore({ ...options, account: { id: 'other', subjectId: 's' } });
  assert.equal(otherAccount.get('private-client-conversation'), null);
  const otherOwner = new RobinConversationStore({ ...options, account: { id: 'r', subjectId: 'other-subject' } });
  assert.equal(otherOwner.get('private-client-conversation'), null);
  now += 10000;
  assert.equal(restarted.get('private-client-conversation'), null);
});

test('Robin cursor capacity, invalid identifiers and account deletion remain bounded', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-cursors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new RobinConversationStore({ directory, account: { id: 'r' }, capacity: 2 });
  store.set('a', cursor); store.set('b', cursor); store.set('c', cursor);
  assert.equal(store.get('a'), null); assert.deepEqual(store.get('c'), cursor);
  store.set('d', { ...cursor, parentRequestId: 'invented' }); assert.equal(store.get('d'), null);
  store.forget(); assert.equal(fs.existsSync(store.file), false); assert.equal(store.cursors.size, 0);
});

test('saved upstream conversations require a real conversation identifier, not a user ID or prompt fingerprint', () => {
  const manager = new SessionManager();
  const req = { headers: { 'user-agent': 'client' }, socket: { remoteAddress: '127.0.0.1' } };
  const normalized = { messages: [{ role: 'user', text: 'hello' }] };
  const fallback = manager.resolveIdentity(req, {}, normalized);
  assert.equal(fallback.reuseConversation, false);
  assert.equal(manager.resolveIdentity(req, { user: 'fixed-user' }, normalized).reuseConversation, false);
  assert.equal(manager.resolveIdentity(req, { metadata: { user_id: 'fixed-user' } }, normalized).reuseConversation, false);
  assert.equal(manager.resolveIdentity({ ...req, headers: { ...req.headers, 'x-session-id': 'thread' } }, {}, normalized).reuseConversation, true);
  assert.equal(manager.resolveIdentity(req, { metadata: { conversation_id: 'thread' } }, normalized).reuseConversation, true);
  assert.equal(manager.resolveIdentity(req, {}, normalized, { sessionId: 'previous-thread' }).reuseConversation, true);
});
