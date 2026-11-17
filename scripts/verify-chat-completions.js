#!/usr/bin/env node
'use strict';

// Replay a complete real client's request through an installed gateway.
// Credentials remain in the caller's environment, full evidence outside git.
// Only explicitly selected wire options change; never trim prompts or tools.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
async function main() {
  const requestFile = option('--request'), output = option('--output'), base = option('--base-url');
  if (!requestFile || !output || !base) throw new Error('Required: --request <complete client JSON> --output <private directory> --base-url <gateway /v1> [--mode json|stream] [--response-format <JSON file>] [--tool-choice <JSON>]');
  const saved = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  const payload = saved.body && typeof saved.body === 'string' ? JSON.parse(saved.body) : saved;
  assert.ok(Array.isArray(payload.messages) && payload.messages.length, 'A real Chat client request is required');
  const mode = option('--mode', payload.stream ? 'stream' : 'json');
  assert.ok(['stream', 'json'].includes(mode));
  payload.stream = mode === 'stream';
  if (payload.stream) payload.stream_options = { ...payload.stream_options, include_usage: true };
  else delete payload.stream_options;
  if (option('--response-format')) payload.response_format = JSON.parse(fs.readFileSync(option('--response-format'), 'utf8'));
  if (option('--tool-choice')) payload.tool_choice = JSON.parse(option('--tool-choice'));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(output, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  write('request.json', payload);
  const started = Date.now();
  const response = await fetch(base.replace(/\/$/, '') + '/chat/completions', { method: 'POST',
    headers: { ...Object.fromEntries(Object.entries(saved.headers || {}).filter(([name]) =>
      !['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'cookie', 'transfer-encoding', 'accept-encoding'].includes(name.toLowerCase()))),
      'content-type': 'application/json', authorization: `Bearer ${process.env[option('--api-key-env', 'GATEWAY_API_KEY')] || 'antigravity-gateway'}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(300000) });
  const raw = await response.text(); write('response.txt', raw);
  const summary = { status: response.status, elapsedMs: Date.now() - started, model: payload.model, mode,
    messageCount: payload.messages.length, toolCount: payload.tools?.length ?? payload.functions?.length ?? 0,
    requestSha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), passed: false };
  try {
    assert.equal(response.status, 200, raw.slice(0, 600));
    let message, usage, finish, usageKnown;
    if (payload.stream) {
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6));
      assert.equal(data.at(-1), '[DONE]');
      const events = data.slice(0, -1).map(value => JSON.parse(value));
      assert.ok(events.length > 1); assert.ok(events.every(event => !event.error && event.object === 'chat.completion.chunk'));
      assert.equal(new Set(events.map(event => event.id)).size, 1);
      assert.ok(events.every(event => event.model === payload.model));
      const choices = events.flatMap(event => event.choices);
      assert.equal(choices[0].delta.role, 'assistant');
      const endings = choices.filter(choice => choice.finish_reason != null);
      assert.equal(endings.length, 1); finish = endings[0].finish_reason;
      assert.deepEqual(events.at(-1).choices, []); usage = events.at(-1).usage;
      usageKnown = events.at(-1).usage_known !== false;
      message = { content: choices.map(choice => choice.delta.content || '').join(''),
        tool_calls: choices.flatMap(choice => choice.delta.tool_calls || []),
        function_call: choices.find(choice => choice.delta.function_call)?.delta.function_call };
    } else {
      const body = JSON.parse(raw); assert.ok(!body.error); assert.equal(body.object, 'chat.completion');
      assert.equal(body.model, payload.model); assert.equal(body.choices.length, 1);
      message = body.choices[0].message; finish = body.choices[0].finish_reason; usage = body.usage;
      usageKnown = body.usage_known !== false;
      assert.equal(message.role, 'assistant');
    }
    assert.ok(['stop', 'tool_calls', 'function_call'].includes(finish), `Incomplete output: ${finish}`);
    assert.ok(message.content || message.tool_calls?.length || message.function_call, 'Empty reply');
    if (usageKnown) assert.ok(usage && usage.total_tokens > 0 && usage.prompt_tokens > 0 && usage.completion_tokens > 0, 'Missing real usage');
    else assert.ok(usage == null, 'Unknown usage must not be fabricated');
    if (payload.response_format?.type !== 'text' && payload.response_format && finish === 'stop') {
      const value = JSON.parse(message.content);
      if (payload.response_format.type === 'json_object') assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      else {
        const { validateSchemaAsync } = require('../src/schema-contract');
        assert.ok(await validateSchemaAsync(value, payload.response_format.json_schema.schema));
      }
    }
    Object.assign(summary, { finish, usageKnown, usage: usage ?? null, outputChars: message.content?.length || 0, toolCalls: message.tool_calls?.length || (message.function_call ? 1 : 0), passed: true });
  } finally { write('summary.json', summary); console.log(JSON.stringify(summary)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
