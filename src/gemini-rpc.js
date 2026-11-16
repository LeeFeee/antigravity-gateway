'use strict';

const http2 = require('node:http2');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');

const GRPC_HTTP_STATUS = { 1: 499, 3: 400, 4: 504, 5: 404, 6: 409, 7: 403, 8: 429, 9: 409, 10: 409, 11: 400, 12: 501, 13: 502, 14: 503, 15: 502, 16: 401 };

class GeminiRpcError extends Error {
  constructor(message, { code = 'gemini_rpc_error', grpcStatus, httpStatus, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GeminiRpcError';
    this.code = code;
    this.grpcStatus = grpcStatus;
    this.upstreamHttpStatus = httpStatus;
    this.status = GRPC_HTTP_STATUS[grpcStatus] || (httpStatus >= 400 ? httpStatus : 502);
  }
}

function frame(message, maxBytes) {
  if (!(message instanceof Uint8Array)) throw new TypeError('Gemini RPC message must be bytes');
  if (message.byteLength > maxBytes) throw new RangeError('Gemini RPC request exceeds message limit');
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(message.byteLength, 1);
  return Buffer.concat([prefix, message]);
}

function messageText(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { return String(value || ''); }
}

class GeminiRpcTransport {
  constructor({ credentials, requestHeaders, origin = 'https://robinfrontend-pa.googleapis.com', timeoutMs = 120000, maxMessageBytes = 64 * 1024 * 1024, maxResponseBytes = 128 * 1024 * 1024, maxMessages = 65536 } = {}) {
    if (typeof credentials !== 'function' || typeof requestHeaders !== 'function') throw new TypeError('Gemini RPC requires credentials and requestHeaders providers');
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new TypeError('Gemini RPC origin must be an HTTPS origin');
    for (const value of [timeoutMs, maxMessageBytes, maxResponseBytes, maxMessages]) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid Gemini RPC limit');
    this.credentials = credentials;
    this.requestHeaders = requestHeaders;
    this.origin = url.origin;
    this.timeoutMs = timeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.maxMessages = maxMessages;
  }

  async open(method, { signal, onMessage = () => {}, timeoutMs = this.timeoutMs, service = 'robin' } = {}) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new TypeError('Invalid Gemini RPC method');
    const serviceName = { robin: 'assistant.mobile.robin.RobinService', notify: 'assistant.mobile.robin.notify.GeminiNotifyService' }[service];
    if (!serviceName) throw new TypeError('Unknown Gemini RPC service');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid Gemini RPC timeout');
    signal?.throwIfAborted();
    const credentials = await this.credentials({ signal });
    const profileHeaders = await this.requestHeaders({ method, signal });
    signal?.throwIfAborted();
    if (!credentials?.accessToken) throw new GeminiRpcError('Gemini 账号缺少有效授权。', { code: 'gemini_auth_missing', grpcStatus: 16 });
    const headers = {};
    for (const [key, value] of Object.entries(profileHeaders || {})) {
      const name = key.toLowerCase();
      if (name.startsWith(':') || ['authorization', 'content-type', 'te', 'grpc-accept-encoding', 'x-server-token'].includes(name)) throw new TypeError(`Protected Gemini RPC header: ${name}`);
      headers[name] = value;
    }
    Object.assign(headers, {
      // Captured from Gemini 1.144.4.1467. The native gRPC transport uses
      // the service path directly; /$rpc was only a historical probe alias.
      ':path': `/${serviceName}/${method}`, ':method': 'POST',
      authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/grpc',
      te: 'trailers', 'grpc-accept-encoding': 'identity,gzip'
    });
    if (credentials.serverToken) headers['x-server-token'] = credentials.serverToken;
    const started = performance.now();
    const session = http2.connect(this.origin);
    let stream;
    try { stream = session.request(headers); }
    catch (error) { session.destroy(); throw error; }
    let resolveDone, rejectDone, settled = false, inputEnded = false, sawEnd = false;
    let receivedBytes = 0, decodedBytes = 0, messageCount = 0, buffer = Buffer.alloc(0), responseHeaders = {}, trailers = {};
    let callbacks = Promise.resolve(), firstByteMs = null, firstMessageMs = null;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // A caller may write several messages before awaiting completion.
    done.catch(() => {});
    const fail = error => finish(error instanceof Error ? error : new Error(String(error)));
    const aborted = () => fail(signal.reason instanceof Error ? signal.reason : new DOMException('Gemini RPC 已取消。', 'AbortError'));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (!stream.destroyed && !stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
      session.destroy();
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      const result = { httpStatus: Number(responseHeaders[':status'] || 0), headers: responseHeaders, trailers,
        grpcStatus: Number(trailers['grpc-status'] ?? responseHeaders['grpc-status']),
        messageCount, receivedBytes, decodedBytes, firstByteMs, firstMessageMs, elapsedMs: performance.now() - started };
      cleanup();
      if (error) rejectDone(error); else resolveDone(result);
    };
    const timer = setTimeout(() => fail(new GeminiRpcError('Gemini 上游请求超时。', { code: 'gemini_rpc_timeout', grpcStatus: 4 })), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    session.on('error', error => fail(new GeminiRpcError('Gemini 上游连接失败。', { code: 'gemini_transport_error', cause: error })));
    stream.on('error', error => fail(new GeminiRpcError('Gemini 上游流中断。', { code: 'gemini_transport_error', cause: error })));
    stream.on('response', value => { responseHeaders = value; });
    stream.on('trailers', value => { trailers = value; });
    stream.on('data', chunk => {
      if (settled) return;
      try {
        firstByteMs ??= performance.now() - started;
        receivedBytes += chunk.length;
        if (receivedBytes > this.maxResponseBytes) throw new GeminiRpcError('Gemini 上游响应超过大小限制。', { code: 'gemini_response_too_large' });
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        while (buffer.length >= 5) {
          const compressed = buffer[0], size = buffer.readUInt32BE(1);
          if (compressed > 1) throw new Error('Invalid gRPC compression flag');
          if (size > this.maxMessageBytes) throw new Error('gRPC message exceeds size limit');
          if (buffer.length < size + 5) break;
          let message = buffer.subarray(5, size + 5);
          buffer = buffer.subarray(size + 5);
          if (compressed) {
            if (responseHeaders['grpc-encoding'] !== 'gzip') throw new Error('Unsupported gRPC compression encoding');
            message = zlib.gunzipSync(message, { maxOutputLength: this.maxMessageBytes });
          }
          decodedBytes += message.length;
          if (decodedBytes > this.maxResponseBytes) throw new Error('Decoded gRPC response exceeds size limit');
          if (++messageCount > this.maxMessages) throw new Error('gRPC message count exceeds limit');
          firstMessageMs ??= performance.now() - started;
          callbacks = callbacks.then(() => { if (!settled) return onMessage(message); });
        }
        stream.pause();
        callbacks.then(() => { if (!settled) stream.resume(); }, fail);
      } catch (error) {
        fail(new GeminiRpcError('Gemini 上游响应格式无效。', { code: 'gemini_invalid_rpc_frame', cause: error }));
      }
    });
    stream.on('end', () => {
      sawEnd = true;
      callbacks.then(() => {
        if (settled) return;
        const httpStatus = Number(responseHeaders[':status'] || 0);
        const rawStatus = trailers['grpc-status'] ?? responseHeaders['grpc-status'];
        if (buffer.length) return fail(new GeminiRpcError('Gemini 上游响应被截断。', { code: 'gemini_truncated_rpc' }));
        if (httpStatus !== 200) return fail(new GeminiRpcError(`Gemini 上游返回 HTTP ${httpStatus}。`, { code: 'gemini_http_error', httpStatus }));
        if (rawStatus === undefined || !/^\d+$/.test(String(rawStatus))) return fail(new GeminiRpcError('Gemini 上游缺少最终 gRPC 状态。', { code: 'gemini_missing_rpc_status', httpStatus }));
        const grpcStatus = Number(rawStatus);
        if (grpcStatus !== 0) return fail(new GeminiRpcError(messageText(trailers['grpc-message'] ?? responseHeaders['grpc-message']) || `Gemini RPC 状态 ${grpcStatus}`, { code: 'gemini_upstream_error', grpcStatus, httpStatus }));
        finish();
      }, fail);
    });
    stream.on('close', () => { if (!sawEnd && !settled) fail(new GeminiRpcError('Gemini 上游连接在完成前关闭。', { code: 'gemini_truncated_rpc' })); });
    return {
      done,
      write: message => {
        if (settled || inputEnded) throw new GeminiRpcError('Gemini 请求流已关闭。', { code: 'gemini_rpc_closed' });
        stream.write(frame(message, this.maxMessageBytes));
      },
      end: () => { if (!settled && !inputEnded) { inputEnded = true; stream.end(); } },
      cancel: () => fail(new DOMException('Gemini RPC 已取消。', 'AbortError'))
    };
  }

  async request(method, message, options = {}) {
    const messages = [];
    const call = await this.open(method, { ...options, onMessage: value => {
      if (messages.length) throw new GeminiRpcError('Gemini 单次 RPC 返回了多条消息。', { code: 'gemini_invalid_unary_response' });
      messages.push(Buffer.from(value));
    } });
    try { call.write(message); call.end(); await call.done; }
    catch (error) { call.cancel(); throw error; }
    if (messages.length !== 1) throw new GeminiRpcError('Gemini 单次 RPC 未返回消息。', { code: 'gemini_empty_unary_response' });
    return messages[0];
  }
}

module.exports = { GeminiRpcTransport, GeminiRpcError };
