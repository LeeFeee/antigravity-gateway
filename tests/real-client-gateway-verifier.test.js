'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { accountSnapshot, copyManagedState, scrub, observerSource, assess, gatewaySandbox, clientSandbox, STATE_FILES } = require('../scripts/verify-real-client-gateway');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'real-gateway-verifier-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'accounts'), { recursive: true }); fs.mkdirSync(path.join(source, 'state'));
  fs.writeFileSync(path.join(source, 'accounts', 'private@example.invalid.json'), JSON.stringify({ id: 'controlled-account', accessToken: 'controlled-secret', refreshToken: 'controlled-refresh', email: 'private@example.invalid', enabled: false }));
  fs.writeFileSync(path.join(source, 'state/account-pool.json'), JSON.stringify({ health: { 'controlled-account': { state: 'verification_required' } }, removedIdentities: ['retained'] }));
  fs.writeFileSync(path.join(source, 'state/quota.json'), JSON.stringify({ 'controlled-account': { geminiQuotaProtection: { protected: true } } }));
  fs.mkdirSync(path.join(source, 'robin-accounts')); fs.writeFileSync(path.join(source, 'robin-accounts/forbidden.json'), 'must not copy');
  return { root, source, target };
}
test('真实验收复制账号和保护状态字节不变，所有私密副本为600，不读取旧账号目录', t => {
  const { source, target } = fixture(t), before = accountSnapshot(source), result = copyManagedState(source, target);
  assert.deepEqual(accountSnapshot(source), before);
  assert.equal(result.summary.disabledAccounts, 1);
  assert.ok(!fs.existsSync(path.join(target, 'robin-accounts')));
  for (const file of ['accounts/private@example.invalid.json', ...STATE_FILES]) {
    assert.deepEqual(fs.readFileSync(path.join(source, file)), fs.readFileSync(path.join(target, file)));
    assert.equal(fs.statSync(path.join(target, file)).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, STATE_FILES[0]))).health['controlled-account'].state, 'verification_required');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, STATE_FILES[1])))['controlled-account'].geminiQuotaProtection.protected, true);
});
test('凭据符号链接或损坏的保护状态不能静默当成空状态继续', t => {
  const { source, target, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'outside.json'), '{}'); fs.symlinkSync(path.join(root, 'outside.json'), path.join(source, 'accounts/link.json'));
  assert.throws(() => copyManagedState(source, target), /regular files/);
  fs.unlinkSync(path.join(source, 'accounts/link.json'));
  fs.writeFileSync(path.join(source, 'state/quota.json'), '{broken');
  assert.throws(() => copyManagedState(source, target), SyntaxError);
});
test('证据在落盘前按字段和已知秘密文本双重脱敏', () => {
  const value = { authorization: 'Bearer dynamic-token', project: 'project', email: 'mail@example.invalid', body: 'controlled-secret /private/test/home Alice@example.invalid ya29.abc123', nested: { refresh_token: 'refresh', id_token: 'idtoken' }, raw: 'Bearer refreshed-later {"access_token":"dynamic-later"}' };
  const result = scrub(value, ['controlled-secret'], '/private/test');
  assert.doesNotMatch(JSON.stringify(result), /dynamic-token|controlled-secret|Alice@|ya29\.|"refresh"|refreshed-later|dynamic-later|idtoken/);
  assert.match(result.body, /\/tmp\/real-client-gateway/);
  assert.equal(value.authorization, 'Bearer dynamic-token');
});
test('观察器保留真实native fetch实现及TLS限定，不注入Node模型传输', () => {
  const source = observerSource('/tmp/trace', '/tmp/config', '/tmp/root', 'local-key');
  new vm.Script(source);
  assert.match(source, /nativeFetch\.call\(this,url,options\)/);
  assert.match(source, /transportReplaced:false/);
  assert.doesNotMatch(source, /nativeCloudCodeFetch\s*=|globalThis\.fetch\s*=/);
  assert.match(gatewaySandbox('/tmp/root', '/tmp/production'), /deny file-read.*production/);
});
test('只有真实原生调用成功及读取返回内容同时存在才可标记真实闭环通过', () => {
  const marker = 'controlled-marker', name = 'mcp_gateway_tool_x';
  const request = (id, contents) => ({ type: 'native-request', id, url: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent', headers: { 'user-agent': 'antigravity/cli/1.5.2 darwin/arm64' }, body: { request: { contents } } });
  const trace = [request('1', []), { type: 'native-response', id: '1', status: 200, binary: '/tmp/agy-transport-hash' }, request('2', [{ parts: [{ functionResponse: { id: 'call', name, response: { output: marker } } }] }]), { type: 'client-http', path: '/v1/messages', status: 200, responseBody: JSON.stringify({content:[{type:'tool_use',name:'Read'},{type:'text',text:marker}]}) }];
  assert.equal(assess('claude', 'read', trace, { code: 0 }, marker).passed, true);
  assert.equal(assess('claude', 'read', trace.filter(item => item.type !== 'native-response'), { code: 0 }, marker).passed, false);
  assert.equal(assess('claude', 'read', trace, { code: 0, timedOut: true }, marker).passed, false);
  assert.equal(assess('claude', 'read', trace, { code: 0 }, 'missing-marker').passed, false);
  const onlyTool = structuredClone(trace); onlyTool.at(-1).responseBody = JSON.stringify({content:[{type:'tool_use',name:'Read',input:{pretend:marker}}]});
  assert.equal(assess('claude', 'read', onlyTool, {code:0}, marker).checks.finalMarkerDelivered, false);
});

test('客户端只允许网关和显式自有Hermes端口，拒绝真实账号及工作目录写入', t => {
  const { root } = fixture(t), sandbox = path.join(root, 'client.sb');
  fs.writeFileSync(sandbox, '(version 1)(deny network*)(allow network-outbound (remote ip "localhost:*"))');
  const settings = { sandbox, work: path.join(root, 'work') };
  const policy = clientSandbox(settings, root, '/private/protected-config', 12345, [12346]);
  assert.match(policy, /remote ip "localhost:12345"/);
  assert.match(policy, /remote ip "localhost:12346"/);
  assert.doesNotMatch(policy, /localhost:\*/);
  assert.match(policy, /deny file-read.*protected-config/);
  assert.match(policy, /deny file-write.*work/);
  assert.throws(() => clientSandbox(settings, root, '/private/protected-config', 12345, ['*']), /explicit valid port/);
});
test('归档8项真实结果逐份重算，摘要和证据文件匹配且各次运行源码/账号稳定', () => {
  const crypto = require('node:crypto'), root = path.join(__dirname, 'fixtures/real-client-gateway-20261107');
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'verified-summary.json')));
  assert.equal(summary.records.length, 8);
  assert.equal(summary.sameSourceSnapshotForAllAgents, false);
  const coverage = new Set();
  for (const record of summary.records) {
    const bytes = fs.readFileSync(path.join(root, record.file)), value = JSON.parse(bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256);
    assert.equal(assess(value.agent, value.scenario, value.trace, value.outcome, value.marker).passed, true, record.file);
    assert.equal(record.sourceUnchanged, true);
    assert.equal(record.productionAccountsBefore.digest, record.productionAccountsAfter.digest);
    assert.equal(value.model, 'claude-sonnet-4-6');
    coverage.add(`${value.agent}:${value.scenario}`);
  }
  for (const agent of ['claude','pi','dsh','hermes']) for (const scenario of ['text','read']) assert.ok(coverage.has(`${agent}:${scenario}`));
});
