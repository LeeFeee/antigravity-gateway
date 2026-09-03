'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  context,
  launchAgentBody,
  manageService,
  powershellEncoded,
  serviceEnvironment,
  serviceName,
  systemdPath,
  systemdUnitBody,
  windowsInstallScript
} = require('../src/service-manager');
const { RESTART_DELAY_MS, readConfiguration, rotate } = require('../src/service-runner');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-service-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeContext(t, platform, execute) {
  const root = temporary(t);
  return {
    platform,
    homeDir: path.join(root, 'home'),
    configDir: path.join(root, 'config'),
    gatewayFile: path.join(root, 'package', 'antigravity-gateway.js'),
    runnerFile: path.join(root, 'package', 'src', 'service-runner.js'),
    nodeFile: platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/opt/node/bin/node',
    name: 'antigravity-gateway-test',
    username: 'test-user',
    uid: 501,
    env: {
      HOME: path.join(root, 'home'),
      PATH: platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin',
      ANTIGRAVITY_GATEWAY_PORT: '19996',
      ANTIGRAVITY_GATEWAY_API_KEY: 'local-secret',
      OPENAI_API_KEY: 'must-not-be-captured'
    },
    execute
  };
}

test('service name and environment are constrained', () => {
  assert.equal(serviceName('gateway_test-1.0'), 'gateway_test-1.0');
  assert.throws(() => serviceName('../outside'), /服务名称/);
  assert.deepEqual(serviceEnvironment({
    HOME: '/home/test',
    PATH: '/usr/bin',
    ANTIGRAVITY_GATEWAY_PORT: '19996',
    ANTIGRAVITY_GATEWAY_API_KEY: 'secret',
    ANTIGRAVITY_GATEWAY_SERVICE_NAME: 'ignored',
    OPENAI_API_KEY: 'excluded'
  }), {
    HOME: '/home/test',
    PATH: '/usr/bin',
    ANTIGRAVITY_GATEWAY_PORT: '19996',
    ANTIGRAVITY_GATEWAY_API_KEY: 'secret'
  });
});

test('platform service definitions use the runner and enable restart', () => {
  const base = {
    platform: 'linux', homeDir: '/home/test', configDir: '/home/test/.gateway',
    name: 'gateway-test', gatewayFile: '/pkg/gateway.js', runnerFile: '/pkg/runner.js',
    configurationFile: '/home/test/.gateway/gateway-test-service.json',
    stdoutFile: '/home/test/.gateway/logs/gateway.log',
    stderrFile: '/home/test/.gateway/logs/gateway-error.log',
    nodeFile: '/opt/node', uid: 501, username: 'test'
  };
  const plist = launchAgentBody({ ...base, platform: 'darwin' });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /\/pkg\/runner\.js/);
  const unit = systemdUnitBody(base);
  assert.match(unit, /^ExecStart="\/opt\/node" "\/pkg\/runner\.js"/m);
  assert.match(unit, /^WorkingDirectory=\/home\/test$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.equal(systemdPath('/home/Test User/网关'), '/home/Test\\x20User/\\xe7\\xbd\\x91\\xe5\\x85\\xb3');
  const windows = windowsInstallScript({ ...base, platform: 'win32', nodeFile: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.match(windows, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(windows, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(windows, /LogonType S4U/);
  assert.match(windows, /RestartCount 999/);
  assert.match(windows, /Start-ScheduledTask/);
  assert.equal(Buffer.from(powershellEncoded('Write-Output ok'), 'base64').toString('utf16le'), 'Write-Output ok');
});

test('Linux service start installs, enables, and captures only gateway environment', async (t) => {
  const calls = [];
  const options = fakeContext(t, 'linux', async (file, args, config = {}) => {
    calls.push({ file, args, config });
    return file === 'loginctl' ? { code: 1, stdout: '', stderr: 'authorization required' } : { code: 0, stdout: '', stderr: '' };
  });
  const message = await manageService('start', options);
  assert.match(message, /后台保活模式已启动/);
  assert.match(message, /登录后自启/);
  const unit = path.join(options.homeDir, '.config', 'systemd', 'user', `${options.name}.service`);
  assert.equal(fs.existsSync(unit), true);
  assert.match(fs.readFileSync(unit, 'utf8'), /Restart=on-failure/);
  const configuration = path.join(options.configDir, `${options.name}-service.json`);
  const environment = readConfiguration(configuration);
  assert.equal(environment.ANTIGRAVITY_GATEWAY_PORT, '19996');
  assert.equal(environment.ANTIGRAVITY_GATEWAY_API_KEY, 'local-secret');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(calls.some((call) => call.file === 'systemctl' && call.args.includes('enable') && call.args.includes('--now')), true);
  assert.equal(calls.some((call) => call.file === 'loginctl' && call.args[0] === 'enable-linger'), true);
});

test('macOS service start writes a LaunchAgent and bootstraps it', async (t) => {
  const calls = [];
  const options = fakeContext(t, 'darwin', async (file, args) => {
    calls.push({ file, args });
    return { code: args[0] === 'bootout' ? 3 : 0, stdout: '', stderr: '' };
  });
  const message = await manageService('start', options);
  assert.match(message, /后台保活模式已启动/);
  const plist = path.join(options.homeDir, 'Library', 'LaunchAgents', `io.github.leefeee.${options.name}.plist`);
  assert.equal(fs.existsSync(plist), true);
  assert.equal(calls.some((call) => call.args[0] === 'bootstrap'), true);
});

test('Windows service start registers and starts a scheduled task', async (t) => {
  let decoded = '';
  const options = fakeContext(t, 'win32', async (file, args) => {
    assert.equal(file, 'powershell.exe');
    decoded = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    return { code: 0, stdout: '', stderr: '' };
  });
  const message = await manageService('start', options);
  assert.match(message, /后台保活模式已启动/);
  assert.match(decoded, /Register-ScheduledTask/);
  assert.match(decoded, /Start-ScheduledTask/);
  assert.match(decoded, /antigravity-gateway-test/);
});

test('service logs tail rotated output without requiring the service manager', async (t) => {
  const options = fakeContext(t, 'linux', async () => ({ code: 0, stdout: '', stderr: '' }));
  const ctx = context(options);
  fs.mkdirSync(ctx.logsDir, { recursive: true });
  fs.writeFileSync(ctx.stdoutFile, 'line one\nline two\n');
  assert.match(await manageService('logs', options), /line two/);
  fs.writeFileSync(ctx.stdoutFile, Buffer.alloc(10 * 1024 * 1024 + 1));
  rotate(ctx.stdoutFile);
  assert.equal(fs.existsSync(`${ctx.stdoutFile}.1`), true);
});

test('runner uses a short internal restart delay', () => {
  assert.equal(RESTART_DELAY_MS, 3000);
});

test('postinstall prints both foreground and background commands', () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-environment.js')], { encoding: 'utf8' });
  assert.match(output, /前台模式：antigravity-gateway/);
  assert.match(output, /后台保活模式：antigravity-gateway service start/);
});
