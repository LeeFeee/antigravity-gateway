'use strict';
require('./helpers/gateway-environment');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { AgySessionStore, newState, recordStreamProjection, recordStreamRecovery, restoreClientProjections, recordToolStreamError } = require('../src/agy-session-state');
const { prepareNativeContext } = require('../src/agy-context-state');
const { streamErrorContent } = require('../src/agy-stream-recovery');
const { DirectAntigravityProvider } = require('../src/direct-provider');
const { capturedClaudeClient, CLAUDE_COMPACTION_PROFILE } = require('../src/agy-client-compaction');
const model = 'gemini-3.8-flash-high';
const reply = parts => new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { headers: { 'content-type': 'application/json' } });
const text = value => ({ role: 'model', parts: [{ text: value }] });
const step = b => Number(b.requestId.split('/').at(-1));
const counter = b => Number(b.request.labels.request_id.split('-').at(-1));
function broken(parts, code = 'upstream_read_error', onError) {
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`)); }
    else { onError?.(); controller.error(Object.assign(new Error('controlled response read failure'), { code })); }
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stream-tests-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], delays = [], original = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => { delays.push(ms); return original(fn, Math.min(ms, 2), ...args); });
  const provider = (fetch, options = {}) => new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory }),
    accessToken: 'test-token', projectId: 'test-project', retryPolicy: 'agy',
    localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:stream-test' }) }, ...options,
    fetchImpl: (url, request) => { requests.push(JSON.parse(request.body)); return fetch(url, request); } });
  const messages = [{ role: 'user', text: 'Read owned.txt once.' }];
  const seed = async () => {
    await provider(async () => reply([{ functionCall: { id: 'call-one', name: 'Read', args: { path: 'owned.txt' } }, thoughtSignature: 'original-call-signature' }]))
      .send({ messages }, model, { sessionId: 's' });
    messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: 'call-one', name: 'Read', arguments: { path: 'owned.txt' } }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'call-one', content: 'file-code' }] });
  };
  return { directory, requests, delays, provider, messages, seed };
}

function brokenWire(bytes) {
  let sent = false;
  return new Response(new ReadableStream({ pull(c) {
    if (!sent) { sent = true;c.enqueue(Buffer.from(bytes)); }
    else c.error(Object.assign(new Error('controlled interrupted body'), { code: 'upstream_read_error' }));
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
const signedCall = id => ({ functionCall: { id, name: 'Read', args: { file_path: id + '.txt' } }, thoughtSignature: 'signature-' + id });
function receipt(messages, call) {
  messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments }] },
    { role: 'user', parts: [{ type: 'tool_result', id: call.id, content: 'actual-file-content' }] });
}

for (const stop of [false, true]) test(`complete signed SSE tool event ${stop ? 'with' : 'without'} STOP survives read failure and restart`, async t => {
  const f = fixture(t), part = signedCall('one');
  const first = await f.provider(async () => brokenWire(`data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\r\n\r\n`
    + (stop ? 'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[]}}]}\r\n\r\n' : '')))
    .send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(first.toolCalls, [{ id: 'one', name: 'Read', arguments: part.functionCall.args, thoughtSignature: part.thoughtSignature }]);
  assert.equal(f.requests.length,1);receipt(f.messages,first.toolCalls[0]);
  await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  const next = f.requests.at(-1);assert.deepEqual(f.requests.map(step),[1,4]);assert.deepEqual(f.requests.map(counter),[0,1]);
  assert.deepEqual(next.request.contents[1].parts,[part]);assert.equal(next.request.contents[2].parts[0].functionResponse.id,'one');
  assert.deepEqual(next.request.contents[3],streamErrorContent());assert.ok(f.delays.some(n=>n>3000&&n<=4000));
  f.messages.push({ role: 'assistant', text: 'FINAL' }, { role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'recall' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.equal(step(f.requests.at(-1)),6);assert.deepEqual(f.requests.at(-1).request.contents.slice(0,4),next.request.contents);
  assert.equal(f.requests.at(-1).request.contents.filter(c=>c.parts.some(p=>p.text?.startsWith('Error:'))).length,1);
  assert.doesNotMatch(JSON.stringify(f.requests),/toolStreamErrors|readyAt|toolRecovery/);
});

test('two interrupted completed tool calls preserve both receipts and advance one shared backoff sequence', async t => {
  const f = fixture(t);
  for (const id of ['one','two']) {
    const result = await f.provider(async () => broken([signedCall(id)])).send({ messages: f.messages }, model, { sessionId: 's' });
    receipt(f.messages,result.toolCalls[0]);
  }
  await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.map(step),[1,4,7]);assert.deepEqual(f.requests.map(counter),[0,1,2]);
  assert.equal(f.requests.at(-1).request.contents.filter(c=>c.parts.some(p=>p.functionResponse)).length,2);
  assert.equal(f.requests.at(-1).request.contents.filter(c=>c.parts.some(p=>p.text?.startsWith('Error:'))).length,2);
  const delays=f.delays.filter(n=>n>3000);assert.equal(delays.length,2);assert.ok(delays[0]<=4000);assert.ok(delays[1]>=4700&&delays[1]<=8000);
});

for (const priorThought of [false,true]) test(`tool JSON without event terminator is not dispatched (${priorThought ? 'prior thought' : 'empty'} case)`, async t => {
  const f=fixture(t);let attempt=0;
  const thought='data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"unfinished"}]}}]}\r\n\r\n';
  const bytes=(priorThought?thought:'')+`data: ${JSON.stringify({ candidates: [{ content: { parts: [signedCall('uncommitted')] } }] })}\r\n`;
  const out=await f.provider(async()=>++attempt===1?brokenWire(bytes):reply([{text:'FINAL'}])).send({messages:f.messages},model,{sessionId:'s'});
  assert.deepEqual(out.toolCalls,[]);assert.deepEqual(f.requests.map(step),priorThought?[1,3]:[1,2]);assert.deepEqual(f.requests.map(counter),priorThought?[0,1]:[0,0]);
  assert.doesNotMatch(JSON.stringify(f.requests),/uncommitted|unfinished/);
  assert.deepEqual(f.requests[1].request.contents.slice(1),priorThought?[streamErrorContent()]:[]);
});

test('tool interruption marker requires full prefix, model, call and matching actual receipts', () => {
  const state=newState('a','s'),prefix=[{role:'user',parts:[{text:'Original'}]}],call={role:'model',parts:[signedCall('one')]};
  recordToolStreamError(state,prefix,model,call,1,Date.now()+4000);
  const result={role:'model',parts:[{functionResponse:{id:'one',name:'Read',response:{output:'actual'}}}]},source=[...prefix,call,result];
  assert.deepEqual(restoreClientProjections(state,source,model),[...source,streamErrorContent()]);
  for(const change of [s=>s[0].parts[0].text='Edited',s=>s[1].parts[0].functionCall.args.file_path='other',s=>s[2].parts[0].functionResponse.id='foreign',s=>s[2].parts[0].functionResponse.name='Write',s=>s[2]={role:'user',parts:[{text:'Continue'}]},s=>s.pop()]){
    const modified=structuredClone(source);change(modified);assert.deepEqual(restoreClientProjections(state,modified,model),modified);
  }
  assert.deepEqual(restoreClientProjections(state,source,'gemini-3.8-flash-low'),source);
  const duplicate=structuredClone(source);duplicate[2].parts.push(duplicate[2].parts[0]);assert.deepEqual(restoreClientProjections(state,duplicate,model),duplicate);
});

test('cancelled wait after a real tool receipt does not allocate an unsent logical request', async t => {
  const f=fixture(t),first=await f.provider(async()=>broken([signedCall('one')])).send({messages:f.messages},model,{sessionId:'s'});
  receipt(f.messages,first.toolCalls[0]);const controller=new AbortController();setImmediate(()=>controller.abort());
  await assert.rejects(f.provider(async()=>assert.fail('cancelled backoff cannot dispatch')).send({messages:f.messages},model,{sessionId:'s',signal:controller.signal}),{name:'AbortError'});
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,fs.readdirSync(f.directory).find(n=>n.endsWith('.json')))));
  assert.equal(saved.requestIndex,1);assert.equal(saved.nextStep,4);assert.equal(f.requests.length,1);
});

for (const firstReceiptWithUser of [false,true]) test(`ninth tool failure executes once, retains receipts and stops without a recovery user (${firstReceiptWithUser?'new user immediately':'identical API retries'})`, async t => {
  const f=fixture(t);let attempt=0;
  const result=await f.provider(async()=>++attempt<=8?new Response('controlled 503',{status:503}):broken([signedCall('last')]))
    .send({messages:f.messages},model,{sessionId:'s'});
  assert.equal(attempt,9);assert.deepEqual(f.requests.map(step),[1,2,3,4,5,6,7,8,9]);assert.equal(result.toolCalls[0].id,'last');
  receipt(f.messages,result.toolCalls[0]);
  if(!firstReceiptWithUser)for(let i=0;i<2;i++)await assert.rejects(f.provider(async()=>assert.fail('terminal receipt must not dispatch'))
    .send({messages:f.messages},model,{sessionId:'s'}),{status:400,code:'direct_stream_interrupted'});
  f.messages.push({role:'user',text:'Recall.'});
  await f.provider(async()=>reply([{text:'FINAL'}])).send({messages:f.messages},model,{sessionId:'s'});
  const next=f.requests.at(-1);assert.equal(step(next),13);assert.equal(counter(next),1);assert.ok(next.request.labels.last_execution_id);
  assert.deepEqual(next.request.contents[1].parts,[signedCall('last')]);assert.equal(next.request.contents[2].parts[0].functionResponse.id,'last');
  assert.equal(next.request.contents.length,4);assert.doesNotMatch(JSON.stringify(next),/Error: The stream was interrupted|terminalRecorded/);
});

test('cancellation client profile requires captured Anthropic CLI version and explicit session', () => {
  const req = { headers: { 'user-agent': 'claude-cli/2.1.285 (external, sdk-cli)', 'x-claude-code-session-id': 's' } };
  assert.equal(capturedClaudeClient(req, { protocol: 'anthropic' }), CLAUDE_COMPACTION_PROFILE);
  for (const headers of [{}, { ...req.headers, 'user-agent': 'claude-cli/2.1.286' }, { ...req.headers, 'x-claude-code-session-id': '' }]) {
    assert.equal(capturedClaudeClient({ headers }, { protocol: 'anthropic' }), '');
  }
  assert.equal(capturedClaudeClient(req, { protocol: 'openai' }), '');
});

for (const timeout of [false, true]) test(`${timeout ? 'gateway timeout retains' : 'observed client cancellation translates'} the exact Claude cancellation pair after restart`, async t => {
  const f = fixture(t), controller = new AbortController();let attempt = 0;
  await assert.rejects(f.provider(async (_url, options) => ++attempt === 1 ? broken([{ text: 'PARTIAL' }])
    : new Response(new ReadableStream({ start(s) {
      s.enqueue(Buffer.from('data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"CONTINUING"}]}}]}\n\n'));
      options.signal.addEventListener('abort', () => s.error(options.signal.reason), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } }))
    .send({ messages: f.messages }, model, { sessionId: 's', signal: controller.signal,
      onThinkingDelta: value => { if (value === 'CONTINUING') controller.abort(timeout
        ? Object.assign(new Error('deadline'), { code: 'request_timeout' }) : undefined); } }));
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,fs.readdirSync(f.directory).find(n=>n.endsWith('.json')))));
  assert.equal(Boolean(Object.values(saved.streamRecoveries)[0].clientCancelled), !timeout);
  f.messages.push({ role: 'assistant', text: 'PARTIAL\n' }, { role: 'user', text: '[Request interrupted by user]' },
    { role: 'assistant', text: 'No response requested.' }, { role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model,
    { sessionId: 's', nativeClientProfile: CLAUDE_COMPACTION_PROFILE });
  const resumed=f.requests.at(-1);assert.equal(step(resumed),timeout?7:5);assert.equal(counter(resumed),2);
  assert.deepEqual(resumed.request.contents.slice(1,3),[text('PARTIAL'),streamErrorContent()]);
  if(timeout)assert.match(JSON.stringify(resumed),/No response requested/);
  else assert.doesNotMatch(JSON.stringify(resumed),/Request interrupted by user|No response requested|CONTINUING|nativeClientProfile|clientCancelled/);
});

test('cancellation translation cannot remove arbitrary text, edited history or other client/model content', () => {
  const prefix=[{role:'user',parts:[{text:'Original'}]}],visible=text('PARTIAL\n');
  const pair=[{role:'user',parts:[{text:'[Request interrupted by user]'}]},text('No response requested.')],next={role:'user',parts:[{text:'Next'}]};
  const state=newState('a','s'),native=[text('PARTIAL'),streamErrorContent()];
  recordStreamProjection(state,prefix,visible,model,native,Date.now(),true);
  const source=[...prefix,visible,...pair,next],options={clientProfile:CLAUDE_COMPACTION_PROFILE};
  assert.deepEqual(restoreClientProjections(state,source,model,options),[...prefix,...native,next]);
  for(const profile of ['', 'claude-code-2.1.286'])assert.ok(JSON.stringify(restoreClientProjections(state,source,model,{clientProfile:profile})).includes('No response requested.'));
  const edited=structuredClone(source);edited[0].parts[0].text='Changed';assert.deepEqual(restoreClientProjections(state,edited,model,options),edited);
  assert.deepEqual(restoreClientProjections(state,source,'gemini-3.8-flash-low',options),source);
  for(const edit of [s=>s[2].parts[0].text+=' ',s=>s[3].parts[0].text+=' extra',s=>s[2].parts.push({text:'actual instruction'}),s=>s.pop()]){
    const changed=structuredClone(source);edit(changed);assert.ok(JSON.stringify(restoreClientProjections(state,changed,model,options)).includes('No response requested'));
  }
  const ordinary=newState('a','s');recordStreamProjection(ordinary,prefix,visible,model,native);
  assert.ok(JSON.stringify(restoreClientProjections(ordinary,source,model,options)).includes('No response requested.'));
});

test('recorded cancellation with no assistant echo translates only the captured pair at the pending prefix', () => {
  const state=newState('a','s'),prefix=[{role:'user',parts:[{text:'Original'}]}],native=[streamErrorContent()];
  recordStreamRecovery(state,prefix,model,native,'',Date.now(),true,1,true);
  const next={role:'user',parts:[{text:'Next'}]},source=[...prefix,{role:'user',parts:[{text:'[Request interrupted by user]'}]},text('No response requested.'),next];
  const context=prepareNativeContext(state,source,model,{clientProfile:CLAUDE_COMPACTION_PROFILE});
  assert.deepEqual(context.sourceContents,[...prefix,...native,next]);
});

for (const phase of ['visible', 'thought']) test(`native ${phase} stream continuation survives restart without flattening its hidden history`, async t => {
  const f = fixture(t); await f.seed(); let attempt = 0; const streamed = [];
  const result = await f.provider(async () => ++attempt === 1
    ? broken([{ thought: true, text: 'INCOMPLETE_THOUGHT' }, ...(phase === 'visible' ? [{ text: 'PARTIAL' }] : [])])
    : reply([{ thought: true, text: 'finished reasoning' }, { text: 'FINAL', thoughtSignature: 'final-signature' }]))
    .send({ messages: f.messages }, model, { sessionId: 's', onDelta: s => streamed.push(s) });
  assert.deepEqual(f.requests.map(step), [1, 3, 5]); assert.deepEqual(f.requests.map(counter), [0, 1, 2]);
  const before = f.requests[1], after = f.requests[2];
  assert.deepEqual(after.request.contents.slice(0, 3), before.request.contents);
  assert.deepEqual(after.request.contents.slice(3), [...(phase === 'visible' ? [text('PARTIAL')] : []), streamErrorContent()]);
  assert.ok(!JSON.stringify(after).includes('INCOMPLETE_THOUGHT'));
  const adjusted = structuredClone(after); adjusted.request.contents = before.request.contents; adjusted.requestId = before.requestId;
  adjusted.request.labels.last_step_index = before.request.labels.last_step_index; adjusted.request.labels.request_id = before.request.labels.request_id;
  assert.deepEqual(adjusted, before); assert.ok(f.delays.includes(4000));
  assert.equal(result.text, phase === 'visible' ? 'PARTIAL\nFINAL' : 'FINAL'); assert.equal(streamed.join(''), result.text);
  f.messages.push({ role: 'assistant', text: result.text }, { role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'file-code' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  const resumed = f.requests.at(-1);
  assert.deepEqual(f.requests.map(step), [1, 3, 5, 7]);
  assert.deepEqual(resumed.request.contents.slice(0, after.request.contents.length), after.request.contents);
  assert.equal(resumed.request.contents.at(-2).parts.at(-1).thoughtSignature, 'final-signature');
  assert.equal(resumed.request.contents[1].parts[0].thoughtSignature, 'original-call-signature');
  assert.equal(resumed.request.contents.filter(c => c.parts.some(p => p.functionResponse)).length, 1);
  assert.doesNotMatch(JSON.stringify(resumed), /streamProjections|streamRecoveries|INCOMPLETE_THOUGHT/);
});

for (const phase of ['visible', 'thought']) test(`first-turn pure ${phase} interruption uses the captured native continuation without requiring a tool`, async t => {
  const f = fixture(t); let attempt = 0;
  const result = await f.provider(async () => ++attempt === 1 ? broken([{ thought: true, text: 'INCOMPLETE' },
    ...(phase === 'visible' ? [{ text: 'PARTIAL' }] : [])]) : reply([{ text: 'FINAL', thoughtSignature: 'signed' }]))
    .send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.map(step), [1, 3]);assert.deepEqual(f.requests.map(counter), [0, 1]);
  assert.deepEqual(f.requests[1].request.contents.slice(1), [...(phase === 'visible' ? [text('PARTIAL')] : []), streamErrorContent()]);
  f.messages.push({ role: 'assistant', text: result.text }, { role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.equal(step(f.requests[2]), 5);assert.equal(f.requests[2].request.contents.at(-2).parts.at(-1).thoughtSignature, 'signed');
  assert.doesNotMatch(JSON.stringify(f.requests[2]), /INCOMPLETE/);
});

for (const terminal of ['http', 'stream']) test(`mixed HTTP/read failures share one nine-attempt budget, including terminal ${terminal}`, async t => {
  const f = fixture(t); await f.seed();
  const sequence = terminal === 'http' ? [503, 'cut', 503, 'cut', 503, 'cut', 503, 503, 503]
    : [503, 'cut', 503, 'cut', 503, 'cut', 503, 503, 'cut'];
  await assert.rejects(f.provider(async () => {
    assert.ok(sequence.length, 'native policy issued an extra tenth automatic request');
    return sequence.shift() === 'cut' ? broken([{ thought: true, text: 'INCOMPLETE' }]) : new Response('controlled 503', { status: 503 });
  }).send({ messages: f.messages }, model, { sessionId: 's' }), terminal === 'http' ? { status: 503 } : { code: 'upstream_read_error' });
  assert.deepEqual(f.requests.map(step), [1, 3, 4, 6, 7, 9, 10, 12, 13, 14]);
  assert.deepEqual(f.requests.map(counter), [0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  const delays = f.delays.filter(d => d >= 4000);
  assert.equal(delays.length, 8);
  for (const [i, delay] of delays.entries()) {
    const max = Math.min(30000, 4000 * 2 ** i), min = Math.max(4000, max * .6);
    assert.ok(delay >= min && delay <= max, `retry ${i} restarted its backoff: ${delay}`);
  }
  f.messages.push({ role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'file-code' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  const resumed = f.requests.at(-1);
  assert.equal(step(resumed), terminal === 'http' ? 16 : 17); assert.equal(counter(resumed), 5);
  assert.deepEqual(resumed.request.contents.slice(3, 6), Array.from({ length: 3 }, streamErrorContent));
  assert.equal(resumed.request.contents.length, 7);assert.ok(resumed.request.labels.last_execution_id);
});

test('hard process stop during mixed backoff preserves the shared failure count before the next dispatch', async t => {
  const f = fixture(t); await f.seed();
  const childSource = `
    const { DirectAntigravityProvider } = require(${JSON.stringify(require.resolve('../src/direct-provider'))});
    const { AgySessionStore } = require(${JSON.stringify(require.resolve('../src/agy-session-state'))});
    const nativeTimeout = global.setTimeout; let waits = 0, attempts = 0;
    global.setTimeout = (fn, ms, ...args) => {
      if (ms >= 4000) { waits++; if (waits === 3) process.send({ ready: true }); ms = waits === 3 ? 60000 : 1; }
      return nativeTimeout(fn, ms, ...args);
    };
    const provider = new DirectAntigravityProvider({ sessionStore: new AgySessionStore({ directory: ${JSON.stringify(f.directory)} }),
      accessToken: 'test-token', projectId: 'test-project', retryPolicy: 'agy',
      localAuth: { isConfigured: () => false, load: () => ({ sourcePath: 'managed-account:stream-test' }) },
      fetchImpl: async () => {
        if (++attempts !== 2) return new Response('controlled 503', { status: 503 });
        let sent = false;
        return new Response(new ReadableStream({ pull(c) {
          if (!sent) { sent = true; c.enqueue(Buffer.from('data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"unfinished"}]}}]}\\n\\n')); }
          else c.error(Object.assign(new Error('controlled stream interruption'), { code: 'upstream_read_error' }));
        } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
      }
    });
    provider.send({ messages: ${JSON.stringify(f.messages)} }, ${JSON.stringify(model)}, { sessionId: 's' })
      .catch(e => { console.error(e.message); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ['-e', childSource], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', b => errors += b);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(message.ready, true, errors);
  const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, fs.readdirSync(f.directory).find(n => n.endsWith('.json')))));
  assert.equal(Object.values(saved.streamRecoveries)[0].retryCount, 3);
  assert.equal(Object.values(saved.streamRecoveries)[0].terminal, undefined);
  assert.equal(saved.nextStep, 7); assert.equal(saved.requestIndex, 3);
  let attempt = 0;
  await f.provider(async () => ++attempt === 1 ? new Response('controlled 503', { status: 503 }) : reply([{ text: 'FINAL' }]))
    .send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.map(step), [1, 7, 8]);assert.deepEqual(f.requests.map(counter), [0, 3, 3]);
  const delay = f.delays.filter(n => n >= 4000).at(-1);assert.ok(delay >= 18000 && delay <= 30000);
});

test('terminal partial text rejects an identical client retry locally and restores before a new user turn', async t => {
  const f = fixture(t); await f.seed();let attempts = 0;
  await assert.rejects(f.provider(async () => ++attempts <= 8 ? new Response('controlled 503', { status: 503 })
    : broken([{ text: 'LAST PARTIAL' }])).send({ messages: f.messages }, model, { sessionId: 's' }), { code: 'upstream_read_error' });
  assert.equal(attempts, 9); assert.deepEqual(f.requests.map(step), [1,3,4,5,6,7,8,9,10,11]);
  await assert.rejects(f.provider(async () => assert.fail('must not dispatch model-ended history'))
    .send({ messages: f.messages }, model, { sessionId: 's' }), { status: 400, code: 'direct_stream_interrupted' });
  assert.equal(f.requests.length, 10);
  f.messages.push({ role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'file-code' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.equal(step(f.requests.at(-1)), 14);assert.equal(counter(f.requests.at(-1)), 2);
  assert.equal(f.requests.at(-1).request.contents[3].parts[0].text, 'LAST PARTIAL');
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /Error: The stream was interrupted/);
});

test('pure streaming recovery never replays the final thought after the answer in any client protocol', async t => {
  const f = fixture(t);
  const { createAnthropicTextEmitter, createChatTextEmitter, createResponsesTextEmitter } = require('../antigravity-gateway');
  const { anthropicResponse, chatResponse, responsesResponse } = require('../src/protocol');
  for (const [protocol, create, format] of [
    ['anthropic', createAnthropicTextEmitter, anthropicResponse],
    ['chat', createChatTextEmitter, chatResponse],
    ['responses', createResponsesTextEmitter, responsesResponse]
  ]) {
    const frames = [], emitter = create({ write: s => frames.push(s), end() {} }, model, 'resp_test');
    let attempt = 0;
    const result = await f.provider(async () => ++attempt === 1
      ? broken([{ thought: true, text: 'UNFINISHED' }, { text: 'PARTIAL' }])
      : reply([{ thought: true, text: 'FINAL THOUGHT' }, { text: 'ANSWER' }]))
      .send({ messages: f.messages }, model, { sessionId: protocol, onDelta: emitter.onDelta, onThinkingDelta: emitter.onThinkingDelta });
    assert.equal(result.thinking, 'UNFINISHEDFINAL THOUGHT');
    emitter.finish(format(model, result, 'resp_test'));
    const events = frames.join('').split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
    const thought = events.map(e => e.delta?.thinking || e.choices?.[0]?.delta?.reasoning_content
      || (e.type === 'response.reasoning_summary_text.delta' ? e.delta : '') || '').join('');
    assert.equal(thought, result.thinking);
    if (protocol === 'anthropic') assert.equal(events.filter(e => e.type === 'content_block_start').at(-1).content_block.type, 'text');
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /UNFINISHED/);
  }
});

test('backoff cancellation persists only actual recovery history and allocates no unsent request', async t => {
  const f = fixture(t); await f.seed(); const controller = new AbortController();
  await assert.rejects(f.provider(async () => broken([{ text: 'PARTIAL' }], 'upstream_read_error', () => setImmediate(() => controller.abort())))
    .send({ messages: f.messages }, model, { sessionId: 's', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.requests.map(step), [1, 3]);
  const state = JSON.parse(fs.readFileSync(path.join(f.directory, fs.readdirSync(f.directory).find(n => n.endsWith('.json')))));
  assert.equal(state.nextStep, 5); assert.equal(state.requestIndex, 2);
  const out = await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.map(step), [1, 3, 5]); assert.deepEqual(f.requests.map(counter), [0, 1, 2]);
  assert.deepEqual(f.requests.at(-1).request.contents.slice(3), [text('PARTIAL'), streamErrorContent()]);
  assert.equal(out.text, 'PARTIAL\nFINAL');
});

test('stream recovery cannot restore removed prefixes, another model or an arbitrary user-role insertion', () => {
  const state = newState('owner', 'key'), prefix = [{ role: 'user', parts: [{ text: 'Original' }] }], visible = text('PARTIAL\nFINAL');
  const native = [text('PARTIAL'), streamErrorContent(), text('FINAL')];
  recordStreamProjection(state, prefix, visible, model, native);
  assert.deepEqual(restoreClientProjections(state, [...prefix, visible], model), [...prefix, ...native]);
  const edited = [{ role: 'user', parts: [{ text: 'Changed' }] }, visible];
  assert.deepEqual(restoreClientProjections(state, edited, model), edited);
  assert.deepEqual(restoreClientProjections(state, [...prefix, visible], 'gemini-3.8-flash-low'), [...prefix, visible]);
  const count = Object.keys(state.streamProjections).length;
  recordStreamProjection(state, prefix, text('bad'), model, [{ role: 'user', parts: [{ text: 'Injected instruction' }] }, text('FINAL')]);
  assert.equal(Object.keys(state.streamProjections).length, count);
  const genuineUser = prepareNativeContext(newState('', ''), [streamErrorContent()], model);
  assert.match(genuineUser.contents[0].parts[0].text, /^<USER_REQUEST>/);
  recordStreamRecovery(state, prefix, model, [text('PARTIAL'), streamErrorContent()], 'PARTIAL\n');
  assert.equal(prepareNativeContext(state, edited, model).streamRecovery, null);
});

test('nine actual stream failures exhaust eight continuations, retaining eight raw errors and the terminal steps', async t => {
  const f = fixture(t); await f.seed();
  await assert.rejects(f.provider(async () => broken([{ thought: true, text: 'unfinished' }]))
    .send({ messages: f.messages }, model, { sessionId: 's' }), { code: 'upstream_read_error' });
  assert.deepEqual(f.requests.map(step), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  assert.deepEqual(f.requests.map(counter), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  f.messages.push({ role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'file-code' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  const resumed = f.requests.at(-1);
  assert.equal(step(resumed), 22); // agy had 23, including its own real restart notification.
  assert.equal(counter(resumed), 10);
  assert.deepEqual(resumed.request.contents.slice(3, 11), Array.from({ length: 8 }, streamErrorContent));
  assert.equal(resumed.request.contents.length, 12);
  assert.match(resumed.request.labels.last_execution_id, /^[a-f\d-]{36}$/);
  assert.doesNotMatch(JSON.stringify(resumed), /unfinished|SYSTEM_MESSAGE|server restart/);
});

test('a client echo of partial output during cancelled backoff restores exactly one copy of the error history', async t => {
  const f = fixture(t); await f.seed(); const controller = new AbortController();
  await assert.rejects(f.provider(async () => broken([{ text: 'PARTIAL' }], 'upstream_read_error', () => setImmediate(() => controller.abort())))
    .send({ messages: f.messages }, model, { sessionId: 's', signal: controller.signal }), { name: 'AbortError' });
  f.messages.push({ role: 'assistant', text: 'PARTIAL' }, { role: 'user', text: 'Continue.' });
  await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.at(-1).request.contents.slice(3, 5), [text('PARTIAL'), streamErrorContent()]);
  assert.equal(f.requests.at(-1).request.contents.length, 6);
  assert.equal(step(f.requests.at(-1)), 6);
});

test('cancellation during the continuation preserves its second partial answer without inventing another stream error', async t => {
  const f = fixture(t); await f.seed(); const controller = new AbortController(); let attempt = 0;
  await assert.rejects(f.provider(async (_url, options) => {
    if (++attempt === 1) return broken([{ text: 'PARTIAL' }]);
    return new Response(new ReadableStream({ start(s) {
      s.enqueue(Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'SECOND' }] } }] })}\n\n`));
      options.signal.addEventListener('abort', () => s.error(options.signal.reason), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }).send({ messages: f.messages }, model, { sessionId: 's', signal: controller.signal,
    onDelta: value => { if (value === 'SECOND') controller.abort(); } }), { name: 'AbortError' });
  f.messages.push({ role: 'assistant', text: 'PARTIAL\nSECOND' }, { role: 'user', text: 'Continue.' });
  await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.at(-1).request.contents.slice(3, 6), [text('PARTIAL'), streamErrorContent(), text('SECOND')]);
  assert.equal(f.requests.at(-1).request.contents.length, 7);
  assert.equal(step(f.requests.at(-1)), 7);
});

test('empty SSE read failure retries the same logical request, changing only its captured step and timestamp', async t => {
  const f = fixture(t);let attempt = 0;
  const result = await f.provider(async () => ++attempt === 1 ? broken([]) : reply([{ text: 'FINAL', thoughtSignature: 'signed' }]))
    .send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.map(step), [1, 2]);assert.deepEqual(f.requests.map(counter), [0, 0]);
  const adjusted = structuredClone(f.requests[1]);adjusted.requestId = f.requests[0].requestId;
  adjusted.request.labels.last_step_index = f.requests[0].request.labels.last_step_index;
  assert.deepEqual(adjusted, f.requests[0]);assert.equal(result.text, 'FINAL');assert.ok(f.delays.includes(4000));
  f.messages.push({ role: 'assistant', text: result.text }, { role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'file-code' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.deepEqual(f.requests.map(step), [1, 2, 4]);assert.deepEqual(f.requests.map(counter), [0, 0, 1]);
  assert.equal(f.requests.at(-1).request.contents.at(-2).parts[0].thoughtSignature, 'signed');
  assert.doesNotMatch(JSON.stringify(f.requests), /Error: The stream was interrupted/);
});

for (const mixed of [false, true]) test(`${mixed ? 'mixed HTTP and empty SSE' : 'empty SSE'} failures exhaust one logical request without inventing history`, async t => {
  const f = fixture(t);let count = 0;
  await assert.rejects(f.provider(async () => {
    assert.ok(++count <= 9, 'no tenth automatic attempt');
    return mixed && ![2, 4, 6].includes(count) ? new Response('controlled 503', { status: 503 }) : broken([]);
  }).send({ messages: f.messages }, model, { sessionId: 's' }), mixed ? { status: 503 } : { code: 'upstream_read_error' });
  assert.deepEqual(f.requests.map(step), [1,2,3,4,5,6,7,8,9]);assert.deepEqual(f.requests.map(counter), Array(9).fill(0));
  for (const request of f.requests) assert.deepEqual(request.request.contents, f.requests[0].request.contents);
  const delays = f.delays.filter(d => d >= 4000);assert.equal(delays.length, 8);
  for (const [i, delay] of delays.entries()) { const max = Math.min(30000, 4000 * 2 ** i);assert.ok(delay >= Math.max(4000, max * .6) && delay <= max); }
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, fs.readdirSync(f.directory).find(n => n.endsWith('.json')))));
  assert.equal(saved.nextStep, 10);assert.equal(saved.requestIndex, 1);assert.ok(saved.lastExecutionId);
  f.messages.push({ role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'file-code' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.equal(step(f.requests.at(-1)), 11);assert.equal(counter(f.requests.at(-1)), 1);
  assert.equal(f.requests.at(-1).request.contents.length, 2);assert.ok(f.requests.at(-1).request.labels.last_execution_id);
});

test('cancelled empty-read backoff allocates no unsent logical request or model step', async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(f.provider(async () => broken([], 'upstream_read_error', () => setImmediate(() => controller.abort())))
    .send({ messages: f.messages }, model, { sessionId: 's', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.requests.map(step), [1]);
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, fs.readdirSync(f.directory).find(n => n.endsWith('.json')))));
  assert.equal(saved.nextStep, 2);assert.equal(saved.requestIndex, 1);assert.ok(saved.lastExecutionId);
});

test('empty-read exhaustion after a partial recovery preserves a terminal budget and only real history', async t => {
  const f = fixture(t);let attempt = 0;
  await assert.rejects(f.provider(async () => ++attempt === 1 ? broken([{ text: 'PARTIAL' }]) : broken([]))
    .send({ messages: f.messages }, model, { sessionId: 's' }), { code: 'upstream_read_error' });
  assert.equal(attempt, 9);assert.deepEqual(f.requests.map(step), [1,3,4,5,6,7,8,9,10]);
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, fs.readdirSync(f.directory).find(n => n.endsWith('.json')))));
  const recovery = Object.values(saved.streamRecoveries)[0];assert.equal(recovery.terminal, true);assert.equal(recovery.retryCount, 9);
  assert.deepEqual(recovery.contents, [text('PARTIAL'), streamErrorContent()]);
  f.messages.push({ role: 'user', text: 'Recall.' });
  await f.provider(async () => reply([{ text: 'FINAL' }])).send({ messages: f.messages }, model, { sessionId: 's' });
  assert.equal(step(f.requests.at(-1)), 12);assert.equal(counter(f.requests.at(-1)), 2);
});

for (const kind of ['unknown-transport', 'half-tool', 'legacy', 'checkpoint', 'other-model']) test(`unmeasured ${kind} does not acquire a guessed native stream recovery`, async t => {
  const f = fixture(t); await f.seed();
  const parts = kind === 'half-tool' ? [{ functionCall: { name: 'Read', args: {} } }] : kind === 'no-content' ? [] : [{ text: 'partial' }];
  await assert.rejects(f.provider(async () => broken(parts, kind === 'unknown-transport' ? 'unknown' : 'upstream_read_error'),
    kind === 'legacy' ? { retryPolicy: 'legacy' } : {}).send({ messages: f.messages }, kind === 'other-model' ? 'gemini-3.8-flash-low' : model,
      { sessionId: 's', ...(kind === 'checkpoint' ? { auxiliaryScope: 'compaction' } : {}) }));
  assert.equal(f.requests.length, 2);
});
