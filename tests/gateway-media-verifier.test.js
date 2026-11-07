'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compact, observerSource, textPayload, assess, visibleText, supportingNativeHTTP, videoFollowupPayload, assessVideoContinuation } = require('../scripts/verify-gateway-media');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('controlled-original-media'), digest = { mimeType: 'video/mp4', bytes: bytes.length, sha256: sha(bytes) };
const input = { image: { mimeType: 'image/png', bytes }, video: { mimeType: 'video/mp4', bytes } };

function trace(model = 'gemini-3.8-flash-low', media = digest) {
  return [{ type: 'native-request', id: 'request-1', url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    headers: { 'user-agent': 'antigravity/cli/1.5.2 (aidev_client)' }, body: { model, request: { contents: [{ role: 'user', parts: [{
      inlineData: { mimeType: media.mimeType, data: { bytes: media.bytes, sha256: media.sha256 } } }] }] } } },
  { type: 'native-response', id: 'request-1', status: 200, binary: '/tmp/agy-transport-test' }];
}

test('media trace compaction hashes original bytes before serializing JSON and SSE, preserving MIME and text', () => {
  const source = { request: { inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') } }, thoughtSignature: 'private-signature' };
  const body = compact(JSON.stringify(source));
  assert.deepEqual(body.request.inlineData.data, { encoding: 'base64', bytes: bytes.length, sha256: sha(bytes) });
  assert.equal(body.request.inlineData.mimeType, 'video/mp4');
  assert.deepEqual(body.thoughtSignature, { sha256: sha('private-signature'), omitted: true });
  assert.doesNotMatch(JSON.stringify(body), /private-signature|Y29udHJvbGxlZA/);
  const sse = compact(`data: ${JSON.stringify(source)}\n\ndata: [DONE]\n`);
  assert.deepEqual(sse.events[0], body); assert.equal(sse.events[1], '[DONE]');
  assert.deepEqual(compact(bytes), { bytes: bytes.length, sha256: sha(bytes) });
});

test('both real HTTP payload formats carry exactly the original video; file input remains a real reference', () => {
  const messages = textPayload('video-messages', input), responses = textPayload('video-responses', input);
  const a = messages.messages[0].content[1], b = responses.input[0].content[1];
  assert.equal(a.type, 'video'); assert.equal(a.source.media_type, 'video/mp4');
  assert.deepEqual(Buffer.from(a.source.data, 'base64'), bytes);
  assert.equal(b.type, 'input_video'); assert.equal(b.video_url, `data:video/mp4;base64,${bytes.toString('base64')}`);
  assert.deepEqual(textPayload('image-file-responses', input, 'file_probe').input[0].content[1], { type: 'input_image', file_id: 'file_probe' });
  assert.equal(messages.model, 'gemini-3.8-flash-low'); assert.equal(responses.model, messages.model);
  const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
  for (const normalized of [normalizeAnthropic(messages), normalizeResponses(responses)]) {
    const media = normalized.messages[0].parts.find(part => part.type === 'media');
    assert.equal(media.mediaType, 'video/mp4');
    assert.deepEqual(Buffer.from(media.data, 'base64'), bytes);
  }
  const reference = normalizeResponses(textPayload('image-file-responses', input, 'file_probe')).messages[0].parts.find(part => part.type === 'media');
  assert.equal(reference.fileId, 'file_probe'); assert.equal(reference.data, undefined);
});

test('actual native success, original bytes and visible semantic answer are all required', () => {
  const response = { status: 200, body: { content: [{ type: 'text', text: 'Red, then blue.' }] } };
  assert.equal(assess('video-messages', trace(), response, digest).passed, true);
  assert.equal(assess('video-messages', trace().slice(0, 1), response, digest).passed, false);
  assert.equal(assess('video-messages', trace('wrong-model'), response, digest).passed, false);
  assert.equal(assess('video-messages', trace(), response, { ...digest, sha256: sha('changed') }).passed, false);
  assert.equal(assess('video-messages', trace(), { ...response, status: 429 }, digest).passed, false);
  const fake = { status: 200, body: { content: [{ type: 'tool_use', input: { text: 'Red then blue' } }] } };
  assert.equal(assess('video-messages', trace(), fake, digest).passed, false);
  assert.equal(visibleText(fake.body), '');
});

test('uploaded image requires successful HTTP upload and byte-identical HTTP readback', () => {
  const expected = { ...digest, mimeType: 'image/png' }, response = { status: 200, body: { output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Red' }] }] } };
  assert.equal(assess('image-file-responses', trace(undefined, expected), response, expected).passed, false);
  response.upload = { status: 200, readBackSame: true };
  assert.equal(assess('image-file-responses', trace(undefined, expected), response, expected).passed, true);
  response.upload.readBackSame = false;
  assert.equal(assess('image-file-responses', trace(undefined, expected), response, expected).passed, false);
});

test('image generation cannot pass with only a URL or a fabricated saved file', () => {
  const events = trace('gemini-3.1-flash-image');
  events[0].url = 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent';
  events[0].body.requestType = 'image_gen';
  const response = { status: 200, body: { data: [{ url: 'http://127.0.0.1/v1/files/file_fake/content' }] } };
  assert.equal(assess('image-generation', events, response).passed, false);
  const saved = { status: 200, sameAsGatewayDisk: true, sameAsNativeResponse: true, bytes: 100, width: 1024, height: 1024, centerRGB: [250, 0, 0] };
  assert.equal(assess('image-generation', events, response, null, saved).passed, true);
  assert.equal(assess('image-generation', events, response, null, { ...saved, sameAsNativeResponse: false }).passed, false);
  assert.equal(assess('image-generation', events, response, null, { ...saved, centerRGB: [0, 0, 250] }).passed, false);
  assert.equal(assess('image-edit', events, response, digest, { ...saved, centerRGB: [0, 0, 250] }).passed, true);
});

test('observer keeps original Go TLS fetch and compacts multipart/binary bodies before persistence', () => {
  const source = observerSource('/tmp/media-trace', '/tmp/media-config', '/tmp/media-root', 'fake-api-key');
  new vm.Script(source);
  assert.match(source, /nativeFetch\.call\(this,url,options\)/);
  assert.match(source, /transportReplaced:false/);
  assert.match(source, /binaryDigest\(rawInput\)/);
  assert.match(source, /binaryDigest\(Buffer\.concat\(output\)\)/);
  assert.doesNotMatch(source, /globalThis\.fetch\s*=|nativeCloudCodeFetch\s*=/);
});

test('supporting authentication evidence keeps only endpoint/method/status and never invents HTTP2 negotiation', () => {
  const events = [{ type: 'native-request', id: 'auth', url: 'https://oauth2.googleapis.com/token', method: 'POST',
    body: { refresh_token: 'private-token' } }, { type: 'native-response', id: 'auth', status: 200 }, ...trace()];
  assert.deepEqual(supportingNativeHTTP(events), [{ endpoint: 'https://oauth2.googleapis.com/token', method: 'POST', status: 200, protocolVersionObserved: false }]);
  assert.doesNotMatch(JSON.stringify(supportingNativeHTTP(events)), /private-token|refresh_token/);
});

test('archived real HTTP media evidence recomputes to five successes and the unchanged quota-blocked edit', () => {
  const directory = path.join(__dirname, 'fixtures/gateway-media-20261107');
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json')));
  assert.equal(summary.sourceUnchanged, true); assert.equal(summary.productionAccountsUnchanged, true); assert.equal(summary.productionStateUnchanged, true);
  assert.equal(summary.results.length, 6);
  for (const result of summary.results) {
    const file = path.join(directory, `${result.scenario}.json`), raw = fs.readFileSync(file, 'utf8'), record = JSON.parse(raw);
    const recomputed = assess(record.scenario, record.trace, record.http, record.expectedMedia, record.saved);
    assert.deepEqual(recomputed, record.assessment);
    assert.deepEqual(recomputed, result.assessment);
    assert.doesNotMatch(raw, /\bya29\.[A-Za-z0-9._~-]+|"authorization"\s*:\s*"Bearer /);
    if (result.scenario === 'image-edit') {
      assert.equal(recomputed.passed, false); assert.equal(record.http.blocked, true); assert.equal(record.http.aborted, true);
      assert.deepEqual(recomputed.nativeStatuses, [429]);
      assert(record.trace.some(item => item.type === 'native-body' && item.body?.error?.status === 'RESOURCE_EXHAUSTED'));
    } else assert.equal(recomputed.passed, true);
  }
  const generation = JSON.parse(fs.readFileSync(path.join(directory, 'image-generation.json')));
  assert.equal(sha(fs.readFileSync(path.join(directory, 'image-generation.jpg'))), generation.saved.sha256);
  const edit = JSON.parse(fs.readFileSync(path.join(directory, 'image-edit.json')));
  assert.equal(edit.expectedMedia.sha256, generation.saved.sha256);
});

test('separate successful edit uses the archived generated bytes after the real cooldown and preserves the first 429', () => {
  const before = path.join(__dirname, 'fixtures/gateway-media-20261107'), after = path.join(__dirname, 'fixtures/gateway-media-edit-20261107');
  const eligibility = JSON.parse(fs.readFileSync(path.join(after, 'retry-eligibility.json')));
  assert.equal(sha(fs.readFileSync(path.join(before, 'image-edit.json'))), eligibility.priorEvidenceSha256);
  assert(Date.parse(eligibility.checkedAt) > Date.parse(eligibility.latestNotBefore));
  assert.equal(eligibility.clockOrStateModified, false);
  const summary = JSON.parse(fs.readFileSync(path.join(after, 'summary.json')));
  assert.equal(summary.results.length, 1); assert.equal(summary.results[0].scenario, 'image-edit');
  assert.equal(summary.sourceUnchanged, true); assert.equal(summary.productionAccountsUnchanged, true); assert.equal(summary.productionStateUnchanged, true);
  const record = JSON.parse(fs.readFileSync(path.join(after, 'image-edit.json')));
  const result = assess(record.scenario, record.trace, record.http, record.expectedMedia, record.saved);
  assert.deepEqual(result, record.assessment); assert.deepEqual(result, summary.results[0].assessment);
  assert.equal(result.passed, true); assert.equal(result.nativeGenerations, 1); assert.deepEqual(result.nativeStatuses, [200]);
  assert.equal(record.expectedMedia.sha256, sha(fs.readFileSync(path.join(before, 'image-generation.jpg'))));
  assert.equal(record.saved.sha256, sha(fs.readFileSync(path.join(after, 'image-edit.jpg'))));
});

for (const protocol of ['messages', 'responses']) test(`${protocol} video continuation requires old media, actual prior answer, stable trajectory and a text-only new turn`, () => {
  const scenario = `video-multiturn-${protocol}`, responseMode = protocol === 'responses';
  const body = text => responseMode ? { id: 'resp_first', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  const firstPayload = textPayload(scenario, input), firstBody = body('Red, blue');
  const followup = videoFollowupPayload(scenario, firstPayload, firstBody);
  assert.equal(followup.model, firstPayload.model);
  if (responseMode) {
    assert.equal(followup.previous_response_id, 'resp_first'); assert.equal(followup.input.length, 1);
    assert.equal(followup.input[0].content.length, 1); assert.equal(followup.input[0].content[0].type, 'input_text');
    assert.doesNotMatch(JSON.stringify(followup), /video_url|base64/);
  } else {
    assert.deepEqual(followup.messages[0], firstPayload.messages[0]);
    assert.deepEqual(followup.messages[1].content, firstBody.content);
    assert.equal(followup.messages[2].content.length, 1); assert.equal(followup.messages[2].content[0].type, 'text');
  }
  const events = trace(), firstRequest = events[0];
  firstRequest.body.request.labels = { cascade_id: 'same-cascade', trajectory_id: 'same-trajectory', last_step_index: '0' };
  const signature = { sha256: sha('actual-upstream-synthetic-signature'), omitted: true };
  events.push({ type: 'native-body', id: 'request-1', body: { events: [{ response: { candidates: [{
    content: { parts: [{ text: 'Red, blue', thoughtSignature: signature }] }, finishReason: 'STOP' }] } }] } });
  const secondRequest = structuredClone(firstRequest); secondRequest.id = 'request-2';
  secondRequest.body.request.labels.last_step_index = '2';
  secondRequest.body.request.contents.push({ role: 'model', parts: [{ text: 'Red, blue', thoughtSignature: signature }] },
    { role: 'user', parts: [{ text: 'What was the last color?' }] });
  events.push(secondRequest, { type: 'native-response', id: 'request-2', status: 200, binary: '/tmp/agy-transport-test' });
  const turns = [{ payload: firstPayload, http: { status: 200, body: firstBody } }, { payload: followup, http: { status: 200, body: body('Blue') } }];
  assert.equal(assessVideoContinuation(scenario, events, turns, digest).passed, true);
  const altered = structuredClone(events);
  altered.find(event => event.id === 'request-2' && event.type === 'native-request').body.request.contents[0].parts[0].inlineData.data.sha256 = 'different';
  assert.equal(assessVideoContinuation(scenario, altered, turns, digest).passed, false);
  const differentTrajectory = structuredClone(events);
  differentTrajectory.find(event => event.id === 'request-2' && event.type === 'native-request').body.request.labels.trajectory_id = 'other-trajectory';
  assert.equal(assessVideoContinuation(scenario, differentTrajectory, turns, digest).passed, false);
  const fakeAnswer = structuredClone(turns); fakeAnswer[1].http.body = body('red');
  assert.equal(assessVideoContinuation(scenario, events, fakeAnswer, digest).passed, false);
  const lostSignature = structuredClone(events);
  delete lostSignature.find(event => event.id === 'request-2' && event.type === 'native-request').body.request.contents[1].parts[0].thoughtSignature;
  assert.equal(assessVideoContinuation(scenario, lostSignature, turns, digest).passed, false);
});

test('real multi-turn observer enforces its generation cap and stops before retrying any 429', async () => {
  for (const statuses of [[200, 200, 200, 200], [429]]) {
    let calls = 0;
    class Native { async fetch() { return { status: statuses[calls++] }; } }
    const source = observerSource('/tmp/trace', '/tmp/config', '/tmp/root', 'synthetic', { generationBudget: 4 });
    new vm.Script(source);
    const guard = source.slice(source.indexOf('const observedFetch='));
    const recorded = [];
    vm.runInNewContext(guard, { transport: { AgyNativeTransport: Native }, URL, record: value => recorded.push(value) });
    const native = new Native();
    for (const _status of statuses) await native.fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    await assert.rejects(native.fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'), { code: 'media_verification_budget_stop' });
    assert.equal(calls, statuses.length);
    assert.equal(recorded[0].quotaStopped, statuses[0] === 429);
  }
});

test('archived real Messages and Responses video continuations preserve media, native answer and signature across four successful generations', () => {
  const directory = path.join(__dirname, 'fixtures/gateway-video-multiturn-20261107');
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json')));
  assert.equal(summary.sourceUnchanged, true);
  assert.equal(summary.source.sha256, summary.sourceAfter.sha256);
  assert.equal(summary.productionAccountsUnchanged, true);
  assert.deepEqual(summary.accountsBefore, summary.accountsAfter);
  assert.equal(summary.productionStateUnchanged, true);
  assert.deepEqual(summary.stateBefore, summary.stateAfter);
  assert.equal(summary.generationBudget, 4);
  assert.equal(summary.nativeGenerationRequests, 4);
  assert.equal(summary.generationBudgetRespected, true);
  assert.equal(summary.temporaryCredentialsRemoved, true);
  assert.equal(summary.ownedGatewayStopped, true);
  assert.deepEqual(summary.scenarios, ['video-multiturn-messages', 'video-multiturn-responses']);
  const video = fs.readFileSync(path.join(__dirname, 'fixtures/gateway-media-inputs/video-fixture.mp4'));
  for (const result of summary.results) {
    const raw = fs.readFileSync(path.join(directory, `${result.scenario}.json`), 'utf8'), record = JSON.parse(raw);
    const recomputed = assessVideoContinuation(record.scenario, record.trace, record.turns, record.expectedMedia);
    assert.deepEqual(recomputed, record.assessment);
    assert.deepEqual(recomputed, result.assessment);
    assert.equal(recomputed.passed, true);
    assert.equal(recomputed.upstreamTextSignatureObserved, true);
    assert.deepEqual(recomputed.nativeStatuses, [200, 200]);
    assert.equal(record.expectedMedia.bytes, video.length);
    assert.equal(record.expectedMedia.sha256, sha(video));
    assert.equal(record.model, 'gemini-3.8-flash-low');
    assert.doesNotMatch(raw, /\bya29\.[A-Za-z0-9._~-]+|"authorization"\s*:\s*"Bearer /);
  }
});
