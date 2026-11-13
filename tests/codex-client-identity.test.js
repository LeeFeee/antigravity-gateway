'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeResponses } = require('../src/protocol');
const { sanitizeClientIdentity, inferClientProfile } = require('../src/client-identity');
const { capturedNativeClient, CODEX_CLIENT_PROFILE, CODEX_167_CLIENT_PROFILE } = require('../src/agy-client-profile');
const { SessionManager } = require('../src/session-manager');

const CURRENT_USER_AGENT = 'codex_exec/0.167.2 (Mac OS 15.7.0; arm64) dumb (codex_exec; 0.167.2)';
const CURRENT_TUI_USER_AGENT = 'codex-tui/0.167.2 (Mac OS 15.7.0; arm64) xterm-256color (codex-tui; 0.167.2)';

function capture(name, index = 0) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/codex-0.164.0-20261107', name), 'utf8'));
  assert.equal(fixture.version, 'codex-cli 0.164.0'); assert.equal(fixture.passed, true);
  const request = fixture.captures.filter(item => item.path === '/v1/responses' && item.body?.input)[index];
  assert(request);
  // Namespace conversion has its own protocol tests; identity tests retain
  // the original instruction blocks without depending on that implementation.
  const normalized = normalizeResponses({ ...request.body, tools: request.body.tools.filter(tool => tool.type !== 'namespace') });
  // The 0.167.2 probe returned the same developer templates and request shapes.
  // Reuse the archived payload and exercise the captured current User-Agent.
  const req = { headers: { ...request.headers, 'user-agent': CURRENT_USER_AGENT }, socket: { remoteAddress: '127.0.0.1' } };
  return { request, normalized, req, options: { clientProfile: capturedNativeClient(req, normalized) } };
}
function project(normalized) { normalized.system = [normalized.instructions, ...normalized.instructionMessages.map(item => item.text)].filter(Boolean).join('\n\n'); return normalized; }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('Codex 0.167.2 fallback 仅去除两处框架身份，完整保留行为、权限和用户 AGENTS', () => {
  const { normalized, options } = capture('text-installation-metadata.json');
  const before = structuredClone(normalized), first = normalized.instructionMessages[0].text;
  const prefix = 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. ';
  const note = 'Within this context, Codex refers to the open-source agentic coding interface (not the old Codex language model built by OpenAI).\n\n';
  const cleaned = sanitizeClientIdentity(freeze(normalized), options);
  assert.deepEqual(cleaned.metadata.profile, { client: 'codex', templateVersion: '0.167.2', evidence: ['codex-cli-fallback-template'] });
  assert.deepEqual(cleaned.metadata.rules, ['codex-cli-framework-identity', 'codex-cli-model-identity-note']);
  assert.equal(cleaned.normalized.instructionMessages[0].text, first.slice(prefix.length).replace(note, ''));
  assert.deepEqual(cleaned.normalized.instructionMessages.slice(1), before.instructionMessages.slice(1));
  assert.match(cleaned.normalized.system, /You are expected to be precise, safe, and helpful\./);
  assert.match(cleaned.normalized.system, /# AGENTS\.md spec/);
  assert.match(cleaned.normalized.system, /Approval policy is currently never/);
  assert.match(cleaned.normalized.system, /Use the `apply_patch` tool to edit files/);
  assert.deepEqual(cleaned.normalized.messages, before.messages);
  assert.match(cleaned.normalized.messages[0].text, /PROBE_USER_RULE/);
  assert.deepEqual(cleaned.normalized.tools, before.tools);
  assert.deepEqual(normalized, before);
  assert.doesNotMatch(cleaned.normalized.system, /You are (?:Google|Antigravity)/);
  assert.equal(Object.hasOwn(cleaned.normalized, 'clientProfile'), false);
  assert.equal(Object.hasOwn(cleaned.normalized, 'metadata'), false);
  assert.deepEqual(sanitizeClientIdentity(cleaned.normalized, options).normalized, cleaned.normalized);
});

test('实抓网关 catalog 的 Codex 中性 developer 无身份可删，原文与工具完整保留', () => {
  const { normalized, options } = capture('text-gateway-catalog.json'), before = structuredClone(normalized);
  const cleaned = sanitizeClientIdentity(freeze(normalized), options);
  assert.deepEqual(cleaned.metadata.profile, { client: 'codex', templateVersion: '0.167.2', evidence: ['codex-neutral-catalog-template'] });
  assert.deepEqual(cleaned.metadata.rules, []);
  assert.deepEqual(cleaned.normalized, before);
  assert.equal(cleaned.normalized.instructionMessages[0].text, 'Follow the client instructions and use only client-provided tools when needed.');
});

test('实抓本地压缩三请求保留新权限块、历史和摘要，并保持同一版本会话', () => {
  const sessions = new SessionManager();
  const identities = [];
  for (let index = 0; index < 3; index++) {
    const { normalized, options, req, request } = capture('compact-external-sandbox.json', index);
    const cleaned = sanitizeClientIdentity(normalized, options);
    assert.equal(cleaned.metadata.profile.client, 'codex');
    assert.deepEqual(cleaned.metadata.rules, []);
    assert.deepEqual(cleaned.normalized, normalized);
    assert.match(cleaned.normalized.instructionMessages[1].text, /danger-full-access/);
    identities.push(sessions.resolveIdentity(req, request.body, normalized));
    if (index === 1) assert.deepEqual(cleaned.normalized.tools, []);
  }
  for (const identity of identities) {
    assert.equal(identity.nativeClientProfile, CODEX_167_CLIENT_PROFILE);
    assert.equal(identity.sessionId, identities[0].sessionId);
    assert.equal(identity.routingKey, identities[0].routingKey);
  }
});

test('Codex 未知版本/profile、近似模板、用户引用和不一致投影均不清理', () => {
  const { normalized, options } = capture('text-installation-metadata.json');
  for (const clientProfile of [undefined, '', CODEX_CLIENT_PROFILE, 'codex-exec-0.164.0', 'codex-cli-0.167.3', 'codex-cli-1.0.0']) {
    assert.equal(inferClientProfile(normalized, { clientProfile }), null);
    assert.deepEqual(sanitizeClientIdentity(normalized, { clientProfile }).normalized, normalized);
  }
  const changes = [
    value => { value.instructionMessages[0].text = value.instructionMessages[0].text.replace('Keep your tone light', 'Keep my custom tone'); project(value); },
    value => { value.instructionMessages[0].text = '```text\n' + value.instructionMessages[0].text + '\n```'; project(value); },
    value => { value.instructionMessages[0].text = '<user_instructions>\n' + value.instructionMessages[0].text + '</user_instructions>'; project(value); },
    value => { value.instructionMessages[0].role = 'system'; },
    value => { value.instructions = 'User supplied top-level instructions.'; project(value); },
    value => { value.system += '\nUnmatched private rule.'; },
    value => { const first = value.instructionMessages.shift(); value.messages.unshift({ role: 'user', text: first.text, parts: [{ type: 'text', text: first.text }] }); project(value); }
  ];
  for (const change of changes) {
    const unknown = structuredClone(normalized); change(unknown);
    assert.equal(inferClientProfile(unknown, options), null);
    assert.deepEqual(sanitizeClientIdentity(unknown, options).normalized, unknown);
  }
});

test('来源明确的 Codex 模板尾部 SOUL、后续 developer、用户同文引用和工具参数逐字保留', () => {
  const { normalized, options } = capture('text-installation-metadata.json');
  const quote = normalized.instructionMessages[0].text;
  const tail = '\n<SOUL>You are Codex; this is my own identity rule.</SOUL>\n# Project rules\nKeep OpenAI and Codex literally in documentation.';
  normalized.instructionMessages[0].text += tail;
  normalized.instructionMessages.push({ role: 'developer', text: 'User project rule: You are Codex. Preserve my exact wording.' });
  normalized.messages.push({ role: 'user', text: quote, parts: [{ type: 'text', text: quote }] },
    { role: 'assistant', text: '', parts: [{ type: 'tool_call', id: 'call_quote', name: 'exec_command', arguments: { cmd: 'printf "You are Codex"' } }] });
  project(normalized);
  const cleaned = sanitizeClientIdentity(normalized, options);
  assert.equal(cleaned.metadata.profile.client, 'codex');
  assert.ok(cleaned.normalized.instructionMessages[0].text.endsWith(tail));
  assert.deepEqual(cleaned.normalized.instructionMessages.slice(1), normalized.instructionMessages.slice(1));
  assert.deepEqual(cleaned.normalized.messages, normalized.messages);
  assert.deepEqual(cleaned.normalized.tools, normalized.tools);
});

test('0.167.2 profile 精确校验 UA、originator 和 session-id', () => {
  const { normalized, req } = capture('text-gateway-catalog.json');
  assert.equal(capturedNativeClient(req, normalized), CODEX_167_CLIENT_PROFILE);
  const identity = new SessionManager().resolveIdentity(req, {}, normalized);
  assert.equal(identity.nativeClientProfile, CODEX_167_CLIENT_PROFILE);
  assert.equal(identity.reuseConversation, true);
  for (const headers of [{ ...req.headers, originator: 'codex_cli_rs' }, { ...req.headers, originator: 'codex-tui' }, { ...req.headers, 'session-id': '' },
    { ...req.headers, 'user-agent': req.headers['user-agent'].replace('0.167.2', '0.164.0') },
    { ...req.headers, 'user-agent': req.headers['user-agent'].replace('0.167.2', '0.167.3') },
    { ...req.headers, 'user-agent': 'codex_exec/0.167.20 (Mac)' }]) assert.equal(capturedNativeClient({ headers }, normalized), '');
  assert.equal(capturedNativeClient(req, { ...normalized, protocol: 'anthropic' }), '');
  const old = { headers: { ...req.headers, 'user-agent': 'codex_exec/0.159.2 (Mac)' } };
  assert.equal(capturedNativeClient(old, normalized), CODEX_CLIENT_PROFILE);
  const resumed = new SessionManager().resolveIdentity(req, { prompt_cache_key: 'irrelevant-cache-key' }, normalized);
  assert.equal(identity.sessionId, resumed.sessionId); assert.equal(identity.routingKey, resumed.routingKey);
  const other = new SessionManager().resolveIdentity({ ...req, headers: { ...req.headers, 'session-id': 'another-session' } }, {}, normalized);
  assert.notEqual(identity.sessionId, other.sessionId); assert.notEqual(identity.routingKey, other.routingKey);
});

test('Codex TUI 0.167.2 共享同一模板，originator 必须与 UA 对应', () => {
  const { normalized, req } = capture('text-installation-metadata.json');
  const headers = { ...req.headers, originator: 'codex-tui', 'user-agent': CURRENT_TUI_USER_AGENT };
  const clientProfile = capturedNativeClient({ headers }, normalized);
  assert.equal(clientProfile, CODEX_167_CLIENT_PROFILE);
  const cleaned = sanitizeClientIdentity(normalized, { clientProfile });
  assert.equal(cleaned.metadata.profile.templateVersion, '0.167.2');
  assert.doesNotMatch(cleaned.normalized.system, /You are a coding agent running in the Codex CLI|Within this context, Codex refers/);
  assert.match(cleaned.normalized.messages[0].text, /PROBE_USER_RULE/);
  assert.equal(capturedNativeClient({ headers: { ...headers, originator: 'codex_exec' } }, normalized), '');
  assert.equal(capturedNativeClient({ headers: { 'session-id': headers['session-id'] } }, normalized), '');
});
