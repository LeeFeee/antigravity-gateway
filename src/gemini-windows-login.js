'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const WebSocket = require('ws');
const { normalizeCookies, fetchWindowsBootstrap } = require('./gemini-windows-auth');

function findLoginBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [env.ANTIGRAVITY_GEMINI_BROWSER];
  if (platform === 'win32') {
    for (const relative of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']) {
      for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)) {
        candidates.push(path.win32.join(root, relative));
      }
    }
  } else throw new Error('add-gemini-win 需要在 Windows 桌面运行；其他系统请使用原 add-gemini。');
  const browser = candidates.find(candidate => candidate && path.win32.isAbsolute(candidate)
    && /^(chrome|msedge)\.exe$/i.test(path.win32.basename(candidate)) && exists(candidate));
  if (!browser) throw new Error('未找到系统安装的完整 Chrome/Edge。请安装正式浏览器，或用 ANTIGRAVITY_GEMINI_BROWSER 指定 chrome.exe/msedge.exe 的完整路径。');
  return browser;
}

async function connectCdp(url, signal) {
  const target = new URL(url);
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw new Error('无效的本机浏览器调试地址。');
  const socket = new WebSocket(url, { maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const pending = new Map(); let sequence = 0;
  const rejectPending = error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  const close = () => {
    socket.terminate();
    rejectPending(new Error('Gemini 登录窗口已关闭。'));
  };
  // Keep an established control connection alive for Browser.close in finally.
  // Terminating it first leaves Edge running when its launcher has already exited.
  const abort = () => {
    rejectPending(signal.reason);
    if (socket.readyState !== WebSocket.OPEN) socket.terminate();
  };
  signal?.addEventListener('abort', abort, { once: true });
  socket.on('error', close);
  socket.on('close', () => { signal?.removeEventListener('abort', abort); close(); });
  socket.on('message', data => {
    let message; try { message = JSON.parse(data.toString()); } catch { return; }
    const wait = pending.get(message.id); if (!wait) return;
    pending.delete(message.id); clearTimeout(wait.timer);
    if (message.error) wait.reject(new Error(`浏览器授权读取失败：${message.error.message}`)); else wait.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('open', () => { signal?.removeEventListener('abort', onAbort); resolve(); });
    socket.once('error', reject); socket.once('close', () => reject(new Error('Gemini 登录窗口连接失败。')));
    if (signal?.aborted) onAbort();
  });
  return { close, send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error('Gemini 登录窗口已关闭。'));
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('读取 Gemini 登录窗口超时。')); }, 5000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}

async function accountFromWindowsCookies(cookies, { signal, authUser = '0', bootstrap = fetchWindowsBootstrap } = {}) {
  const record = await bootstrap(normalizeCookies(cookies), {
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]), authUser
  });
  const instanceId = crypto.randomUUID().toUpperCase();
  return { providerType: 'robin', accountType: 'gemini-app', authMethod: 'gemini-windows-session',
    subjectId: record.subjectId, email: record.email, source: 'gemini-windows-login', enabled: true,
    capabilities: ['gemini-4-argon'], providerMetadata: { geminiWindows: { cookies: record.cookies, authUser, instanceId } } };
}

function waitForBrowserExit(child, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      child.removeListener('exit', exited); child.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const exited = (code, exitSignal) => finish(code === 0 && !exitSignal ? null : new Error('登录浏览器异常退出，请重新执行 add-gemini-win。'));
    const failed = error => finish(error);
    const aborted = () => finish(signal.reason);
    child.once('exit', exited); child.once('error', failed); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (child.exitCode !== null && child.exitCode !== undefined) exited(child.exitCode);
  });
}

class GeminiWindowsLogin {
  constructor({ platform = process.platform, timeoutMs = 10 * 60_000, browserFinder = findLoginBrowser,
    spawnImpl = spawn, accountFactory = accountFromWindowsCookies } = {}) {
    this.platform = platform; this.timeoutMs = timeoutMs; this.browserFinder = browserFinder;
    this.spawn = spawnImpl; this.accountFactory = accountFactory; this.active = null;
  }
  cancel() { this.active?.controller.abort(new Error('已取消 Windows Gemini 授权。')); }
  async start({ onReady, onProgress } = {}) {
    if (this.active) throw new Error('已有 Windows Gemini 账号授权正在进行。');
    const controller = new AbortController(); this.active = { controller };
    const timeout = setTimeout(() => controller.abort(new Error('Windows Gemini 授权超时，请重新添加。')), this.timeoutMs);
    const signal = controller.signal;
    let child, cdp, profile;
    try {
      if (this.platform !== 'win32') throw new Error('请在 Windows 桌面执行 add-gemini-win。原 add-gemini OAuth 流程保持不变。');
      const browser = this.browserFinder({ platform: this.platform });
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gemini-login-'));
      fs.chmodSync(profile, 0o700);
      const commonArgs = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode'];
      // Human login runs in the installed, full browser WITHOUT debugging,
      // WebDriver, headless, automation-hiding flags or script injection.
      child = this.spawn(browser, [...commonArgs,
        '--new-window', 'https://gemini.google.com/app'], { stdio: 'ignore', windowsHide: false });
      child.once('error', error => controller.abort(error));
      onReady?.({ url: 'https://gemini.google.com/app', browserOpened: true, browser });
      await waitForBrowserExit(child, signal);
      signal.throwIfAborted();
      onProgress?.('登录窗口已关闭，正在读取并保存本次 Google 会话……');
      // Reopen ONLY this flow's profile on a blank page for local cookie export.
      // No Google sign-in page is controlled through CDP. The user's ordinary
      // Chrome/Edge profile and any running browser windows remain untouched.
      child = this.spawn(browser, [...commonArgs, '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--new-window', 'about:blank'], { stdio: 'ignore', windowsHide: false });
      child.once('error', error => controller.abort(error));
      const captureDeadline = Date.now() + 15000;
      const portFile = path.join(profile, 'DevToolsActivePort'); let port, route;
      while (!cdp) {
        signal.throwIfAborted();
        if (child.exitCode !== null) throw new Error('Gemini 登录窗口已退出。');
        if (Date.now() > captureDeadline) throw new Error('浏览器会话读取超时，请确认系统浏览器允许本机调试连接。');
        try {
          [port, route] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
          if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route)) {
            cdp = await connectCdp(`ws://127.0.0.1:${port}${route}`, signal);
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!cdp) await pause(300, undefined, { signal });
      }
      const { cookies } = await cdp.send('Storage.getCookies');
      signal.throwIfAborted();
      const account = await this.accountFactory(normalizeCookies(cookies), { signal });
      signal.throwIfAborted();
      return account;
    } finally {
      clearTimeout(timeout);
      // Close only the browser launched by this flow. No global taskkill names.
      if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); }
      if (child?.pid && child.exitCode === null) {
        if (this.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
        else child.kill();
      }
      try { if (profile) {
        // This exact directory was created by mkdtemp above and belongs solely
        // to this authorization attempt. It contains temporary login secrets.
        await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } } finally { if (this.active?.controller === controller) this.active = null; }
    }
  }
}

module.exports = { GeminiWindowsLogin, accountFromWindowsCookies, findLoginBrowser, connectCdp, waitForBrowserExit };
