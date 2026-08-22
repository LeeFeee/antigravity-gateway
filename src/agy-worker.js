'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DEFAULT_AGY_COMMAND = 'agy';

function resolveAgyCommand(explicitPath) {
  if (explicitPath) return explicitPath;
  const candidates = process.platform === 'win32'
    ? [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
      ]
    : [path.join(require('node:os').homedir(), '.local', 'bin', 'agy')];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || DEFAULT_AGY_COMMAND;
}

class AgyError extends Error {
  constructor(message, { code = 'agy_error', status = 502, cause, details } = {}) {
    super(message, { cause });
    this.name = 'AgyError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function redactDiagnostic(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:access|refresh|id|session|auth)[_-]?token["']?\s*[:=]\s*["']?)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|apiKey|client[_-]?secret|password|cookie|authorization)["']?\s*[:=]\s*["']?)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(-2000);
}

function safeChildEnv(source = process.env) {
  const allowed = [
    'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'
  ];
  return Object.fromEntries(allowed.filter((key) => source[key] != null).map((key) => [key, source[key]]));
}

function usageDelta(current = {}, previous = {}) {
  const keys = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
  return Object.fromEntries(keys.map((key) => [key, Math.max(0, Number(current[key] || 0) - Number(previous[key] || 0))]));
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...options, env: options.env || safeChildEnv() }, (error, stdout, stderr) => {
      if (error) {
        reject(new AgyError('无法执行 Antigravity CLI。', {
          code: error.code === 'ENOENT' ? 'agy_not_found' : 'agy_command_failed',
          status: error.code === 'ENOENT' ? 503 : 502,
          cause: error,
          details: redactDiagnostic(stderr || error.message)
        }));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    // `agy models` waits for possible interactive input while stdin remains
    // open. It is a read-only command, so explicitly signal EOF.
    child.stdin?.end();
  });
}

async function listModels({ agyPath, prefixArgs = [], timeoutMs = 30000 } = {}) {
  const command = resolveAgyCommand(agyPath || process.env.ANTIGRAVITY_CLI_PATH);
  const { stdout } = await execFilePromise(command, [...prefixArgs, 'models'], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  const seen = new Set();
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.includes('\t') ? line.split('\t', 1)[0].trim() : line)
    .filter((line) => MODEL_SLUG.test(line))
    .filter((line) => !seen.has(line) && seen.add(line));
}

async function getVersion({ agyPath, prefixArgs = [], timeoutMs = 10000 } = {}) {
  const command = resolveAgyCommand(agyPath || process.env.ANTIGRAVITY_CLI_PATH);
  const { stdout } = await execFilePromise(command, [...prefixArgs, '--version'], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    windowsHide: true
  });
  return stdout.trim().split(/\r?\n/).find(Boolean) || 'unknown';
}

class AgyWorker {
  constructor({
    agyPath,
    prefixArgs = [],
    model,
    cwd,
    logFile,
    timeoutMs = 300000,
    maxOutputBytes = 16 * 1024 * 1024,
    spawnImpl = spawn
  } = {}) {
    if (!model || !MODEL_SLUG.test(model)) throw new AgyError(`无效模型 ID: ${model || '(empty)'}`, { code: 'invalid_model', status: 400 });
    this.agyPath = resolveAgyCommand(agyPath || process.env.ANTIGRAVITY_CLI_PATH);
    this.prefixArgs = prefixArgs;
    this.model = model;
    this.cwd = cwd;
    this.logFile = logFile;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.current = null;
    this.queue = Promise.resolve();
    this.closed = false;
    this.conversationId = null;
    this.lastUsage = {};
    this.closePromise = null;
  }

  start() {
    if (this.child) return;
    if (this.closed) throw new AgyError('Antigravity Worker 已关闭。', { code: 'worker_closed' });
    fs.mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
    const args = [
      ...this.prefixArgs,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', this.model,
      '--mode', 'plan',
      '--sandbox',
      '--log-file', this.logFile
    ];
    if (args.includes('--dangerously-skip-permissions')) {
      throw new AgyError('安全策略禁止 --dangerously-skip-permissions。', { code: 'unsafe_flag', status: 500 });
    }
    this.child = this.spawnImpl(this.agyPath, args, {
      cwd: this.cwd,
      env: safeChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = redactDiagnostic(`${this.stderr} ${chunk}`);
    });
    this.child.on('error', (error) => this._failCurrent(new AgyError('无法启动 Antigravity CLI。', {
      code: error.code === 'ENOENT' ? 'agy_not_found' : 'agy_spawn_failed',
      status: error.code === 'ENOENT' ? 503 : 502,
      cause: error,
      details: redactDiagnostic(error.message)
    })));
    this.child.on('exit', (code, signal) => {
      const expected = this.closed;
      this.child = null;
      if (this.current && !expected) {
        this._failCurrent(new AgyError('Antigravity CLI 在返回结果前退出。', {
          code: 'agy_exited',
          status: 502,
          details: this.stderr || `exit=${code} signal=${signal || 'none'}`
        }));
      }
    });
  }

  send(content, { signal, onDelta } = {}) {
    const run = () => this._sendNow(content, { signal, onDelta });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  _sendNow(content, { signal, onDelta } = {}) {
    if (typeof content !== 'string' || !content.trim()) {
      return Promise.reject(new AgyError('发送给 Antigravity 的内容不能为空。', { code: 'empty_prompt', status: 400 }));
    }
    if (signal?.aborted) return Promise.reject(new AgyError('请求已取消。', { code: 'request_aborted', status: 499 }));
    this.start();
    return new Promise((resolve, reject) => {
      const request = {
        resolve,
        reject,
        text: '',
        onDelta,
        internalToolUsed: false,
        timer: null,
        abortHandler: null,
        outputBytes: 0
      };
      request.timer = setTimeout(() => {
        this._failCurrent(new AgyError('Antigravity 模型响应超时。', { code: 'agy_timeout', status: 504, details: this.stderr }));
        this.close();
      }, this.timeoutMs);
      request.abortHandler = () => {
        this._failCurrent(new AgyError('客户端已取消请求。', { code: 'request_aborted', status: 499 }));
        this.close();
      };
      signal?.addEventListener('abort', request.abortHandler, { once: true });
      request.signal = signal;
      this.current = request;
      const line = JSON.stringify({ event: 'user', message: { content } }) + '\n';
      this.child.stdin.write(line, (error) => {
        if (error) this._failCurrent(new AgyError('无法向 Antigravity CLI 写入请求。', { code: 'agy_stdin_failed', cause: error }));
      });
    });
  }

  _onStdout(chunk) {
    if (this.current) {
      this.current.outputBytes += Buffer.byteLength(chunk);
      if (this.current.outputBytes > this.maxOutputBytes) {
        this._failCurrent(new AgyError('Antigravity CLI 输出超过安全上限。', { code: 'agy_output_too_large', status: 502 }));
        void this.close();
        return;
      }
    }
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this._onEvent(event);
    }
  }

  _onEvent(event) {
    if (event.event === 'init') {
      this.conversationId = event.conversation_id || event.init?.conversation_id || this.conversationId;
      return;
    }
    const current = this.current;
    if (!current) return;
    if (event.event === 'step_update') {
      const step = event.step_update || {};
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
        current.text += step.text_delta;
        if (current.onDelta) current.onDelta(step.text_delta, step);
      }
      if (step.step_type === 'tool' || step.tool_info) current.internalToolUsed = true;
      return;
    }
    if (event.event !== 'result') return;
    const result = event.result || {};
    if (result.conversation_id) this.conversationId = result.conversation_id;
    const deltaUsage = usageDelta(result.usage, this.lastUsage);
    this.lastUsage = { ...(result.usage || this.lastUsage) };
    if (result.status !== 'SUCCESS') {
      this._failCurrent(new AgyError('Antigravity 模型请求失败。', {
        code: 'agy_upstream_error',
        status: 502,
        details: redactDiagnostic(result.error || this.stderr || result.status)
      }));
      return;
    }
    this._finishCurrent({
      text: typeof result.response === 'string' ? result.response : current.text,
      streamedText: current.text,
      conversationId: this.conversationId,
      usage: deltaUsage,
      cumulativeUsage: result.usage || {},
      structuredOutput: result.structured_output,
      internalToolUsed: current.internalToolUsed,
      rawStatus: result.status
    });
  }

  _cleanupCurrent() {
    const current = this.current;
    if (!current) return null;
    clearTimeout(current.timer);
    current.signal?.removeEventListener('abort', current.abortHandler);
    this.current = null;
    return current;
  }

  _finishCurrent(value) {
    const current = this._cleanupCurrent();
    current?.resolve(value);
  }

  _failCurrent(error) {
    const current = this._cleanupCurrent();
    current?.reject(error);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return Promise.resolve();
    this.closePromise = new Promise((resolve) => {
      let finished = false;
      let forceTimer;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const signal = (name) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
          else child.kill(name);
        } catch { /* process already exited */ }
      };
      child.once('close', finish);
      child.stdin.end();
      signal('SIGTERM');
      forceTimer = setTimeout(() => { signal('SIGKILL'); finish(); }, 1500);
      forceTimer.unref?.();
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
    return this.closePromise;
  }
}

module.exports = {
  AgyError,
  AgyWorker,
  DEFAULT_AGY_COMMAND,
  MODEL_SLUG,
  getVersion,
  listModels,
  redactDiagnostic,
  resolveAgyCommand,
  safeChildEnv,
  usageDelta
};
