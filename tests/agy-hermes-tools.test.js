'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('./fixtures/hermes-0.21.7-tools.json');
const current = require('./fixtures/agent-requests-20261107/hermes-first.json');
const { normalizeResponses } = require('../src/protocol');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { prepareAntigravityTools, fingerprint } = require('../src/antigravity-tool-contract');
const normalizeOld = () => normalizeResponses({ tools: fixture.tools.map(tool => ({ type: 'function', ...tool.function })), instructions: fixture.systemPrefix, input: [{ role: 'user', content: 'Preserve terminal/read_file/patch literally.' }] });
function latest() {
  const source = normalizeResponses(structuredClone(current.captures.find(item => item.body?.tools?.length).body)), cleaned = sanitizeClientIdentity(source);
  return { source, adapter: prepareAntigravityTools(cleaned.normalized, { sourceTools: source.tools, clientIdentity: cleaned.metadata.profile }) };
}

test('旧 Hermes 工具使用完整兼容声明，当前实抓版本才启用受约束文件视图', () => {
  const old = normalizeOld(), oldAdapter = prepareAntigravityTools(old, { clientProfile: 'hermes-0.21.7-captured' });
  assert.ok(oldAdapter.declarations.every(tool => tool.name.startsWith('mcp_')));
  assert.equal(oldAdapter.normalized.system, old.system);
  assert.equal(oldAdapter.records.length, old.tools.length);
  const { adapter } = latest();
  assert.ok(adapter.declarations.some(tool => tool.name === 'read_file'));
  assert.ok(adapter.declarations.some(tool => tool.name === 'write_file'));
  assert.ok(!adapter.declarations.some(tool => tool.name === 'edit_file'));
});

test('Hermes 指纹忽略属性顺序，完整约束改变后停止套用当前官方视图', () => {
  const { source } = latest(), read = source.tools.find(tool => tool.name === 'read_file'), original = fingerprint(read);
  read.schema.properties = Object.fromEntries(Object.entries(read.schema.properties).reverse()); assert.equal(fingerprint(read), original);
  read.schema.properties.limit.maximum = 4000; assert.notEqual(fingerprint(read), original);
  const cleaned = sanitizeClientIdentity(source), adapter = prepareAntigravityTools(cleaned.normalized, { sourceTools: source.tools, clientIdentity: cleaned.metadata.profile });
  assert.ok(!adapter.declarations.some(tool => tool.name === 'read_file'));
  assert.ok(adapter.declarations.some(tool => tool.name === 'write_file'));
  const call = { name: 'read_file', arguments: { path: '~/fixture.txt', offset: 1, limit: 3500 } };
  assert.deepEqual(adapter.toClient(adapter.toProvider(call)), call);
});

test('Hermes 模糊 patch、空替换、写入语法检查和默认读取限制原样保留', () => {
  const { source, adapter } = latest();
  for (const [name, args] of [
    ['patch', { path: '/tmp/f.txt', old_string: 'read_file old_string terminal\n', new_string: '', replace_all: false }],
    ['write_file', { path: '~/f.txt', content: 'read_file old_string terminal\n' }],
    ['read_file', { path: 'relative.pdf', offset: 10, limit: 2000 }]
  ]) {
    const call = { id: name, name, arguments: args };
    assert.deepEqual(adapter.toClient(adapter.toProvider(call)), call);
  }
  const patch = source.tools.find(tool => tool.name === 'patch');
  const record = adapter.records.find(item => item.clientName === 'patch');
  assert.deepEqual(record.clientSchema, patch.schema);
  assert.ok(adapter.declarations.filter(tool => record.views.some(view => view.name === tool.name)).every(tool => tool.description.includes(patch.description)));
  assert.match(adapter.declarations.find(tool => tool.name === 'read_file').description, /next_offset/);
});

test('Hermes terminal 联合通知、秒超时、PTY、持久会话均完整校验，不偷换成原生 shell', () => {
  const { adapter } = latest();
  for (const notify of [false, true, ['READY']]) {
    const args = { command: 'fixture only', background: true, timeout: 45, workdir: '/tmp/a b', pty: true, notify, heartbeat: 60, persist_on_release: false };
    const call = { name: 'terminal', arguments: args };
    assert.deepEqual(adapter.toClient(adapter.toProvider(call)), call);
  }
  for (const extra of [{ timeout: 0 }, { timeout: 0.5 }, { heartbeat: -1 }, { notify: ['x', 2] }, { notify: {} }]) assert.throws(() => adapter.toProvider({ name: 'terminal', arguments: { command: 'fixture only', ...extra } }));
  assert.ok(!adapter.declarations.some(tool => tool.name === 'run_command'));
});
