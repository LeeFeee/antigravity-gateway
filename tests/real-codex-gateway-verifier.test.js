'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGuard, assess, completeResponses, configureScenario } = require('../scripts/verify-real-codex-gateway');
const MODEL = 'gemini-3.8-flash-low';
const URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const body = JSON.stringify({ model: MODEL, requestType: 'agent', request: { contents: [] } });

test('Codex 真实验收按物理生成计数，双 RPC／重试不能突破每场景 4 次硬限', async () => {
  let physical = 0, scope = { runId: 'read-1', scenario: 'read', model: MODEL, maxGenerations: 4 };
  const records = [], receiver = {}, guard = createGuard({ nativeFetch: async function() { assert.equal(this, receiver); physical++; return new Response('{}'); }, control: () => scope, record: value => records.push(value) });
  for (let index = 0; index < 4; index++) await guard.call(receiver, index % 2 ? URL.replace('streamGenerateContent?alt=sse', 'generateContent') : URL, { method: 'POST', body });
  await assert.rejects(guard.call(receiver, URL, { method: 'POST', body }), /budget exceeded/);
  assert.equal(physical, 4);
  scope = { ...scope, runId: 'patch-1', scenario: 'patch' };
  await guard.call(receiver, URL, { method: 'POST', body }); assert.equal(physical, 5);
  assert.equal(records.filter(item => item.type === 'generation-dispatch' && item.scenario === 'read').length, 4);
});

test('真实 429 或异常后锁住整个实验，拒绝换 host／账号／下场景重发且保留原 response', async () => {
  for (const mode of ['429', 'error']) {
    let physical = 0;
    const original = new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', resetTime: 'preserved' } }), { status: 429 });
    const guard = createGuard({ nativeFetch: async () => { physical++; if (mode === 'error') throw new Error('synthetic failure'); return original; },
      control: () => ({ runId: 'read', scenario: 'read', model: MODEL, maxGenerations: 4 }), record() {} });
    if (mode === '429') assert.equal(await guard(URL, { method: 'POST', body }), original);
    else await assert.rejects(guard(URL, { method: 'POST', body }), /synthetic failure/);
    await assert.rejects(guard(URL.replace('daily-', ''), { method: 'POST', body }), /stopped/);
    assert.equal(physical, 1);
  }
});

test('元数据不占生成预算；错误模型、无场景、外站、额外业务 RPC 在原生 dispatch 前拒绝', async () => {
  let calls = 0, scope;
  const guard = createGuard({ nativeFetch: async () => { calls++; return new Response('{}'); }, control: () => scope, record() {} });
  await guard('https://oauth2.googleapis.com/token', { method: 'POST' });
  await guard('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', { method: 'POST' });
  assert.equal(calls, 2);
  await assert.rejects(guard(URL, { method: 'POST', body }), /No active/);
  scope = { scenario: 'text', runId: 'x', model: MODEL, maxGenerations: 4 };
  await assert.rejects(guard(URL, { method: 'POST', body: body.replace(MODEL, 'other-model') }), /Unexpected generation/);
  for (const url of ['https://example.com/', 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchFromTrawlerCache', URL + '&extra=1']) {
    await assert.rejects(guard(url, { method: 'POST', body }), /endpoint denied/);
  }
  assert.equal(calls, 2);
});

function stream(items) {
  const events = [], push = (type, data) => events.push({ type, sequence_number: events.length, ...data });
  push('response.created', { response: { id: 'r', status: 'in_progress', output: [] } });
  items.forEach((item, output_index) => {
    const custom = item.type === 'custom_tool_call', tool = custom || item.type === 'function_call';
    push('response.output_item.added', { output_index, item: { ...item, ...(custom ? { input: '' } : tool ? { arguments: '' } : {}) } });
    if (tool) {
      const prefix = custom ? 'custom_tool_call_input' : 'function_call_arguments', value = custom ? item.input : item.arguments;
      for (const delta of [value.slice(0, 3), value.slice(3)]) push(`response.${prefix}.delta`, { output_index, item_id: item.id, delta });
      push(`response.${prefix}.done`, { output_index, item_id: item.id, [custom ? 'input' : 'arguments']: value });
    }
    push('response.output_item.done', { output_index, item });
  });
  push('response.completed', { response: { id: 'r', status: 'completed', output: items, error: null } });
  return events;
}
const wire = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
test('SSE 完整性验收消费 custom 字符串和普通参数，缺 done／重复参数／ID 或终态篡改不能通过', () => {
  const input = '*** Begin Patch\n*** Add File: a\n+中文 🐱 "quoted" \\ test\n*** End Patch';
  const events = stream([{ type: 'custom_tool_call', id: 'ct', call_id: 'call-c', name: 'apply_patch', input, status: 'completed' },
    { type: 'function_call', id: 'fn', call_id: 'call-f', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat "文件"' }), status: 'completed' }]);
  assert.equal(completeResponses(events), true);
  for (const mutate of [
    value => { value[1].item.input = input; },
    value => { value[2].item_id = 'wrong'; },
    value => { value.at(-1).response.output[0].input += 'tampered'; },
    value => { value.at(-1).type = 'response.incomplete'; },
    value => { value.splice(value.findIndex(event => event.type === 'response.custom_tool_call_input.done'), 1); value.forEach((event, index) => { event.sequence_number = index; }); }
  ]) { const value = structuredClone(events); mutate(value); assert.equal(completeResponses(value), false); }
});

function evidence(scenario) {
  const marker = 'RANDOM_FILE_MARKER', name = scenario === 'read' ? 'exec_command' : 'apply_patch';
  const call = { type: scenario === 'read' ? 'function_call' : 'custom_tool_call', id: 'item-tool', call_id: 'call-id', name, status: 'completed',
    ...(scenario === 'read' ? { arguments: '{"cmd":"cat probe-input.txt"}' } : { input: '*** Begin Patch\n*** End Patch' }) };
  const final = { type: 'message', id: 'item-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: marker }] };
  const nativeCall = { functionCall: { id: 'call-id', name: 'mcp_gateway_tool_exact', args: { input: 'original unchanged' } }, thoughtSignature: 'real-shaped-signature' };
  const request = (id, contents) => ({ type: 'native-request', id, url: URL, headers: { 'user-agent': 'antigravity/cli/1.5.2 darwin/arm64' }, body: { model: MODEL, requestType: 'agent', request: { contents } } });
  const trace = [request('native1', []), { type: 'native-response', id: 'native1', status: 200, binary: '/tmp/agy-transport-test' },
    { type: 'native-body', id: 'native1', body: JSON.stringify({ response: { candidates: [{ content: { parts: [nativeCall] } }] } }) },
    { type: 'client-http', path: '/v1/responses', status: 200, body: { input: [] }, responseBody: wire(stream([call])) },
    request('native2', [{ parts: [nativeCall] }, { parts: [{ functionResponse: { id: 'call-id', name: 'mcp_gateway_tool_exact', response: { output: marker } } }] }]),
    { type: 'native-response', id: 'native2', status: 200, binary: '/tmp/agy-transport-test' },
    { type: 'client-http', path: '/v1/responses', status: 200, body: { input: [{ type: scenario === 'read' ? 'function_call_output' : 'custom_tool_call_output', call_id: 'call-id', output: marker }] }, responseBody: wire(stream([final])) }];
  const item = scenario === 'read' ? { type: 'command_execution', exit_code: 0, aggregated_output: marker }
    : { type: 'file_change', status: 'completed', changes: [{ path: '/tmp/probe-patch.txt' }] };
  const outcome = { code: 0, stdout: JSON.stringify({ type: 'item.completed', item }) };
  const file = { beforeSha256: 'old', afterSha256: scenario === 'read' ? 'old' : 'new', actual: marker, expected: marker };
  return { marker, trace, outcome, file };
}
test('read 成功需要随机文件回执、真实 CLI 执行事件、ID 和原生签名续接，不能仅凭终答标记', () => {
  const value = evidence('read');
  assert.equal(assess('read', value.trace, value.outcome, value.marker, value.file).passed, true);
  for (const mutate of [
    data => { data.outcome.stdout = ''; },
    data => { data.trace.at(-1).body.input[0].call_id = 'unrelated'; },
    data => { data.trace[4].body.request.contents[1].parts[0].functionResponse.response.output = 'fabricated'; },
    data => { data.trace[4].body.request.contents[0].parts[0].thoughtSignature = 'tampered'; },
    data => { data.file.afterSha256 = 'changed'; }
  ]) { const bad = JSON.parse(JSON.stringify(value)); mutate(bad); assert.equal(assess('read', bad.trace, bad.outcome, bad.marker, bad.file).passed, false); }
});
test('patch 成功需要客户端文件修改完成且磁盘字节精确，不允许终答或伪造回执替代文件', () => {
  const value = evidence('patch');
  assert.equal(assess('patch', value.trace, value.outcome, value.marker, value.file).passed, true);
  assert.equal(assess('patch', value.trace, value.outcome, value.marker, { ...value.file, actual: 'wrong' }).passed, false);
  assert.equal(assess('patch', value.trace, { ...value.outcome, stdout: '' }, value.marker, value.file).passed, false);
});

test('Codex 准备仅写独立 client root，读取提示不泄露随机答案，HOME/CODEX_HOME保持原值', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-real-prepare-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const scenario of ['text', 'read', 'patch']) {
    const result = configureScenario(path.join(root, scenario), 'http://127.0.0.1:18765', MODEL, scenario, 'synthetic-local-key');
    assert.equal(result.settings.env.HOME, process.env.HOME);
    assert.equal(result.settings.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(result.settings.env.CODEX_PROBE_FAKE_KEY, 'synthetic-local-key');
    assert.equal(fs.statSync(result.filePath).mode & 0o777, 0o600);
    if (scenario === 'read') assert.ok(!result.settings.args.join('\n').includes(result.marker));
    assert.match(fs.readFileSync(result.settings.sandbox, 'utf8'), /localhost:18765/);
  }
});
