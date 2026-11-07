#!/usr/bin/env node
'use strict';

// Isolated HTTP gateway -> original native Go TLS -> real Google.
// Without --run this prepares synthetic media only; it does not read accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const isolation = require('./verify-real-client-gateway');
const processes = require('./verify-client-gateway');
const ROOT = path.resolve(__dirname, '..');
const TEXT_MODEL = 'gemini-3.8-flash-low', IMAGE_MODEL = 'gemini-3.1-flash-image';
const SCENARIOS = ['video-messages', 'video-responses', 'image-messages', 'image-file-responses', 'image-generation', 'image-edit'];
const CONTINUATION_SCENARIOS = ['video-multiturn-messages', 'video-multiturn-responses'];
const INTERNAL_IMAGE_SCENARIO = 'internal-image';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const binaryDigest = value => ({ bytes: value.length, sha256: sha(value) });

function compact(value, key = '') {
  if (Buffer.isBuffer(value)) return binaryDigest(value);
  if (/^(thoughtSignature|signature)$/i.test(key) && typeof value === 'string') return { sha256: sha(value), omitted: true };
  if (typeof value === 'string') {
    if (/^data:[^,]+;base64,/i.test(value)) {
      const [prefix, body] = [value.slice(0, value.indexOf(',')), value.slice(value.indexOf(',') + 1)];
      return { dataUrl: prefix, ...binaryDigest(Buffer.from(body, 'base64')) };
    }
    if (['data', 'b64_json', 'file_data'].includes(key) && /^[A-Za-z0-9+/\r\n]*={0,2}$/.test(value) && value.length >= 16) {
      return { encoding: 'base64', ...binaryDigest(Buffer.from(value, 'base64')) };
    }
    if (/^[\[{]/.test(value.trim())) { try { return compact(JSON.parse(value)); } catch {} }
    if (value.includes('data: ')) {
      return { events: value.split('\n').filter(line => line.startsWith('data: ')).map(line => {
        try { return compact(JSON.parse(line.slice(6))); } catch { return line.slice(6); }
      }) };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => compact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, compact(item, name)]));
  return value;
}

function installInternalImageGuard(transport, record, textModel, imageModel) {
  const original = transport.AgyNativeTransport.prototype.fetch;
  let phase = 0, stopped = false, trajectory, credential;
  transport.AgyNativeTransport.prototype.fetch = async function(url, options = {}) {
    const pathname = new URL(url).pathname;
    if (!/^\/v1internal:(?:streamGenerateContent|generateContent)$/.test(pathname)) return original.call(this, url, options);
    const stop = reason => {
      stopped = true;
      record({ type: 'internal-image-guard-stop', phase, reason });
      throw Object.assign(new Error(`Controlled internal image verification stopped: ${reason}`), { status: 400, code: 'media_verification_budget_stop' });
    };
    if (stopped || phase >= 3) return stop('single attempt or three generation limit');
    let body; try { body = JSON.parse(options.body); } catch { return stop('invalid generation body'); }
    const imagePhase = phase === 1, pieces = String(body.requestId || '').split('/');
    const currentTrajectory = pieces.at(-2), step = pieces.at(-1);
    const currentCredential = new Headers(options.headers).get('authorization');
    if (body.model !== (imagePhase ? imageModel : textModel)
      || body.requestType !== (imagePhase ? 'image_gen' : 'agent')
      || pathname !== `/v1internal:${imagePhase ? 'generateContent' : 'streamGenerateContent'}`
      || step !== String(phase + 1) || !currentTrajectory || !currentCredential) return stop('unexpected model, phase or step');
    if (phase === 0) { trajectory = currentTrajectory; credential = currentCredential; }
    if (currentTrajectory !== trajectory || currentCredential !== credential) return stop('trajectory or account changed');
    if (!imagePhase && body.request?.generationConfig?.thinkingConfig?.thinkingLevel !== 'LOW') return stop('main model thinking changed');
    phase++;
    record({ type: 'internal-image-stage', phase, model: body.model, requestId: body.requestId, sameCredential: true });
    try {
      const response = await original.call(this, url, options);
      if (response.status !== 200) stopped = true;
      return response;
    } catch (error) { stopped = true; throw error; }
  };
}

function observerSource(traceFile, configDir, root, apiKey, { generationBudget = 0, internalImage = false } = {}) {
  // Wrap the observer's recorder, not the transport implementation. It calls
  // the original AgyNativeTransport.fetch and leaves the Go subprocess intact.
  const base = isolation.observerSource(traceFile, configDir, root, apiKey);
  const old = "function record(value){fs.appendFileSync(";
  assert(base.includes(old), 'Native observer recording interface changed');
  const multipart = "let body=Buffer.concat(input).toString('utf8');";
  const outgoing = "responseBody:Buffer.concat(output).toString('utf8')";
  assert(base.includes(multipart) && base.includes(outgoing), 'HTTP observer recording interface changed');
  const observed = base.replace(old, `const crypto=require('node:crypto');\nconst sha=${sha.toString()};\nconst binaryDigest=${binaryDigest.toString()};\nconst compact=${compact.toString()};\nfunction record(value){value=compact(value);fs.appendFileSync(`)
    .replace(multipart, "const rawInput=Buffer.concat(input);let body=/multipart\\/form-data/i.test(req.headers['content-type']||'')?{encoding:'multipart',...binaryDigest(rawInput)}:rawInput.toString('utf8');")
    .replace(outgoing, "responseBody:/^(image|video)\\//i.test(String(res.getHeader('content-type')||''))?binaryDigest(Buffer.concat(output)):Buffer.concat(output).toString('utf8')");
  if (internalImage) {
    assert.equal(generationBudget, 3, 'Internal image verification has exactly three available generation slots');
    return observed + `\n(${installInternalImageGuard.toString()})(transport,record,${JSON.stringify(TEXT_MODEL)},${JSON.stringify(IMAGE_MODEL)});\n`;
  }
  if (!generationBudget) return observed;
  assert(Number.isInteger(generationBudget) && generationBudget > 0 && generationBudget <= 12);
  return observed + `\nconst observedFetch=transport.AgyNativeTransport.prototype.fetch;
let generationRequests=0,quotaStopped=false;
transport.AgyNativeTransport.prototype.fetch=async function(url,options={}){
 const generation=/^\\/v1internal:(?:streamGenerateContent|generateContent)$/.test(new URL(url).pathname);
 if(generation){
  if(quotaStopped||generationRequests>=${generationBudget}){record({type:'generation-budget-stop',quotaStopped,generationRequests,budget:${generationBudget}});throw Object.assign(new Error('Controlled media verification generation budget or quota stop'),{status:400,code:'media_verification_budget_stop'});}
  generationRequests++;
 }
 const response=await observedFetch.call(this,url,options);
 if(generation&&response.status===429)quotaStopped=true;
 return response;
};\n`;
}

function mediaInputs(directory = path.join(ROOT, 'tests/fixtures/gateway-media-inputs'), ffprobe = 'ffprobe') {
  const read = (name, mimeType) => {
    const file = path.join(directory, name), bytes = fs.readFileSync(file);
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries',
      'stream=codec_name,codec_type,width,height,sample_rate,channels', '-show_entries', 'format=duration,size', '-of', 'json', file], { encoding: 'utf8' }));
    return { file, bytes, mimeType, descriptor: { filename: name, mimeType, ...binaryDigest(bytes), streams: probe.streams, duration: probe.format?.duration } };
  };
  const image = read('image-fixture.png', 'image/png'), video = read('video-fixture.mp4', 'video/mp4');
  assert(video.descriptor.streams.some(s => s.codec_type === 'video' && s.codec_name === 'h264'));
  assert(video.descriptor.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
  return { image, video };
}

function textPayload(scenario, inputs, fileId) {
  const responses = scenario.endsWith('responses'), video = scenario.startsWith('video');
  const media = video ? inputs.video : inputs.image;
  const prompt = video ? 'Inspect this attached video. State only the first and then the second solid background colors, in temporal order, in English. Do not use tools.'
    : 'Inspect this attached image. State only the dominant color in English. Do not use tools.';
  let block;
  if (responses) block = fileId ? { type: 'input_image', file_id: fileId }
    : { type: video ? 'input_video' : 'input_image', [video ? 'video_url' : 'image_url']: `data:${media.mimeType};base64,${media.bytes.toString('base64')}` };
  else block = { type: video ? 'video' : 'image', source: { type: 'base64', media_type: media.mimeType, data: media.bytes.toString('base64') } };
  return { model: TEXT_MODEL, stream: false, ...(responses ? { max_output_tokens: 2048,
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, block] }] }
    : { max_tokens: 2048, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, block] }] }) };
}

function internalImagePayload(prompt) {
  return { model: TEXT_MODEL, stream: false, max_tokens: 2048, messages: [{ role: 'user', content: [{ type: 'text',
    text: prompt || 'Use the available generate_image model service exactly once to create a plain white square containing one large solid blue circle. No text or gradients. Name it blue_circle. After the image tool result arrives, reply briefly that the blue circle image was generated. Do not call any other tool.' }] }] };
}

function visibleText(body) {
  return [...(body?.content || []), ...(body?.output || []).flatMap(item => item.type === 'message' ? item.content || [] : [])]
    .filter(item => ['text', 'output_text'].includes(item.type)).map(item => item.text || '').join('\n');
}
function nativeMedia(body) {
  return (body?.request?.contents || []).flatMap(content => content.parts || []).filter(part => part.inlineData).map(part => part.inlineData);
}
function videoFollowupPayload(scenario, firstPayload, firstBody) {
  const prompt = 'In the same video from the previous turn, what was the last solid background color? Reply with only the English color name. Do not use tools.';
  if (scenario.endsWith('responses')) {
    assert(typeof firstBody?.id === 'string' && firstBody.id.startsWith('resp_'), 'First Responses turn must provide a real response ID');
    return { model: TEXT_MODEL, stream: false, max_output_tokens: 2048, previous_response_id: firstBody.id,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] };
  }
  assert(Array.isArray(firstBody?.content), 'First Messages turn must provide its actual content');
  return { model: TEXT_MODEL, stream: false, max_tokens: 2048,
    messages: [...firstPayload.messages, { role: 'assistant', content: firstBody.content },
      { role: 'user', content: [{ type: 'text', text: prompt }] }] };
}
function nativeParts(trace, requestId) {
  return trace.filter(event => event.type === 'native-body' && event.id === requestId).flatMap(event => {
    const bodies = event.body?.events || [event.body];
    return bodies.flatMap(body => (body?.response || body)?.candidates?.[0]?.content?.parts || []);
  });
}
function completedText(body, responses) {
  return responses ? body?.status === 'completed' : body?.stop_reason === 'end_turn';
}
function assessVideoContinuation(scenario, trace, turns, expectedMedia) {
  const requests = trace.filter(event => event.type === 'native-request' && /:(?:streamGenerateContent|generateContent)/.test(event.url));
  const statuses = requests.map(request => trace.find(event => event.type === 'native-response' && event.id === request.id)?.status ?? null);
  const [first, second] = requests, [one, two] = turns;
  const firstContents = first?.body?.request?.contents || [], secondContents = second?.body?.request?.contents || [];
  const firstAnswer = visibleText(one?.http?.body), secondAnswer = visibleText(two?.http?.body);
  const responseMode = scenario.endsWith('responses');
  const continuation = two?.payload;
  const newUserParts = responseMode ? continuation?.input?.[0]?.content : continuation?.messages?.at(-1)?.content;
  const upstreamAnswer = secondContents.slice(firstContents.length).find(content => content.role === 'model');
  const signature = nativeParts(trace, first?.id).filter(part => typeof part.text === 'string' && !part.thought && part.thoughtSignature).at(-1)?.thoughtSignature;
  const originalMedia = request => nativeMedia(request?.body).some(media => media.mimeType === expectedMedia.mimeType
    && media.data?.sha256 === expectedMedia.sha256 && media.data?.bytes === expectedMedia.bytes);
  const sourceParts = nativeParts(trace, first?.id).filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
  const firstLabels = first?.body?.request?.labels, secondLabels = second?.body?.request?.labels;
  const checks = {
    exactlyTwoGenerations: requests.length === 2,
    gatewayHTTP: turns.length === 2 && turns.every(turn => turn.http?.status === 200 && !turn.http.aborted),
    clientCompleted: turns.length === 2 && turns.every(turn => completedText(turn.http?.body, responseMode)),
    nativeHTTP: statuses.length === 2 && statuses.every(status => status === 200),
    originalGoTLS: requests.length === 2 && requests.every(request => trace.some(event => event.type === 'native-response'
      && event.id === request.id && /agy-transport-/.test(event.binary || ''))),
    requestedModelPreserved: requests.length === 2 && requests.every(request => request.body?.model === TEXT_MODEL),
    officialUA: requests.length === 2 && requests.every(request => /^antigravity\/cli\/1\.5\.2 /.test(request.headers?.['user-agent'] || '')),
    originalVideoOnBothTurns: requests.length === 2 && requests.every(originalMedia),
    originalContentPrefixRetained: firstContents.length > 0 && secondContents.length > firstContents.length
      && JSON.stringify(secondContents.slice(0, firstContents.length)) === JSON.stringify(firstContents),
    firstAnswerIsRealUpstreamText: Boolean(firstAnswer && sourceParts === firstAnswer),
    previousAnswerInNativeHistory: Boolean(firstAnswer && upstreamAnswer?.parts?.some(part => !part.thought && part.text === firstAnswer)),
    observedSignatureRetained: !signature || Boolean(upstreamAnswer?.parts?.some(part => JSON.stringify(part.thoughtSignature) === JSON.stringify(signature))),
    sameNativeTrajectory: Boolean(firstLabels?.cascade_id && firstLabels?.trajectory_id
      && firstLabels.cascade_id === secondLabels?.cascade_id && firstLabels.trajectory_id === secondLabels?.trajectory_id
      && Number(secondLabels.last_step_index) > Number(firstLabels.last_step_index)),
    noNewMediaAttachment: Array.isArray(newUserParts) && newUserParts.length === 1 && ['input_text', 'text'].includes(newUserParts[0].type),
    correctClientContinuation: responseMode ? Boolean(one?.http?.body?.id && continuation?.previous_response_id === one.http.body.id
      && continuation.input.length === 1 && !continuation.messages)
      : Boolean(continuation?.messages?.length === one?.payload?.messages?.length + 2
        && JSON.stringify(continuation.messages.slice(0, one.payload.messages.length)) === JSON.stringify(one.payload.messages)
        && JSON.stringify(continuation.messages.at(-2).content) === JSON.stringify(one.http.body.content)),
    firstTemporalColors: /\bred\b[\s\S]*\bblue\b/i.test(firstAnswer),
    rememberedLastColor: /\bblue\b/i.test(secondAnswer) && !/\bred\b/i.test(secondAnswer)
  };
  return { passed: Object.values(checks).every(Boolean), checks, nativeGenerations: requests.length, nativeStatuses: statuses,
    answers: [firstAnswer, secondAnswer], upstreamTextSignatureObserved: Boolean(signature) };
}
function assess(scenario, trace, http, expectedMedia, saved) {
  const model = scenario === 'image-generation' || scenario === 'image-edit' ? IMAGE_MODEL : TEXT_MODEL;
  const imageOperation = model === IMAGE_MODEL;
  const requests = trace.filter(item => item.type === 'native-request' && /:(?:streamGenerateContent|generateContent)/.test(item.url) && item.body?.model === model);
  const ids = new Set(requests.map(item => item.id));
  const responses = trace.filter(item => item.type === 'native-response' && ids.has(item.id));
  const checks = {
    gatewayHTTP: http.status === 200 && !http.aborted,
    requestedModelPreserved: requests.length > 0,
    originalGoTLS: responses.some(item => item.status === 200 && /agy-transport-/.test(item.binary || '')),
    officialUA: requests.length > 0 && requests.every(item => /^antigravity\/cli\/1\.5\.2 /.test(item.headers?.['user-agent'] || ''))
  };
  if (expectedMedia) checks.exactMediaBytes = requests.some(item => nativeMedia(item.body).some(media =>
    media.mimeType === expectedMedia.mimeType && media.data?.sha256 === expectedMedia.sha256 && media.data?.bytes === expectedMedia.bytes));
  if (imageOperation) {
    checks.imageEnvelope = requests.length > 0 && requests.every(item => item.body.requestType === 'image_gen' && /:generateContent$/.test(item.url));
    checks.savedFileReadBack = Boolean(saved?.status === 200 && saved.sameAsGatewayDisk && saved.sameAsNativeResponse && saved.bytes > 0);
    checks.decodableImage = Boolean(saved?.width > 0 && saved?.height > 0);
    const pixel = saved?.centerRGB;
    checks.requestedColor = Boolean(pixel && (scenario === 'image-generation' ? pixel[0] > pixel[2] + 60 : pixel[2] > pixel[0] + 40));
  } else {
    const answer = visibleText(http.body);
    checks.mediaUnderstood = scenario.startsWith('video') ? /red[\s\S]*blue/i.test(answer) : /\bred\b/i.test(answer);
    if (scenario === 'image-file-responses') checks.fileUploadRoundTrip = http.upload?.status === 200 && http.upload?.readBackSame === true;
  }
  return { passed: Object.values(checks).every(Boolean), checks, nativeGenerations: requests.length,
    nativeStatuses: responses.map(item => item.status), answer: visibleText(http.body) };
}

function assessInternalImage(trace, http, saved) {
  const requests = trace.filter(event => event.type === 'native-request' && /:(?:streamGenerateContent|generateContent)/.test(event.url));
  const statuses = requests.map(request => trace.find(event => event.type === 'native-response' && event.id === request.id)?.status ?? null);
  const [first, imageRequest, last] = requests;
  const declarations = (first?.body?.request?.tools || []).flatMap(tool => tool.functionDeclarations || []);
  // This isolated payload has no client tools and enables exactly one internal
  // image service. Its current reversible MCP wire name is as valid as the
  // native name; identify the actual sole declaration, never guess a hash.
  const imageDeclaration = declarations.length === 1 ? declarations[0] : null;
  const firstParts = nativeParts(trace, first?.id), callPart = imageDeclaration && firstParts.find(part =>
    part.functionCall?.name === imageDeclaration.name && /^(?:generate_image|mcp_gateway_tool_[a-z0-9_]+)$/.test(imageDeclaration.name));
  const call = callPart?.functionCall;
  const history = (last?.body?.request?.contents || []).flatMap(content => content.parts || []);
  const replayedCall = call && history.find(part => part.functionCall?.id === call.id && part.functionCall?.name === call.name);
  const receipt = call && history.find(part => part.functionResponse?.id === call.id && part.functionResponse?.name === call.name)?.functionResponse;
  const trajectory = first?.body?.requestId?.split('/').at(-2);
  const stages = trace.filter(event => event.type === 'internal-image-stage');
  const checks = {
    exactlyThreeGenerations: requests.length === 3,
    gatewayHTTP: http.status === 200 && !http.aborted,
    clientCompleted: http.body?.stop_reason === 'end_turn' && http.body?.model === TEXT_MODEL && Boolean(visibleText(http.body)),
    nativeHTTP: statuses.length === 3 && statuses.every(status => status === 200),
    originalGoTLS: requests.length === 3 && requests.every(request => trace.some(event => event.type === 'native-response'
      && event.id === request.id && /agy-transport-/.test(event.binary || ''))),
    modelsAndRequestTypes: first?.body?.model === TEXT_MODEL && last?.body?.model === TEXT_MODEL
      && imageRequest?.body?.model === IMAGE_MODEL && imageRequest?.body?.requestType === 'image_gen'
      && first?.body?.requestType === 'agent' && last?.body?.requestType === 'agent',
    fixedLowThinking: [first, last].every(request => request?.body?.request?.generationConfig?.thinkingConfig?.thinkingLevel === 'LOW'),
    sameNativeTrajectory: Boolean(trajectory && requests.length === 3 && requests.every(request => request.body?.requestId?.split('/').at(-2) === trajectory)),
    stepsOneTwoThree: JSON.stringify(requests.map(request => request.body?.requestId?.split('/').at(-1))) === JSON.stringify(['1', '2', '3']),
    sameAccountCredential: stages.length === 3 && stages.every((stage, index) => stage.phase === index + 1 && stage.sameCredential === true),
    originalToolCallRetained: Boolean(call?.id && replayedCall && isDeepStrictEqual(replayedCall.functionCall, call)),
    observedSignatureRetained: Boolean(call && (!callPart.thoughtSignature || JSON.stringify(replayedCall?.thoughtSignature) === JSON.stringify(callPart.thoughtSignature))),
    realImageReceipt: Boolean(saved?.sha256 && receipt?.parts?.some(part => part.inlineData?.data?.sha256 === saved.sha256
      && part.inlineData.data.bytes === saved.bytes && part.inlineData.mimeType === saved.mimeType)),
    officialReceiptText: typeof receipt?.response?.output === 'string' && receipt.response.output.includes('Generated image is saved at '),
    savedFileReadBack: Boolean(saved?.status === 200 && saved.sameAsGatewayDisk && saved.sameAsNativeResponse && saved.bytes > 0),
    decodableImage: Boolean(saved?.width > 0 && saved?.height > 0),
    noPrivateToolLeak: Array.isArray(http.body?.content) && !http.body.content.some(part => part.type === 'tool_use'),
    noGuardFailure: !trace.some(event => event.type === 'internal-image-guard-stop'),
    officialUA: requests.length === 3 && requests.every(request => /^antigravity\/cli\/1\.5\.2 /.test(request.headers?.['user-agent'] || ''))
  };
  const imageBodies = trace.filter(event => event.type === 'native-body' && event.id === imageRequest?.id)
    .flatMap(event => event.body?.events || [event.body]);
  return { passed: Object.values(checks).every(Boolean), checks, nativeGenerations: requests.length, nativeStatuses: statuses,
    internalToolCallObserved: Boolean(call), toolWireName: call?.name || null,
    upstreamToolSignatureObserved: Boolean(callPart?.thoughtSignature),
    imageSubrequestAccepted: imageRequest?.body?.requestType === 'image_gen' && statuses[1] === 200,
    imageFinishMessages: imageBodies.flatMap(body => ((body?.response || body)?.candidates || []).map(candidate => candidate.finishMessage).filter(Boolean)),
    answer: visibleText(http.body) };
}

function readTrace(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function supportingNativeHTTP(trace) {
  const output = [];
  for (const request of trace.filter(item => item.type === 'native-request')) {
    const url = new URL(request.url);
    if (!((url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token')
      || (url.hostname === 'www.googleapis.com' && url.pathname === '/oauth2/v2/userinfo'))) continue;
    const response = trace.find(item => item.type === 'native-response' && item.id === request.id);
    output.push({ endpoint: `${url.origin}${url.pathname}`, method: request.method, status: response?.status ?? null,
      protocolVersionObserved: false }); // The current bridge does not expose negotiated HTTP version.
  }
  return output;
}
function stateSnapshot(source) {
  return Object.fromEntries(isolation.STATE_FILES.map(name => [name, fs.existsSync(path.join(source, name)) ? sha(fs.readFileSync(path.join(source, name))) : null]));
}

async function request(runtime, route, options = {}, startTrace = 0, model = '') {
  const controller = new AbortController(); let blocked = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, runtime.timeoutMs);
  const monitor = model ? setInterval(() => {
    const trace = readTrace(runtime.traceFile).slice(startTrace), ids = new Set(trace.filter(item => item.type === 'native-request'
      && item.body?.model === model && /:(streamGenerateContent|generateContent)/.test(item.url)).map(item => item.id));
    if (trace.some(item => item.type === 'native-response' && ids.has(item.id) && item.status === 429)) {
      blocked = true; controller.abort();
    }
  }, 50) : null;
  try {
    const response = await fetch(`${runtime.base}${route}`, { ...options, headers: { authorization: `Bearer ${runtime.apiKey}`,
      'x-client-id': 'gateway-media-verifier', 'x-session-id': crypto.randomUUID(), ...options.headers }, signal: controller.signal });
    const bytes = Buffer.from(await response.arrayBuffer()), contentType = response.headers.get('content-type') || '';
    let body;
    if (/json/.test(contentType)) { try { body = JSON.parse(bytes.toString('utf8')); } catch { body = { malformedJson: true }; } }
    return { status: response.status, headers: Object.fromEntries(response.headers), body, bytes,
      blocked: response.status === 429 || /account_quota_protected|account_pool_unavailable/.test(JSON.stringify(body)) };
  } catch (error) { return { status: null, aborted: true, blocked, timedOut, error: error.message }; }
  finally { clearTimeout(timer); clearInterval(monitor); }
}

function inspectImage(file, ffprobe, ffmpeg) {
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file], { encoding: 'utf8' }));
  const stream = probe.streams[0];
  const pixel = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'crop=32:32:(iw-32)/2:(ih-32)/2,scale=1:1',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return { ...stream, centerRGB: [...pixel.subarray(0, 3)] };
}

function loadEditReference(file, ffprobe = 'ffprobe', ffmpeg = 'ffmpeg') {
  if (!file) return null;
  const absolute = path.resolve(file), stat = fs.lstatSync(absolute);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Edit reference must be a regular image file');
  const bytes = fs.readFileSync(absolute), inspected = inspectImage(absolute, ffprobe, ffmpeg);
  const mimeType = { png: 'image/png', mjpeg: 'image/jpeg' }[inspected.codec_name];
  assert(mimeType, 'Isolated edit reference must be PNG or JPEG');
  return { file: absolute, mimeType, ...binaryDigest(bytes), ...inspected };
}

async function imageReadBack(runtime, response, scenario, trace, options) {
  const image = response.body?.data?.[0]; if (!image?.url) return null;
  const url = new URL(image.url); assert.equal(url.origin, runtime.base, 'Only read owned gateway artifact URLs');
  const read = await request(runtime, url.pathname), artifact = image.artifact;
  if (read.status !== 200 || !read.bytes?.length) return { status: read.status };
  const ext = /png/.test(read.headers['content-type']) ? '.png' : '.jpg', file = path.join(runtime.root, `${scenario}${ext}`);
  isolation.privateWrite(file, read.bytes);
  const nativeImages = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.inlineData?.mimeType?.startsWith('image/')) nativeImages.push(value.inlineData);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  for (const item of trace.filter(item => item.type === 'native-body')) visit(item.body);
  const disk = artifact?.gateway_path;
  const owned = typeof disk === 'string' && path.resolve(disk).startsWith(path.join(runtime.configDir, 'media') + path.sep);
  const result = { status: read.status, mimeType: read.headers['content-type'].split(';')[0], ...binaryDigest(read.bytes),
    sameAsGatewayDisk: Boolean(owned && fs.existsSync(disk) && sha(fs.readFileSync(disk)) === sha(read.bytes)),
    sameAsNativeResponse: nativeImages.some(part => part.data?.sha256 === sha(read.bytes)),
    ...inspectImage(file, options.ffprobe, options.ffmpeg), file };
  isolation.privateWrite(path.join(options.output, `${scenario}${ext}`), read.bytes);
  return result;
}

async function runScenario(scenario, runtime, inputs, options, generated) {
  if (scenario === INTERNAL_IMAGE_SCENARIO) return runInternalImage(runtime, options);
  if (CONTINUATION_SCENARIOS.includes(scenario)) return runVideoContinuation(scenario, runtime, inputs, options);
  const model = scenario === 'image-generation' || scenario === 'image-edit' ? IMAGE_MODEL : TEXT_MODEL;
  const start = readTrace(runtime.traceFile).length; let http, expected, upload;
  if (scenario === 'image-generation') {
    http = await request(runtime, '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'Create a plain white square with one large solid red circle centered in it. No text, no gradients.', n: 1, size: '1024x1024', response_format: 'url' }) }, start, model);
  } else if (scenario === 'image-edit') {
    if (!generated?.file) return { scenario, model, skipped: 'No verified generated image is available.' };
    const bytes = fs.readFileSync(generated.file), form = new FormData();
    form.append('model', model); form.append('prompt', 'Change only the red circle to solid blue. Keep the plain white background and centered circle. No text.');
    form.append('n', '1'); form.append('size', '1024x1024'); form.append('response_format', 'url');
    form.append('image', new Blob([bytes], { type: generated.mimeType }), 'generated-reference.jpg');
    expected = { mimeType: generated.mimeType, ...binaryDigest(bytes) };
    http = await request(runtime, '/v1/images/edits', { method: 'POST', body: form }, start, model);
  } else {
    let fileId;
    if (scenario === 'image-file-responses') {
      const form = new FormData(); form.append('purpose', 'assistants');
      form.append('file', new Blob([inputs.image.bytes], { type: inputs.image.mimeType }), 'image-fixture.png');
      upload = await request(runtime, '/v1/files', { method: 'POST', body: form }); fileId = upload.body?.id;
      if (!fileId) return { scenario, model, assessment: { passed: false, checks: { uploadSucceeded: false } }, http: compact(upload) };
      const back = await request(runtime, `/v1/files/${fileId}/content`);
      upload = { status: upload.status, fileId, readBackSame: back.status === 200 && sha(back.bytes) === inputs.image.descriptor.sha256 };
    }
    const payload = textPayload(scenario, inputs, fileId); expected = scenario.startsWith('video') ? inputs.video.descriptor : inputs.image.descriptor;
    http = await request(runtime, scenario.endsWith('responses') ? '/v1/responses' : '/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, start, model);
    if (upload) http.upload = upload;
  }
  await delay(250); let trace = readTrace(runtime.traceFile).slice(start);
  let saved;
  if (http.status === 200 && model === IMAGE_MODEL) saved = await imageReadBack(runtime, http, scenario, trace, options);
  await delay(50); trace = readTrace(runtime.traceFile).slice(start);
  const assessment = assess(scenario, trace, http, expected, saved);
  const record = { scenario, model, recordedAt: new Date().toISOString(), evidence: 'actual-http-real-gateway-real-google-native-tls',
    assessment, expectedMedia: expected, http: { ...http, bytes: http.bytes ? binaryDigest(http.bytes) : undefined }, saved, trace };
  const clean = isolation.scrub(compact(record), runtime.secrets, runtime.root);
  isolation.privateWrite(path.join(options.output, `${scenario}.json`), clean);
  console.log(JSON.stringify({ scenario, ...assessment, blocked: http.blocked }));
  return { ...record, saved };
}

async function runInternalImage(runtime, options) {
  const scenario = INTERNAL_IMAGE_SCENARIO, start = readTrace(runtime.traceFile).length, payload = internalImagePayload(options.internalImagePrompt);
  const http = await request(runtime, '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload) }, start, TEXT_MODEL);
  await delay(300);
  let trace = readTrace(runtime.traceFile).slice(start), saved;
  const artifact = http.body?.artifacts?.find(value => value.type === 'image');
  if (http.status === 200 && artifact?.url) {
    try { saved = await imageReadBack(runtime, { body: { data: [{ url: artifact.url, artifact }] } }, scenario, trace, options); }
    catch (error) { saved = { error: error.message }; }
  }
  await delay(50); trace = readTrace(runtime.traceFile).slice(start);
  http.blocked ||= trace.some(event => event.type === 'native-response' && event.status === 429);
  const assessment = assessInternalImage(trace, http, saved);
  const record = { scenario, model: TEXT_MODEL, imageModel: IMAGE_MODEL, recordedAt: new Date().toISOString(),
    evidence: 'actual-messages-real-gateway-real-google-native-tls-internal-image', payload, assessment,
    http: { ...http, bytes: http.bytes ? binaryDigest(http.bytes) : undefined }, saved, trace };
  isolation.privateWrite(path.join(options.output, `${scenario}.json`), isolation.scrub(compact(record), runtime.secrets, runtime.root));
  console.log(JSON.stringify({ scenario, ...assessment, blocked: http.blocked }));
  return record;
}

async function runVideoContinuation(scenario, runtime, inputs, options) {
  const start = readTrace(runtime.traceFile).length, turns = [], sessionId = crypto.randomUUID();
  const route = scenario.endsWith('responses') ? '/v1/responses' : '/v1/messages';
  const firstPayload = textPayload(scenario, inputs);
  const send = payload => request(runtime, route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
    body: JSON.stringify(payload) }, start, TEXT_MODEL);
  const first = await send(firstPayload); turns.push({ payload: firstPayload, http: first });
  if (first.status === 200 && !first.aborted && completedText(first.body, scenario.endsWith('responses'))
    && /\bred\b[\s\S]*\bblue\b/i.test(visibleText(first.body))) {
    const payload = videoFollowupPayload(scenario, firstPayload, first.body);
    turns.push({ payload, http: await send(payload) });
  }
  await delay(300);
  const trace = readTrace(runtime.traceFile).slice(start), assessment = assessVideoContinuation(scenario, trace, turns, inputs.video.descriptor);
  const http = { status: turns.at(-1).http.status, blocked: turns.some(turn => turn.http.blocked)
    || trace.some(event => event.type === 'native-response' && event.status === 429), aborted: turns.some(turn => turn.http.aborted) };
  const record = { scenario, model: TEXT_MODEL, recordedAt: new Date().toISOString(), evidence: 'actual-http-real-gateway-real-google-native-tls-video-continuation',
    assessment, expectedMedia: inputs.video.descriptor, http, turns: turns.map(turn => ({ payload: turn.payload,
      http: { ...turn.http, bytes: turn.http.bytes ? binaryDigest(turn.http.bytes) : undefined } })), trace };
  isolation.privateWrite(path.join(options.output, `${scenario}.json`), isolation.scrub(compact(record), runtime.secrets, runtime.root));
  console.log(JSON.stringify({ scenario, ...assessment, blocked: http.blocked }));
  return record;
}

async function main() {
  process.umask(0o077);
  const argv = process.argv.slice(2), option = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  const options = { source: path.resolve(option('--source-config', path.join(os.homedir(), '.antigravity-gateway'))),
    output: path.resolve(option('--out', 'tests/fixtures/gateway-media-20261107')), timeoutMs: Number(option('--timeout', '180')) * 1000,
    ffprobe: option('--ffprobe', 'ffprobe'), ffmpeg: option('--ffmpeg', 'ffmpeg'), editReference: option('--edit-reference', ''),
    generationBudget: Number(option('--generation-budget', '0')), internalImagePrompt: option('--internal-image-prompt', '') };
  assert(Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 300_000);
  assert(Number.isInteger(options.generationBudget) && options.generationBudget >= 0 && options.generationBudget <= 12);
  const selected = option('--scenarios', SCENARIOS.join(',')).split(','); assert(selected.every(name => [...SCENARIOS, ...CONTINUATION_SCENARIOS, INTERNAL_IMAGE_SCENARIO].includes(name)));
  options.internalImage = selected.includes(INTERNAL_IMAGE_SCENARIO);
  assert(!options.internalImagePrompt || (options.internalImage && options.internalImagePrompt.trim().length > 0
    && options.internalImagePrompt.length <= 16000), 'A prompt override is only valid for the isolated internal image scenario');
  if (options.internalImage) {
    assert.deepEqual(selected, [INTERNAL_IMAGE_SCENARIO], 'Internal image verification runs alone without retries');
    assert.equal(options.generationBudget, 3, 'Internal image verification requires --generation-budget 3');
    assert(argv.includes('--out'), 'Internal image verification requires a separate --out evidence directory');
  }
  const inputs = mediaInputs(option('--inputs', path.join(ROOT, 'tests/fixtures/gateway-media-inputs')), options.ffprobe);
  const reference = loadEditReference(options.editReference, options.ffprobe, options.ffmpeg);
  const desiredModels = [...new Set(selected.flatMap(scenario => scenario === INTERNAL_IMAGE_SCENARIO ? [TEXT_MODEL, IMAGE_MODEL]
    : ['image-generation', 'image-edit'].includes(scenario) ? [IMAGE_MODEL] : [TEXT_MODEL]))];
  const source = { ...isolation.sourceSnapshot(), verifierSha256: sha(fs.readFileSync(__filename)) };
  const prepared = { recordedAt: new Date().toISOString(), source, models: desiredModels, scenarios: selected,
    inputs: { image: inputs.image.descriptor, video: inputs.video.descriptor }, generationBudget: options.generationBudget || null,
    ...(reference ? { editReference: { ...reference, file: path.basename(reference.file) } } : {}), accountDataRead: false, realRequestsSent: false };
  if (!argv.includes('--run')) { isolation.privateWrite(path.join(options.output, 'preflight.json'), prepared); console.log(JSON.stringify(prepared)); return; }
  assert(!fs.existsSync(path.join(options.output, 'summary.json')), 'Use a fresh output directory; do not overwrite previous real evidence');
  assert(process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec'), 'macOS Seatbelt is required for real verification');
  const root = fs.mkdtempSync('/private/tmp/agy-media-'), configDir = path.join(root, 'gateway-data'), traceFile = path.join(root, 'trace.jsonl');
  const apiKey = `media-verifier-${crypto.randomBytes(24).toString('hex')}`, stateBefore = stateSnapshot(options.source);
  let snapshot, gateway, runError, startup, results = [];
  try {
    snapshot = isolation.copyManagedState(options.source, configDir);
    const port = await processes.unusedPort(), preload = path.join(root, 'observer.cjs'), sandbox = path.join(root, 'gateway.sb');
    isolation.privateWrite(preload, observerSource(traceFile, configDir, root, apiKey, options));
    isolation.privateWrite(sandbox, isolation.gatewaySandbox(root, options.source));
    const tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp);
    // No HOME reassignment; only explicitly copied managed credentials exist
    // under this CONFIG_DIR and Seatbelt denies the formal config directory.
    const env = { PATH: process.env.PATH, TMPDIR: tmp, TERM: 'dumb', NO_COLOR: '1',
      ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir, ANTIGRAVITY_GATEWAY_PORT: String(port), ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1',
      ANTIGRAVITY_GATEWAY_API_KEY: apiKey, ANTIGRAVITY_GATEWAY_TIMEOUT_MS: String(options.timeoutMs), ANTIGRAVITY_DEFAULT_MODEL: TEXT_MODEL };
    gateway = processes.launch('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, '--require', preload, path.join(ROOT, 'antigravity-gateway.js')], { cwd: root, env });
    const runtime = { root, configDir, base: `http://127.0.0.1:${port}`, apiKey, traceFile, timeoutMs: options.timeoutMs,
      secrets: snapshot.secrets.concat(apiKey) };
    for (let index = 0; index < 120 && !gateway.closed; index++) {
      const response = await request({ ...runtime, timeoutMs: 1000 }, '/v1/models');
      if (response.status === 200) {
        startup = { status: response.status, modelIds: response.body?.data?.map(item => item.id) || [] };
        if (desiredModels.every(model => startup.modelIds.includes(model))) break;
      }
      await delay(250);
    }
    assert(desiredModels.every(model => startup?.modelIds.includes(model)), 'The HTTP model catalog did not advertise the required models');
    const blockedModels = new Set(); let generated = reference;
    for (const scenario of selected) {
      const model = scenario === 'image-generation' || scenario === 'image-edit' ? IMAGE_MODEL : TEXT_MODEL;
      if (blockedModels.has(model)) { results.push({ scenario, model, skipped: 'Earlier 429 or unavailable pool; no repeated request for this model.' }); continue; }
      const result = await runScenario(scenario, runtime, inputs, options, generated); results.push(result);
      if (result.http?.blocked) blockedModels.add(model);
      if (scenario === 'image-generation' && result.assessment?.passed) generated = result.saved;
    }
  } catch (error) { runError = error.message; process.exitCode = 1; }
  finally {
    try {
      await processes.stop(gateway);
      const accountsAfter = isolation.accountSnapshot(options.source), stateAfter = stateSnapshot(options.source), sourceAfter = isolation.sourceSnapshot();
      const summary = { ...prepared, realRequestsSent: true, accountDataRead: true, accountSnapshot: snapshot?.summary,
        productionAccountsUnchanged: accountsAfter.digest === snapshot?.before.digest, productionStateUnchanged: JSON.stringify(stateBefore) === JSON.stringify(stateAfter),
        accountsBefore: snapshot?.before, accountsAfter, stateBefore, stateAfter, sourceAfter, sourceUnchanged: sourceAfter.sha256 === source.sha256,
        startup, runError, results: results.map(({ scenario, model, assessment, http, skipped }) => ({ scenario, model, assessment,
          ...(http ? { status: http.status, blocked: http.blocked, aborted: http.aborted } : {}), skipped })),
        supportingNativeHTTP: supportingNativeHTTP(readTrace(traceFile)),
        gatewayStdout: gateway?.stdout, gatewayStderr: gateway?.stderr,
        boundary: options.internalImage
          ? 'One Messages request; original internal image extension explicitly enabled; Gemini Low -> image model -> Gemini Low only. Three physical generations maximum, fixed account/trajectory/steps, no retry after failure. No formal service or protection changes.'
          : 'Owned temporary foreground gateway only. No formal service start/restart; no protection reset; exact MP4 includes audio but audio semantics are not independently verified.' };
      summary.nativeGenerationRequests = readTrace(traceFile).filter(event => event.type === 'native-request' && /:(streamGenerateContent|generateContent)/.test(event.url)).length;
      summary.generationBudgetRespected = !options.generationBudget || summary.nativeGenerationRequests <= options.generationBudget;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      summary.temporaryCredentialsRemoved = !fs.existsSync(root);
      summary.ownedGatewayStopped = !gateway || gateway.closed === true;
      isolation.privateWrite(path.join(options.output, 'summary.json'), isolation.scrub(compact(summary), (snapshot?.secrets || []).concat(apiKey), root));
      if (runError || !summary.productionAccountsUnchanged || !summary.productionStateUnchanged || !summary.sourceUnchanged
        || !summary.generationBudgetRespected || !summary.temporaryCredentialsRemoved || !summary.ownedGatewayStopped
        || results.some(result => !result.assessment?.passed)) process.exitCode = 1;
      console.log(JSON.stringify({ finished: true, passed: results.filter(result => result.assessment?.passed).length, total: results.length,
        sourceUnchanged: summary.sourceUnchanged, productionAccountsUnchanged: summary.productionAccountsUnchanged, productionStateUnchanged: summary.productionStateUnchanged, runError }));
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  }
}

module.exports = { compact, observerSource, mediaInputs, textPayload, visibleText, nativeMedia, assess, stateSnapshot, supportingNativeHTTP, loadEditReference,
  videoFollowupPayload, assessVideoContinuation, SCENARIOS, CONTINUATION_SCENARIOS,
  installInternalImageGuard, internalImagePayload, assessInternalImage, INTERNAL_IMAGE_SCENARIO };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
