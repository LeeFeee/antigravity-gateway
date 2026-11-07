'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { readToolCall, createSyntheticTurnPlanner, assessEvidence, sanitize } = require('../scripts/verify-client-gateway');
const model = 'gemini-3.8-flash-high';
const declaration = { name: 'read_file', parameters: { type: 'OBJECT', properties: { Path: { type: 'STRING' },
  StartLine: { type: 'INTEGER' }, EndLine: { type: 'INTEGER' } }, required: ['Path', 'StartLine', 'EndLine'] } };
const nativeBody = () => ({ project: 'synthetic-project', model, userAgent: 'antigravity', requestType: 'agent',
  request: { contents: [{ role: 'user', parts: [{ text: 'Read isolated fixture' }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } }, tools: [{ functionDeclarations: [declaration] }] } });
const capture = body => ({ path: '/v1internal:streamGenerateContent?alt=sse', headers: { 'user-agent': 'antigravity/cli/1.5.2 (test)' }, body });

test('synthetic upstream can only construct the declared bounded native read', () => {
  for (const agent of ['claude', 'hermes', 'pi', 'dsh']) {
    assert.deepEqual(readToolCall(nativeBody(), agent, '/tmp/fixture.txt'), {
      id: `verify_read_${agent}`, name: 'read_file', args: { Path: '/tmp/fixture.txt', StartLine: 1, EndLine: 2 }
    });
  }
  const missing = nativeBody(); missing.request.tools = [];
  assert.throws(() => readToolCall(missing, 'pi', '/tmp/fixture.txt'), /Expected one verified/);
  const ambiguous = nativeBody(); ambiguous.request.tools[0].functionDeclarations.push({ ...declaration, name: 'read' });
  assert.throws(() => readToolCall(ambiguous, 'pi', '/tmp/fixture.txt'), /Expected one verified/);
  const extended = nativeBody(); extended.request.tools[0].functionDeclarations[0] = { ...declaration, parameters: {
    ...declaration.parameters, required: [...declaration.parameters.required, 'executeCommand'] } };
  assert.throws(() => readToolCall(extended, 'pi', '/tmp/fixture.txt'), /Unverified required/);
});

test('closed-loop evidence requires native envelopes, restored client tool names and actual tool result bytes', () => {
  const first = capture(nativeBody()), second = capture(nativeBody());
  first.issuedToolCall = readToolCall(first.body, 'pi', '/tmp/fixture.txt');
  second.body.request.contents.push({ role: 'model', parts: [{ functionResponse: { id: 'verify_read_pi', name: 'read_file',
    response: { result: 'PROBE_FIXTURE_LINE_1\nPROBE_FIXTURE_LINE_2' } } }] });
  const client = [{ path: '/v1/responses', status: 200, responseBody: '{"name":"read"}' },
    { path: '/v1/responses', status: 200, responseBody: '{"text":"LOCAL_GATEWAY_VERIFIED"}' }];
  const outcome = { code: 0, clientReportedError: false };
  assert.equal(assessEvidence('pi', 'read', [first, second], client, outcome).passed, true);
  assert.equal(assessEvidence('pi', 'read', [first, second], client, { ...outcome, clientReportedError: true }).passed, false);
  assert.equal(assessEvidence('pi', 'read', [first], client, outcome).passed, false);
  assert.equal(assessEvidence('pi', 'read', [first, second], client.map(item => ({ ...item, responseBody: item.responseBody.replace('"read"', '"read_file"') })), outcome).passed, false);
  second.body.request.contents.at(-1).parts[0].functionResponse.response.result = 'fabricated empty result';
  assert.equal(assessEvidence('pi', 'read', [first, second], client, outcome).passed, false);
  first.body.request.contents = [];
  assert.equal(assessEvidence('pi', 'text', [first], client, outcome).checks.nativeGenerationEnvelope, false);
});

function auxiliaryBody() {
  const body = nativeBody();
  body.request.tools = [{ functionDeclarations: [{ name: 'generate_image', parameters: { type: 'OBJECT', properties: {} } }] }];
  body.request.contents = [{ role: 'user', parts: [{ text: 'Generate a short session title.' }] }];
  return body;
}
function resultBody(call, marker = 'PROBE_FIXTURE_LINE_1\nPROBE_FIXTURE_LINE_2') {
  const body = nativeBody();
  body.request.contents.push({ role: 'model', parts: [{ functionCall: call }] },
    { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { result: marker } } }] });
  return body;
}

for (const order of [['auxiliary', 'call', 'result'], ['call', 'auxiliary', 'result'], ['call', 'result', 'auxiliary']]) {
  test(`title requests do not change read state when arriving ${order.join(' -> ')}`, () => {
    const plan = createSyntheticTurnPlanner('dsh', 'read', '/tmp/fixture.txt');
    const upstream = [];
    let issued;
    for (const kind of order) {
      const body = kind === 'auxiliary' ? auxiliaryBody() : kind === 'call' ? nativeBody() : resultBody(issued);
      const turn = plan(body), record = capture(body);
      record.syntheticTurn = turn.kind;
      if (turn.issuedToolCall) { issued = turn.issuedToolCall; record.issuedToolCall = issued; }
      upstream.push(record);
      assert.equal(turn.kind, kind === 'call' ? 'read-call' : kind === 'result' ? 'read-result' : 'auxiliary');
      assert.ok(turn.events.at(-1).response.candidates[0].finishReason === 'STOP');
    }
    assert.equal(upstream.length, 3, 'auxiliary requests remain in evidence');
    assert.equal(upstream.filter(record => record.issuedToolCall).length, 1);
    const client = [{ path: '/v1/responses', status: 200, responseBody: '{"name":"read"}' },
      { path: '/v1/responses', status: 200, responseBody: '{"text":"LOCAL_GATEWAY_VERIFIED"}' }];
    assert.equal(assessEvidence('dsh', 'read', upstream, client, { code: 0 }).passed, true);
  });
}

test('read planner still rejects missing or mismatched receipts and malformed reader declarations', () => {
  const planner = createSyntheticTurnPlanner('hermes', 'read', '/tmp/fixture.txt');
  const issued = planner(nativeBody()).issuedToolCall;
  assert.throws(() => planner(nativeBody()), /did not return the temporary file contents/);
  assert.throws(() => planner(resultBody(issued, 'empty result')), /did not return the temporary file contents/);
  const wrongId = resultBody(issued); wrongId.request.contents.at(-1).parts[0].functionResponse.id = 'unissued-read';
  assert.throws(() => planner(wrongId), /issued read/);
  const malformed = nativeBody(); malformed.request.tools[0].functionDeclarations = [{ name: 'read_file', parameters: { type: 'OBJECT', properties: {} } }];
  assert.throws(() => createSyntheticTurnPlanner('pi', 'read', '/tmp/fixture.txt')(malformed), /no captured file-path parameter/);
});

test('a missing main reader cannot pass by returning only successful auxiliary completions', () => {
  const plan = createSyntheticTurnPlanner('hermes', 'read', '/tmp/fixture.txt');
  const upstream = [auxiliaryBody(), auxiliaryBody()].map(body => {
    const turn = plan(body); assert.equal(turn.kind, 'auxiliary');
    return { ...capture(body), syntheticTurn: turn.kind };
  });
  const client = [{ path: '/v1/responses', status: 200, responseBody: '{"text":"LOCAL_GATEWAY_VERIFIED"}' }];
  const assessment = assessEvidence('hermes', 'read', upstream, client, { code: 0 });
  assert.equal(assessment.passed, false);
  assert.equal(assessment.checks.declaredReaderWasIssued, false);
  assert.equal(assessment.checks.actualLocalReadReturned, false);
  assert.equal(assessment.checks.toolRoundtripGeneratedAgain, false);
});

test('capture export removes synthetic keys and temporary paths while retaining protocol evidence', () => {
  assert.deepEqual(sanitize({ headers: { authorization: 'Bearer synthetic-value' },
    body: { path: '/private/tmp/run-a/work/file.txt', url: 'http://127.0.0.1:1234/v1/responses', requestType: 'agent' } },
  '/private/tmp/run-a', [[1234, 'GATEWAY_PORT']]), {
    headers: { authorization: '<SYNTHETIC_CREDENTIAL>' },
    body: { path: '/tmp/client-gateway-verify/work/file.txt', url: 'http://127.0.0.1:GATEWAY_PORT/v1/responses', requestType: 'agent' }
  });
});
