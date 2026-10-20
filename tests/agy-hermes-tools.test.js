'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const fixture = require('./fixtures/hermes-0.21.7-tools.json');
const { normalizeChat } = require('../src/protocol');
const { capturedNativeClient } = require('../src/agy-client-profile');
const { HERMES_CLIENT_PROFILE, capturedHermesTool } = require('../src/agy-hermes-profile');
const { prepareToolAdapter } = require('../src/agy-tool-adapter');
const { SessionManager } = require('../src/session-manager');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const profile = { clientProfile: HERMES_CLIENT_PROFILE }, model = 'gemini-3.8-flash-high';
const suffix = '\n\nActive Hermes profile: default. Keep /tmp/terminal/patch/read_file intact.\nProject rule: use read_file literally in documentation.';
const user = { role: 'user', content: 'Do not rewrite read_file, patch or terminal in this user message.' };
const normalize = (history = [user]) => normalizeChat({ tools: structuredClone(fixture.tools), messages: [{ role: 'system', content: fixture.systemPrefix + suffix }, ...history] });

test('Hermes is selected by captured framework and capabilities, never generic SDK headers or invented session identity', () => {
  const req = { headers: { 'user-agent': 'OpenAI/Python 2.24.0' }, socket: { remoteAddress: '127.0.0.1' } }, n = normalize();
  assert.equal(capturedNativeClient(req, n), HERMES_CLIENT_PROFILE);
  const identity = new SessionManager().resolveIdentity(req, {}, n);
  assert.equal(identity.nativeClientProfile, HERMES_CLIENT_PROFILE);assert.equal(identity.reuseConversation, false);assert.equal(identity.sessionSource, 'fallback');
  for (const changed of [{ ...n, protocol: 'responses' }, { ...n, tools: [] }, { ...n, system: 'You are Hermes Agent.' }, { ...n, system: n.system.replace('# Finishing the job', '# Changed framework') }]) assert.equal(capturedNativeClient(req, changed), '');
  assert.equal(capturedNativeClient({}, n), HERMES_CLIENT_PROFILE);
});

test('Hermes hashes full declarations without depending on property order and retains unknown tools', () => {
  const n = normalize(), read = n.tools.find(t => t.name === 'read_file');
  assert.equal(capturedHermesTool(read), true);
  read.schema.properties = Object.fromEntries(Object.entries(read.schema.properties).reverse());assert.equal(capturedHermesTool(read), true);
  read.schema.properties.limit.maximum = 4000;assert.equal(capturedHermesTool(read), false);
  const a = prepareToolAdapter(n, profile);assert.ok(a.normalized.tools.some(t => t.name === 'read_file'));assert.ok(a.normalized.tools.some(t => t.name === 'run_command'));
  for (const name of ['search_files','tool_search','tool_describe','tool_call']) assert.deepEqual(a.normalized.tools.find(t => t.name === name), n.tools.find(t => t.name === name));
});

test('Hermes fixed framework rewrites known tool references while preserving user rules, real runtime and execution semantics', () => {
  const n = normalize(), original = structuredClone(n), a = prepareToolAdapter(n, profile), s = a.normalized.system;
  assert.match(s, /^You are Antigravity,/);assert.match(s, /Use view_file\/search_files to check/);assert.match(s, /plain terminal \(CLI\)/);
  assert.match(s, /https:\/\/hermes-agent\.nousresearch\.com\/docs/);assert.ok(s.endsWith(suffix));assert.deepEqual(a.normalized.messages, n.messages);assert.deepEqual(n, original);
  const command = a.normalized.tools.find(t => t.name === 'run_command');assert.match(command.description, /shell, and terminal backend/);assert.match(command.description, /Reserve run_command for/);
  assert.match(command.description, /sed\/awk \(use replace_file_content\)/);assert.match(command.description, /RunInBackground=true/);assert.match(command.description, /without a terminal/);
  assert.match(a.normalized.tools.find(t => t.name === 'replace_file_content').description, /fuzzy matching \(9 strategies\)/);
  assert.match(a.normalized.tools.find(t => t.name === 'write_to_file').description, /refuses \(file untouched\)/);
});

test('Hermes inclusive line ranges convert back to bounded line counts without inventing image support', () => {
  const a = prepareToolAdapter(normalize(), profile), tool = a.normalized.tools.find(t => t.name === 'view_file');
  assert.match(tool.description, /Cannot read images\/binary/);assert.match(tool.description, /next_offset/);assert.match(tool.description, /Use StartLine and inclusive EndLine/);
  const call = args => a.toClient({ name: 'view_file', id: 'r', arguments: args });
  assert.deepEqual(call({ AbsolutePath: '~/file.txt', StartLine: 10, EndLine: 29 }).arguments, { path: '~/file.txt', offset: 10, limit: 20 });
  assert.deepEqual(call({ AbsolutePath: 'relative.txt' }).arguments, { path: 'relative.txt' });
  assert.deepEqual(call({ AbsolutePath: '/f', EndLine: 1 }).arguments, { path: '/f', limit: 1 });
  for (const extra of [{ StartLine: 0 }, { StartLine: 10, EndLine: 9 }, { EndLine: 2001 }, { EndLine: 1.5 }, { Pages: '1-3' }]) assert.throws(() => call({ AbsolutePath: '/f', ...extra }), { code: 'invalid_tool_arguments' });
});

test('Hermes write and fuzzy patch values are preserved byte for byte including false and empty replacement', () => {
  const a = prepareToolAdapter(normalize(), profile), content = 'read_file old_string terminal\n';
  assert.deepEqual(a.toClient({ name: 'write_to_file', arguments: { TargetFile: '/f', CodeContent: content } }).arguments, { path: '/f', content });
  assert.deepEqual(a.toClient({ name: 'replace_file_content', arguments: { TargetFile: '/f', TargetContent: content, ReplacementContent: '', AllowMultiple: false, toolAction: 'Editing file', toolSummary: 'Edit' } }).arguments, { path: '/f', old_string: content, new_string: '', replace_all: false });
  assert.throws(() => a.toClient({ name: 'replace_file_content', arguments: { TargetFile: '/f', TargetContent: 'x', ReplacementContent: 'y', StartLine: 1 } }), { code: 'invalid_tool_arguments' });
});

test('Hermes terminal seconds, persistent environment and notification union remain distinct from native asynchronous wait', () => {
  const a = prepareToolAdapter(normalize(), profile), command = a.normalized.tools.find(t => t.name === 'run_command');
  assert.equal(command.schema.properties.ExecutionTimeoutSeconds.type, 'integer');assert.equal(command.schema.properties.WaitMsBeforeAsync, undefined);
  assert.match(command.description, /exported environment variables persist/);assert.equal(command.schema.properties.Notify.anyOf.length, 2);
  const args = { CommandLine: 'printf "$VALUE"', RunInBackground: true, ExecutionTimeoutSeconds: 45, Cwd: '/tmp/a b', Tty: true, Notify: ['READY'], HeartbeatSeconds: 60, PersistOnRelease: false };
  assert.deepEqual(a.toClient({ name: 'run_command', arguments: args }).arguments, { command: 'printf "$VALUE"', background: true, timeout: 45, workdir: '/tmp/a b', pty: true, notify: ['READY'], heartbeat: 60, persist_on_release: false });
  assert.deepEqual(a.toClient({ name: 'run_command', arguments: { CommandLine: 'true', Notify: false } }).arguments, { command: 'true', notify: false });
  for (const extra of [{ ExecutionTimeoutSeconds: 0 }, { ExecutionTimeoutSeconds: 0.5 }, { HeartbeatSeconds: -1 }, { Notify: ['x', 2] }, { Notify: {} }, { BypassSandbox: true }]) assert.throws(() => a.toClient({ name: 'run_command', arguments: { CommandLine: 'true', ...extra } }), { code: 'invalid_tool_arguments' });
});

test('Hermes named choice, native-name collision and other model paths retain existing contracts', () => {
  const n = normalize();n.toolChoice = { type: 'function', function: { name: 'read_file' } };
  const wire = buildDirectRequest(n, model, 'p', 's', '', null, profile);
  assert.deepEqual(wire.request.toolConfig.functionCallingConfig.allowedFunctionNames, ['view_file']);assert.doesNotMatch(JSON.stringify(wire), /hermes-0\.21\.7-captured|clientProfile/);
  n.tools.push({ name: 'view_file', schema: { type: 'object' }, description: 'User tool' });
  const a = prepareToolAdapter(n, profile);assert.ok(a.normalized.tools.some(t => t.name === 'read_file'));assert.match(a.normalized.system, /Use read_file\/search_files/);
  assert.equal(prepareToolAdapter(n, { ...profile, checkpoint: true }).normalized, n);assert.equal(prepareToolAdapter(n).normalized, n);
});

test('Hermes Chat tool calls, results and signatures survive persistence and restored agent history', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hermes-tools-'));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parts = [{ text: 'Reading.' }, { functionCall: { name: 'view_file', id: 'read-1', args: { AbsolutePath: '/f', StartLine: 10, EndLine: 29, toolAction: 'Reading file', toolSummary: 'File read' } }, thoughtSignature: 'actual-native-signature' }], requests = [], replies = [parts, [{ text: 'done' }]];
  const send = history => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'token', projectId: 'p', maxRetries: 0, localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:hermes-tools' }) }, fetchImpl: async (_u, options) => { requests.push(JSON.parse(options.body));return new Response(JSON.stringify({ candidates: [{ content: { parts: replies.shift() } }] })); } }).send(normalize(history), model, { sessionId: 'hermes-tools', nativeClientProfile: HERMES_CLIENT_PROFILE });
  const first = await send([user]);assert.equal(first.toolCalls[0].name, 'read_file');assert.deepEqual(first.toolCalls[0].arguments, { path: '/f', offset: 10, limit: 20 });
  const output = '{"content":"10|text","next_offset":30}';
  await send([user, { role: 'assistant', content: 'Reading.', tool_calls: [{ id: first.toolCalls[0].id, type: 'function', function: { name: first.toolCalls[0].name, arguments: JSON.stringify(first.toolCalls[0].arguments) } }] }, { role: 'tool', tool_call_id: first.toolCalls[0].id, content: output }]);
  assert.deepEqual(requests[1].request.contents[1].parts, parts);assert.deepEqual(requests[1].request.contents[2].parts[0].functionResponse, { id: 'read-1', name: 'view_file', response: { output: JSON.parse(output) } });
});
