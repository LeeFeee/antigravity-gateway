'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const fakeAgy = path.join(__dirname, 'fixtures', 'fake-agy.js');
process.env.ANTIGRAVITY_CLI_PATH = process.execPath;
process.env.ANTIGRAVITY_CLI_PREFIX_ARGS = JSON.stringify([fakeAgy]);
process.env.ANTIGRAVITY_DEFAULT_MODEL = 'gemini-test-high';
process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS = '2000';
// The developer machine may have a real local agy login. Keep protocol tests
// deterministic and exercise the official subprocess fallback here.
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'agy';

const { codexModelInfo, createServer } = require('../antigravity-gateway');
const { version: packageVersion } = require('../package.json');

async function withServer(t) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('model endpoint reflects agy models', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((item) => item.id), ['gemini-test-high', 'gemini-test-low']);
  assert.deepEqual(body.models.map((item) => item.slug), ['gemini-test-high', 'gemini-test-low']);
  assert.equal(body.models[0].supports_parallel_tool_calls, true);
});

test('Gemini 3.7 Flash advertises its 1M context even when discovery metadata is temporarily unavailable', () => {
  const model = codexModelInfo('gemini-3.7-flash-high', 0);
  assert.equal(model.context_window, 1048576);
  assert.equal(model.max_context_window, 1048576);
});

test('health endpoint reports the package release version', async (t) => {
  const base = await withServer(t);
  const response = await fetch(base);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.name, 'antigravity-gateway');
  assert.equal(body.version, packageVersion);
});

test('Claude Code provider connectivity probe does not produce a false missing-interface error', async (t) => {
  const base = await withServer(t);
  for (const method of ['GET', 'POST', 'HEAD']) {
    const response = await fetch(`${base}/api/hello`, { method });
    assert.equal(response.status, 200);
    if (method !== 'HEAD') {
      const body = await response.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.name, 'antigravity-gateway');
    }
  }
});

test('Claude Code telemetry batches are acknowledged locally without upstream forwarding', async (t) => {
  const base = await withServer(t);
  for (const method of ['POST', 'HEAD']) {
    const response = await fetch(`${base}/api/event_logging/batch`, {
      method,
      ...(method === 'POST' ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ name: 'client_test' }] })
      } : {})
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  }
});

test('Anthropic non-stream and stream responses are protocol-shaped', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-test-high', max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].text, 'hello-1');

  const streamed = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-test-high', stream: true, messages: [{ role: 'user', content: 'hello' }] })
  });
  const text = await streamed.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: message_stop/);
  assert.match(text, /"text":"hel"/);
  assert.match(text, /"text":"lo-1"/);
});

test('Anthropic tools are returned to the client and never executed by gateway', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-test-high',
      messages: [{ role: 'user', content: 'RETURN_TOOL' }],
      tools: [{ name: 'shell', description: 'run', input_schema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } }, additionalProperties: false } }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.stop_reason, 'tool_use');
  const toolUse = body.content.find((block) => block.type === 'tool_use');
  assert.equal(toolUse.name, 'shell');
  assert.deepEqual(toolUse.input, { command: 'pwd' });
});

test('Responses supports previous_response_id and function call shape', async (t) => {
  const base = await withServer(t);
  const first = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-test-high', input: 'hello' })
  }).then((response) => response.json());
  assert.match(first.id, /^resp_/);
  assert.equal(first.output[0].content[0].text, 'hello-1');
  const secondResponse = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-test-high', previous_response_id: first.id, input: 'second' })
  });
  assert.equal(secondResponse.status, 200);
});

test('Responses previous_response_id is bound to the client session scope', async (t) => {
  const base = await withServer(t);
  const first = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'session-a' },
    body: JSON.stringify({ model: 'gemini-test-high', input: 'hello' })
  }).then((response) => response.json());
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'session-b' },
    body: JSON.stringify({ model: 'gemini-test-high', previous_response_id: first.id, input: 'second' })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'previous_response_not_found');
});

test('Responses exposes projected client tools as function_call items', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-test-high', input: 'RETURN_TOOL',
      tools: [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } }, additionalProperties: false } }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.output[0].type, 'function_call');
  assert.equal(body.output[0].name, 'shell');
  assert.deepEqual(JSON.parse(body.output[0].arguments), { command: 'pwd' });
});

test('Claude Code Auto mode output is normalized to XML only', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      system: 'You are a security monitor for autonomous AI coding agents. Return <block>no</block>.',
      messages: [{ role: 'user', content: 'classify safe action' }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.content[0].text, '<block>no</block>');
  assert.equal(response.headers.get('x-antigravity-model'), 'gemini-test-low');
});

test('current Claude Code Auto mode output-format contract uses the fast route', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      system: 'Auto Mode evaluator. If the action should be blocked: <block>yes</block>. If the action should be allowed: <block>no</block>.',
      messages: [{ role: 'user', content: 'classify safe action' }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.content[0].text, '<block>no</block>');
  assert.equal(response.headers.get('x-antigravity-model'), 'gemini-test-low');
});

test('Claude Code Haiku helper agents use the fast model route', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'helper request' }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-antigravity-model'), 'gemini-test-low');
});
