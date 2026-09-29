'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDashboardAccessPolicy } = require('../src/dashboard-access');

const ENTRY = path.join(__dirname, '..', 'antigravity-gateway.js');

function localIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (!item.internal && item.family === 'IPv4') return item.address;
    }
  }
  return '';
}

function subnet24(address) {
  return `${address.split('.').slice(0, 3).join('.')}.0/24`;
}

function request({ port, host, localAddress, route, headers = {}, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, localAddress, path: route, headers, method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startGateway(t, allow) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-dashboard-access-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = `
    const { createServer } = require(${JSON.stringify(ENTRY)});
    const server = createServer();
    server.listen(0, '0.0.0.0', () => console.log('port ' + server.address().port));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      ANTIGRAVITY_GATEWAY_CONFIG_DIR: path.join(directory, 'config'),
      ANTIGRAVITY_GATEWAY_TRANSPORT: 'agy',
      ANTIGRAVITY_GATEWAY_DASHBOARD_ALLOW: allow
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`网关未启动：${stderr}`)), 10000);
    child.stdout.on('data', () => {
      const match = stdout.match(/^port (\d+)$/m);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`网关提前退出 ${code}：${stderr}`));
    });
  });
  return { child, port };
}

test('dashboard access policy accepts exact addresses, CIDRs, wildcard, and mapped IPv4', () => {
  const policy = createDashboardAccessPolicy('192.168.10.0/24,2001:db8::/32');
  assert.equal(policy.allows('127.0.0.1'), true);
  assert.equal(policy.allows('::ffff:127.0.0.1'), true);
  assert.equal(policy.allows('192.168.10.25'), true);
  assert.equal(policy.allows('::ffff:192.168.10.25'), true);
  assert.equal(policy.allows('192.168.11.25'), false);
  assert.equal(policy.allows('2001:db8::12'), true);
  assert.equal(createDashboardAccessPolicy('*').allows('203.0.113.8'), true);
});

test('invalid dashboard allowlist entries are ignored without widening access', () => {
  const warnings = [];
  const policy = createDashboardAccessPolicy('bad,10.0.0.0/33,1.2.3.4/8/9,10.0.0.0/nope', {
    warn: (message) => warnings.push(message)
  });
  assert.equal(policy.allows('10.0.0.8'), false);
  assert.equal(policy.description, '仅本机');
  assert.equal(warnings.length, 4);
});

test('remote dashboard allowlist gates page, data, and every bundled asset together', async (t) => {
  const address = localIpv4();
  if (!address) return t.skip('本机没有非回环 IPv4 地址');
  const routes = [
    '/dashboard',
    '/dashboard/data',
    '/dashboard/assets/community-qr.png',
    '/dashboard/assets/community-poster.png',
    '/dashboard/assets/html2canvas.min.js'
  ];

  const denied = await startGateway(t, '');
  for (const route of routes) {
    assert.equal((await request({ port: denied.port, host: address, localAddress: address, route })).status, 403);
  }
  assert.equal((await request({ port: denied.port, host: address, localAddress: address, route: '/dashboard/accounts/example/recheck', method: 'POST' })).status, 403);
  assert.equal((await request({ port: denied.port, host: address, localAddress: address, route: '/dashboard/accounts/example', method: 'DELETE' })).status, 403);

  const allowed = await startGateway(t, subnet24(address));
  assert.equal((await request({ port: allowed.port, host: address, localAddress: address, route: '/dashboard' })).status, 200);
  assert.equal((await request({ port: allowed.port, host: address, localAddress: address, route: '/dashboard/data' })).status, 200);
  const asset = await request({ port: allowed.port, host: address, localAddress: address, route: '/dashboard/assets/community-qr.png' });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-type'], 'image/png');
  assert.ok(asset.body.length > 1000);
  assert.equal((await request({ port: allowed.port, host: address, localAddress: address, route: '/dashboard/assets/community-poster.png' })).status, 200);
  assert.equal((await request({ port: allowed.port, host: address, localAddress: address, route: '/dashboard/assets/html2canvas.min.js' })).status, 200);
  assert.equal((await request({ port: allowed.port, host: address, localAddress: address, route: '/dashboard/accounts/missing-test/recheck', method: 'POST' })).status, 404);
  assert.equal((await request({ port: allowed.port, host: address, localAddress: address, route: '/dashboard/accounts/missing-test', method: 'DELETE' })).status, 404);
});

test('forwarded headers cannot bypass the TCP dashboard source check', async (t) => {
  const address = localIpv4();
  if (!address) return t.skip('本机没有非回环 IPv4 地址');
  const gateway = await startGateway(t, '203.0.113.0/24');
  const response = await request({
    port: gateway.port,
    host: address,
    localAddress: address,
    route: '/dashboard',
    headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' }
  });
  assert.equal(response.status, 403);
});
