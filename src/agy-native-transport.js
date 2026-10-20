'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const BRIDGE_PROTOCOL = 1;

class NativeTransportError extends Error {
  constructor(message, code = 'native_transport_error', options) {
    super(message, options);
    this.name = 'NativeTransportError';
    this.code = code;
  }
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function resolveNativeBinary({ platform = process.platform, arch = process.arch,
  packageDir = path.resolve(__dirname, '..'), cacheDir, binaryPath = process.env.ANTIGRAVITY_NATIVE_TRANSPORT_PATH } = {}) {
  if (binaryPath) return path.resolve(binaryPath);
  const directory = path.join(packageDir, 'native', 'bin');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')); }
  catch (cause) {
    throw new NativeTransportError('原生传输文件缺失，请重新安装完整的网关安装包。', 'native_transport_missing', { cause });
  }
  const entry = manifest.platforms?.[`${platform}-${arch}`];
  if (!entry || manifest.protocol !== BRIDGE_PROTOCOL || !/^[a-z0-9._-]+\.gz$/.test(entry.file || '')
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !/^[a-f0-9]{64}$/.test(entry.compressedSha256 || '')) {
    throw new NativeTransportError(`没有适用于 ${platform}/${arch} 的原生传输文件。`, 'native_transport_unsupported');
  }
  const base = cacheDir || path.join(process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR || path.join(os.homedir(), '.antigravity-gateway'), 'native');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const target = path.join(base, `agy-transport-${entry.sha256.slice(0, 20)}${platform === 'win32' ? '.exe' : ''}`);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile() && !stat.isSymbolicLink() && sha256(fs.readFileSync(target)) === entry.sha256) return target;
    throw new NativeTransportError('原生传输缓存完整性校验失败。', 'native_transport_integrity');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const compressed = fs.readFileSync(path.join(directory, entry.file));
  if (sha256(compressed) !== entry.compressedSha256) {
    throw new NativeTransportError('安装包中的原生传输文件校验失败。', 'native_transport_integrity');
  }
  const binary = zlib.gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
  if (sha256(binary) !== entry.sha256) throw new NativeTransportError('原生传输解压校验失败。', 'native_transport_integrity');
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, binary, { mode: 0o700, flag: 'wx' });
    try { fs.renameSync(temporary, target); }
    catch (error) {
      // Windows can reject replacing an executable already opened by another
      // gateway process. A concurrent extractor is safe only if it produced
      // the same verified regular file, never a symlink or different binary.
      let identical = false;
      try {
        const stat = fs.lstatSync(target);
        identical = stat.isFile() && !stat.isSymbolicLink() && sha256(fs.readFileSync(target)) === entry.sha256;
      } catch { /* preserve the original extraction error */ }
      if (!identical) throw error;
    }
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return target;
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The request was aborted.', 'AbortError');
}

class AgyNativeTransport {
  constructor({ binaryPath, env = process.env, spawnImpl = spawn, binaryResolver = resolveNativeBinary,
    startupTimeoutMs = 10000 } = {}) {
    this.binaryPath = binaryPath;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.binaryResolver = binaryResolver;
    this.startupTimeoutMs = startupTimeoutMs;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.exitHandler = () => this.child?.kill();
    process.once('exit', this.exitHandler);
  }

  reference(active) {
    const method = active ? 'ref' : 'unref';
    this.child?.[method]?.();
    this.child?.stdin?.[method]?.();
    this.child?.stdout?.[method]?.();
    this.child?.stderr?.[method]?.();
  }

  async start() {
    if (this.closed) throw new NativeTransportError('原生传输已关闭。', 'native_transport_closed');
    if (this.starting) return this.starting;
    const binary = this.binaryPath || this.binaryResolver();
    const child = this.spawnImpl(binary, [], { env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    this.starting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new NativeTransportError('原生传输启动超时。', 'native_transport_start_timeout'));
        child.kill();
      }, this.startupTimeoutMs);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
        if (this.child === child) {
          this.child = null;
          this.starting = null;
          for (const id of [...this.pending.keys()]) this.fail(id, error);
        }
      };
      child.on('error', cause => fail(new NativeTransportError('无法启动原生传输。', 'native_transport_start_failed', { cause })));
      child.on('exit', () => fail(new NativeTransportError('原生传输进程退出。', 'native_transport_exited')));
      child.stdin.on('error', () => fail(new NativeTransportError('原生传输管道已关闭。', 'native_transport_pipe_closed')));
      child.stderr.on('data', () => { /* Do not mirror potentially sensitive child diagnostics. */ });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          if (index > MAX_EVENT_BYTES) { child.kill(); return; }
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          let value;
          try { value = JSON.parse(line); } catch { child.kill(); return; }
          if (value.type === 'ready') {
            if (value.protocol !== BRIDGE_PROTOCOL) { child.kill(); return; }
            clearTimeout(timer);
            this.reference(this.pending.size > 0);
            resolve();
          } else {
            try { this.onEvent(value); }
            catch (cause) {
              this.fail(value.id, new NativeTransportError('原生传输响应无效。', 'native_transport_protocol_error', { cause }));
              this.write({ type: 'cancel', id: value.id });
            }
          }
        }
        if (this.buffer.length > MAX_EVENT_BYTES) child.kill();
      });
    });
    return this.starting;
  }

  write(command) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  finish(id) {
    const state = this.pending.get(id);
    if (!state) return;
    state.signal?.removeEventListener('abort', state.abort);
    this.pending.delete(id);
    this.reference(this.pending.size > 0);
    return state;
  }

  fail(id, error) {
    const state = this.finish(id);
    if (!state) return;
    // A malformed header event can create a controller before Response itself
    // is constructed. Reject the fetch as well, so that case cannot hang.
    state.reject(error);
    if (state.controller) state.controller.error(error);
  }

  onEvent(value) {
    const state = this.pending.get(value.id);
    if (!state) return;
    if (value.type === 'headers') {
      if (state.controller) throw new Error('duplicate response headers');
      const stream = new ReadableStream({
        start: controller => { state.controller = controller; },
        pull: () => {
          if (!state.credit && this.pending.has(value.id)) {
            state.credit = true;
            this.write({ type: 'credit', id: value.id });
          }
        },
        cancel: () => { this.write({ type: 'cancel', id: value.id }); this.finish(value.id); }
      }, { highWaterMark: 1 });
      const headers = new Headers();
      for (const [key, values] of Object.entries(value.headers || {})) for (const item of values) headers.append(key, item);
      const noBody = [101, 204, 205, 304].includes(value.status) || state.method === 'HEAD';
      const response = new Response(noBody ? null : stream, { status: value.status, statusText: value.statusText, headers });
      state.resolve(response);
      if (noBody) { this.write({ type: 'cancel', id: value.id }); this.finish(value.id); state.controller.close(); }
    } else if (value.type === 'data') {
      if (!state.controller || !state.credit || typeof value.data !== 'string') throw new Error('unexpected body chunk');
      state.credit = false;
      state.controller.enqueue(Buffer.from(value.data, 'base64'));
    } else if (value.type === 'end') {
      const done = this.finish(value.id);
      if (!done?.controller) throw new Error('response ended before headers');
      done.controller.close();
    } else if (value.type === 'error') {
      this.fail(value.id, new NativeTransportError(value.error || '原生上游请求失败。', value.code || 'native_transport_error'));
    } else throw new Error('unknown transport event');
  }

  async fetch(url, { method = 'GET', headers: inputHeaders, body = '', signal } = {}) {
    if (signal?.aborted) throw abortError(signal);
    await this.start();
    if (signal?.aborted) throw abortError(signal);
    const id = crypto.randomUUID();
    const headers = Object.fromEntries(new Headers(inputHeaders));
    // These are implementation-generated Node/fetch headers, not application
    // requirements. Go supplies the captured gzip and chunked framing itself.
    for (const key of ['accept', 'accept-language', 'sec-fetch-mode', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']) delete headers[key];
    const data = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString()
      : Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : null;
    if (data === null) throw new NativeTransportError('原生传输要求文本请求体。', 'native_transport_body_type');
    return new Promise((resolve, reject) => {
      const state = { resolve, reject, signal, method: method.toUpperCase(), credit: false, controller: null };
      state.abort = () => { this.write({ type: 'cancel', id }); this.fail(id, abortError(signal)); };
      this.pending.set(id, state);
      this.reference(true);
      signal?.addEventListener('abort', state.abort, { once: true });
      if (signal?.aborted) { state.abort(); return; }
      if (!this.write({ type: 'request', id, url: String(url), method: state.method, headers, body: data })) {
        this.fail(id, new NativeTransportError('原生传输不可用。', 'native_transport_exited'));
      }
    });
  }

  close() {
    this.closed = true;
    process.removeListener('exit', this.exitHandler);
    for (const id of [...this.pending.keys()]) this.fail(id, new NativeTransportError('原生传输已关闭。', 'native_transport_closed'));
    this.child?.stdin.end();
    this.child?.kill();
  }
}

let sharedTransport;
function nativeCloudCodeFetch(url, options) {
  const parsed = new URL(url);
  // Gemini App/Robin, OAuth and unrelated HTTP requests keep their existing
  // implementation. Only the Cloud Code origin uses this native transport.
  if (!/^(daily-)?cloudcode-pa\.googleapis\.com$/.test(parsed.hostname)) return globalThis.fetch(url, options);
  sharedTransport ||= new AgyNativeTransport();
  return sharedTransport.fetch(url, options);
}

function closeNativeTransport() { sharedTransport?.close(); sharedTransport = undefined; }

module.exports = { AgyNativeTransport, NativeTransportError, nativeCloudCodeFetch, resolveNativeBinary, closeNativeTransport };
