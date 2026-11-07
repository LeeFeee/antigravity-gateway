'use strict';
require('./helpers/gateway-environment');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createServer } = require('../antigravity-gateway');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { buildDirectRequestAsync } = require('../src/direct-provider');
const { ToolContractError } = require('../src/antigravity-tool-contract');
const { ToolReceiptError } = require('../src/agy-tool-results');

async function httpFixture(t) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (protocol, fields) => {
    const payload = protocol === 'messages' ? { model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Run the declared tool.' }], max_tokens: 2048, ...fields }
      : { model: 'claude-sonnet-4-6', input: 'Run the declared tool.', max_output_tokens: 2048, ...fields };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${protocol}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  };
}

for (const protocol of ['messages', 'responses']) {
  test(`${protocol}: real fixed-thinking/forced-tool conflict retains the capability error at the HTTP boundary`, async t => {
    const post = await httpFixture(t);
    t.mock.method(AccountPool.prototype, 'send', async (normalized, model) => buildDirectRequestAsync(normalized, model, 'project', 'session'));
    const fields = protocol === 'messages'
      ? { tools: [{ name: 'read', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'read' } }
      : { tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], tool_choice: { type: 'function', name: 'read' } };
    const result = await post(protocol, fields);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'model_capability_conflict');
  });

  test(`${protocol}: invalid schema is a request error before account dispatch`, async t => {
    const post = await httpFixture(t);
    let calls = 0;
    t.mock.method(AccountPool.prototype, 'send', async () => { calls++; throw new Error('unexpected dispatch'); });
    const schema = { $schema: 'https://synthetic.invalid/unsupported-dialect', type: 'object' };
    const fields = protocol === 'messages' ? { tools: [{ name: 'read', input_schema: schema }] }
      : { tools: [{ type: 'function', name: 'read', parameters: schema }] };
    const result = await post(protocol, fields);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'invalid_tool_schema');
    assert.equal(calls, 0);
  });

  test(`${protocol}: returned tool and receipt contract errors retain their public meaning`, async t => {
    const post = await httpFixture(t);
    let failure;
    t.mock.method(AccountPool.prototype, 'send', async () => { throw failure; });
    for (const error of [new ToolContractError('模型工具参数不符合声明。'), new ToolReceiptError('动态工具结果缺少当次声明。')]) {
      failure = error;
      const result = await post(protocol, {});
      assert.equal(result.status, error.status);
      assert.equal(result.body.error.type, error.code);
    }
    failure = Object.assign(new Error('private diagnostic text'), { status: 400, code: 'untrusted_error' });
    const unknown = await post(protocol, {});
    assert.equal(unknown.status, 500);
    assert.equal(unknown.body.error.type, 'internal_error');
    assert.doesNotMatch(JSON.stringify(unknown.body), /private diagnostic text/);
  });
}

test('invalid converted tool arguments do not cool accounts or repeat a generation on other accounts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-contract-errors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  for (const email of ['one@example.test', 'two@example.test']) store.save({ email, accessToken: 'synthetic', refreshToken: 'synthetic' });
  let calls = 0;
  const failure = new ToolContractError('工具 quota 参数不符合声明。', { details: 'The business field is named permission_denied.' });
  const pool = new AccountPool({ store, providerFactory: () => ({
    listModels: async () => ['synthetic-model'], modelInfo: () => null,
    send: async () => { calls++; throw failure; }
  }) });
  t.after(() => pool.stop());
  await assert.rejects(pool.send({}, 'synthetic-model'), error => error === failure);
  assert.equal(calls, 1);
  assert.ok(pool.status().every(item => item.state === 'available' && !item.cooldownUntil));
  assert.ok([...pool.entries.values()].every(entry => entry.modelCooldowns.size === 0));
});
