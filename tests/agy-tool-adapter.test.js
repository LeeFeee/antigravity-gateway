'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { prepareToolAdapter } = require('../src/agy-tool-adapter');
const { normalizeAnthropic } = require('../src/protocol');
const { buildDirectRequest, DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore, newState, recordStreamRecovery } = require('../src/agy-session-state');
const profile = { clientProfile: 'claude-code-2.1.285' }, model = 'gemini-3.8-flash-high';
const tools = [
  { name: 'Read', description: 'Reads a file from the local filesystem.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, pages: { type: 'string' } }, required: ['file_path'], additionalProperties: false } },
  { name: 'Write', description: 'Writes a file to the local filesystem, overwriting if one exists.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'], additionalProperties: false } }
];
const user = { role: 'user', content: 'Read /tmp/Read.txt. Do not change the literal word Read in this message.' };
const normalize = messages => normalizeAnthropic({ tools, messages, system: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\nUse the Read tool and `Write`. Keep permission rules and workspace /tmp/Read unchanged." });
// Actual declarations captured from the installed Claude Code 2.1.285 CLI.
const editShell = require('./fixtures/claude-code-2.1.285-edit-bash.json');
const normalizeAll = messages => normalizeAnthropic({ tools: structuredClone([...tools, ...editShell]), messages });

test('captured Edit and Bash schemas expose native equivalents without inventing line scopes or terminal capabilities', () => {
  const n = normalizeAll([user]), original = structuredClone(n), a = prepareToolAdapter(n, profile);
  const edit = a.normalized.tools.find(t => t.name === 'replace_file_content'), bash = a.normalized.tools.find(t => t.name === 'run_command');
  assert.deepEqual(Object.keys(edit.schema.properties), ['TargetFile', 'TargetContent', 'ReplacementContent', 'AllowMultiple', 'toolAction', 'toolSummary']);
  assert.deepEqual(edit.schema.required, ['TargetFile', 'TargetContent', 'ReplacementContent', 'toolSummary', 'toolAction']);
  assert.equal(edit.schema.properties.AllowMultiple.default, false);
  assert.match(edit.description, /must use view_file to read/);assert.match(edit.description, /`TargetContent` must match/);
  assert.match(edit.description, /`AllowMultiple: true`/);assert.doesNotMatch(edit.description, /\bold_string\b|\breplace_all\b/);
  assert.deepEqual(Object.keys(bash.schema.properties), ['CommandLine', 'TimeoutMs', 'Description', 'RunInBackground', 'BypassSandbox', 'toolAction', 'toolSummary']);
  assert.deepEqual(bash.schema.required, ['CommandLine', 'toolSummary', 'toolAction']);
  assert.equal(bash.schema.properties.TimeoutMs.type, 'number');
  assert.match(bash.description, /`TimeoutMs` is in milliseconds: default 120000, max 600000/);
  assert.match(bash.description, /default 1800000, max 7200000/);assert.match(bash.description, /Commit or push only when the user asks/);
  assert.match(bash.description, /Working directory persists/);assert.match(bash.description, /Shell state .* does not persist/);
  for (const name of ['Cwd', 'WaitMsBeforeAsync', 'IsDaemon', 'RunPersistent', 'RequestedTerminalID']) assert.ok(!Object.hasOwn(bash.schema.properties, name));
  for (const name of ['StartLine', 'EndLine', 'Instruction', 'Description', 'TargetLintErrorIds']) assert.ok(!Object.hasOwn(edit.schema.properties, name));
  assert.deepEqual(n, original);assert.equal(a.normalized.messages, n.messages);
});

test('exact replacements, empty replacement strings and optional replace-all are lossless', () => {
  const a = prepareToolAdapter(normalizeAll([user]), profile), old = '\tRead `$HOME`\n原文', replacement = 'Write `command`\n新文';
  const call = { id: 'edit-1', name: 'replace_file_content', arguments: { TargetFile: '/tmp/Read file', TargetContent: old, ReplacementContent: replacement, AllowMultiple: true, toolAction: 'Editing file', toolSummary: 'Text replacement' }, thoughtSignature: 'untouched' };
  assert.deepEqual(a.toClient(call), { ...call, name: 'Edit', arguments: { file_path: '/tmp/Read file', old_string: old, new_string: replacement, replace_all: true } });
  for (const setting of [undefined, false]) {
    const args = { TargetFile: '/a', TargetContent: 'x', ReplacementContent: '', ...(setting === undefined ? {} : { AllowMultiple: setting }) };
    assert.deepEqual(a.toClient({ ...call, arguments: JSON.stringify(args) }).arguments,
      { file_path: '/a', old_string: 'x', new_string: '', ...(setting === undefined ? {} : { replace_all: setting }) });
  }
});

test('shell command, execution timeout, background flag and sandbox request retain distinct meanings', () => {
  const a = prepareToolAdapter(normalizeAll([user]), profile), command = 'printf "%s\\n" "$VALUE"  ', description = 'Display the current value';
  const call = { id: 'shell-1', name: 'run_command', arguments: { CommandLine: command, TimeoutMs: 7200000, RunInBackground: true, Description: description, BypassSandbox: false, toolAction: 'Displaying value', toolSummary: 'Value output' } };
  assert.deepEqual(a.toClient(call), { ...call, name: 'Bash', arguments: { command, timeout: 7200000, description, run_in_background: true, dangerouslyDisableSandbox: false } });
  assert.deepEqual(a.toClient({ ...call, arguments: { CommandLine: command } }).arguments, { command });
  assert.deepEqual(a.toClient({ ...call, arguments: { CommandLine: command, RunInBackground: false, BypassSandbox: true } }).arguments,
    { command, run_in_background: false, dangerouslyDisableSandbox: true });
});

test('unavailable native controls and malformed arguments are rejected rather than silently dropped', () => {
  const a = prepareToolAdapter(normalizeAll([user]), profile);
  for (const extra of [{ StartLine: 1 }, { EndLine: 9 }, { Instruction: 'anything' }, { AllowMultiple: 'yes' }]) {
    assert.throws(() => a.toClient({ name: 'replace_file_content', arguments: { TargetFile: '/a', TargetContent: 'x', ReplacementContent: 'y', ...extra } }), { code: 'invalid_tool_arguments' });
  }
  for (const extra of [{ Cwd: '/a' }, { WaitMsBeforeAsync: 1000 }, { IsDaemon: true }, { RunPersistent: true }, { RequestedTerminalID: 'one' }, { TimeoutMs: '1000' }, { BypassSandbox: 'yes' }]) {
    assert.throws(() => a.toClient({ name: 'run_command', arguments: { CommandLine: 'true', ...extra } }), { code: 'invalid_tool_arguments' });
  }
  for (const name of ['run_command', 'replace_file_content']) for (const arguments_ of ['{', [], null, {}]) {
    assert.throws(() => a.toClient({ name, arguments: arguments_ }), { code: 'invalid_tool_arguments' });
  }
  const n = normalizeAll([user]);delete n.tools.find(t => t.name === 'Bash').schema.properties.timeout;
  const limited = prepareToolAdapter(n, profile);assert.ok(!limited.normalized.tools.find(t => t.name === 'run_command').schema.properties.TimeoutMs);
  assert.throws(() => limited.toClient({ name: 'run_command', arguments: { CommandLine: 'true', TimeoutMs: 1000 } }), { code: 'invalid_tool_arguments' });
});

test('Edit and Bash selection is reversible and profile/schema/collision checks remain per-tool', () => {
  for (const [name, alias] of [['Edit', 'replace_file_content'], ['Bash', 'run_command']]) {
    const n = normalizeAll([user]);n.toolChoice = { type: 'function', function: { name } };
    assert.equal(prepareToolAdapter(n, profile).normalized.toolChoice.function.name, alias);
    for (const mutate of [t => t.description = 'Different behavior', t => t.schema.properties.extra = { type: 'boolean' }, t => t.schema.required.push('extra')]) {
      const copy = structuredClone(n);mutate(copy.tools.find(t => t.name === name));assert.ok(prepareToolAdapter(copy, profile).normalized.tools.some(t => t.name === name));
    }
    n.tools.push({ name: alias, schema: { type: 'object', properties: {} } });assert.ok(prepareToolAdapter(n, profile).normalized.tools.some(t => t.name === name));
    assert.equal(prepareToolAdapter(n, { clientProfile: 'unknown' }).normalized, n);
  }
  const n = normalizeAll([user]);n.tools = n.tools.filter(t => t.name !== 'Read');
  assert.match(prepareToolAdapter(n, profile).normalized.tools.find(t => t.name === 'replace_file_content').description, /You must Read/);
});

test('issued Edit and Bash calls retain native signed history and correlated client error receipts across restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-edit-shell-'));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const native = [
    { functionCall: { id: 'e', name: 'replace_file_content', args: { TargetFile: '/a', TargetContent: 'old', ReplacementContent: 'new', AllowMultiple: false, toolAction: 'Editing text', toolSummary: 'Text edit' } }, thoughtSignature: 'edit-signature' },
    { functionCall: { id: 'b', name: 'run_command', args: { CommandLine: 'unchanged command', TimeoutMs: 100, RunInBackground: false, toolAction: 'Running command', toolSummary: 'Command execution' } }, thoughtSignature: 'shell-signature' }
  ], requests = [];
  const send = messages => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'token', projectId: 'p', maxRetries: 0,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:edit-shell' }) },
    fetchImpl: async (_u, o) => { requests.push(JSON.parse(o.body));return new Response(JSON.stringify({ candidates: [{ content: { parts: requests.length === 1 ? native : [{ text: 'done' }] } }] })); }
  }).send(normalizeAll(messages), model, { sessionId: 'edit-shell', nativeClientProfile: profile.clientProfile });
  const first = await send([user]);assert.deepEqual(first.toolCalls.map(c => c.name), ['Edit', 'Bash']);
  const messages = [user, { role: 'assistant', content: first.toolCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })) },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e', content: 'exact replacement applied' }, { type: 'tool_result', tool_use_id: 'b', content: 'permission denied', is_error: true }] }];
  await send(messages);const contents = requests.at(-1).request.contents;
  assert.deepEqual(contents[1].parts, native);
  assert.deepEqual(contents[2].parts.map(p => p.functionResponse.name), ['replace_file_content', 'run_command']);
  assert.match(JSON.stringify(contents[2]), /permission denied/);assert.doesNotMatch(JSON.stringify(contents[2]), /toolAction|toolSummary/);
  assert.ok(first.toolCalls.every(c => !Object.hasOwn(c.arguments, 'toolAction')));
});

test('captured client capabilities are translated without changing messages or inventing available tools', () => {
  const n = normalize([user]), before = structuredClone(n), adapter = prepareToolAdapter(n, profile), defs = adapter.normalized.tools;
  assert.deepEqual(defs.map(t => t.name), ['view_file', 'write_to_file']);
  assert.deepEqual(Object.keys(defs[0].schema.properties), ['AbsolutePath', 'StartLine', 'EndLine', 'Pages', 'toolAction', 'toolSummary']);
  assert.deepEqual(Object.keys(defs[1].schema.properties), ['TargetFile', 'CodeContent', 'toolAction', 'toolSummary']);
  assert.doesNotMatch(JSON.stringify(defs), /ContentOffset|RunPersistent|ArtifactMetadata/);
  assert.match(defs[0].description, /2000/);assert.match(defs[1].description, /overwriting/);
  assert.match(adapter.normalized.system, /^You are Antigravity,/);assert.doesNotMatch(adapter.normalized.system, /protocol-compatible client/);
  assert.match(adapter.normalized.system, /Read tool and `Write`/);assert.match(adapter.normalized.system, /workspace \/tmp\/Read unchanged/);
  assert.deepEqual(n, before);assert.equal(adapter.normalized.messages, n.messages);
});

test('native range, PDF selection and write metadata translate to executable original client calls', () => {
  const a = prepareToolAdapter(normalize([user]), profile);
  const call = { id: 'one', name: 'view_file', arguments: { AbsolutePath: '/tmp/a', StartLine: 10, EndLine: 14, toolAction: 'Reading file', toolSummary: 'File read' }, thoughtSignature: 'real' };
  assert.deepEqual(a.toClient(call), { id: 'one', name: 'Read', arguments: { file_path: '/tmp/a', offset: 10, limit: 5 }, thoughtSignature: 'real' });
  assert.deepEqual(a.toClient({ ...call, arguments: { AbsolutePath: '/a.pdf', Pages: '2-4' } }).arguments, { file_path: '/a.pdf', pages: '2-4' });
  assert.deepEqual(a.toClient({ ...call, arguments: { AbsolutePath: '/a', EndLine: 5 } }).arguments, { file_path: '/a', limit: 5 });
  assert.deepEqual(a.toClient({ ...call, arguments: { AbsolutePath: '/a' } }).arguments, { file_path: '/a' });
  assert.deepEqual(a.toClient({ id: 'w', name: 'write_to_file', arguments: { TargetFile: '/b', CodeContent: 'literal Read', toolAction: 'Writing file' } }).arguments, { file_path: '/b', content: 'literal Read' });
  const unknown = { name: 'other', arguments: {} };assert.equal(a.toClient(unknown), unknown);
});

test('invalid and unsupported native arguments never silently change the requested operation', () => {
  const a = prepareToolAdapter(normalize([user]), profile);
  for (const args of [{}, { AbsolutePath: 1 }, { AbsolutePath: '/a', StartLine: 0 }, { AbsolutePath: '/a', StartLine: 8, EndLine: 7 }, { AbsolutePath: '/a', ContentOffset: 64 }, { AbsolutePath: '/a', Pages: 3 }]) {
    assert.throws(() => a.toClient({ name: 'view_file', arguments: args }), { code: 'invalid_tool_arguments' });
  }
  assert.throws(() => a.toClient({ name: 'write_to_file', arguments: { TargetFile: '/a', CodeContent: 'x', Append: true } }), { code: 'invalid_tool_arguments' });
});

test('unknown profiles, schemas, reserved-name collisions and auxiliary requests retain their actual tools', () => {
  const n = normalize([user]);
  for (const options of [{}, { clientProfile: 'other' }, { ...profile, checkpoint: true }]) assert.equal(prepareToolAdapter(n, options).normalized, n);
  for (const change of [x => x.protocol = 'responses', x => x.autoMode = true, x => x.tools[0].description = 'Reads secrets from a database.', x => x.tools[0].schema.not = {}, x => x.tools[0].schema.properties.extra = { type: 'string' }, x => x.tools.push({ name: 'view_file' })]) {
    const x = structuredClone(n);change(x);assert.equal(prepareToolAdapter(x, profile).normalized.tools[0].name, 'Read');
  }
  const x = { ...n, toolChoice: { type: 'tool', name: 'Read' } }, native = { ...profile };
  const wire = buildDirectRequest(x, model, 'p', 's', '', null, native);
  assert.deepEqual(wire.request.toolConfig.functionCallingConfig.allowedFunctionNames, ['view_file']);
  assert.equal(x.toolChoice.name, 'Read');
});

test('pure recognized system identity is native without adding a tool or rewriting user text', () => {
  const n = normalize([user]);n.tools = [];
  const a = prepareToolAdapter(n, profile);assert.deepEqual(a.normalized.tools, []);
  assert.match(a.normalized.system, /^You are Antigravity,/);assert.equal(a.normalized.messages, n.messages);
});

test('actual issued native calls and receipts restore across restart; edited history does not acquire a private translation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tool-adapter-'));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], nativeCall = { id: 'real-call', name: 'view_file', args: { AbsolutePath: '/tmp/Read.txt', StartLine: 2, EndLine: 4, toolAction: 'Reading file', toolSummary: 'File read' } };
  let count = 0;
  const send = (messages, sessionId = 's') => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'token', projectId: 'project', maxRetries: 0,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:adapter' }) },
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body));return new Response(JSON.stringify({ candidates: [{ content: { parts: count++ === 0 ? [{ functionCall: nativeCall, thoughtSignature: 'real-native-signature' }] : [{ text: 'done' }] } }] }), { headers: { 'content-type': 'application/json' } }); }
  }).send(normalize(messages), model, { sessionId, nativeClientProfile: profile.clientProfile });
  const first = await send([user]);assert.equal(first.toolCalls[0].name, 'Read');assert.deepEqual(first.toolCalls[0].arguments, { file_path: '/tmp/Read.txt', offset: 2, limit: 3 });
  const history = [user, { role: 'assistant', content: [{ type: 'tool_use', id: 'real-call', name: 'Read', input: first.toolCalls[0].arguments }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'real-call', content: 'real client output' }] }];
  await send(history);
  const resumed = requests.at(-1).request.contents;
  assert.deepEqual(resumed[1].parts[0], { functionCall: nativeCall, thoughtSignature: 'real-native-signature' });
  assert.equal(resumed[2].parts[0].functionResponse.name, 'view_file');assert.equal(resumed[2].parts[0].functionResponse.response.output, 'real client output');
  const edited = structuredClone(history);edited[0].content = 'Changed context';await send(edited);
  assert.equal(requests.at(-1).request.contents[1].parts[0].functionCall.name, 'Read');
  assert.equal(requests.at(-1).request.contents[2].parts[0].functionResponse.name, 'Read');
  await send(history, 'different-session');assert.equal(requests.at(-1).request.contents[1].parts[0].functionCall.name, 'Read');
  assert.doesNotMatch(JSON.stringify(requests), /toolAdapter|clientProfile|protocol-compatible client/);
});

test('default transport returns interrupted content errors to the agent without a hidden continuation or retry veto', async () => {
  const state = newState('owner', 'session'), requests = [], error = Object.assign(new Error('actual read error'), { code: 'upstream_read_error' });
  let failed = false;
  const provider = new DirectAntigravityProvider({ accessToken: 'token', projectId: 'p', localAuth: { isConfigured: () => false, load: () => ({}) },
    fetchImpl: async (_u, o) => {
      requests.push(JSON.parse(o.body));if (failed) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'reconnected' }] } }] }));
      let sent = false;return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true;c.enqueue(Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n')); } else { failed = true;c.error(error); } } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    }
  });
  assert.equal(provider.retryPolicy, 'legacy');
  const n = { messages: [{ role: 'user', text: 'original context' }] }, visible = [];
  await assert.rejects(provider.sendInSession(n, model, { onDelta: s => visible.push(s) }, state, () => {}), e => e === error);
  assert.deepEqual(visible, ['partial']);assert.equal(requests.length, 1);
  const next = await provider.sendInSession(n, model, {}, state, () => {});assert.equal(next.text, 'reconnected');
  assert.equal(requests.length, 2);assert.equal(requests[1].request.contents.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /Please continue the task|direct_stream_interrupted/);
});

test('default policy delivers a complete tool once and accepts the agent receipt immediately without injecting a user', async () => {
  const state = newState('owner', 'session'), requests = [], call = { id: 'one', name: 'view_file', args: { AbsolutePath: '/tmp/Read.txt', toolAction: 'Reading file', toolSummary: 'File read' } };
  const provider = new DirectAntigravityProvider({ accessToken: 'token', projectId: 'p', localAuth: { isConfigured: () => false, load: () => ({}) },
    fetchImpl: async (_u, o) => { requests.push(JSON.parse(o.body));if (requests.length > 1) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }));
      let sent = false;return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true;c.enqueue(Buffer.from('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: call, thoughtSignature: 'signed' }] } }] }) + '\n\n')); } else c.error(Object.assign(new Error('read failed'), { code: 'upstream_read_error' })); } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }); }
  });
  const first = await provider.sendInSession(normalize([user]), model, { nativeClientProfile: profile.clientProfile }, state, () => {});
  const messages = [user, { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'Read', input: first.toolCalls[0].arguments }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'actual result' }] }];
  await provider.sendInSession(normalize(messages), model, { nativeClientProfile: profile.clientProfile }, state, () => {});
  assert.equal(requests.length, 2);assert.equal(requests[1].request.contents.length, 3);
  assert.equal(requests[1].request.contents[2].parts[0].functionResponse.name, 'view_file');
  assert.equal(state.toolStreamErrors, undefined);assert.equal(state.streamRecoveries, undefined);
});

test('default policy ignores old hidden recovery and terminal veto state, retaining only submitted context', async () => {
  const state = newState('owner', 'session'), source = [{ role: 'user', parts: [{ text: 'context' }] }];
  recordStreamRecovery(state, source, model, [{ role: 'model', parts: [{ text: 'old hidden response' }] }], '', Date.now(), true, 9);
  let sent;
  const provider = new DirectAntigravityProvider({ accessToken: 'token', projectId: 'p', localAuth: { isConfigured: () => false, load: () => ({}) },
    fetchImpl: async (_u, o) => { sent = JSON.parse(o.body);return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'new' }] } }] })); } });
  await provider.sendInSession({ messages: [{ role: 'user', text: 'context' }] }, model, {}, state, () => {});
  assert.equal(sent.request.contents.length, 1);assert.doesNotMatch(JSON.stringify(sent), /old hidden response/);
});

test('Claude Code 2.1.304 translates Edit, Bash, Write while preserving Read with allow_large intact', async (t) => {
  const fixture304 = require('./fixtures/claude-code-2.1.304-tools.json');
  const tools304 = Array.isArray(fixture304) ? fixture304 : fixture304.tools;
  const { capturedNativeClient, CLAUDE_304_CLIENT_PROFILE } = require('../src/agy-client-profile');
  const { detectNativeCompaction } = require('../src/agy-client-compaction');
  const { prepareRobinClientAdapter } = require('../src/robin-client-adapter');
  const userMsg = { role: 'user', content: 'test message' };
  const req = {
    headers: {
      'user-agent': fixture304.user_agent || 'claude-cli/2.1.304 (external, sdk-cli)',
      'x-claude-code-session-id': 'session-304'
    }
  };
  const normalized = normalizeAnthropic({ tools: structuredClone(tools304), messages: [userMsg] });

  // 1. 门禁正例与反例验证
  assert.equal(capturedNativeClient(req, normalized), CLAUDE_304_CLIENT_PROFILE);
  assert.equal(detectNativeCompaction(req, normalized), '', '304 绝不激活 285 自动压缩');
  for (const version of ['2.1.284_external_sdk-cli_', '2.1.303', '2.1.305', '2.1.304evil']) {
    assert.equal(capturedNativeClient({ headers: { ...req.headers, 'user-agent': 'claude-cli/' + version } }, normalized), '');
  }
  assert.equal(capturedNativeClient({ headers: { ...req.headers, 'x-claude-code-session-id': ' ' } }, normalized), '');
  assert.equal(capturedNativeClient(req, { ...normalized, protocol: 'responses' }), '');

  // 2. Robin 路径隔离验证：304 绝不在 Robin 路径激活适配
  const robin = prepareRobinClientAdapter(normalized, capturedNativeClient(req, normalized));
  assert.equal(robin.adapted, false, 'Robin 路径下 304 必须保持 adapted=false');
  assert.equal(robin.normalized.tools.find(t => t.name === 'run_command'), undefined);

  // 3. Cloud Code 路径适配验证
  const adapter = prepareToolAdapter(normalized, { clientProfile: CLAUDE_304_CLIENT_PROFILE });
  const defs = adapter.normalized.tools;

  const edit = defs.find(t => t.name === 'replace_file_content');
  const bash = defs.find(t => t.name === 'run_command');
  const write = defs.find(t => t.name === 'write_to_file');
  assert.ok(edit, 'replace_file_content 必须存在');
  assert.ok(bash, 'run_command 必须存在');
  assert.ok(write, 'write_to_file 必须存在');

  // Read 工具保持原生透传，绝不转译为 view_file，保留 allow_large
  const read = defs.find(t => t.name === 'Read');
  assert.ok(read, 'Read 工具必须保持原生名称 Read');
  assert.equal(defs.find(t => t.name === 'view_file'), undefined, 'view_file 绝不能存在');
  assert.equal(read.schema.properties.allow_large.type, 'boolean', 'allow_large 必须保留');
  assert.ok(read.schema.properties.file_path, 'file_path 必须保留');

  // 其余 9 项工具声明深相等保留
  for (const t of normalized.tools.filter(t => !['Edit', 'Bash', 'Write'].includes(t.name))) {
    assert.deepEqual(defs.find(x => x.name === t.name), t);
  }

  // 4. 四组参数 toProvider / toClient 双向还原
  for (const [name, args] of [
    ['Edit', { file_path: '/tmp/a', old_string: 'x', new_string: '', replace_all: true }],
    ['Bash', { command: 'printf "%s" "$VALUE"', timeout: 123, description: '保留', run_in_background: true, dangerouslyDisableSandbox: false }],
    ['Write', { file_path: '/tmp/a', content: '' }],
    ['Read', { file_path: '/tmp/a', offset: 4, limit: 12, pages: '2-4', allow_large: true }]
  ]) {
    const c = { id: 'unchanged', name, arguments: args, thoughtSignature: 'same' };
    assert.deepEqual(adapter.toClient(adapter.toProvider(c)), c);
  }

  // 5. 跨 DirectProvider 实例与调用历史回执贯通测试
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-304-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const native = [
    { functionCall: { id: 'e', name: 'replace_file_content', args: { TargetFile: '/test/a', TargetContent: 'x', ReplacementContent: '', AllowMultiple: true } }, thoughtSignature: 'sig-e' },
    { functionCall: { id: 'b', name: 'run_command', args: { CommandLine: 'pwd', TimeoutMs: 123, RunInBackground: false, BypassSandbox: false } }, thoughtSignature: 'sig-b' },
    { functionCall: { id: 'w', name: 'write_to_file', args: { TargetFile: '/test/a', CodeContent: '' } }, thoughtSignature: 'sig-w' },
    { functionCall: { id: 'r', name: 'Read', args: { file_path: '/test/a', offset: 1, limit: 2, allow_large: true } }, thoughtSignature: 'sig-r' }
  ];
  const requests = [];
  const send = messages => new DirectAntigravityProvider({
    accessToken: 'fake', projectId: 'fake', maxRetries: 0,
    sessionStore: new AgySessionStore({ directory: dir }),
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:fake' }) },
    fetchImpl: async (_u, o) => {
      requests.push(JSON.parse(o.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: requests.length === 1 ? native : [{ text: 'done' }] } }] }));
    }
  }).send(normalizeAnthropic({ tools: fixture304.tools, messages }), model, { sessionId: 'same-session', nativeClientProfile: CLAUDE_304_CLIENT_PROFILE });

  const first = await send([userMsg]);
  assert.deepEqual(first.toolCalls.map(c => c.name), ['Edit', 'Bash', 'Write', 'Read']);
  await send([
    userMsg,
    { role: 'assistant', content: first.toolCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })) },
    { role: 'user', content: first.toolCalls.map(c => ({ type: 'tool_result', tool_use_id: c.id, content: c.id === 'b' ? 'permission denied' : 'done', ...(c.id === 'b' ? { is_error: true } : {}) })) }
  ]);
  const contents = requests[1].request.contents;
  assert.deepEqual(contents[1].parts, native);
  assert.deepEqual(contents[2].parts.map(p => [p.functionResponse.id, p.functionResponse.name]), native.map(p => [p.functionCall.id, p.functionCall.name]));
  assert.match(JSON.stringify(contents[2]), /permission denied/);
  assert.equal(requests[0].request.labels.cascade_id, requests[1].request.labels.cascade_id);
});

test('Claude Code 2.1.284 translates all four tools Edit, Bash, Write, Read aligning with 285', async (t) => {
  const fixture284 = require('./fixtures/claude-code-2.1.284-tools.json');
  const tools284 = Array.isArray(fixture284) ? fixture284 : fixture284.tools;
  const { capturedNativeClient, CLAUDE_284_CLIENT_PROFILE } = require('../src/agy-client-profile');
  const { detectNativeCompaction } = require('../src/agy-client-compaction');
  const { prepareRobinClientAdapter } = require('../src/robin-client-adapter');
  const userMsg = { role: 'user', content: 'test message' };
  const req = {
    headers: {
      'user-agent': fixture284.headers?.['User-Agent'] || fixture284.user_agent || 'claude-cli/2.1.284 (external, sdk-cli)',
      'x-claude-code-session-id': 'session-284'
    }
  };
  const normalized = normalizeAnthropic({ tools: structuredClone(tools284), messages: [userMsg] });

  // 1. 门禁正例与反例验证
  assert.equal(capturedNativeClient(req, normalized), CLAUDE_284_CLIENT_PROFILE);
  assert.equal(detectNativeCompaction(req, normalized), '', '284 不激活 285 自动压缩');
  assert.equal(capturedNativeClient({ headers: { ...req.headers, 'user-agent': 'claude-cli/2.1.283' } }, normalized), '');
  assert.equal(capturedNativeClient({ headers: { ...req.headers, 'x-claude-code-session-id': '' } }, normalized), '');
  assert.equal(capturedNativeClient(req, { ...normalized, protocol: 'responses' }), '');

  // 2. Robin 路径隔离验证：284 绝不在 Robin 路径激活适配
  const robin = prepareRobinClientAdapter(normalized, capturedNativeClient(req, normalized));
  assert.equal(robin.adapted, false, 'Robin 路径下 284 必须保持 adapted=false');
  assert.equal(robin.normalized.tools.find(t => t.name === 'run_command'), undefined);

  // 3. Cloud Code 路径适配验证：全部四项工具均成功转译
  const adapter = prepareToolAdapter(normalized, { clientProfile: CLAUDE_284_CLIENT_PROFILE });
  const defs = adapter.normalized.tools;

  const viewFile = defs.find(t => t.name === 'view_file');
  const writeToFile = defs.find(t => t.name === 'write_to_file');
  const replaceContent = defs.find(t => t.name === 'replace_file_content');
  const runCommand = defs.find(t => t.name === 'run_command');
  assert.ok(viewFile, 'view_file 必须存在');
  assert.ok(writeToFile, 'write_to_file 必须存在');
  assert.ok(replaceContent, 'replace_file_content 必须存在');
  assert.ok(runCommand, 'run_command 必须存在');

  // 4. 四组参数 toProvider / toClient 双向还原
  for (const [name, args] of [
    ['Edit', { file_path: '/tmp/a', old_string: 'x', new_string: '', replace_all: true }],
    ['Bash', { command: 'echo 1', timeout: 100, description: 'desc', run_in_background: false, dangerouslyDisableSandbox: false }],
    ['Write', { file_path: '/tmp/w', content: 'test' }],
    ['Read', { file_path: '/tmp/r', offset: 1, limit: 10, pages: '1-2' }]
  ]) {
    const c = { id: 'test_call', name, arguments: args, thoughtSignature: 'sig' };
    assert.deepEqual(adapter.toClient(adapter.toProvider(c)), c);
  }
});



