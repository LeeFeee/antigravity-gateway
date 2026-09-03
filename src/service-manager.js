'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ACTIONS = new Set(['start', 'install', 'status', 'restart', 'stop', 'logs', 'uninstall']);
const DEFAULT_SERVICE_NAME = 'antigravity-gateway';
const ENVIRONMENT_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'DBUS_SESSION_BUS_ADDRESS'
]);

class ServiceError extends Error {
  constructor(message, { cause, details = '' } = {}) {
    super(message, { cause });
    this.name = 'ServiceError';
    this.details = details;
  }
}

function serviceName(source = process.env.ANTIGRAVITY_GATEWAY_SERVICE_NAME || DEFAULT_SERVICE_NAME) {
  const value = String(source || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new ServiceError('后台服务名称只能包含字母、数字、点、下划线和连字符。');
  }
  return value;
}

function serviceEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => (
    typeof value === 'string'
    && (key.startsWith('ANTIGRAVITY_') || ENVIRONMENT_KEYS.has(key))
    && key !== 'ANTIGRAVITY_GATEWAY_SERVICE_NAME'
  )));
}

function context(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const configDir = path.resolve(options.configDir || path.join(homeDir, '.antigravity-gateway'));
  const name = serviceName(options.name);
  const gatewayFile = path.resolve(options.gatewayFile || path.join(__dirname, '..', 'antigravity-gateway.js'));
  const runnerFile = path.resolve(options.runnerFile || path.join(__dirname, 'service-runner.js'));
  const logsDir = path.join(configDir, 'logs');
  const stdoutFile = path.join(logsDir, 'gateway.log');
  const stderrFile = path.join(logsDir, 'gateway-error.log');
  const configurationFile = path.join(configDir, `${name}-service.json`);
  return {
    platform, homeDir, configDir, name, gatewayFile, runnerFile, logsDir,
    stdoutFile, stderrFile, configurationFile,
    nodeFile: path.resolve(options.nodeFile || process.execPath),
    env: options.env || process.env,
    uid: options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null),
    username: options.username || os.userInfo().username,
    execute: options.execute || execute
  };
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function systemdQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function systemdPath(value) {
  let output = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9/_.-]/.test(character)) output += character;
    else if (character === '%') output += '%%';
    else output += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return output;
}

function launchAgentLabel(name) {
  return `io.github.leefeee.${name}`;
}

function launchAgentBody(ctx) {
  const args = [ctx.nodeFile, ctx.runnerFile, ctx.configurationFile, ctx.gatewayFile, ctx.stdoutFile, ctx.stderrFile];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(launchAgentLabel(ctx.name))}</string>
  <key>ProgramArguments</key>
  <array>${args.map((value) => `\n    <string>${xml(value)}</string>`).join('')}
  </array>
  <key>WorkingDirectory</key><string>${xml(ctx.homeDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function systemdUnitBody(ctx) {
  const command = [ctx.nodeFile, ctx.runnerFile, ctx.configurationFile, ctx.gatewayFile, ctx.stdoutFile, ctx.stderrFile]
    .map(systemdQuote).join(' ');
  return `[Unit]
Description=Antigravity Gateway (${ctx.name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${systemdPath(ctx.homeDir)}
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function powershellEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function windowsInstallScript(ctx) {
  const args = [ctx.runnerFile, ctx.configurationFile, ctx.gatewayFile, ctx.stdoutFile, ctx.stderrFile]
    .map((value) => `"${String(value).replaceAll('"', '\\"')}"`).join(' ');
  return [
    '$ErrorActionPreference = "Stop"',
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(ctx.nodeFile)} -Argument ${powershellLiteral(args)} -WorkingDirectory ${powershellLiteral(ctx.homeDir)}`,
    '$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $identity))',
    '$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited',
    '$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew',
    `$task = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings`,
    `Register-ScheduledTask -TaskName ${powershellLiteral(ctx.name)} -InputObject $task -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${powershellLiteral(ctx.name)}`
  ].join('; ');
}

function execute(file, args = [], { allowFailure = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, env }, (error, stdout, stderr) => {
      const result = { code: error?.code || 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      if (error && !allowFailure) {
        reject(new ServiceError(`后台服务命令执行失败：${path.basename(file)}`, {
          cause: error,
          details: (result.stderr || result.stdout || error.message).trim().slice(-2000)
        }));
        return;
      }
      resolve(result);
    });
  });
}

function writePrivateFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows inherits the user profile ACL */ }
}

function saveConfiguration(ctx) {
  fs.mkdirSync(ctx.logsDir, { recursive: true, mode: 0o700 });
  writePrivateFile(ctx.configurationFile, `${JSON.stringify({
    version: 1,
    installedAt: new Date().toISOString(),
    environment: serviceEnvironment(ctx.env)
  }, null, 2)}\n`);
}

function tail(file, lineCount = 80) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - lineCount - 1)).join('\n').trim();
  } catch { return ''; }
}

function logs(ctx) {
  const stdout = tail(ctx.stdoutFile);
  const stderr = tail(ctx.stderrFile);
  if (!stdout && !stderr) return '后台服务尚未生成日志。';
  return [`== gateway.log ==\n${stdout || '(empty)'}`, `== gateway-error.log ==\n${stderr || '(empty)'}`].join('\n\n');
}

async function macService(action, ctx) {
  if (!Number.isInteger(ctx.uid)) throw new ServiceError('无法确定当前 macOS 用户 UID。');
  const agentsDir = path.join(ctx.homeDir, 'Library', 'LaunchAgents');
  const plist = path.join(agentsDir, `${launchAgentLabel(ctx.name)}.plist`);
  const domain = `gui/${ctx.uid}`;
  const target = `${domain}/${launchAgentLabel(ctx.name)}`;
  if (action === 'install') {
    saveConfiguration(ctx);
    writePrivateFile(plist, launchAgentBody(ctx));
    await ctx.execute('/bin/launchctl', ['bootout', domain, plist], { allowFailure: true, env: ctx.env });
    await ctx.execute('/bin/launchctl', ['bootstrap', domain, plist], { env: ctx.env });
    return `后台保活模式已启动：${launchAgentLabel(ctx.name)}`;
  }
  if (action === 'status') {
    const state = await ctx.execute('/bin/launchctl', ['print', target], { allowFailure: true, env: ctx.env });
    return `配置状态: ${fs.existsSync(plist) ? '已配置' : '未配置'}\n运行状态: ${state.code === 0 ? '运行中' : '未运行'}`;
  }
  if (action === 'restart') {
    if (!fs.existsSync(plist)) throw new ServiceError('后台保活模式尚未配置，请先运行 antigravity-gateway service start。');
    const result = await ctx.execute('/bin/launchctl', ['kickstart', '-k', target], { allowFailure: true, env: ctx.env });
    if (result.code !== 0) {
      await ctx.execute('/bin/launchctl', ['bootstrap', domain, plist], { env: ctx.env });
    }
    return '后台服务已重启。';
  }
  if (action === 'stop') {
    await ctx.execute('/bin/launchctl', ['bootout', domain, plist], { allowFailure: true, env: ctx.env });
    return '后台服务已停止；配置仍保留，下次登录会自动启动。';
  }
  if (action === 'uninstall') {
    await ctx.execute('/bin/launchctl', ['bootout', domain, plist], { allowFailure: true, env: ctx.env });
    fs.rmSync(plist, { force: true });
    fs.rmSync(ctx.configurationFile, { force: true });
    return '后台服务已卸载，历史日志保留。';
  }
  return logs(ctx);
}

async function linuxService(action, ctx) {
  const unitDir = path.join(ctx.homeDir, '.config', 'systemd', 'user');
  const unitName = `${ctx.name}.service`;
  const unitFile = path.join(unitDir, unitName);
  const systemctl = (args, options) => ctx.execute('systemctl', ['--user', ...args], { ...options, env: ctx.env });
  if (action === 'install') {
    saveConfiguration(ctx);
    writePrivateFile(unitFile, systemdUnitBody(ctx));
    await systemctl(['daemon-reload']);
    try {
      await systemctl(['enable', '--now', unitName]);
    } catch (error) {
      await systemctl(['disable', '--now', unitName], { allowFailure: true });
      throw error;
    }
    const linger = await ctx.execute('loginctl', ['enable-linger', ctx.username], { allowFailure: true, env: ctx.env });
    const suffix = linger.code === 0 ? '，已启用开机自启' : '；当前为登录后自启（启用 linger 需要系统授权）';
    return `后台保活模式已启动：${unitName}${suffix}`;
  }
  if (action === 'status') {
    const enabled = await systemctl(['is-enabled', unitName], { allowFailure: true });
    const active = await systemctl(['is-active', unitName], { allowFailure: true });
    return `配置状态: ${fs.existsSync(unitFile) && enabled.code === 0 ? '已配置并启用' : '未启用'}\n运行状态: ${active.code === 0 ? '运行中' : '未运行'}`;
  }
  if (action === 'restart') {
    if (!fs.existsSync(unitFile)) throw new ServiceError('后台保活模式尚未配置，请先运行 antigravity-gateway service start。');
    await systemctl(['restart', unitName]);
    return '后台服务已重启。';
  }
  if (action === 'stop') {
    await systemctl(['stop', unitName], { allowFailure: true });
    return '后台服务已停止；服务仍启用，下次用户服务启动时会自动运行。';
  }
  if (action === 'uninstall') {
    await systemctl(['disable', '--now', unitName], { allowFailure: true });
    fs.rmSync(unitFile, { force: true });
    fs.rmSync(ctx.configurationFile, { force: true });
    await systemctl(['daemon-reload'], { allowFailure: true });
    await systemctl(['reset-failed'], { allowFailure: true });
    return '后台服务已卸载，历史日志保留。';
  }
  return logs(ctx);
}

async function windowsPowerShell(ctx, script, allowFailure = false) {
  return ctx.execute('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', powershellEncoded(script)
  ], { allowFailure, env: ctx.env });
}

async function windowsService(action, ctx) {
  if (action === 'install') {
    saveConfiguration(ctx);
    await windowsPowerShell(ctx, windowsInstallScript(ctx));
    return `后台保活模式已启动：${ctx.name}`;
  }
  if (action === 'status') {
    const script = `$task = Get-ScheduledTask -TaskName ${powershellLiteral(ctx.name)} -ErrorAction SilentlyContinue; if (-not $task) { exit 3 }; $info = Get-ScheduledTaskInfo -TaskName ${powershellLiteral(ctx.name)}; [Console]::Write($task.State.ToString() + '|' + $info.LastTaskResult)`;
    const result = await windowsPowerShell(ctx, script, true);
    const state = result.stdout.trim().split('|')[0];
    return `配置状态: ${result.code === 0 ? '已配置' : '未配置'}\n运行状态: ${state === 'Running' ? '运行中' : state || '未运行'}`;
  }
  if (action === 'restart') {
    const script = `$task = Get-ScheduledTask -TaskName ${powershellLiteral(ctx.name)} -ErrorAction Stop; Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Start-ScheduledTask -InputObject $task`;
    await windowsPowerShell(ctx, script);
    return '后台服务已重启。';
  }
  if (action === 'stop') {
    await windowsPowerShell(ctx, `Stop-ScheduledTask -TaskName ${powershellLiteral(ctx.name)} -ErrorAction SilentlyContinue`, true);
    return '后台服务已停止；任务仍保留，下次登录会自动启动。';
  }
  if (action === 'uninstall') {
    await windowsPowerShell(ctx, `$task = Get-ScheduledTask -TaskName ${powershellLiteral(ctx.name)} -ErrorAction SilentlyContinue; if ($task) { Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $task -Confirm:$false }`, true);
    fs.rmSync(ctx.configurationFile, { force: true });
    return '后台服务已卸载，历史日志保留。';
  }
  return logs(ctx);
}

async function manageService(action, options = {}) {
  const requested = String(action || '').trim().toLowerCase();
  if (!ACTIONS.has(requested)) throw new ServiceError(`未知后台服务命令: ${action || '(empty)'}`);
  const normalized = requested === 'start' ? 'install' : requested;
  const ctx = context(options);
  if (normalized === 'logs') return logs(ctx);
  if (ctx.platform === 'darwin') return macService(normalized, ctx);
  if (ctx.platform === 'linux') return linuxService(normalized, ctx);
  if (ctx.platform === 'win32') return windowsService(normalized, ctx);
  throw new ServiceError(`当前操作系统不支持后台服务: ${ctx.platform}`);
}

module.exports = {
  ACTIONS,
  DEFAULT_SERVICE_NAME,
  ServiceError,
  context,
  launchAgentBody,
  launchAgentLabel,
  logs,
  manageService,
  powershellEncoded,
  serviceEnvironment,
  serviceName,
  systemdPath,
  systemdUnitBody,
  windowsInstallScript
};
