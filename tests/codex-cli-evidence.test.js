'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assess, selectCall, completeResponseStream } = require('../scripts/verify-codex-gateway');
const { sanitize } = require('../scripts/probe-codex-requests');
const directory = path.join(__dirname, 'fixtures/codex-gateway-0.164.0-20261107');
const names = ['text-v3', 'read-v3', 'patch-v3', 'error-v3', 'image-v3', 'image-input-v3', 'compact-v3', 'namespace-error-v4', 'parallel-v1'];
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name + '.json'), 'utf8'));
const generations = record => record.upstream.filter(x => x.path.includes(':streamGenerateContent'));
const clientRequests = record => record.clientHTTP.filter(x => x.path === '/v1/responses');
const parts = body => body.request.contents.flatMap(c => c.parts || []);
const objects = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(objects)];

test('nine actual Codex CLI/full gateway captures pass their current evidence gates', () => {
  for (const name of names) {
    const record = read(name);
    assert.equal(record.version, 'codex-cli 0.164.0');
    assert.equal(record.evidence, 'actual-codex-cli-real-gateway-synthetic-google');
    assert.equal(record.realModelValidated, false);
    assert.equal(record.nativeTLSValidated, false);
    assert.equal(record.assessment.passed, true, name);
    assert.equal(assess(record.scenario, record).passed, true, name);
  }
});

test('signed native call arguments, IDs and mock signature survive each actual client tool roundtrip', () => {
  for (const name of names.filter(n => !['text-v3', 'image-input-v3'].includes(n))) {
    const record = read(name), requests = generations(record), first = requests[0];
    for (const call of [first.issuedToolCall, first.issuedSecondToolCall].filter(Boolean)) {
      const replay = requests.slice(1).flatMap(x => parts(x.body)).find(p => p.functionCall?.id === call.id);
      assert.deepEqual(replay.functionCall, call, name);
      assert.equal(replay.thoughtSignature, call.id.endsWith('_second')
        ? 'synthetic-codex-second-signature-not-provider-issued' : 'synthetic-codex-signature-not-provider-issued');
      assert.ok(requests.slice(1).flatMap(x => parts(x.body)).some(p => p.functionResponse?.id === call.id && p.functionResponse.name === call.name));
    }
  }
});

test('Codex custom patch preserves full grammar, custom input and actual disk result', () => {
  const record = read('patch-v3'), requests = clientRequests(record);
  const tool = requests[0].body.tools.find(t => t.name === 'apply_patch');
  assert.equal(tool.type, 'custom'); assert.equal(tool.format.syntax, 'lark');
  assert.match(tool.format.definition, /update_hunk/);
  const call = requests[1].body.input.find(i => i.type === 'custom_tool_call');
  assert.equal(call.name, 'apply_patch');
  assert.equal(call.input, generations(record)[0].issuedToolCall.args.input);
  assert.equal(record.disk.written, 'CODEX_PATCH_DISK_MARKER\n');
  const events = record.stdout.split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(events.some(e => e.type === 'item.completed' && e.item.type === 'file_change' && e.item.status === 'completed'));
});

test('image input and view_image result retain the exact controlled PNG bytes', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/gateway-media-inputs/image-fixture.png'));
  for (const name of ['image-v3', 'image-input-v3']) {
    const images = generations(read(name)).flatMap(r => objects(r.body.request.contents)).filter(x => x.inlineData).map(x => x.inlineData);
    assert.ok(images.length >= 1, name);
    for (const image of images) { assert.equal(image.mimeType, 'image/png'); assert.deepEqual(Buffer.from(image.data, 'base64'), bytes); }
  }
});

test('automatic compaction retains real old tool projection then resumes summary without synthetic calls', () => {
  const record = read('compact-v3'), requests = clientRequests(record), native = generations(record);
  assert.equal(requests.length, 3); assert.equal(native.length, 3);
  assert.equal(requests[1].body.tools.length, 0);
  assert.ok(requests[1].body.input.some(i => i.type === 'function_call_output'));
  assert.match(JSON.stringify(requests[1].body.input), /CONTEXT CHECKPOINT COMPACTION/);
  assert.match(JSON.stringify(requests[2].body.input), /Another language model started to solve this problem/);
  assert.equal(requests[2].body.input.some(i => /function_call/.test(i.type)), false);
  assert.equal(parts(native[2].body).some(p => p.functionCall || p.thoughtSignature), false);
  for (const request of requests) assert.match(JSON.stringify(request.body.input), /PROBE_USER_RULE/);
});

test('grouped close_agent selection and its real error receipt do not accidentally select resume_agent', () => {
  const record = read('namespace-error-v4'), native = generations(record);
  const call = selectCall(native[0].body, 'namespace-error', '/tmp/work');
  assert.deepEqual(call.args.target, '00000000-0000-0000-0000-000000000001');
  const response = clientRequests(record)[1].body.input.find(x => x.type === 'function_call');
  assert.equal(response.namespace, 'multi_agent_v1'); assert.equal(response.name, 'close_agent');
  assert.ok(record.assessment.checks.namespaceDispatched);
});

test('same-turn parallel reads return both distinct call IDs and actual client file markers', () => {
  const record = read('parallel-v1'), requests = clientRequests(record);
  const calls = requests[1].body.input.filter(x => x.type === 'function_call');
  const outputs = requests[1].body.input.filter(x => x.type === 'function_call_output');
  assert.equal(calls.length, 2); assert.equal(outputs.length, 2);
  assert.deepEqual(new Set(calls.map(x => x.call_id)), new Set(outputs.map(x => x.call_id)));
  assert.match(JSON.stringify(outputs), /CODEX_LOCAL_FILE_MARKER/); assert.match(JSON.stringify(outputs), /CODEX_SECOND_FILE_MARKER/);
});

test('source mutation, failed cleanup or incomplete stream cannot pass the verifier', () => {
  for (const change of [r => { r.sourceAfter.sha256 = 'changed'; }, r => { r.temporaryDirectoryRemoved = false; },
    r => { r.installationAfter.sha256 = 'changed'; },
    r => { clientRequests(r)[0].responseBody = clientRequests(r)[0].responseBody.split('data: {"type":"response.completed"')[0]; }]) {
    const record = read('text-v3'); change(record); assert.equal(assess('text', record).passed, false);
  }
  assert.equal(completeResponseStream('data: {"type":"response.failed"}\n\n'), false);
  assert.equal(completeResponseStream('data: {broken}\n\n'), false);
});

test('installation metadata redaction retains comparison booleans and SHA while removing private IDs', () => {
  const result = sanitize({ installation_id: 'private-test-id', installationIdContentUnchanged: true,
    installationBefore: { sha256: 'synthetic-sha' }, header: '{"installation_id":"private-test-id"}' }, '/tmp/root', 123, '', ['private-test-id']);
  assert.equal(result.installationIdContentUnchanged, true); assert.equal(result.installationBefore.sha256, 'synthetic-sha');
  assert.ok(!JSON.stringify(result).includes('private-test-id'));
});
