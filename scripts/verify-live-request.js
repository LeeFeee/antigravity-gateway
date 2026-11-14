#!/usr/bin/env node
'use strict';

// Replay an actual captured client body through an already deployed gateway.
// No fake provider, replacement model, stripped instructions or tool executor.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--base-url', '--service-config', '--body', '--protocol', '--out', '--modes', '--expected-error'].includes(key)
      || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Invalid option: ${key}`);
    result[key.slice(2)] = argv[index + 1];
  }
  for (const key of ['base-url', 'body', 'protocol', 'out']) assert.ok(result[key], `Missing --${key}`);
  assert.ok(['messages', 'responses'].includes(result.protocol), 'Protocol must be messages or responses');
  return result;
}

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function sseEvents(text) {
  return text.replace(/\r\n/g, '\n').split('\n\n').flatMap(block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return !data || data === '[DONE]' ? [] : [JSON.parse(data)];
  });
}

function inspectResponse(raw, protocol, streaming) {
  const events = streaming ? sseEvents(raw) : [JSON.parse(raw)];
  const failure = events.find(event => event.error || event.type === 'error'
    || ['response.failed', 'response.incomplete'].includes(event.type));
  if (failure) return { passed: false, errorCode: failure.error?.code || failure.error?.type
    || failure.response?.error?.code || failure.code || failure.type,
    upstreamStatus: failure.error?.upstream_status || failure.upstream_status || null };
  if (protocol === 'responses') {
    const response = streaming ? events.find(event => event.type === 'response.completed')?.response : events[0];
    const text = (response?.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text')
      .map(part => part.text || '').join('');
    const calls = (response?.output || []).filter(item => /tool_call|function_call/.test(item.type));
    return { passed: response?.status === 'completed' && (!streaming || events.at(-1)?.type === 'response.completed')
      && text.trim().length > 0 && calls.length === 0
      && response?.usage?.input_tokens > 0 && response?.usage?.output_tokens > 0,
    terminalEvent: streaming ? events.at(-1)?.type : response?.status, textCharacters: text.length,
    textSha256: hash(text), toolCalls: calls.length, usage: response?.usage || null, responseId: response?.id };
  }
  const response = events[0];
  const text = streaming ? events.filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
    .map(event => event.delta.text || '').join('') : (response.content || []).filter(part => part.type === 'text')
    .map(part => part.text || '').join('');
  const start = events.find(event => event.type === 'message_start');
  const last = events.findLast(event => event.type === 'message_delta');
  const usage = streaming ? { ...start?.message?.usage, ...last?.usage } : response.usage;
  const stop = streaming ? last?.delta?.stop_reason : response.stop_reason;
  const terminal = streaming ? events.at(-1)?.type : response.type;
  return { passed: stop === 'end_turn' && text.trim().length > 0 && usage?.input_tokens > 0
    && usage?.output_tokens > 0 && terminal === (streaming ? 'message_stop' : 'message'),
  terminalEvent: terminal, stopReason: stop, textCharacters: text.length, textSha256: hash(text), usage,
  responseId: streaming ? start?.message?.id : response.id };
}

async function main() {
  process.umask(0o077);
  const args = options(process.argv.slice(2));
  const url = new URL(args['base-url']);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
  const base = url.href.replace(/\/$/, '').replace(/\/v1$/, '');
  const service = args['service-config'] ? JSON.parse(fs.readFileSync(args['service-config'], 'utf8')) : null;
  const key = service?.environment?.ANTIGRAVITY_GATEWAY_API_KEY || process.env.ANTIGRAVITY_GATEWAY_API_KEY;
  assert.ok(key || (service && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)),
    'Existing gateway key required via service config or environment for a remote gateway');
  const authentication = key ? { Authorization: `Bearer ${key}` } : {};
  const sourceBytes = fs.readFileSync(args.body), source = JSON.parse(sourceBytes);
  assert.ok(source && typeof source === 'object' && typeof source.model === 'string');
  assert.ok(args.protocol === 'responses' ? source.input : source.messages, 'Expected a complete client body');
  const modes = (args.modes || 'json,sse').split(',');
  assert.ok(modes.length > 0 && new Set(modes).size === modes.length && modes.every(mode => ['json', 'sse'].includes(mode)));
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { mode: 0o700 }); // Refuse to overwrite a previous run.
  const sourceDigest = hash(sourceBytes);
  const report = { startedAt: new Date().toISOString(), baseUrl: base, protocol: args.protocol,
    sourceSha256: sourceDigest, model: source.model, clientToolCount: source.tools?.length || 0,
    systemSha256: hash(JSON.stringify(source.instructions ?? source.system ?? null)),
    toolsSha256: hash(JSON.stringify(source.tools ?? [])),
    changesToCapturedBody: ['stream'], cases: [], passed: false };
  try {
    const health = await fetch(base + '/api/hello', { headers: authentication, signal: AbortSignal.timeout(20000) });
    assert.equal(health.status, 200, 'Authenticated gateway health');
    report.gatewayVersion = (await health.json()).version;
    assert.ok(report.gatewayVersion);
    for (const mode of modes) {
      const started = Date.now(), session = `live-hermes-${crypto.randomUUID()}`;
      const body = { ...source, stream: mode === 'sse' };
      const requestText = JSON.stringify(body);
      const entry = { mode, session, startedAt: new Date().toISOString(), requestSha256: hash(requestText) };
      report.cases.push(entry);
      const response = await fetch(base + '/v1/' + args.protocol, {
        method: 'POST', headers: { ...authentication, 'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01', 'x-session-id': session, 'x-client-name': 'hermes',
          'User-Agent': args.protocol === 'responses' ? 'OpenAI/Python 2.54.0' : 'Anthropic/Python 0.125.0' },
        body: requestText, signal: AbortSignal.timeout(300000)
      });
      entry.httpStatus = response.status;
      entry.contentType = response.headers.get('content-type');
      const raw = await response.text();
      fs.writeFileSync(path.join(out, mode + '-response.txt'), raw, { mode: 0o600 });
      entry.responseSha256 = hash(raw);
      Object.assign(entry, inspectResponse(raw, args.protocol, mode === 'sse' && /text\/event-stream/.test(entry.contentType || '')));
      entry.elapsedMs = Date.now() - started;
      if (args['expected-error']) entry.passed = entry.errorCode === args['expected-error']
        && entry.upstreamStatus === 'RESOURCE_EXHAUSTED';
      else entry.passed &&= response.status === 200;
      console.log(JSON.stringify({ mode, httpStatus: entry.httpStatus, passed: entry.passed,
        errorCode: entry.errorCode, elapsedMs: entry.elapsedMs, textCharacters: entry.textCharacters }));
    }
    assert.equal(hash(fs.readFileSync(args.body)), sourceDigest, 'Original captured request changed during validation');
    report.passed = report.cases.length === modes.length && report.cases.every(entry => entry.passed);
    if (!report.passed) process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { inspectResponse, sseEvents };
