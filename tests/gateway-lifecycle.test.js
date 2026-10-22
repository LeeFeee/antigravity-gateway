'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

async function waitFor(predicate, message, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function start(t, dir, port) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTIGRAVITY_|ROBIN_|GEMINI_)/.test(k)));
  Object.assign(env, {
    HOME: dir,
    ANTIGRAVITY_GATEWAY_CONFIG_DIR: dir,
    ANTIGRAVITY_GATEWAY_RUNTIME_DIR: path.join(dir, 'runtime'),
    ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1',
    ANTIGRAVITY_GATEWAY_PORT: String(port),
    ANTIGRAVITY_GATEWAY_TRANSPORT: 'direct',
    ANTIGRAVITY_DEFAULT_MODEL: 'gemini-test-high',
    ANTIGRAVITY_CLI_PATH: process.execPath,
    ANTIGRAVITY_CLI_PREFIX_ARGS: JSON.stringify([path.join(__dirname, 'fixtures/fake-agy.js')])
  });
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/lifecycle-preload.js'), path.join(__dirname, '../antigravity-gateway.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.output += data; });
  child.finished = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.finished;
    }
  });
  return child;
}

test('SIGTERM 排空 HTTP 已断开但尚未结束的真实请求事务', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-drain-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const child = start(t, dir, port);
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/hello`)).status === 200; }
    catch { return false; }
  }, '网关未就绪');
  const request = http.request(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: 'gemini-test-high', max_tokens: 32, messages: [{ role: 'user', content: '夹具请求' }] }));
  await waitFor(() => fs.existsSync(path.join(dir, 'transaction-started')), '未进入上游事务');
  request.destroy();
  await delay(30);
  child.kill('SIGTERM');
  await delay(150);
  assert.equal(child.exitCode, null, 'HTTP 连接已断开时，SIGTERM 仍必须等待在途事务结束');
  assert.equal(child.signalCode, null);
  // 排空期间，同一数据目录不能由第二个实例接管。
  const contender = start(t, dir, await freePort());
  const [contenderCode] = await contender.finished;
  assert.equal(contenderCode, 1);
  assert.match(contender.output, /数据目录已被正在运行的网关进程独占/);
  assert.equal(fs.existsSync(path.join(dir, `pool-initialized-${contender.pid}`)), false, '未获得守护的重复实例不能构造可能写状态的账号池');
  fs.writeFileSync(path.join(dir, 'release-transaction'), '1');
  const [code, signal] = await child.finished;
  assert.equal(code, 0, child.output);
  assert.equal(signal, null);
  assert.ok(fs.existsSync(path.join(dir, 'transaction-finished')));
  const successor = start(t, dir, await freePort());
  await waitFor(() => /Antigravity Gateway/.test(successor.output), '后继实例未启动');
  assert.doesNotMatch(successor.output, /数据目录已被正在运行的网关进程独占/);
  successor.kill('SIGTERM');
  const [successorCode] = await successor.finished;
  assert.equal(successorCode, 0, successor.output);
});

test('SIGTERM 排空超过十秒的后台事务后才交接目录', { timeout: 25000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-drain-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const child = start(t, dir, port);
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/hello`)).status === 200; }
    catch { return false; }
  }, '网关未就绪');
  const request = http.request(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: 'gemini-test-high', max_tokens: 32, messages: [{ role: 'user', content: '夹具请求' }] }));
  await waitFor(() => fs.existsSync(path.join(dir, 'transaction-started')), '未进入上游事务');
  request.destroy();
  await delay(30);
  child.kill('SIGTERM');
  await delay(150);
  assert.equal(child.exitCode, null, 'HTTP 连接已断开时，SIGTERM 仍必须等待在途事务结束');
  assert.equal(child.signalCode, null);
  await delay(10500);
  assert.equal(child.exitCode, null, '排空不得在十秒后提前退出');
  fs.writeFileSync(path.join(dir, 'release-transaction'), '1');
  const [code, signal] = await child.finished;
  assert.equal(code, 0, child.output);
  assert.equal(signal, null);
  assert.ok(fs.existsSync(path.join(dir, 'transaction-finished')));
  const successor = start(t, dir, await freePort());
  await waitFor(() => /Antigravity Gateway/.test(successor.output), '后继实例未启动');
  assert.doesNotMatch(successor.output, /数据目录已被正在运行的网关进程独占/);
  successor.kill('SIGTERM');
  const [successorCode] = await successor.finished;
  assert.equal(successorCode, 0, successor.output);
});
