'use strict';

// Migration coverage: old clients keep their complete contracts without
// reusing the retired view_file/run_command/replace_file_content vocabulary.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');
const { normalizeAnthropic } = require('../src/protocol');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { AgySessionStore, newState, recordStreamRecovery } = require('../src/agy-session-state');
const { capturedNativeClient } = require('../src/agy-client-profile');
const { detectNativeCompaction } = require('../src/agy-client-compaction');
const profile = { clientProfile: 'claude-code-2.1.285' }, model = 'gemini-3.8-flash-high';
const tools = [
  { name: 'Read', description: 'Reads a file from the local filesystem.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, pages: { type: 'string' } }, required: ['file_path'], additionalProperties: false } },
  { name: 'Write', description: 'Writes a file to the local filesystem, overwriting if one exists.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'], additionalProperties: false } },
  ...require('./fixtures/claude-code-2.1.285-edit-bash.json')
];
const user = { role: 'user', content: 'Read /tmp/Read.txt. Do not change the literal word Read in this message.' };
const normalize = messages => normalizeAnthropic({ tools, messages, system: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\nUse the Read tool and `Write`. Keep permission rules and workspace /tmp/Read unchanged." });

for (const version of ['2.1.284', '2.1.285', '2.1.304']) {
  test(`Claude ${version}: 旧版本完整参数使用 MCP，不套用未确认官方工具`, () => {
    const fixture = version === '2.1.285' ? { tools } : require(`./fixtures/claude-code-${version}-tools.json`);
    const normalized = normalizeAnthropic({ tools: fixture.tools, messages: [user] }), before = structuredClone(normalized);
    const adapter = prepareAntigravityTools(normalized, { clientProfile: `claude-code-${version}`, clientVersion: version });
    assert.ok(adapter.declarations.every(tool => tool.name.startsWith('mcp_')));
    assert.equal(adapter.records.length, normalized.tools.length);
    for (const [name, args] of [
      ['Edit', { file_path: '/tmp/a.txt', old_string: '\tRead `$HOME`\n原文', new_string: '', replace_all: false }],
      ['Bash', { command: 'printf "%s" "$VALUE"  ', timeout: 123, description: '保留', run_in_background: true, dangerouslyDisableSandbox: false }],
      ['Write', { file_path: '/tmp/a.txt', content: '' }],
      ['Read', { file_path: '/tmp/a.pdf', offset: 4, limit: 12, pages: '2-4', ...(version === '2.1.304' ? { allow_large: true } : {}) }]
    ]) {
      const call = { id: name, name, arguments: args, thoughtSignature: 'same' };
      assert.deepEqual(adapter.toClient(adapter.toProvider(call)), call);
    }
    assert.deepEqual(normalized, before);
    const request = { headers: { 'user-agent': `claude-cli/${version} (external, sdk-cli)`, 'x-claude-code-session-id': 'controlled-session' } };
    assert.equal(capturedNativeClient(request, normalized), `claude-code-${version}`);
    if (version !== '2.1.285') assert.equal(detectNativeCompaction(request, normalized), '');
  });
}

test('未知工具与缺少参数明确拒绝，熟悉名字不能绕过完整 Schema 校验', () => {
  const adapter = prepareAntigravityTools(normalize([user]));
  for (const [name, args] of [['Read', {}], ['Write', { file_path: '/tmp/a' }], ['Bash', { command: 'x', timeout: '1000' }], ['Edit', { file_path: '/tmp/a', old_string: 'x', new_string: 'y', StartLine: 1 }]]) assert.throws(() => adapter.toProvider({ name, arguments: args }));
  assert.throws(() => adapter.toClient({ name: 'Read', arguments: { file_path: '/tmp/a' } }), error => error.code === 'invalid_tool_call');
  assert.throws(() => adapter.toClient({ name: 'undeclared', arguments: {} }), error => error.code === 'invalid_tool_call');
});

test('Messages 调用、错误回执在 provider 重建后恢复当时上游别名和原始签名', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-messages-contract-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = prepareAntigravityTools(normalize([user]));
  const calls = [
    { id: 'e', name: 'Edit', arguments: { file_path: '/tmp/a.txt', old_string: 'old', new_string: 'new', replace_all: false } },
    { id: 'b', name: 'Bash', arguments: { command: 'controlled command', timeout: 100, run_in_background: false } }
  ];
  const native = calls.map(call => { const upstream = adapter.toProvider(call); return { functionCall: { id: upstream.id, name: upstream.name, args: upstream.arguments }, thoughtSignature: `signed-${call.id}` }; });
  const requests = [];
  const send = (messages, sessionId = 'messages-contract') => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }), accessToken: 'synthetic', projectId: 'p', maxRetries: 0,
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:messages-contract' }) },
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ candidates: [{ content: { parts: requests.length === 1 ? native : [{ text: 'done' }] } }] })); }
  }).send(normalize(messages), model, { sessionId, nativeClientProfile: profile.clientProfile });
  const first = await send([user]); assert.deepEqual(first.toolCalls.map(call => call.name), ['Edit', 'Bash']);
  const messages = [user, { role: 'assistant', content: first.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })) },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e', content: 'exact replacement applied' }, { type: 'tool_result', tool_use_id: 'b', content: 'permission denied', is_error: true }] }];
  await send(messages);
  const contents = requests.at(-1).request.contents;
  assert.deepEqual(contents[1].parts, native);
  assert.deepEqual(contents[2].parts.map(part => [part.functionResponse.id, part.functionResponse.name]), native.map(part => [part.functionCall.id, part.functionCall.name]));
  assert.match(JSON.stringify(contents[2]), /permission denied/);
  assert.ok(first.toolCalls.every(call => !Object.hasOwn(call.arguments, 'toolSummary')));
  const edited = structuredClone(messages); edited[1].content[0].input.new_string = 'changed';
  const attempts = requests.length;
  await send(edited, 'different-session');
  assert.equal(requests.length, attempts + 1, '新会话按客户端提供的历史发送，不依赖本地历史准入');
  assert.match(JSON.stringify(requests.at(-1).request.contents), /changed/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).request.contents), /signed-e|signed-b/);
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
  const state = newState('owner', 'session'), requests = [];
  const issued = prepareAntigravityTools(normalize([user])).toProvider({ id: 'one', name: 'Read', arguments: { file_path: '/tmp/Read.txt' } });
  const call = { id: issued.id, name: issued.name, args: issued.arguments };
  const provider = new DirectAntigravityProvider({ accessToken: 'token', projectId: 'p', localAuth: { isConfigured: () => false, load: () => ({}) },
    fetchImpl: async (_u, o) => { requests.push(JSON.parse(o.body));if (requests.length > 1) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }));
      let sent = false;return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true;c.enqueue(Buffer.from('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: call, thoughtSignature: 'signed' }] } }] }) + '\n\n')); } else c.error(Object.assign(new Error('read failed'), { code: 'upstream_read_error' })); } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }); }
  });
  const first = await provider.sendInSession(normalize([user]), model, { nativeClientProfile: profile.clientProfile }, state, () => {});
  const messages = [user, { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'Read', input: first.toolCalls[0].arguments }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'actual result' }] }];
  await provider.sendInSession(normalize(messages), model, { nativeClientProfile: profile.clientProfile }, state, () => {});
  assert.equal(requests.length, 2);assert.equal(requests[1].request.contents.length, 3);
  assert.equal(requests[1].request.contents[2].parts[0].functionResponse.name, call.name);
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

