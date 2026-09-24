'use strict';

// ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW is read once at module load, so every
// configuration runs in its own child process on a random port with a
// throwaway HOME/config dir. Nothing here touches the real 9897 service.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ENTRY = path.join(__dirname, '..', 'antigravity-gateway.js');
const FAKE_AGY = path.join(__dirname, 'fixtures', 'fake-agy.js');

function localAddress(family, accept = () => true) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (!item.internal && item.family === family && accept(item.address)) return item.address;
    }
  }
  return null;
}

const LAN_IPV4 = localAddress('IPv4');
// Link-local fe80:: needs a scope id to connect; use a global/ULA address.
const LAN_IPV6 = localAddress('IPv6', (address) => !/^fe80:/i.test(address));
const NO_IPV4 = LAN_IPV4 ? false : '本机没有非回环 IPv4 地址';
const NO_IPV6 = LAN_IPV6 ? false : '本机没有非回环、非链路本地的 IPv6 地址';

function baseEnv(t, extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-dashboard-allow-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    ANTIGRAVITY_GATEWAY_CONFIG_DIR: path.join(home, 'config'),
    ANTIGRAVITY_GATEWAY_TRANSPORT: 'agy',
    ANTIGRAVITY_CLI_PATH: process.execPath,
    ANTIGRAVITY_CLI_PREFIX_ARGS: JSON.stringify([FAKE_AGY]),
    ANTIGRAVITY_DEFAULT_MODEL: 'gemini-test-high',
    ...extra
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

function collect(child) {
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  return output;
}

// Starts createServer() only (no startup side effects) and reports each
// accepted socket's remoteAddress so tests can assert what the gate saw.
async function startServer(t, { host = '0.0.0.0', allow, apiKey } = {}) {
  const script = `
    const { createServer } = require(${JSON.stringify(ENTRY)});
    const server = createServer();
    server.on('connection', (socket) => console.log('conn ' + socket.remoteAddress));
    server.listen(0, ${JSON.stringify(host)}, () => console.log('port ' + server.address().port));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: baseEnv(t, { ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW: allow, ANTIGRAVITY_GATEWAY_API_KEY: apiKey }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGKILL'));
  const output = collect(child);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程没报端口：${output.stderr}`)), 10000);
    child.stdout.on('data', () => {
      const match = output.stdout.match(/^port (\d+)$/m);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`子进程提前退出 ${code}：${output.stderr}`)); });
  });
  return { port, output, child };
}

function request({ port, host, from, route, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: route, localAddress: from, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The CLI rejects --port 0, so reserve a free port and hand it over.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function ipv4Subnet24(address) {
  return `${address.split('.').slice(0, 3).join('.')}.0/24`;
}

test('A: 默认为空时只放行本机', { skip: NO_IPV4 }, async (t) => {
  const { port } = await startServer(t);
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard' })).status, 403);
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard/data' })).status, 403);
  assert.equal((await request({ port, host: '127.0.0.1', route: '/dashboard' })).status, 200);
});

test('B: 白名单内的 IPv4 网段可以打开看板和数据接口', { skip: NO_IPV4 }, async (t) => {
  const { port } = await startServer(t, { allow: ipv4Subnet24(LAN_IPV4) });
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard' })).status, 200);
  const data = await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard/data' });
  assert.equal(data.status, 200);
  assert.ok(JSON.parse(data.body).generatedAt);
});

test('C: 白名单外的网段仍然 403', { skip: NO_IPV4 }, async (t) => {
  const { port } = await startServer(t, { allow: '203.0.113.0/24, 198.51.100.7' });
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard' })).status, 403);
  assert.equal((await request({ port, host: '127.0.0.1', route: '/dashboard' })).status, 200);
});

test('D: * 放行任意来源', { skip: NO_IPV4 }, async (t) => {
  const { port } = await startServer(t, { allow: '*' });
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard' })).status, 200);
});

test('E: 无效项逐条告警后跳过，不放宽访问、进程不退出', { skip: NO_IPV4 }, async (t) => {
  const invalid = ['foo', '10.0.0.0/33', '1.2.3.4/8/9', '10.0.0.0/abc'];
  const { port, output, child } = await startServer(t, { allow: invalid.join(',') });
  for (const entry of invalid) assert.match(output.stderr, new RegExp(`忽略无效项：${entry.replace(/[./]/g, '\\$&')}$`, 'm'));
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard' })).status, 403);
  assert.equal(child.exitCode, null);
});

test('F: 伪造 X-Forwarded-For 不能冒充本机', { skip: NO_IPV4 }, async (t) => {
  const { port } = await startServer(t);
  const result = await request({
    port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard',
    headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' }
  });
  assert.equal(result.status, 403);
});

test('G: API Key 管模型接口，不管白名单内的看板', { skip: NO_IPV4 }, async (t) => {
  const { port } = await startServer(t, { allow: '*', apiKey: 'test-key' });
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/v1/models' })).status, 401);
  assert.equal((await request({
    port, host: LAN_IPV4, from: LAN_IPV4, route: '/v1/models', headers: { authorization: 'Bearer test-key' }
  })).status, 200);
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard' })).status, 200);
});

test('H: 双栈监听时 IPv4 映射地址按 IPv4 规则匹配', { skip: NO_IPV4 }, async (t) => {
  const { port, output } = await startServer(t, { host: '::', allow: ipv4Subnet24(LAN_IPV4) });
  assert.equal((await request({ port, host: LAN_IPV4, from: LAN_IPV4, route: '/dashboard' })).status, 200);
  assert.match(output.stdout, new RegExp(`^conn ::ffff:${LAN_IPV4.replace(/\./g, '\\.')}$`, 'm'));
});

test('I: IPv6 条目生效', { skip: NO_IPV6 }, async (t) => {
  const { port } = await startServer(t, { host: '::', allow: `${LAN_IPV6}/128` });
  assert.equal((await request({ port, host: LAN_IPV6, from: LAN_IPV6, route: '/dashboard' })).status, 200);
});

test('J: 启动日志写出看板来源生效列表', async (t) => {
  const child = spawn(process.execPath, [ENTRY, '--port', String(await freePort())], {
    env: baseEnv(t, { ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW: '192.168.0.0/16, bad, *' }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGKILL'));
  const output = collect(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`没等到启动日志：${output.stdout}${output.stderr}`)), 10000);
    child.stdout.on('data', () => {
      if (/看板来源：/.test(output.stdout)) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`进程提前退出 ${code}：${output.stderr}`)); });
  });
  assert.match(output.stdout, /看板来源：本机 \+ 192\.168\.0\.0\/16, \*$/m);
  assert.match(output.stderr, /忽略无效项：bad$/m);
});

test('K: 非本机监听却没设 API Key 时退出码为 1', async (t) => {
  const child = spawn(process.execPath, [ENTRY, '--port', String(await freePort()), '--host', '0.0.0.0'], {
    env: baseEnv(t, { ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW: '*' }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGKILL'));
  const output = collect(child);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(output.stderr, /非本机监听必须设置 ANTIGRAVITY_GATEWAY_API_KEY/);
});
