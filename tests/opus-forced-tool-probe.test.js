'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODEL, ENDPOINT, buildDiagnostic, createGuard, assessResponse, main } = require('../scripts/probe-opus-forced-tool');
const { cliUserAgent } = require('../src/agy-request-profile');
function headers() { return { authorization: 'Bearer synthetic-token', 'content-type': 'application/json', 'user-agent': cliUserAgent() }; }
function harness(status = 200) {
  const diagnostic = buildDiagnostic(), calls = [], records = [];
  const guard = createGuard({ nativeFetch: async (url, options) => { calls.push({ url, options }); return new Response('{}', { status }); }, record: value => records.push(value) });
  guard.arm(diagnostic.body, 'synthetic-token');
  return { diagnostic, calls, records, guard, options: { method: 'POST', headers: headers(), body: JSON.stringify(diagnostic.body) } };
}

test('诊断只在正常生产 builder 结果上增加强制工具配置，固定 Opus 思考与真实工具 Schema 不变', () => {
  const result = buildDiagnostic('synthetic-project', { thinkingBudget: 64000, maxOutputTokens: 64000 });
  assert.equal(result.baseline.model, MODEL);
  assert.equal(result.baseline.request.toolConfig, undefined);
  assert.deepEqual(result.body.request.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } });
  const copy = structuredClone(result.body); delete copy.request.toolConfig; assert.deepEqual(copy, result.baseline);
  assert.deepEqual(result.body.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
  assert.equal(result.body.request.generationConfig.maxOutputTokens, 2048);
  assert.equal(result.localProtection.rejected, true);
  assert.equal(result.localProtection.code, 'model_capability_conflict');
  assert.deepEqual(result.tool.parameters.required, ['Path', 'StartLine', 'EndLine']);
  assert(!('toolSummary' in result.tool.parameters.properties));
});

test('传输护栏只允许一次精确诊断，拒绝成功后的第二次及其他模型/账号/参数变更', async () => {
  const h = harness();
  await h.guard.fetch({}, ENDPOINT, h.options);
  assert.equal(h.guard.generationCount, 1); assert.equal(h.calls.length, 1);
  await assert.rejects(h.guard.fetch({}, ENDPOINT, h.options), /already stopped/);
  for (const mutate of [body => { body.model = 'claude-sonnet-4-6'; }, body => { body.request.generationConfig.thinkingConfig.thinkingBudget = 0; },
    body => { body.request.tools[0].functionDeclarations[0].parameters.required = []; }, body => { body.request.toolConfig.functionCallingConfig.mode = 'AUTO'; }]) {
    const current = harness(), body = structuredClone(current.diagnostic.body); mutate(body);
    await assert.rejects(current.guard.fetch({}, ENDPOINT, { ...current.options, body: JSON.stringify(body) }), /reviewed diagnostic body/);
    assert.equal(current.calls.length, 0);
  }
  const wrongAccount = harness();
  await assert.rejects(wrongAccount.guard.fetch({}, ENDPOINT, { ...wrongAccount.options, headers: { ...headers(), authorization: 'Bearer different' } }), /account cannot change/);
  assert.equal(wrongAccount.calls.length, 0);
});

test('429/网络失败禁止后续生成，未知路径与取消在原生传输前终止', async () => {
  const limited = harness(429); await limited.guard.fetch({}, ENDPOINT, limited.options);
  await assert.rejects(limited.guard.fetch({}, ENDPOINT, limited.options), /already stopped/); assert.equal(limited.calls.length, 1);
  const quota = harness(429); await quota.guard.fetch({}, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', { method: 'POST' });
  await assert.rejects(quota.guard.fetch({}, ENDPOINT, quota.options), /already stopped/); assert.equal(quota.guard.generationCount, 0);
  for (const url of ['https://example.com/', ENDPOINT.replace('daily-', ''), ENDPOINT.replace('streamGenerateContent?alt=sse', 'generateContent'), 'https://oauth2.googleapis.com/other']) {
    const h = harness(); await assert.rejects(h.guard.fetch({}, url, h.options), /denied/); assert.equal(h.calls.length, 0);
  }
  const h = harness(); await assert.rejects(h.guard.fetch({}, ENDPOINT, { ...h.options, signal: AbortSignal.abort(new Error('synthetic cancel')) }), /synthetic cancel/);
  assert.equal(h.calls.length, 0);
  let attempts = 0;
  const guard = createGuard({ nativeFetch: async () => { attempts++; throw new Error('synthetic network failure'); } });
  guard.arm(h.diagnostic.body, 'synthetic-token');
  await assert.rejects(guard.fetch({}, ENDPOINT, h.options), /synthetic network failure/);
  await assert.rejects(guard.fetch({}, ENDPOINT, h.options), /already stopped/); assert.equal(attempts, 1);
});

test('源码发生变化时诊断在第一次生成前中止', async () => {
  const h = harness(); let physical = 0;
  const guard = createGuard({ nativeFetch: async () => { physical++; }, frozenSourceCheck: () => { throw new Error('Runtime source changed'); } });
  guard.arm(h.diagnostic.body, 'synthetic-token');
  await assert.rejects(guard.fetch({}, ENDPOINT, h.options), /Runtime source changed/);
  assert.equal(physical, 0); assert.equal(guard.generationCount, 0);
});

test('仅真实对应 400 或 HTTP200 合法工具调用能得出能力结论，零工具执行', () => {
  const { adapter } = buildDiagnostic();
  const conflict = assessResponse(400, JSON.stringify({ error: { message: 'Thinking may not be enabled when tool_choice forces tool use.' } }), adapter);
  assert(conflict.rejectsCombination); assert.equal(conflict.conclusion, 'upstream_rejects_fixed_thinking_with_forced_tool');
  const body = { response: { candidates: [{ content: { parts: [{ functionCall: { id: 'call_test', name: 'read_file', args: { Path: '/tmp/opus-forced-tool-probe.txt', StartLine: 1, EndLine: 1 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 } } };
  const success = assessResponse(200, `data: ${JSON.stringify(body)}\n\n`, adapter);
  assert(success.acceptedToolCall); assert(success.requiresProductionGuardReview); assert.equal(success.toolExecutions, 0);
  assert.deepEqual(success.finishReasons, ['STOP']); assert.equal(success.validatedCalls[0].clientName, 'Read');
  assert.equal(assessResponse(400, '{"error":{"message":"some other validation error"}}', adapter).conclusion, 'inconclusive');
  assert.equal(assessResponse(429, '{"error":{"message":"quota"}}', adapter).conclusion, 'inconclusive');
  assert.equal(assessResponse(200, '{"candidates":[{"content":{"parts":[{"text":"not a tool call"}]}}]}', adapter).conclusion, 'inconclusive');
  body.response.candidates[0].content.parts[0].functionCall.args.StartLine = 0;
  assert.equal(assessResponse(200, JSON.stringify(body), adapter).conclusion, 'inconclusive');
});

test('默认 preflight 不读取不存在的账号目录也不访问网络，拒绝覆盖证据', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-diagnostic-test-'));
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network forbidden in preflight'); };
  try {
    const report = await main({ out: root, sourceConfig: path.join(root, 'does-not-exist') });
    assert.equal(report.accountDataRead, false); assert.equal(report.realRequestsSent, false); assert.equal(report.preparedOnly, true);
    assert(fs.existsSync(path.join(root, 'prepared.json')));
    await assert.rejects(main({ out: root }), /never be overwritten/);
    await assert.rejects(main({ run: true, out: path.join(root, 'run'), expectedSource: '0'.repeat(64), sourceConfig: path.join(root, 'absent') }), /frozen source SHA/);
    assert(!fs.existsSync(path.join(root, 'run')));
  } finally { globalThis.fetch = original; fs.rmSync(root, { recursive: true, force: true }); }
});
