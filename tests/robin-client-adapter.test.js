'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareRobinClientAdapter } = require('../src/robin-client-adapter');
const { capturedNativeClient, CODEX_CLIENT_PROFILE } = require('../src/agy-client-profile');
const { HERMES_CLIENT_PROFILE } = require('../src/agy-hermes-profile');
const { normalizeAnthropic, normalizeChat, normalizeResponses, finalizeModelResult } = require('../src/protocol');
const { RobinProvider, ARGON_MODEL, PROCESS_QUERY_PATH, EXECUTE_REMOTE_TOOLS_PATH, robinTaskText } = require('../src/robin-provider');
const { bytesField, messageField, stringField, protoStruct, decodeFields, decodeProtoStruct } = require('../src/robin-proto');
const codex = require('./fixtures/codex-exec-0.159.2-tools.json');
const hermes = require('./fixtures/hermes-0.21.7-tools.json');
const framework = require('./fixtures/hermes-0.21.7-framework.json');
const editShell = require('./fixtures/claude-code-2.1.285-edit-bash.json');
const claudeTools = [
  { name: 'Read', description: 'Reads a file from the local filesystem.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, pages: { type: 'string' } }, required: ['file_path'], additionalProperties: false } },
  { name: 'Write', description: 'Writes a file to the local filesystem, overwriting if one exists.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'], additionalProperties: false } },
  ...editShell
];
const userText = 'Keep Read, exec_command, terminal and mode=\'patch\' literal. Never execute without client approval.';
const cases = [
  { name: 'Claude', profile: 'claude-code-2.1.285', normalize: () => normalizeAnthropic({ system: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n" + userText, tools: structuredClone(claudeTools), messages: [{ role: 'user', content: userText }] }),
    call: { name: 'Read', arguments: { file_path: '/tmp/Read/terminal.txt', offset: 2, limit: 3 } }, alias: 'view_file', args: { AbsolutePath: '/tmp/Read/terminal.txt', StartLine: 2, EndLine: 4 } },
  { name: 'Codex', profile: CODEX_CLIENT_PROFILE, normalize: () => normalizeResponses({ instructions: userText, tools: structuredClone(codex.tools), input: userText }),
    call: { name: 'exec_command', arguments: { cmd: 'printf "%s" "Read terminal"', workdir: '/tmp', yield_time_ms: 1000, sandbox_permissions: 'use_default', login: false } }, alias: 'run_command',
    args: { CommandLine: 'printf "%s" "Read terminal"', Cwd: '/tmp', WaitMsBeforeAsync: 1000, BypassSandbox: false, Login: false } },
  { name: 'Hermes', profile: HERMES_CLIENT_PROFILE, normalize: () => normalizeChat({ tools: structuredClone(hermes.tools), messages: [{ role: 'system', content: [framework.identity, framework.framework, framework.coding, framework.project].join('\n\n') }, { role: 'user', content: userText }] }),
    call: { name: 'patch', arguments: { path: '/tmp/patch.txt', old_string: 'Read terminal', new_string: '', replace_all: false } }, alias: 'replace_file_content',
    args: { TargetFile: '/tmp/patch.txt', TargetContent: 'Read terminal', ReplacementContent: '', AllowMultiple: false } }
];

for (const c of cases) {
  test(`Robin ${c.name} maps capabilities bidirectionally without agy identity or metadata`, () => {
    const n = c.normalize(), before = structuredClone(n), a = prepareRobinClientAdapter(n, c.profile);
    const upstream = a.toProvider({ id: 'call-1', ...c.call });
    assert.deepEqual(upstream, { id: 'call-1', name: c.alias, arguments: c.args });
    assert.deepEqual(a.toClient(upstream), { id: 'call-1', ...c.call });
    assert.deepEqual(n, before);
    assert.deepEqual(a.normalized.messages, n.messages);
    assert.doesNotMatch(a.normalized.system, /You are Antigravity|protocol-compatible client/);
    for (const tool of a.normalized.tools) {
      assert.equal(tool.schema.properties?.toolAction, undefined);
      assert.equal(tool.schema.properties?.toolSummary, undefined);
    }
    assert.throws(() => a.toClient({ ...upstream, arguments: { ...upstream.arguments, toolAction: 'Invented action' } }), { code: 'invalid_tool_arguments' });
    n.toolChoice = { type: 'function', function: { name: c.call.name } };
    assert.equal(prepareRobinClientAdapter(n, c.profile).normalized.toolChoice.function.name, c.alias);
  });

  test(`Robin ${c.name} transforms only typed assistant history and keeps tool results and quoted examples`, () => {
    const n = c.normalize();
    n.messages.push({ role: 'assistant', text: 'old rendered transcript', parts: [
      { type: 'text', text: userText }, { type: 'tool_call', id: 'call-1', ...c.call }
    ] }, { role: 'user', text: 'Tool result: Read exec_command terminal', parts: [{ type: 'tool_result', id: 'call-1', name: c.call.name, content: 'Read exec_command terminal', isError: true }] });
    const before = structuredClone(n), a = prepareRobinClientAdapter(n, c.profile);
    assert.ok(a.normalized.messages[1].text.startsWith(userText + '\n'));
    assert.ok(a.normalized.messages[1].text.includes(`name=${c.alias}]`));
    assert.deepEqual(a.normalized.messages[1].parts[1].arguments, c.args);
    assert.deepEqual(a.normalized.messages[2], n.messages[2]);assert.deepEqual(n, before);
  });
}

test('Robin preserves custom SOUL, project rules, runtime constraints and unknown templates', () => {
  const n = cases[2].normalize(), a = prepareRobinClientAdapter(n, capturedNativeClient({}, n));
  assert.ok(a.normalized.system.startsWith(framework.identity + '\n\n'));
  assert.ok(a.normalized.system.endsWith(framework.project));
  assert.match(a.normalized.system, /Read the relevant files with `view_file`/);
  assert.doesNotMatch(a.normalized.system, /mode='(?:replace|patch)'/);
  const defaultSoul = normalizeChat({ tools: hermes.tools, messages: [{ role: 'system', content: hermes.systemPrefix }] });
  assert.doesNotMatch(prepareRobinClientAdapter(defaultSoul, HERMES_CLIENT_PROFILE).normalized.system, /You are Hermes Agent|You are Antigravity/);
  assert.match(prepareRobinClientAdapter(defaultSoul, HERMES_CLIENT_PROFILE).normalized.system, /Be direct/);
  n.system += '\n\n' + framework.framework;
  assert.equal(capturedNativeClient({}, n), '');assert.equal(prepareRobinClientAdapter(n).normalized, n);
});

test('Robin unknown profiles, modified schemas, collisions and auto-mode do not force aliases', () => {
  for (const c of cases) {
    const n = c.normalize();assert.equal(prepareRobinClientAdapter(n, 'unknown').normalized, n);
    n.autoMode = true;assert.equal(prepareRobinClientAdapter(n, c.profile).normalized, n);delete n.autoMode;
    n.tools.push({ name: c.alias, schema: { type: 'object' } });
    assert.ok(prepareRobinClientAdapter(n, c.profile).normalized.tools.some(t => t.name === c.call.name));
    n.tools.pop();n.tools.find(t => t.name === c.call.name).schema.properties.unknown = { type: 'string' };
    assert.ok(prepareRobinClientAdapter(n, c.profile).normalized.tools.some(t => t.name === c.call.name));
  }
});

test('Robin preserves custom patch grammar and deferred tools, and never declares unavailable capabilities', () => {
  const n = cases[1].normalize(), a = prepareRobinClientAdapter(n, CODEX_CLIENT_PROFILE);
  assert.deepEqual(a.normalized.tools.find(t => t.name === 'apply_patch'), n.tools.find(t => t.name === 'apply_patch'));
  for (const call of [
    { name: 'write_stdin', arguments: { session_id: 42, chars: '', yield_time_ms: 1000 } },
    { name: 'write_stdin', arguments: { session_id: 42, chars: 'hello\n' } },
    { name: 'view_image', arguments: { path: '/tmp/image.png', detail: 'original' } },
    { name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** End Patch' } }
  ]) assert.deepEqual(a.toClient(a.toProvider(call)), call);
  assert.throws(() => a.toClient({ name: 'manage_task', arguments: { TaskId: 42, Action: 'kill' } }), { code: 'invalid_tool_arguments' });
  const h = cases[2].normalize(), b = prepareRobinClientAdapter(h, HERMES_CLIENT_PROFILE);
  for (const name of ['search_files', 'tool_search', 'tool_describe', 'tool_call']) assert.deepEqual(b.normalized.tools.find(t => t.name === name), h.tools.find(t => t.name === name));
  const shell = { name: 'terminal', arguments: { command: 'true', timeout: 120, background: false, notify: ['stdout'] } };
  assert.deepEqual(b.toClient(b.toProvider(shell)), shell);
  assert.equal(b.toProvider(shell).arguments.ExecutionTimeoutSeconds, 120);
});

test('Robin leaves malformed or non-equivalent old calls untouched instead of fabricating history', () => {
  const a = prepareRobinClientAdapter(cases[0].normalize(), cases[0].profile);
  for (const call of [
    { name: 'Read', arguments: '{' }, { name: 'Read', arguments: { file_path: '/a', limit: 0 } },
    { name: 'Read', arguments: { file_path: '/a', unknown: true } }, { name: 'other', arguments: {} }
  ]) assert.equal(a.toProvider(call), call);
});

function fixture(t) {
  const streams = [];
  const transport = { unary: async () => Buffer.alloc(0), request(route, _token, options = {}) {
    let resolve, reject;
    const stream = { route, options, writes: [], done: new Promise((a, b) => { resolve = a; reject = b; }),
      write(message) { this.writes.push(message); }, end() {}, close() {}, resolve, reject };
    streams.push(stream);return stream;
  } };
  const provider = new RobinProvider({ auth: { account: {}, get: async () => ({ accessToken: 'test-token', serverToken: 'test-server-token' }) }, transport });
  t.after(() => provider.stop());
  return { provider, streams };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const callFrame = (name, args, id = 'remote-call-1') => messageField(2, messageField(1, Buffer.concat([stringField(1, name), stringField(2, id), messageField(3, protoStruct(args))])));
function connect(streams) {
  streams[0].options.onMessage(bytesField(1014, messageField(1, stringField(1, 'c_client_adapter_1'))));
  assert.equal(streams[0].route, PROCESS_QUERY_PATH);assert.equal(streams[1].route, EXECUTE_REMOTE_TOOLS_PATH);
}
function responses(stream) {
  return stream.writes.slice(1).flatMap(b => decodeFields(b).filter(f => f.number === 2)
    .flatMap(f => decodeFields(f.value)).map(f => {
      const v = decodeFields(f.value);
      return { name: v.find(x => x.number === 1).value.toString(), id: v.find(x => x.number === 2)?.value.toString() || '', value: decodeProtoStruct(v.find(x => x.number === 3).value) };
    }));
}
function finish(streams) {
  streams[0].resolve([bytesField(1003, messageField(1, messageField(1, Buffer.concat([
    stringField(1, 'rc_completed_1234'), messageField(2, stringField(1, 'DONE'))
  ]))))]);
}

for (const c of cases) test(`Robin ${c.name} MCP catalog, native call, client execution receipt keep one source stream`, async t => {
  const { provider, streams } = fixture(t), n = c.normalize();
  const first = provider.send(n, ARGON_MODEL, { sessionId: 'test-session', nativeClientProfile: c.profile });
  await tick();connect(streams);
  streams[1].options.onMessage(messageField(2, messageField(1, Buffer.concat([stringField(1, 'list_mcp'), messageField(2, protoStruct({}))]))));
  const catalog = responses(streams[1])[0].value.servers[0];
  assert.equal(catalog.name, 'external_client');assert.ok(catalog.tools.some(x => x.name === c.alias));
  assert.doesNotMatch(JSON.stringify(catalog), /toolSummary|toolAction|nativeClientProfile/);
  streams[1].options.onMessage(callFrame('execute_mcp', { ServerName: 'external_client', ToolName: c.alias, Arguments: c.args }));
  const result = await first;
  assert.deepEqual(result.toolCalls, [{ id: 'remote-call-1', ...c.call }]);
  assert.deepEqual(finalizeModelResult(n, result).toolCalls, result.toolCalls);
  // Tools/profile may be omitted on the next HTTP call; the actual issued
  // mapping stays attached to the task, not recomputed from that request.
  const next = provider.send({ ...n, tools: [], messages: [...n.messages, { role: 'user', text: 'done', parts: [{ type: 'tool_result', id: 'remote-call-1', name: c.call.name, content: 'Read terminal stays literal' }] }] }, ARGON_MODEL, { sessionId: 'test-session' });
  await tick();
  assert.equal(streams.length, 2);assert.deepEqual(responses(streams[1]).at(-1), {
    name: 'execute_mcp', id: 'remote-call-1', value: { result: 'Read terminal stays literal' }
  });
  finish(streams);assert.equal((await next).text, 'DONE');
});

test('Robin malformed mapped arguments fail the task without delivering a fabricated client call', async t => {
  const { provider, streams } = fixture(t), c = cases[0];
  const first = provider.send(c.normalize(), ARGON_MODEL, { sessionId: 's', nativeClientProfile: c.profile });
  const rejected = assert.rejects(first, { code: 'robin_client_tool_contract', status: 422 });
  await tick();connect(streams);streams[1].options.onMessage(callFrame('execute_mcp', { ServerName: 'external_client', ToolName: c.alias, Arguments: { ...c.args, Append: true } }));
  await rejected;assert.equal(provider.turns.size, 0);
});

test('Robin duplicate in-flight calls are not delivered twice and result names must match the issued client call', async t => {
  const { provider, streams } = fixture(t), c = cases[0], n = c.normalize();
  const first = provider.send(n, ARGON_MODEL, { sessionId: 's', nativeClientProfile: c.profile });
  await tick();connect(streams);
  const frame = callFrame('execute_mcp', { ServerName: 'external_client', ToolName: c.alias, Arguments: c.args });
  streams[1].options.onMessage(frame);streams[1].options.onMessage(frame);
  assert.equal((await first).toolCalls.length, 1);assert.equal(provider.turns.get('s').events.length, 0);
  await assert.rejects(provider.send({ ...n, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: 'remote-call-1', name: 'Write', content: 'wrong result' }] }] }, ARGON_MODEL, { sessionId: 's' }), { code: 'robin_client_tool_contract' });
  assert.equal(responses(streams[1]).length, 0);
});

test('Robin restart with outstanding tool results still reports lost native stream without replay', async t => {
  const { provider, streams } = fixture(t);
  await assert.rejects(provider.send({ ...cases[0].normalize(), messages: [{ role: 'user', parts: [{ type: 'tool_result', id: 'lost-call', name: 'Read', content: 'already executed' }] }] }, ARGON_MODEL,
    { sessionId: 'restarted', nativeClientProfile: cases[0].profile }), { code: 'robin_task_not_found' });
  assert.equal(streams.length, 0);
});

test('Robin rejects repeated completed native call IDs instead of asking the agent to execute them again', async t => {
  const { provider, streams } = fixture(t), c = cases[0], n = c.normalize();
  const first = provider.send(n, ARGON_MODEL, { sessionId: 's', nativeClientProfile: c.profile });
  await tick();connect(streams);
  const frame = callFrame('execute_mcp', { ServerName: 'external_client', ToolName: c.alias, Arguments: c.args });
  streams[1].options.onMessage(frame);await first;
  const next = provider.send({ ...n, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: 'remote-call-1', name: c.call.name, content: 'already executed' }] }] }, ARGON_MODEL, { sessionId: 's' });
  const rejected = assert.rejects(next, { code: 'robin_client_tool_contract' });
  await tick();assert.equal(responses(streams[1]).length, 1);
  streams[1].options.onMessage(frame);await rejected;
  assert.equal(responses(streams[1]).length, 1);
});

test('Robin parallel mapped calls retain per-call IDs and real client error receipts', async t => {
  const { provider, streams } = fixture(t), c = cases[0], n = c.normalize();
  const first = provider.send(n, ARGON_MODEL, { sessionId: 's', nativeClientProfile: c.profile });
  await tick();connect(streams);
  const entries = [['read-1', 'view_file', { AbsolutePath: '/a' }], ['write-1', 'write_to_file', { TargetFile: '/b', CodeContent: '' }]];
  streams[1].options.onMessage(messageField(2, Buffer.concat(entries.map(([id, name, args]) => messageField(1, Buffer.concat([
    stringField(1, 'execute_mcp'), stringField(2, id), messageField(3, protoStruct({ ServerName: 'external_client', ToolName: name, Arguments: args }))
  ]))))));
  assert.deepEqual((await first).toolCalls, [{ id: 'read-1', name: 'Read', arguments: { file_path: '/a' } }, { id: 'write-1', name: 'Write', arguments: { file_path: '/b', content: '' } }]);
  const next = provider.send({ ...n, messages: [{ role: 'user', parts: [
    { type: 'tool_result', id: 'read-1', name: 'Read', content: 'client denied permission', isError: true },
    { type: 'tool_result', id: 'write-1', name: 'Write', content: 'created empty file' }
  ] }] }, ARGON_MODEL, { sessionId: 's' });
  await tick();assert.deepEqual(responses(streams[1]), [{ name: 'execute_mcp', id: 'write-1', value: { result: 'created empty file' } }]);
  const failure = decodeFields(streams[1].writes[1]).find(f => f.number === 3);
  assert.ok(failure);const failureFields = decodeFields(failure.value);
  assert.equal(failureFields.find(f => f.number === 2).value.toString(), 'read-1');
  assert.equal(failureFields.find(f => f.number === 3).value.toString(), 'client denied permission');
  finish(streams);assert.equal((await next).text, 'DONE');
});
