'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('./fixtures/hermes-0.21.7-framework.json');
const tools = require('./fixtures/hermes-0.21.7-tools.json');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');
const { sanitizeClientIdentity } = require('../src/client-identity');
const runtime = '\n\nActive Hermes profile: personal.\n\n# Hermes runtime environment\n\nPath: /tmp/read_file/terminal\n\n<!-- End Hermes runtime environment -->';
const system = [fixture.identity, fixture.framework, fixture.coding, fixture.project].join('\n\n') + runtime;
const user = 'Use read_file for terminal/patch.txt. Keep this exact string.';
const normalize = instructions => normalizeResponses({ tools: tools.tools.map(tool => ({ type: 'function', ...tool.function })), instructions, input: [{ role: 'user', content: user }] });

test('旧 Hermes SOUL、框架、项目规则和工具字面引用完整保留，由单独索引说明兼容工具名', () => {
  const normalized = normalize(system), before = structuredClone(normalized), adapter = prepareAntigravityTools(normalized);
  assert.equal(adapter.normalized.system, system);
  assert.deepEqual(adapter.normalized.messages, normalized.messages);
  assert.ok(adapter.instructions.includes('"read_file"'));
  assert.ok(adapter.instructions.includes('"patch"'));
  assert.ok(adapter.declarations.every(tool => tool.name.startsWith('mcp_')));
  assert.deepEqual(normalized, before);
  assert.ok(adapter.normalized.system.includes('Keep the literal identifiers read_file, write_file, patch and terminal unchanged'));
});

test('未知框架、重复模板、项目中的引用和自定义身份不因工具转换而改写', () => {
  const quoted = '\n\n# User notes\n\n' + fixture.coding;
  for (const changed of [system + quoted, system.replace('# Parallel tool calls', '# Other parallel strategy'), system + '\n\n' + fixture.framework, system.replace(fixture.identity, 'You are my assistant. Preserve project-specific permissions.')]) {
    const normalized = normalize(changed), adapter = prepareAntigravityTools(normalized);
    assert.equal(adapter.normalized.system, changed);
    assert.deepEqual(adapter.normalized.messages, normalized.messages);
  }
});

test('声明改变按完整兼容处理；过深 Schema 明确拒绝，不能删字段后改成官方工具', () => {
  const normalized = normalize(system), read = normalized.tools.find(tool => tool.name === 'read_file');
  read.schema.properties.limit.maximum = 4000;
  const adapter = prepareAntigravityTools(normalized);
  assert.equal(adapter.records.find(record => record.clientName === 'read_file').clientSchema.properties.limit.maximum, 4000);
  assert.ok(adapter.declarations.every(tool => tool.name.startsWith('mcp_')));
  let nested = { type: 'string' }; for (let i = 0; i < 80; i++) nested = { type: 'array', items: nested };
  read.schema.properties.extra = nested;
  assert.throws(() => prepareAntigravityTools(normalized), error => error.code === 'invalid_tool_schema');
});

test('身份清理与工具适配分开：移除已验证身份，保留用户文字、路径与权限', () => {
  const rule = 'Project rule: keep Read, Write and exec_command literal; permissions are decided by the client.';
  const claude = normalizeAnthropic({ system: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n" + rule, messages: [{ role: 'user', content: 'Read stays literal. SOUL: I am my own assistant.' }] });
  const cleaned = sanitizeClientIdentity(claude), adapter = prepareAntigravityTools(cleaned.normalized, { sourceTools: claude.tools, clientIdentity: cleaned.metadata.profile });
  assert.ok(adapter.normalized.system.endsWith(rule));
  assert.deepEqual(adapter.normalized.messages, claude.messages);
  assert.equal(adapter.normalized.tools.length, 0);
  assert.doesNotMatch(adapter.normalized.system, /You are Antigravity/);
  const codex = normalizeResponses({ instructions: rule, input: [{ role: 'user', content: 'Keep original permissions.' }] });
  const unknown = prepareAntigravityTools(codex);
  assert.equal(unknown.normalized.system, rule);
  assert.deepEqual(unknown.normalized.messages, codex.messages);
});
