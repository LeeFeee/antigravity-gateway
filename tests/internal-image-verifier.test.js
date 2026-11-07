'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installInternalImageGuard, internalImagePayload, assessInternalImage, observerSource } = require('../scripts/verify-gateway-media');
const textModel = 'gemini-3.8-flash-low', imageModel = 'gemini-3.1-flash-image';
const origin = 'https://daily-cloudcode-pa.googleapis.com';

function request(phase) {
  const image = phase === 2;
  return { url: `${origin}/v1internal:${image ? 'generateContent' : 'streamGenerateContent?alt=sse'}`,
    options: { headers: { authorization: 'Bearer synthetic-owned-account' }, body: JSON.stringify({
      model: image ? imageModel : textModel, requestType: image ? 'image_gen' : 'agent',
      requestId: `${image ? 'image_gen' : 'agent'}/123456/owned-trajectory/${phase}`,
      request: { generationConfig: image ? {} : { thinkingConfig: { thinkingLevel: 'LOW' } }, contents: [] }
    }) } };
}

test('internal image request uses one explicit Low Messages turn without a client-owned image tool', () => {
  const payload = internalImagePayload();
  assert.equal(payload.model, textModel); assert.equal(payload.messages.length, 1);
  assert.equal(payload.tools, undefined); assert.equal(payload.tool_choice, undefined);
  assert.match(payload.messages[0].content[0].text, /generate_image.*exactly once/);
  const { normalizeAnthropic, prepareNativeMultimodal } = require('../src/protocol');
  const normalized = normalizeAnthropic(payload);
  const enabled = prepareNativeMultimodal(normalized);
  assert.equal(enabled.imageToolInjected, true);
  assert.deepEqual(enabled.normalized.tools.map(tool => [tool.name, tool.internal]), [['generate_image', true]]);
});

test('internal image guard allows only one ordered three-phase sequence with original native fetch', async () => {
  const sent = [], recorded = [];
  class Native { async fetch(url, options) { sent.push({ url, options }); return { status: 200 }; } }
  installInternalImageGuard({ AgyNativeTransport: Native }, value => recorded.push(value), textModel, imageModel);
  const native = new Native();
  for (const phase of [1, 2, 3]) { const item = request(phase); await native.fetch(item.url, item.options); }
  const fourth = request(3);
  await assert.rejects(native.fetch(fourth.url, fourth.options), { code: 'media_verification_budget_stop' });
  assert.equal(sent.length, 3);
  assert.deepEqual(recorded.filter(event => event.type === 'internal-image-stage').map(event => event.phase), [1, 2, 3]);
  assert.doesNotMatch(JSON.stringify(recorded), /synthetic-owned-account/);
  new vm.Script(observerSource('/tmp/trace', '/tmp/config', '/tmp/root', 'synthetic', { generationBudget: 3, internalImage: true }));
  assert.throws(() => observerSource('/tmp/trace', '/tmp/config', '/tmp/root', 'synthetic', { generationBudget: 4, internalImage: true }));
});

test('internal image guard stops retries, account/model/trajectory changes and any non-200 response before more I/O', async () => {
  for (const variant of ['429', '503', 'network', 'retry', 'account', 'model', 'trajectory', 'thinking']) {
    let calls = 0;
    class Native { async fetch() { calls++; if (variant === 'network') throw new Error('controlled disconnect');
      return { status: ['429', '503'].includes(variant) ? Number(variant) : 200 }; } }
    installInternalImageGuard({ AgyNativeTransport: Native }, () => {}, textModel, imageModel);
    const native = new Native(), first = request(1);
    if (variant === 'thinking') {
      const body = JSON.parse(first.options.body); body.request.generationConfig.thinkingConfig.thinkingLevel = 'HIGH';
      first.options.body = JSON.stringify(body);
      await assert.rejects(native.fetch(first.url, first.options), { code: 'media_verification_budget_stop' });
      assert.equal(calls, 0); continue;
    }
    if (variant === 'network') await assert.rejects(native.fetch(first.url, first.options), /controlled disconnect/);
    else await native.fetch(first.url, first.options);
    const next = request(variant === 'retry' ? 1 : 2), body = JSON.parse(next.options.body);
    if (variant === 'account') next.options.headers.authorization = 'Bearer another-owned-account';
    if (variant === 'model') body.model = 'different-image-model';
    if (variant === 'trajectory') body.requestId = body.requestId.replace('owned-trajectory', 'another-trajectory');
    next.options.body = JSON.stringify(body);
    await assert.rejects(native.fetch(next.url, next.options), { code: 'media_verification_budget_stop' });
    assert.equal(calls, 1, variant);
  }
});

function evidence() {
  const signature = { omitted: true, sha256: 'synthetic-signature-hash' };
  const call = { id: 'image-call', name: 'generate_image', args: { Prompt: 'Blue circle', ImageName: 'blue_circle' } };
  const data = { bytes: 100, sha256: 'synthetic-image-hash' }, events = [];
  for (const phase of [1, 2, 3]) {
    const item = request(phase), body = JSON.parse(item.options.body);
    if (phase === 1) body.request.tools = [{ functionDeclarations: [{ name: 'generate_image' }] }];
    if (phase === 3) body.request.contents.push({ role: 'model', parts: [{ functionCall: call, thoughtSignature: signature }] },
      { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { output: 'Generated image is saved at owned-path' },
        parts: [{ inlineData: { mimeType: 'image/png', data } }] } }] });
    events.push({ type: 'internal-image-stage', phase, sameCredential: true },
      { type: 'native-request', id: `request-${phase}`, url: item.url, body, headers: { 'user-agent': 'antigravity/cli/1.5.2 (aidev_client)' } },
      { type: 'native-response', id: `request-${phase}`, status: 200, binary: '/tmp/agy-transport-test' });
  }
  events.push({ type: 'native-body', id: 'request-1', body: { candidates: [{ content: { parts: [{ functionCall: call, thoughtSignature: signature }] } }] } });
  return { events, http: { status: 200, body: { model: textModel, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Blue circle generated.' }] } },
    saved: { status: 200, ...data, mimeType: 'image/png', sameAsGatewayDisk: true, sameAsNativeResponse: true, width: 1024, height: 1024 } };
}

test('internal image success requires actual three-stage history, account guard, call/signature, byte receipt and readable artifact', () => {
  const { events, http, saved } = evidence();
  assert.equal(assessInternalImage(events, http, saved).passed, true);
  for (const variant of ['no-call', 'wrong-call-id', 'lost-signature', 'wrong-bytes', 'wrong-trajectory', 'retry', 'no-account-proof', 'no-file']) {
    const copy = structuredClone(events);
    const last = copy.find(event => event.type === 'native-request' && event.id === 'request-3').body;
    if (variant === 'no-call') copy.splice(copy.findIndex(event => event.type === 'native-body'), 1);
    if (variant === 'wrong-call-id') last.request.contents[1].parts[0].functionResponse.id = 'another-call';
    if (variant === 'lost-signature') delete last.request.contents[0].parts[0].thoughtSignature;
    if (variant === 'wrong-bytes') last.request.contents[1].parts[0].functionResponse.parts[0].inlineData.data.sha256 = 'different';
    if (variant === 'wrong-trajectory') last.requestId = last.requestId.replace('owned-trajectory', 'different');
    if (variant === 'retry') copy.push({ type: 'internal-image-guard-stop', reason: 'retry rejected' });
    if (variant === 'no-account-proof') copy.splice(copy.findIndex(event => event.type === 'internal-image-stage'), 1);
    assert.equal(assessInternalImage(copy, http, variant === 'no-file' ? null : saved).passed, false, variant);
  }
});

test('internal image assessment follows the sole declared reversible tool wire name rather than assuming a native name', () => {
  const { events, http, saved } = evidence();
  const wireName = 'mcp_gateway_tool_synthetic';
  for (const event of events) {
    const body = event.body;
    for (const declaration of body?.request?.tools?.flatMap(tool => tool.functionDeclarations || []) || []) declaration.name = wireName;
    for (const part of body?.request?.contents?.flatMap(content => content.parts || []) || []) {
      if (part.functionCall) part.functionCall.name = wireName;
      if (part.functionResponse) part.functionResponse.name = wireName;
    }
    for (const part of body?.candidates?.flatMap(candidate => candidate.content.parts) || []) if (part.functionCall) part.functionCall.name = wireName;
  }
  const result = assessInternalImage(events, http, saved);
  assert.equal(result.passed, true); assert.equal(result.toolWireName, wireName);
  events.find(event => event.type === 'native-request').body.request.tools[0].functionDeclarations.push({ name: 'unknown_client_tool' });
  assert.equal(assessInternalImage(events, http, saved).internalToolCallObserved, false);
});

test('the single real internal-image attempt preserves the actual upstream empty-image failure and never claims completion', () => {
  const directory = path.join(__dirname, 'fixtures/gateway-internal-image-20261107');
  const raw = fs.readFileSync(path.join(directory, 'internal-image.json'), 'utf8'), record = JSON.parse(raw);
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json')));
  const result = assessInternalImage(record.trace, record.http, record.saved);
  assert.equal(result.passed, false); assert.equal(result.internalToolCallObserved, true);
  assert.equal(result.upstreamToolSignatureObserved, true);
  assert.equal(result.imageSubrequestAccepted, true);
  assert.deepEqual(result.nativeStatuses, [200, 200]);
  assert.equal(result.nativeGenerations, 2);
  assert(result.imageFinishMessages.some(message => message.includes('could not generate the image')));
  assert.equal(record.http.status, 502); assert.equal(record.http.body.error.type, 'image_response_missing');
  const stages = record.trace.filter(event => event.type === 'internal-image-stage');
  assert.deepEqual(stages.map(event => event.phase), [1, 2]);
  assert(stages.every(event => event.sameCredential));
  assert.equal(stages[0].requestId.split('/').at(-2), stages[1].requestId.split('/').at(-2));
  assert.equal(summary.nativeGenerationRequests, 2); assert.equal(summary.generationBudget, 3);
  for (const key of ['sourceUnchanged', 'productionAccountsUnchanged', 'productionStateUnchanged', 'temporaryCredentialsRemoved', 'ownedGatewayStopped', 'generationBudgetRespected']) assert.equal(summary[key], true, key);
  assert.doesNotMatch(raw, /\bya29\.[A-Za-z0-9._~-]+|"authorization"\s*:\s*"Bearer /);
});
