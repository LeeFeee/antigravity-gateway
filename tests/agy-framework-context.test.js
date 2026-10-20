'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('./fixtures/hermes-0.21.7-framework.json');
const tools = require('./fixtures/hermes-0.21.7-tools.json');
const { normalizeChat, normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { capturedNativeClient, CODEX_CLIENT_PROFILE } = require('../src/agy-client-profile');
const { HERMES_CLIENT_PROFILE, capturedHermesTool, toolReferences } = require('../src/agy-hermes-profile');
const { prepareToolAdapter } = require('../src/agy-tool-adapter');
const { SessionManager } = require('../src/session-manager');

const runtime = '\n\nActive Hermes profile: personal.\n\n# Hermes runtime environment\n\nPath: /tmp/read_file/terminal\n\n<!-- End Hermes runtime environment -->';
const system = [fixture.identity, fixture.framework, fixture.coding, fixture.project].join('\n\n') + runtime;
const message = { role: 'user', content: 'Use read_file for terminal/patch.txt. Keep this exact string.' };
const normalize = s => normalizeChat({ tools: structuredClone(tools.tools), messages: [{ role: 'system', content: s }, message] });
const adapter = n => prepareToolAdapter(n, { clientProfile: capturedNativeClient({}, n) });

test('ordinary Hermes SOUL and project context do not disable the captured framework capabilities', () => {
  const n = normalize(system), original = structuredClone(n), a = adapter(n);
  assert.equal(capturedNativeClient({}, n), HERMES_CLIENT_PROFILE);
  assert.deepEqual(a.normalized.tools.map(t => t.name), ['replace_file_content','view_file','search_files','run_command','write_to_file','tool_search','tool_describe','tool_call']);
  assert.ok(a.normalized.system.startsWith(fixture.identity + '\n\n'));
  assert.ok(a.normalized.system.endsWith(fixture.project + runtime));
  assert.match(a.normalized.system, /Read the relevant files with `view_file`/);
  assert.match(a.normalized.system, /Edit with `replace_file_content`\/`write_to_file`/);
  assert.match(a.normalized.system, /Use `run_command` for git, builds, tests/);
  assert.match(a.normalized.system, /don't commit, push, or rewrite history unless asked/);
  assert.ok(n.system.includes("mode='patch'"));assert.doesNotMatch(a.normalized.system, /mode='(?:patch|replace)'/);
  assert.equal(a.normalized.tools.find(t => t.name === 'replace_file_content').schema.properties.mode, undefined);
  assert.deepEqual(n, original);assert.deepEqual(a.normalized.messages, n.messages);
});

test('only the adjacent captured coding brief is rewritten, not quoted examples inside project or memory', () => {
  const quoted = '\n\n# User notes\n\n' + fixture.coding;
  const n = normalize([fixture.identity, fixture.framework, fixture.project].join('\n\n') + quoted + runtime), a = adapter(n);
  assert.equal(capturedNativeClient({}, n), HERMES_CLIENT_PROFILE);
  assert.ok(a.normalized.system.endsWith(fixture.project + quoted + runtime));
  assert.match(a.normalized.system, /Use view_file\/search_files to check/);
  assert.ok(a.normalized.system.includes('Keep the literal identifiers read_file, write_file, patch and terminal unchanged'));
  assert.equal(toolReferences("mode='patch' and use 'patch'", new Map([['patch', { name: 'replace_file_content' }]])), "mode='patch' and use 'replace_file_content'");
});

test('unknown framework blocks, duplicate copies and malformed boundaries never guess ownership', () => {
  for (const changed of [system.replace('# Parallel tool calls', '# Other parallel strategy'), system + '\n\n' + fixture.framework, system.replace('\n\n' + fixture.framework, '\n' + fixture.framework), system.replace(fixture.framework + '\n\n', fixture.framework + 'extra\n\n')]) {
    const n = normalize(changed);assert.equal(capturedNativeClient({}, n), '');assert.equal(adapter(n).normalized, n);
  }
});

test('custom identity and runtime changes preserve user meaning without granting private session reuse', () => {
  const custom = system.replace(fixture.identity, 'You are my assistant. Preserve project-specific permissions.');
  const n = normalize(custom), req = { headers: { 'user-agent': 'OpenAI/Python 2.24.0' }, socket: { remoteAddress: '127.0.0.1' } };
  const identity = new SessionManager().resolveIdentity(req, {}, n);
  assert.equal(identity.nativeClientProfile, HERMES_CLIENT_PROFILE);assert.equal(identity.reuseConversation, false);assert.equal(identity.sessionSource, 'fallback');
  const a = adapter(n);assert.ok(a.normalized.system.startsWith('You are my assistant. Preserve project-specific permissions.\n\n'));
  assert.ok(a.normalized.system.endsWith(runtime));assert.doesNotMatch(a.normalized.system, /You are Antigravity/);
});

test('schema fingerprinting remains bounded and a changed capability is not aliased by a familiar name', () => {
  const n = normalize(system), read = n.tools.find(t => t.name === 'read_file');let nested = { type: 'string' };
  for (let i = 0; i < 2000; i++) nested = { items: nested };
  read.schema.properties.unknown = nested;assert.equal(capturedHermesTool(read), false);
  const a = adapter(n);assert.ok(a.normalized.tools.some(t => t.name === 'read_file'));assert.match(a.normalized.system, /Read the relevant files with `read_file`/);
});

test('Claude identity translation and Codex capability instructions preserve actual runtime and user rules', () => {
  const rule = 'Project rule: keep Read, Write and exec_command literal; permissions are decided by the client.';
  const claude = normalizeAnthropic({ system: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n" + rule, messages: [{ role: 'user', content: 'Read stays literal.' }] });
  const a = prepareToolAdapter(claude, { clientProfile: 'claude-code-2.1.285' });assert.match(a.normalized.system, /^You are Antigravity,/);assert.ok(a.normalized.system.endsWith(rule));assert.deepEqual(a.normalized.messages, claude.messages);
  const instructions = 'Follow the client instructions and use only client-provided tools when needed.';
  const codex = normalizeResponses({ instructions, input: [{ role: 'developer', content: rule }, { role: 'user', content: 'Keep original permissions.' }] });
  const b = prepareToolAdapter(codex, { clientProfile: CODEX_CLIENT_PROFILE });assert.equal(b.normalized.system, codex.system);assert.deepEqual(b.normalized.messages, codex.messages);
});
