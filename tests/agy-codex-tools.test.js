'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const fixture = require('./fixtures/codex-exec-0.159.2-tools.json');
const { capturedNativeClient, CODEX_CLIENT_PROFILE } = require('../src/agy-client-profile');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');
const { normalizeResponses } = require('../src/protocol');
const { SessionManager } = require('../src/session-manager');
const { DirectAntigravityProvider, buildDirectRequest } = require('../src/direct-provider');
const { AgySessionStore } = require('../src/agy-session-state');
const model = 'gemini-3.8-flash-high';
const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep exec_command and /tmp/workdir literally unchanged in this user instruction.' }] }];
const normalize = (messages = input) => normalizeResponses({ tools: structuredClone(fixture.tools), input: messages });

test('旧 Codex 会话识别仍要求实抓版本、Responses、originator 和明确会话，不因此启用旧工具别名', () => {
  const req = { headers: { ...fixture.headers }, socket: { remoteAddress: '127.0.0.1' } }, normalized = normalize();
  assert.equal(capturedNativeClient(req, normalized), CODEX_CLIENT_PROFILE);
  assert.equal(new SessionManager().resolveIdentity(req, {}, normalized).nativeClientProfile, CODEX_CLIENT_PROFILE);
  for (const headers of [{ ...req.headers, originator: 'other' }, { ...req.headers, 'session-id': '' }, { ...req.headers, 'user-agent': 'codex_exec/0.159.3 (Mac)' }]) assert.equal(capturedNativeClient({ headers }, normalized), '');
  const adapter = prepareAntigravityTools(normalized, { clientProfile: CODEX_CLIENT_PROFILE });
  assert.ok(adapter.declarations.every(tool => tool.name.startsWith('mcp_')));
  assert.equal(adapter.records.length, fixture.tools.length);
  assert.deepEqual(adapter.records.find(record => record.clientName === 'apply_patch').clientFormat, fixture.tools.find(tool => tool.name === 'apply_patch').format);
});

test('Codex 命令原文、权限请求、PTY、时间单位和 stdin 会话编号无损保留', () => {
  const normalized = normalize(), before = structuredClone(normalized), adapter = prepareAntigravityTools(normalized);
  const examples = [
    ['exec_command', { cmd: 'printf "%s" "$VALUE"  ', workdir: '/tmp/a b', yield_time_ms: 500, login: false, tty: true, shell: '/bin/zsh', max_output_tokens: 100, sandbox_permissions: 'require_escalated', justification: 'Controlled test.', prefix_rule: ['printf'] }],
    ['exec_command', { cmd: 'fixture only', sandbox_permissions: 'use_default' }],
    ['write_stdin', { session_id: 123, chars: '', yield_time_ms: 5000, max_output_tokens: 300 }],
    ['write_stdin', { session_id: 123, chars: 'answer\n' }],
    ['view_image', { path: '/tmp/image.png', detail: 'original' }]
  ];
  for (const [name, args] of examples) {
    const call = { name, arguments: args, id: name, thoughtSignature: 'retained-signature' };
    assert.deepEqual(adapter.toClient(adapter.toProvider(call)), call);
  }
  for (const [name, args] of [['exec_command', { cmd: 'x', sandbox_permissions: 'not-a-real-mode' }], ['write_stdin', { session_id: '123' }], ['view_image', { path: '/tmp/a.png', detail: 'low' }]]) assert.throws(() => adapter.toProvider({ name, arguments: args }));
  assert.deepEqual(normalized, before);
  assert.equal(adapter.normalized.system, normalized.system);
  assert.deepEqual(adapter.normalized.messages, normalized.messages);
});

test('旧 Codex 工具 Schema 更新仍完整兼容，named choice 指向完整声明', () => {
  const normalized = normalize();
  normalized.tools[0].schema.properties.sandbox_permissions.enum.push('future-mode');
  normalized.toolChoice = { type: 'function', name: 'exec_command' };
  const adapter = prepareAntigravityTools(normalized);
  assert.deepEqual(adapter.toClient(adapter.toProvider({ name: 'exec_command', arguments: { cmd: 'x', sandbox_permissions: 'future-mode' } })).arguments, { cmd: 'x', sandbox_permissions: 'future-mode' });
  const wire = buildDirectRequest(normalized, model, 'p', 's');
  assert.deepEqual(wire.request.toolConfig.functionCallingConfig.allowedFunctionNames, [adapter.toProviderName('exec_command')]);
  assert.equal(normalized.toolChoice.name, 'exec_command');
});

test('Codex 并行调用、乱序回执和 custom 补丁在重启后恢复原上游别名及签名', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-contract-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = prepareAntigravityTools(normalize());
  const upstream = call => { const c = adapter.toProvider(call); return { functionCall: { id: c.id, name: c.name, args: c.arguments }, thoughtSignature: `signed-${call.id}` }; };
  const firstParts = [{ text: 'Reading both.' }, upstream({ id: 'a', name: 'exec_command', arguments: { cmd: 'controlled first', login: false } }), upstream({ id: 'b', name: 'exec_command', arguments: { cmd: 'controlled second' } })];
  const patch = '*** Begin Patch\n*** Add File: combined.txt\n+two lines\n*** End Patch';
  const patchParts = [upstream({ id: 'c', name: 'apply_patch', kind: 'custom', input: patch })];
  const replies = [firstParts, patchParts, [{ text: 'done' }]], requests = [];
  const send = messages => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'synthetic', projectId: 'p', maxRetries: 0,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:codex-contract' }) },
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ candidates: [{ content: { parts: replies.shift() } }] })); }
  }).send(normalize(messages), model, { sessionId: 'codex-contract', nativeClientProfile: CODEX_CLIENT_PROFILE });
  const first = await send(input);
  assert.deepEqual(first.toolCalls.map(call => call.name), ['exec_command', 'exec_command']);
  const history = [...input, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading both.' }] },
    ...first.toolCalls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })),
    { type: 'function_call_output', call_id: 'b', output: 'B' }, { type: 'function_call_output', call_id: 'a', output: 'A' }];
  const second = await send(history); assert.equal(second.toolCalls[0].name, 'apply_patch'); assert.equal(second.toolCalls[0].arguments.input, patch);
  await send([...history, { type: 'custom_tool_call', call_id: 'c', name: 'apply_patch', input: patch }, { type: 'custom_tool_call_output', call_id: 'c', output: 'patch applied' }]);
  assert.deepEqual(requests[1].request.contents[1].parts, firstParts);
  assert.deepEqual(requests[2].request.contents[1].parts, firstParts);
  const receipts = requests[1].request.contents[2].parts.map(part => [part.functionResponse.id, part.functionResponse.name, part.functionResponse.response.output]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(receipts, [['a', firstParts[1].functionCall.name, 'A'], ['b', firstParts[2].functionCall.name, 'B']]);
  assert.deepEqual(requests[2].request.contents[3].parts, patchParts);
  assert.doesNotMatch(JSON.stringify(requests), /skip_thought_signature_validator/);
});
