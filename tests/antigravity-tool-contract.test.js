'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { prepareAntigravityTools, projectSimple, validPatch, APPLY_PATCH_GRAMMAR } = require('../src/antigravity-tool-contract');
const { withClaude322Billing } = require('./helpers/claude-capture');
const official = require('./fixtures/antigravity-1.5.2-file-tools.json');
const mcp = require('./fixtures/antigravity-1.5.2-mcp.json');
const agentNames = ['claude', 'pi', 'hermes', 'dsh'];

function captured(agent, scenario = 'first', last = false) {
  const fixture = require(`./fixtures/agent-requests-20261107/${agent}-${scenario}.json`);
  const captures = fixture.captures.filter(item => item.body?.tools?.length);
  const capture = last ? captures.at(-1) : captures[0];
  return agent === 'claude' ? normalizeAnthropic(withClaude322Billing(capture.body)) : normalizeResponses(capture.body);
}
function current(agent, scenario = 'first', last = false, overrides = {}) {
  const source = captured(agent, scenario, last), cleaned = sanitizeClientIdentity(source);
  return { source, cleaned, adapter: prepareAntigravityTools(cleaned.normalized, {
    sourceTools: source.tools, clientIdentity: cleaned.metadata.profile, ...overrides
  }) };
}
function synthetic(schema, extra = {}) {
  return prepareAntigravityTools({ tools: [{ name: 'fixture', kind: 'function', description: 'Controlled tool.', schema, ...extra }] });
}
function view(adapter, clientName, mode) {
  return adapter.records.find(record => record.clientName === clientName).views.find(item => item.mode === mode)?.name;
}
function roundtrip(adapter, name, args, extras = {}) {
  const input = { id: 'call_controlled', name, arguments: args, ...extras };
  const provider = adapter.toProvider(input), restored = adapter.toClient(provider);
  assert.deepEqual(restored, input);
  return provider;
}

for (const agent of agentNames) {
  test(`${agent}: 实抓工具声明识别版本，采用官方参数子集而保留完整兼容声明`, () => {
    const { adapter, source, cleaned } = current(agent);
    const expected = ['read_file', 'write_file', ...(['claude', 'dsh'].includes(agent) ? ['edit_file'] : [])].sort();
    assert.deepEqual(adapter.normalized.tools.filter(tool => !tool.name.startsWith('mcp_')).map(tool => tool.name).sort(), expected);
    assert.equal(adapter.records.length, source.tools.length);
    assert.ok(adapter.records.every(record => record.views.some(item => item.mode.startsWith('mcp-'))));
    for (const tool of adapter.normalized.tools.filter(tool => !tool.name.startsWith('mcp_'))) {
      const standard = official.tools.find(item => item.name === tool.name);
      for (const [key, property] of Object.entries(tool.nativeSchema.properties)) {
        assert.ok(standard.parameters.properties[key], `${tool.name}.${key} 是真实官方字段`);
        assert.equal(property.type, standard.parameters.properties[key].type);
      }
      assert.ok(!tool.schema.properties.toolSummary);
    }
    assert.equal(adapter.normalized.system, cleaned.normalized.system);
    assert.deepEqual(adapter.normalized.messages, cleaned.normalized.messages);
    assert.deepEqual(source, captured(agent), '原始对象不得被适配器修改');
    const unknown = current(agent, 'first', false, { clientVersion: '999.0.0' }).adapter;
    assert.ok(unknown.normalized.tools.every(tool => tool.name.startsWith('mcp_')));
    assert.equal(unknown.records.length, source.tools.length);
  });
}

test('指纹使用清理前 sourceTools，描述使用清理后内容，模板更新不误套原生语义', () => {
  const { source, cleaned } = current('claude');
  const changed = structuredClone(cleaned.normalized);
  changed.tools.find(tool => tool.name === 'Read').description = 'Sanitized client read constraints.';
  const adapter = prepareAntigravityTools(changed, { sourceTools: source.tools, clientIdentity: cleaned.metadata.profile });
  assert.match(adapter.normalized.tools.find(tool => tool.name === 'read_file').description, /Sanitized client read constraints/);
  const future = structuredClone(source.tools);
  future.find(tool => tool.name === 'Read').description += '\nNew client execution rule.';
  const unknown = prepareAntigravityTools(changed, { sourceTools: future, clientIdentity: cleaned.metadata.profile });
  assert.ok(!unknown.normalized.tools.some(tool => tool.name === 'read_file'));
  assert.ok(unknown.records.find(record => record.clientName === 'Read').views.length);
});

test('Claude 按模型切换的精简 harness 使用独立实抓完整指纹', () => {
  const fixture = require('./fixtures/client-gateway-20261107/failures/claude-read-compact-template.json');
  const source = normalizeAnthropic(withClaude322Billing(fixture.clientHTTP.find(item => item.body?.tools?.length).body));
  const cleaned = sanitizeClientIdentity(source);
  assert.equal(cleaned.metadata.profile.templateVersion, '2.1.322');
  assert.ok(cleaned.metadata.profile.evidence.includes('claude-sdk-compact-system-template'));
  const adapter = prepareAntigravityTools(cleaned.normalized, { sourceTools: source.tools, clientIdentity: cleaned.metadata.profile });
  for (const name of ['read_file', 'write_file', 'edit_file']) assert.ok(adapter.declarations.some(tool => tool.name === name));
  roundtrip(adapter, 'Read', { file_path: '/tmp/probe.txt', offset: 1, limit: 2 });
  roundtrip(adapter, 'Write', { file_path: '/tmp/probe.txt', content: 'controlled' });
  roundtrip(adapter, 'Edit', { file_path: '/tmp/probe.txt', old_string: 'a', new_string: 'b', replace_all: true });
  const changed = structuredClone(source.tools); changed.find(tool => tool.name === 'Read').description += ' Changed behavior.';
  const unknown = prepareAntigravityTools(cleaned.normalized, { sourceTools: changed, clientIdentity: cleaned.metadata.profile });
  assert.ok(!unknown.declarations.some(tool => tool.name === 'read_file'));
});

test('官方 basic MCP 样本保持结构、字符串枚举、布尔值、0、嵌套和数组', () => {
  const source = mcp.basic.inputTools[0];
  const adapter = synthetic(source.inputSchema), name = view(adapter, 'fixture', 'mcp-direct');
  assert.ok(name);
  assert.equal(adapter.records[0].views.length, 1);
  const declaration = adapter.declarations[0], officialDeclaration = mcp.basic.upstreamDeclarations[0];
  assert.equal(declaration.parameters.properties.toolSummary.description, officialDeclaration.parameters.properties.toolSummary.description);
  assert.ok(declaration.parameters.required.includes('toolSummary'));
  assert.equal(declaration.parameters.properties.count.type, 'INTEGER');
  assert.deepEqual(declaration.parameters.properties.choice.enum, ['alpha', 'beta']);
  assert.equal(declaration.parameters.additionalProperties, undefined);
  const args = { text: '中文\n\"quoted\"', count: 0, enabled: false, choice: 'beta', values: ['α', ''], nested: { label: 'x' } };
  const provider = roundtrip(adapter, 'fixture', args, { thoughtSignature: 'signature_unchanged', other: { key: true } });
  assert.equal(provider.name, name);
  assert.equal(provider.arguments.text, args.text);
  assert.equal(provider.arguments.toolSummary, 'Client tool request');
  assert.throws(() => adapter.toClient({ name, arguments: { ...args, count: 4, toolSummary: 'test' } }), /原始客户端契约/);
  assert.throws(() => adapter.toClient({ name, arguments: { ...args, extra: true, toolSummary: 'test' } }), /原始客户端契约/);
  assert.throws(() => adapter.toClient({ name, arguments: args }), /原始客户端契约/);
});

test('开放对象保留结构视图和完整 JSON 视图，业务 toolSummary 从不丢失', () => {
  const adapter = synthetic({ type: 'object', properties: { value: { type: 'string' }, nested: { type: 'object', properties: { flag: { type: 'boolean' } } } } });
  assert.ok(view(adapter, 'fixture', 'mcp-direct'));
  assert.ok(view(adapter, 'fixture', 'mcp-json'));
  assert.equal(roundtrip(adapter, 'fixture', { value: 'x', nested: { flag: false } }).name, view(adapter, 'fixture', 'mcp-direct'));
  for (const args of [{ value: 'x', undeclared: 42 }, { toolSummary: 'BUSINESS MUST SURVIVE' }, { nested: { another: null } }]) {
    const provider = roundtrip(adapter, 'fixture', args);
    assert.equal(provider.name, view(adapter, 'fixture', 'mcp-json'));
    assert.deepEqual(JSON.parse(provider.arguments.argumentsJson), args);
  }
  const collision = synthetic({ type: 'object', properties: { toolSummary: { type: 'string' }, value: { type: 'boolean' } }, required: ['toolSummary'], additionalProperties: false });
  assert.ok(!view(collision, 'fixture', 'mcp-direct'));
  roundtrip(collision, 'fixture', { toolSummary: 'Business label', value: false });
});

test('官方失败复杂样本无损封装，完整校验 union/null/数值 enum/tuple/const/map', () => {
  const schema = mcp.schemaFailure.inputTool.inputSchema, adapter = synthetic(schema), name = view(adapter, 'fixture', 'mcp-json');
  assert.equal(adapter.records[0].views.length, 1);
  assert.deepEqual(adapter.records[0].clientSchema, schema);
  assert.match(adapter.declarations[0].description, /"prefixItems"/);
  const args = { literal: 'fixed', nullable: null, union: 0, number: 1.5, text: 'safe text', map: { x: 3 }, tuple: ['item', 7] };
  roundtrip(adapter, 'fixture', args);
  for (const invalid of [{ ...args, literal: 'other' }, { ...args, nullable: 0 }, { ...args, union: false }, { ...args, number: 2 }, { ...args, text: 'bad' }, { ...args, map: { x: '3' } }, { ...args, tuple: [7, 'item'] }, { ...args, tuple: ['item', 7, 8] }]) {
    assert.throws(() => adapter.toClient({ name, arguments: { argumentsJson: JSON.stringify(invalid), toolSummary: 'Test validation' } }), /原始客户端契约/);
    assert.throws(() => adapter.toProvider({ name: 'fixture', arguments: invalid }), /原始客户端契约/);
  }
});

test('JSON Schema 引用、draft-07 tuple、if/then、布尔 schema 仍在本地完整执行', () => {
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', definitions: { count: { type: 'integer', minimum: 2 } }, type: 'array', items: [{ $ref: '#/definitions/count' }, { enum: ['yes', false] }], additionalItems: false, minItems: 2 };
  const adapter = synthetic(schema);
  roundtrip(adapter, 'fixture', [2, false]);
  assert.throws(() => adapter.toProvider({ name: 'fixture', arguments: [1, false] }));
  assert.throws(() => adapter.toProvider({ name: 'fixture', arguments: [2, false, 0] }));
  const conditional = synthetic({ type: 'object', properties: { a: { type: 'boolean' }, b: { type: 'integer' } }, if: { properties: { a: { const: true } } }, then: { required: ['b'] } });
  roundtrip(conditional, 'fixture', { a: false });
  assert.throws(() => conditional.toProvider({ name: 'fixture', arguments: { a: true } }));
  const never = synthetic(false);
  assert.equal(never.records[0].clientSchema, false);
  assert.throws(() => never.toProvider({ name: 'fixture', arguments: {} }));
  const any = synthetic(true);
  for (const args of [false, null, 0, [], { value: 'ok' }, 'literal string', '{"still":"a literal string"}']) roundtrip(any, 'fixture', args);
});

test('可逆读取仅覆盖显式文本行范围，不把文档、图片、字节游标或默认限额伪装成官方读取', () => {
  for (const agent of agentNames) {
    const adapter = current(agent).adapter, name = agent === 'claude' ? 'Read' : agent === 'hermes' ? 'read_file' : 'read';
    const pathField = ['claude', 'dsh'].includes(agent) ? 'file_path' : 'path';
    const provider = roundtrip(adapter, name, { [pathField]: '/tmp/probe.txt', offset: 10, limit: 20 });
    assert.equal(provider.name, 'read_file');
    assert.deepEqual(provider.arguments, { Path: '/tmp/probe.txt', StartLine: 10, EndLine: 29 });
    for (const args of [{ [pathField]: '/tmp/probe.txt' }, { [pathField]: '/tmp/probe.pdf', offset: 1, limit: 10 }, { [pathField]: '/tmp/probe.png', offset: 1, limit: 10 }, { [pathField]: 'relative.txt', offset: 1, limit: 10 }, { [pathField]: '/tmp/probe.txt', offset: 1, limit: 801 }]) {
      assert.match(roundtrip(adapter, name, args).name, /^mcp_/);
    }
    for (const args of [{ Path: '/tmp/probe.txt', StartLine: 2, EndLine: 1 }, { Path: '/tmp/probe.txt', StartLine: 1, EndLine: 801 }, { Path: '/tmp/probe.pdf', StartLine: 1, EndLine: 2 }, { Path: '/tmp/probe.txt', StartLine: 1, EndLine: 2, ByteOffset: 100 }]) {
      assert.throws(() => adapter.toClient({ name: 'read_file', arguments: args }));
    }
    assert.match(adapter.declarations.find(item => item.name === 'read_file').description, /does not implement.*46080-byte/);
  }
  const claude = current('claude').adapter;
  for (const args of [{ file_path: '/tmp/probe.pdf', pages: '1-2' }, { file_path: '/tmp/probe.txt', allow_large: true }, { file_path: '/tmp/probe.txt', offset: 0, limit: 2 }]) assert.match(roundtrip(claude, 'Read', args).name, /^mcp_/);
});

test('写入仅覆盖完整覆盖语义，客户端权限参数原样走兼容工具', () => {
  for (const agent of agentNames) {
    const adapter = current(agent).adapter, name = agent === 'claude' ? 'Write' : agent === 'hermes' ? 'write_file' : 'write';
    const key = ['claude', 'dsh'].includes(agent) ? 'file_path' : 'path';
    const provider = roundtrip(adapter, name, { [key]: '/tmp/probe.txt', content: '中文\n' });
    assert.equal(provider.name, 'write_file');
    assert.deepEqual(provider.arguments, { Path: '/tmp/probe.txt', Content: '中文\n', Overwrite: true });
    assert.throws(() => adapter.toClient({ name: 'write_file', arguments: { ...provider.arguments, Overwrite: false } }));
    assert.throws(() => adapter.toClient({ name: 'write_file', arguments: { ...provider.arguments, Append: true } }));
  }
  const dsh = current('dsh').adapter;
  assert.match(roundtrip(dsh, 'write', { file_path: '/tmp/probe.txt', content: 'x', sandbox_permissions: 'workspace-write', justification: 'Controlled fixture.' }).name, /^mcp_/);
});

test('精确全部替换才转换 edit_file；Pi 批量和 Hermes 模糊补丁保留真实契约', () => {
  for (const agent of ['claude', 'dsh']) {
    const adapter = current(agent).adapter, name = agent === 'claude' ? 'Edit' : 'edit';
    const args = { file_path: '/tmp/probe.txt', old_string: 'old', new_string: 'new', replace_all: true };
    assert.equal(roundtrip(adapter, name, args).name, 'edit_file');
    assert.match(roundtrip(adapter, name, { ...args, replace_all: false }).name, /^mcp_/);
    const unique = { ...args }; delete unique.replace_all;
    assert.match(roundtrip(adapter, name, unique).name, /^mcp_/);
    assert.throws(() => adapter.toClient({ name: 'edit_file', arguments: { Path: '/tmp/probe.txt', Target: '', Replacement: 'new' } }));
  }
  const pi = current('pi').adapter;
  assert.match(roundtrip(pi, 'edit', { path: '/tmp/probe.txt', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] }).name, /^mcp_/);
  const hermes = current('hermes').adapter;
  assert.match(roundtrip(hermes, 'patch', { path: '/tmp/probe.txt', old_string: 'a', new_string: 'b', replace_all: true }).name, /^mcp_/);
  assert.ok(!hermes.declarations.some(item => item.name === 'edit_file'));
});

test('后台 PTY、通知、时间单位与沙箱选项不投射到官方 shell 参数', () => {
  const hermes = current('hermes').adapter;
  const args = { command: 'fixture only', background: true, pty: true, timeout: 750, notify: ['ready'], heartbeat: 60, persist_on_release: true };
  assert.equal(roundtrip(hermes, 'terminal', args).name, view(hermes, 'terminal', 'mcp-json'));
  const claude = current('claude').adapter;
  assert.match(roundtrip(claude, 'Bash', { command: 'fixture only', timeout: 1200, run_in_background: true, dangerouslyDisableSandbox: false }).name, /^mcp_/);
  const dsh = current('dsh').adapter;
  assert.match(roundtrip(dsh, 'bash', { description: 'Controlled fixture', command: 'fixture only', timeoutMs: 42, run_in_background: true, sandbox_permissions: 'workspace-write', justification: 'Controlled fixture.' }).name, /^mcp_/);
});

test('已验证 custom apply_patch 原文及语法约束保留；未知 grammar 明确报错', () => {
  const capturedPatch = require('./fixtures/codex-exec-0.159.2-tools.json').tools.find(tool => tool.name === 'apply_patch');
  assert.equal(capturedPatch.format.definition, APPLY_PATCH_GRAMMAR);
  const adapter = synthetic({ type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }, { name: 'apply_patch', kind: 'custom', format: capturedPatch.format });
  const patch = '*** Begin Patch\n*** Add File: /tmp/fixture.txt\n+中文\n+\n*** Update File: /tmp/other.txt\n*** Move to: /tmp/renamed.txt\n@@ context\n-old\n+new\n*** End of File\n*** Delete File: /tmp/deleted.txt\n*** End Patch\n';
  const provider = adapter.toProvider({ id: 'patch1', name: 'apply_patch', kind: 'custom', input: patch, arguments: { input: patch }, thoughtSignature: 'keep' });
  const restored = adapter.toClient(provider);
  assert.equal(restored.kind, 'custom'); assert.equal(restored.input, patch); assert.deepEqual(restored.arguments, { input: patch }); assert.equal(restored.id, 'patch1'); assert.equal(restored.thoughtSignature, 'keep');
  for (const invalid of ['*** Begin Patch\n*** End Patch\n', '*** Begin Patch\n*** Add File: x\n*** End Patch\n', patch + 'trailing', patch.replace('@@ context', '@context'), patch.replace('*** Move to: /tmp/renamed.txt', '*** Move to: ')]) {
    assert.equal(validPatch(invalid), false);
    assert.throws(() => adapter.toProvider({ name: 'apply_patch', input: invalid }));
  }
  assert.throws(() => synthetic({ type: 'object' }, { kind: 'custom', format: { type: 'grammar', syntax: 'lark', definition: 'start: "anything"' } }), error => error.code === 'unsupported_tool_grammar');
});

test('纯文本 custom 工具不擅自解析 JSON 样式字符串，可注入显式校验器', () => {
  const schema = { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false };
  const adapter = synthetic(schema, { kind: 'custom', format: { type: 'text' } });
  const raw = '{"input":"literal text, not a function envelope"}';
  const provider = adapter.toProvider({ name: 'fixture', kind: 'custom', input: raw });
  assert.equal(adapter.toClient(provider).input, raw);
  const custom = prepareAntigravityTools({ tools: [{ name: 'grammar', schema, kind: 'custom', format: { type: 'grammar', syntax: 'regex', definition: '^ok$' } }] }, { customToolValidators: { grammar: value => value === 'ok' } });
  assert.equal(custom.toClient(custom.toProvider({ name: 'grammar', input: 'ok' })).input, 'ok');
  assert.throws(() => custom.toProvider({ name: 'grammar', input: 'bad' }));
});

test('实抓 ToolSearch 延迟声明与 tool_reference 可逆展开，未知引用不被吞掉', () => {
  const { adapter, source } = current('claude', 'tool-search', true);
  assert.ok(source.tools.some(tool => tool.name === 'TaskCreate'));
  assert.ok(adapter.records.length > current('claude').adapter.records.length);
  const refs = [{ type: 'tool_reference', tool_name: 'Read' }, { type: 'tool_reference', tool_name: 'TaskCreate' }];
  const mapped = adapter.toProviderReferences(refs);
  assert.ok(mapped.length >= refs.length);
  assert.ok(mapped.every(item => adapter.declarations.some(declaration => declaration.name === item.tool_name)));
  assert.deepEqual(adapter.toClientReferences(mapped), refs);
  assert.throws(() => adapter.toProviderReferences(['unannounced_tool']), error => error.code === 'unknown_client_tool');
  assert.throws(() => adapter.toClientReferences(['undeclared_alias']), error => error.code === 'invalid_tool_call');
  const placeholder = adapter.records.find(record => record.clientName === 'DeferredToolPlaceholder');
  assert.ok(placeholder);
  assert.throws(() => adapter.toProvider({ name: placeholder.clientName, arguments: {} }), error => error.code === 'non_executable_tool');
});

test('返回结果只恢复名称和引用，保留媒体、错误、ID与签名，不制造执行时间', () => {
  const { adapter } = current('claude');
  const issued = adapter.toProvider({ id: 'call_media', name: 'Read', arguments: { file_path: '/tmp/probe.png' } });
  const result = { id: 'call_media', name: 'Read', text: 'controlled error', isError: true, media: [{ type: 'image', data: 'synthetic_bytes' }], parts: [{ type: 'image', index: 0 }], thoughtSignature: 'sig' };
  const provider = adapter.toProviderResult(result, issued);
  assert.deepEqual(provider, { ...result, name: issued.name });
  assert.deepEqual(adapter.toClientResult(provider), result);
  assert.deepEqual(adapter.resultContract(issued.name), { clientName: 'Read', clientKind: 'function', successField: 'output', errorField: 'error', timestamps: 'not-generated', media: 'preserve' });
  assert.throws(() => adapter.toProviderResult(result), error => error.code === 'missing_provider_tool_identity');
  assert.throws(() => adapter.toProviderResult({ ...result, name: 'Write' }, issued), error => error.code === 'tool_result_mismatch');
  assert.throws(() => adapter.toProviderResult({ ...result, id: 'different_call' }, issued), error => error.code === 'tool_result_mismatch');
});

for (const agent of agentNames) {
  test(`${agent}: 实抓读取/错误/并行/媒体调用及结果均无损往返`, () => {
    for (const scenario of ['read', 'read-error', 'parallel-read', 'image']) {
      const { adapter, source } = current(agent, scenario, true);
      const parts = source.messages.flatMap(message => message.parts || []);
      const calls = parts.filter(part => part.type === 'tool_call');
      assert.ok(calls.length, scenario);
      for (const call of calls) {
        const providerCall = adapter.toProvider(call);
        assert.deepEqual(adapter.toClient(providerCall), call);
        const result = parts.find(part => part.type === 'tool_result' && part.id === call.id);
        assert.ok(result, `${scenario}/${call.id}`);
        const providerResult = adapter.toProviderResult(result, providerCall);
        assert.deepEqual(adapter.toClientResult(providerResult), { ...result, name: call.name });
        assert.equal(providerResult.content, result.content);
        assert.deepEqual(providerResult.media, result.media);
        assert.equal(providerResult.isError, result.isError);
      }
    }
  });
}

test('工具名冲突、非法参数与缺失契约明确报错；别名稳定且 named choice 指向完整视图', () => {
  const schema = { type: 'object', properties: { value: { type: 'string' } } };
  const tools = ['fixture', 'read_file', 'mcp_gateway_tool_conflict'].map(name => ({ name, schema, kind: 'function' }));
  const adapter = prepareAntigravityTools({ tools, toolChoice: { type: 'function', name: 'fixture' } });
  assert.equal(new Set(adapter.declarations.map(tool => tool.name)).size, adapter.declarations.length);
  assert.equal(adapter.normalized.toolChoice.name, adapter.toProviderName('fixture'));
  const reversed = prepareAntigravityTools({ tools: [...tools].reverse() });
  assert.equal(adapter.toProviderName('fixture'), reversed.toProviderName('fixture'));
  assert.throws(() => prepareAntigravityTools({ tools: [tools[0], tools[0]] }), error => error.code === 'invalid_tool_declaration');
  assert.throws(() => prepareAntigravityTools({ tools }, { sourceTools: [] }), error => error.code === 'missing_tool_contract');
  assert.throws(() => adapter.toProvider({ name: 'unknown', arguments: {} }), error => error.code === 'unknown_client_tool');
  assert.throws(() => adapter.toClient({ name: 'unknown', arguments: {} }), error => error.code === 'invalid_tool_call');
  for (const value of [NaN, Infinity, undefined, new Date(), [, 1], { x: undefined }]) {
    assert.throws(() => synthetic(true).toProvider({ name: 'fixture', arguments: value }));
  }
  assert.equal(projectSimple({ type: 'object', required: ['missing'] }), null);
});

test('未知 internal 标记与外部同名字段均不能授予模型服务执行责任', () => {
  const internal = synthetic({ type: 'object' }, { internal: true });
  assert.ok(internal.declarations.every(tool => tool.description.startsWith('Client-executed tool')));
  const external = normalizeResponses({ tools: [{ type: 'function', name: 'fixture', internal: true, parameters: { type: 'object' } }], input: 'controlled' });
  assert.ok(!external.tools[0].internal);
  assert.ok(prepareAntigravityTools(external).declarations.every(tool => tool.description.startsWith('Client-executed tool')));
});

test('合法工具名与对象原型键相同仍走完整兼容声明', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const normalized = { tools: [{ name, description: 'A real client tool.', schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }] };
    const adapter = prepareAntigravityTools(normalized, { clientIdentity: { client: 'claude', templateVersion: '2.1.322' } });
    const issued = adapter.toProvider({ name, arguments: { value: 1 } });
    assert.deepEqual(adapter.toClient(issued).arguments, { value: 1 });
    assert.equal(adapter.toClient(issued).name, name);
    assert.match(issued.name, /^mcp_gateway_tool_/);
  }
});
