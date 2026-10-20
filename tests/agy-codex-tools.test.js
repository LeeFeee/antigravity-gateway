'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const fixture = require('./fixtures/codex-exec-0.159.2-tools.json');
const { capturedNativeClient, CODEX_CLIENT_PROFILE } = require('../src/agy-client-profile');
const { prepareToolAdapter } = require('../src/agy-tool-adapter');
const { normalizeResponses } = require('../src/protocol');
const { SessionManager } = require('../src/session-manager');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const profile = { clientProfile: CODEX_CLIENT_PROFILE }, model = 'gemini-3.8-flash-high';
const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep exec_command and /tmp/workdir literally unchanged in this user instruction.' }] }];
const normalize = (messages = input) => normalizeResponses({ tools: structuredClone(fixture.tools), input: messages });

test('actual Codex identity requires the captured version, Responses, originator and explicit session', () => {
  const req = { headers: { ...fixture.headers }, socket: { remoteAddress: '127.0.0.1' } }, n = normalize();
  assert.equal(capturedNativeClient(req, n), CODEX_CLIENT_PROFILE);
  const manager = new SessionManager(), identity = manager.resolveIdentity(req, {}, n);
  assert.equal(identity.nativeClientProfile, CODEX_CLIENT_PROFILE);assert.equal(identity.nativeCompaction, undefined);
  for (const headers of [{ ...req.headers, originator: 'other' }, { ...req.headers, 'session-id': '' }, { ...req.headers, 'user-agent': 'codex_exec/0.159.3 (Mac)' }, { ...req.headers, 'user-agent': 'other/0.159.2' }]) {
    assert.equal(capturedNativeClient({ headers }, n), '');
  }
  for (const protocol of ['anthropic', 'chat']) assert.equal(capturedNativeClient(req, { ...n, protocol }), '');
  assert.equal(capturedNativeClient({ headers: { 'user-agent': 'claude-cli/2.1.285 (external)', 'x-claude-code-session-id': 's' } }, { protocol: 'anthropic' }), 'claude-code-2.1.285');
});

test('Codex declarations translate actual capabilities and leave custom patch grammar and user text unchanged', () => {
  const n = normalize(), original = structuredClone(n), a = prepareToolAdapter(n, profile);
  assert.deepEqual(a.normalized.tools.map(t => t.name), ['run_command', 'manage_task', 'apply_patch', 'view_file']);
  const command = a.normalized.tools[0], session = a.normalized.tools[1], image = a.normalized.tools[3];
  assert.deepEqual(Object.keys(command.schema.properties), ['CommandLine', 'Justification', 'Login', 'MaxOutputTokens', 'ApprovalPrefix', 'BypassSandbox', 'Shell', 'Tty', 'Cwd', 'WaitMsBeforeAsync', 'toolAction', 'toolSummary']);
  assert.equal(command.schema.properties.BypassSandbox.type, 'boolean');assert.equal(command.schema.properties.WaitMsBeforeAsync.type, 'number');
  assert.match(command.schema.properties.WaitMsBeforeAsync.description, /250-30000/);
  assert.deepEqual(session.schema.properties.Action.enum, ['status', 'send_input']);assert.equal(session.schema.properties.TaskId.type, 'number');
  assert.deepEqual(image.schema.properties.ImageDetail.enum, ['high', 'original']);
  assert.deepEqual(a.normalized.tools[2], n.tools[2]);assert.equal(a.normalized.tools[2].kind, 'custom');
  assert.deepEqual(n, original);assert.equal(a.normalized.messages, n.messages);
});

test('Codex command strings and optional fields are reversible, including permission requests without escalation by the gateway', () => {
  const a = prepareToolAdapter(normalize(), profile), args = { CommandLine: 'printf "%s" "$VALUE"  ', Cwd: '/tmp/a b', WaitMsBeforeAsync: 500, Login: false, Tty: true, Shell: '/bin/zsh', MaxOutputTokens: 100, BypassSandbox: true, Justification: 'Allow this command?', ApprovalPrefix: ['printf'], toolAction: 'Displaying value', toolSummary: 'Value display' };
  const call = { id: 'command', name: 'run_command', arguments: args, thoughtSignature: 'original' };
  assert.deepEqual(a.toClient(call), { ...call, name: 'exec_command', arguments: { cmd: args.CommandLine, workdir: args.Cwd, yield_time_ms: 500, login: false, tty: true, shell: '/bin/zsh', max_output_tokens: 100, sandbox_permissions: 'require_escalated', justification: args.Justification, prefix_rule: ['printf'] } });
  assert.deepEqual(a.toClient({ ...call, arguments: { CommandLine: 'true' } }).arguments, { cmd: 'true' });
  assert.deepEqual(a.toClient({ ...call, arguments: { CommandLine: 'true', BypassSandbox: false } }).arguments, { cmd: 'true', sandbox_permissions: 'use_default' });
  for (const extra of [{ IsDaemon: true }, { RunPersistent: true }, { TimeoutMs: 100 }, { BypassSandbox: 'require_escalated' }]) assert.throws(() => a.toClient({ ...call, arguments: { CommandLine: 'true', ...extra } }), { code: 'invalid_tool_arguments' });
});

test('manage_task supports only actual stdin and output-poll semantics with unchanged session identity', () => {
  const a = prepareToolAdapter(normalize(), profile), call = { name: 'manage_task', id: 'poll' };
  assert.deepEqual(a.toClient({ ...call, arguments: { Action: 'status', TaskId: 123 } }).arguments, { session_id: 123 });
  assert.deepEqual(a.toClient({ ...call, arguments: { Action: 'status', TaskId: 123, Input: '', WaitMs: 5000, MaxOutputTokens: 300 } }).arguments, { chars: '', session_id: 123, yield_time_ms: 5000, max_output_tokens: 300 });
  assert.deepEqual(a.toClient({ ...call, arguments: { Action: 'send_input', TaskId: 123, Input: 'answer\n' } }).arguments, { session_id: 123, chars: 'answer\n' });
  for (const args of [{ Action: 'kill', TaskId: 123 }, { Action: 'list' }, { TaskId: 123 }, { Action: 'status', TaskId: 123, Input: 'not a poll' }, { Action: 'send_input', TaskId: 123 }, { Action: 'status', TaskId: '123' }]) assert.throws(() => a.toClient({ ...call, arguments: args }), { code: 'invalid_tool_arguments' });
});

test('image-only view_file preserves image detail and never advertises text-reading capabilities', () => {
  const a = prepareToolAdapter(normalize(), profile), call = { name: 'view_file', arguments: { AbsolutePath: '/tmp/image.png', ImageDetail: 'original' } };
  assert.deepEqual(a.toClient(call), { name: 'view_image', arguments: { path: '/tmp/image.png', detail: 'original' } });
  assert.match(a.normalized.tools.find(t => t.name === 'view_file').description, /local image/);
  for (const extra of [{ StartLine: 1 }, { Pages: '1' }, { ImageDetail: 'low' }]) assert.throws(() => a.toClient({ ...call, arguments: { AbsolutePath: '/a.png', ...extra } }), { code: 'invalid_tool_arguments' });
});

test('unsupported permissions, missing stdin capability and reserved names stay on the compatibility path', () => {
  for (const mutate of [n => n.tools[0].schema.properties.sandbox_permissions.enum.push('another-mode'), n => n.tools[0].schema.properties.sandbox_permissions.default = 'require_escalated', n => n.tools[0].schema.properties.extra = { type: 'string' }, n => n.tools[0].description += ' changed first line']) {
    const n = normalize();mutate(n);assert.equal(prepareToolAdapter(n, profile).normalized.tools[0].name, 'exec_command');
  }
  const n = normalize();delete n.tools[1].schema.properties.chars;assert.equal(prepareToolAdapter(n, profile).normalized.tools[1].name, 'write_stdin');
  for (const [index, alias] of [[0, 'run_command'], [1, 'manage_task'], [3, 'view_file']]) {
    const copy = normalize();copy.tools.push({ name: alias });assert.equal(prepareToolAdapter(copy, profile).normalized.tools[index].name, copy.tools[index].name);
  }
  for (const options of [{}, { clientProfile: 'codex-exec-unknown' }, { ...profile, checkpoint: true }]) { const n = normalize();assert.equal(prepareToolAdapter(n, options).normalized, n); }
});

test('named tool selection uses native names but no client-profile or gateway fields appear upstream', () => {
  const n = normalize();n.toolChoice = { type: 'function', name: 'exec_command' };
  const wire = buildDirectRequest(n, model, 'p', 's', '', null, { ...profile });
  assert.deepEqual(wire.request.toolConfig.functionCallingConfig.allowedFunctionNames, ['run_command']);
  assert.equal(n.toolChoice.name, 'exec_command');assert.doesNotMatch(JSON.stringify(wire), /codex-exec-0\.159\.2|clientProfile|toolAdapter/);
});

test('parallel native commands restore signed Responses history after restart alongside unchanged custom patch calls', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-tools-'));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = (id, file) => ({ functionCall: { id, name: 'run_command', args: { CommandLine: 'cat '+file, Login: false, toolAction: 'Reading file', toolSummary: 'File read' } } });
  const firstParts = [{ text: 'Reading both.' }, { ...command('a','first.txt'), thoughtSignature: 'actual-first-signature' }, command('b','second.txt')];
  const patch = '*** Begin Patch\n*** Add File: combined.txt\n+two lines\n*** End Patch';
  const patchParts = [{ functionCall: { id: 'c', name: 'apply_patch', args: { input: patch } }, thoughtSignature: 'actual-patch-signature' }];
  const replies = [firstParts, patchParts, [{ text: 'done' }]], requests = [];
  const send = input => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'token', projectId: 'p', maxRetries: 0,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:codex-tools' }) },
    fetchImpl: async (_u, o) => { requests.push(JSON.parse(o.body));return new Response(JSON.stringify({ candidates: [{ content: { parts: replies.shift() } }] })); }
  }).send(normalize(input), model, { sessionId: 'codex-tools', nativeClientProfile: CODEX_CLIENT_PROFILE });
  const first = await send(input);assert.deepEqual(first.toolCalls.map(c => c.name), ['exec_command','exec_command']);
  const history = [...input, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading both.' }] },
    ...first.toolCalls.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) })),
    { type: 'function_call_output', call_id: 'b', output: 'B' }, { type: 'function_call_output', call_id: 'a', output: 'A' }];
  const second = await send(history);assert.equal(second.toolCalls[0].name, 'apply_patch');assert.equal(second.toolCalls[0].arguments.input, patch);
  await send([...history, { type: 'custom_tool_call', call_id: 'c', name: 'apply_patch', input: patch }, { type: 'custom_tool_call_output', call_id: 'c', output: 'patch applied' }]);
  assert.deepEqual(requests[1].request.contents[1].parts, firstParts);assert.deepEqual(requests[2].request.contents[1].parts, firstParts);
  assert.deepEqual(requests[1].request.contents[2].parts.map(p => p.functionResponse.name), ['run_command','run_command']);
  assert.deepEqual(requests[2].request.contents[3].parts, patchParts);assert.doesNotMatch(JSON.stringify(requests.slice(1)), /skip_thought_signature_validator/);
});
