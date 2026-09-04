'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const fakeAgy = path.join(__dirname, 'fixtures', 'fake-agy.js');
process.env.ANTIGRAVITY_CLI_PATH = process.execPath;
process.env.ANTIGRAVITY_CLI_PREFIX_ARGS = JSON.stringify([fakeAgy]);
process.env.ANTIGRAVITY_DEFAULT_MODEL = 'gemini-test-high';
process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS = '2000';
delete process.env.ANTIGRAVITY_GATEWAY_API_KEY;
// The developer machine may have a real local agy login. Keep protocol tests
// deterministic and exercise the official subprocess fallback here.
process.env.ANTIGRAVITY_GATEWAY_TRANSPORT = 'agy';

const {
  claudeConfigBody,
  codexModelInfo,
  createServer,
  displayModels,
  featuredModels,
  startupBanner
} = require('../antigravity-gateway');
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
  const expected = ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-test-high', 'gemini-test-low'];
  assert.deepEqual(body.data.map((item) => item.id), expected);
  assert.deepEqual(body.models.map((item) => item.slug), expected);
  assert.equal(body.models[0].supports_parallel_tool_calls, true);
});

test('Claude model picker contains every discovered model with exact IDs', () => {
  const models = ['gemini-3.7-flash-high', 'claude-opus-4-6-thinking'];
  const body = claudeConfigBody(models);
  assert.equal(body.modelPicker.replaceBuiltInOptions, true);
  assert.deepEqual(body.modelPicker.options.map((item) => item.model), models);
});

test('model presentation follows the configured priority without mutating discovery order', () => {
  const expected = [
    'gemini-3.8-flash-high',
    'gemini-3.7-flash-high',
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'gemini-3.1-pro-high',
    'gemini-3.1-flash-image',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-tiered',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash',
    'gemini-3.7-flash-tiered',
    'gemini-3.5-flash-extra-low',
    'gemini-3.1-pro-low',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-agent',
    'gemini-3-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-thinking',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-pro-agent',
    'chat_20706',
    'gpt-oss-120b-medium'
  ];
  const discovered = [...expected].reverse();
  const snapshot = [...discovered];
  assert.deepEqual(displayModels(discovered), expected);
  assert.deepEqual(discovered, snapshot);
});

test('startup banner shows only featured real IDs and client base URLs', () => {
  const models = [
    'gemini-2.5-pro',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-low',
    'gemini-3.7-flash-low',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking'
  ];
  assert.deepEqual(featuredModels(models), [
    'gemini-3.8-flash-high',
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'gemini-3.8-flash-low',
    'gemini-3.7-flash-low'
  ]);
  const banner = startupBanner({ models, credentialSource: 'test-credential-source' });
  assert.match(banner, /BaseURL:\n    Anthropic: http:\/\/127\.0\.0\.1:9897\n    OpenAI: http:\/\/127\.0\.0\.1:9897\/v1/);
  assert.match(banner, /API Key: antigravity-gateway（任意内容）/);
  assert.match(banner, /本地密钥: test-credential-source/);
  assert.match(banner, /    gemini-3\.7-flash-low/);
  assert.doesNotMatch(banner, /    gemini-2\.5-pro/);
  assert.match(banner, /更多模型: antigravity-gateway --models/);
});

test('Gemini 3.7 and 3.8 Flash advertise their verified 1M context without discovery metadata', () => {
  for (const slug of ['gemini-3.7-flash-high', 'gemini-3.8-flash-high']) {
    const model = codexModelInfo(slug, 0);
    assert.equal(model.context_window, 1048576);
    assert.equal(model.max_context_window, 1048576);
  }
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

test('normal Claude model IDs are never silently replaced', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'normal request' }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-antigravity-model'), 'claude-opus-4-6-thinking');
});

test('Chat Completions and Responses preserve exact client model IDs', async (t) => {
  const base = await withServer(t);
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'chat request' }]
    })
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-antigravity-model'), 'claude-sonnet-4-6');

  const responses = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-6-thinking',
      input: 'responses request'
    })
  });
  assert.equal(responses.status, 200);
  assert.equal(responses.headers.get('x-antigravity-model'), 'claude-opus-4-6-thinking');
});

test('models missing from the local catalog are still sent upstream unchanged', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'normal request' }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-antigravity-model'), 'gpt-5.6-sol');
});

test('upstream model failures keep the provider error and add an advisory catalog diagnosis', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'FAIL' }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error.type, 'agy_upstream_error');
  assert.match(body.error.message, /^Antigravity 上游请求失败：simulated failure/);
  assert.match(body.error.message, /网关诊断：/);
  assert.match(body.error.message, /请求模型 gpt-5\.6-sol 未出现在当前发现的 Antigravity 模型目录中/);
  assert.match(body.error.message, /请输入 \/model 更换可用模型/);
});

test('upstream failures for catalog models are returned without a false model diagnosis', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-test-high',
      messages: [{ role: 'user', content: 'FAIL' }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(body.error.message, /^Antigravity 上游请求失败：simulated failure/);
  assert.doesNotMatch(body.error.message, /网关诊断：/);
});

test('a missing client model field uses the configured default only', async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'default request' }] })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-antigravity-model'), 'gemini-test-high');
});

test('explicit model aliases remain opt-in exact mappings', async (t) => {
  const previous = process.env.ANTIGRAVITY_MODEL_ALIASES;
  process.env.ANTIGRAVITY_MODEL_ALIASES = JSON.stringify({ 'my-opus': 'claude-opus-4-6-thinking' });
  t.after(() => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_MODEL_ALIASES;
    else process.env.ANTIGRAVITY_MODEL_ALIASES = previous;
  });
  const base = await withServer(t);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'my-opus',
      messages: [{ role: 'user', content: 'explicit alias request' }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-antigravity-model'), 'claude-opus-4-6-thinking');
});
