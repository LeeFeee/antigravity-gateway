'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function redactText(value) {
  return String(value || '')
    .replace(/(SAPISID(?:1P|3P)?HASH\s+)[a-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/((?:__Secure-(?:[13]P(?:SID(?:TS|CC)?|APISID)|STRP)|SAPISID|APISID|HSID|SSID|SIDCC|SID)["']?\s*[=:]\s*["']?)[^\s,;&}"']+/g, '$1[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|(?:robin[_-]?)?server[_-]?token|x-server-token)["']?\s*[=:]\s*["']?)[^\s,;&}"']+/gi, '$1[REDACTED]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[REDACTED_JWT]')
    .slice(0, 1200);
}

function errorDetails(error) {
  if (!error) return {};
  const schemaError = error.schemaWorker ? error : error.cause?.schemaWorker ? error.cause : null;
  if (schemaError) {
    const cause = schemaError.cause;
    const causeCode = /^(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+|MODULE_NOT_FOUND)$/.test(String(cause?.code || ''))
      ? String(cause.code).slice(0, 100) : '';
    return {
      errorName: 'SchemaContractError', errorCode: 'schema_worker_unavailable', status: 503,
      message: schemaError.schemaWorker.exitCode !== undefined && !cause ? 'Schema 校验线程已退出。' : 'Schema 校验线程异常退出。',
      details: causeCode === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Schema Worker 达到 V8 内存上限。' : '',
      causeName: /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError|SystemError)$/.test(cause?.name || '') ? cause.name : '',
      causeCode, schemaWorker: schemaWorkerMetadata(schemaError.schemaWorker)
    };
  }
  return {
    errorName: String(error.name || ''),
    errorCode: String(error.code || error.cause?.code || ''),
    status: Number(error.status) || 0,
    message: redactText(error.message || error),
    details: redactText(error.details || error.cause?.message || '')
  };
}

function schemaWorkerMetadata(value) {
  const result = {};
  for (const key of ['threadId', 'schemaBytes', 'exitCode']) {
    if (Number.isSafeInteger(value?.[key])) result[key] = value[key];
  }
  if (['busy', 'idle', 'startup'].includes(value?.phase)) result.phase = value.phase;
  if (['compile', 'validate'].includes(value?.operation)) result.operation = value.operation;
  if (/^[a-f0-9]{64}$/.test(value?.schemaSha256 || '')) result.schemaSha256 = value.schemaSha256;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value?.requestId || '')) result.requestId = value.requestId;
  const limits = {};
  for (const key of ['maxOldGenerationSizeMb', 'maxYoungGenerationSizeMb', 'stackSizeMb']) {
    if (Number.isSafeInteger(value?.limits?.[key]) && value.limits[key] > 0) limits[key] = value.limits[key];
  }
  result.limits = limits;
  return result;
}

function maskEmail(value) {
  const source = String(value || '').trim();
  const at = source.indexOf('@');
  if (at < 1) return source ? `${source.slice(0, 2)}***` : '';
  const local = source.slice(0, at);
  const domain = source.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const suffix = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}${local.length > 1 ? '***' + local.at(-1) : '***'}@${host[0] || '*'}***${suffix}`;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      /^(?:cookies?|set-cookie|geminiWindows|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|authorization|(?:robin[_-]?)?server[_-]?token|x-server-token)$/i.test(key)
        ? '[REDACTED]'
        : sanitizeValue(item, depth + 1)
    ]));
  }
  return redactText(value);
}

class DiagnosticLog {
  constructor({ directory, fsImpl = fs, now = () => Date.now(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.fs = fsImpl;
    this.now = now;
    this.directory = directory;
    this.file = path.join(directory, 'auth-diagnostics.jsonl');
    this.rotatedFile = `${this.file}.1`;
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
  }

  rotateIfNeeded(extraBytes) {
    let size = 0;
    try { size = this.fs.statSync(this.file).size; } catch { /* a new log has no size yet */ }
    if (size + extraBytes <= this.maxBytes) return;
    try { this.fs.rmSync(this.rotatedFile, { force: true }); } catch { /* best effort */ }
    try { this.fs.renameSync(this.file, this.rotatedFile); } catch { /* best effort */ }
  }

  write(event, fields = {}) {
    try {
      this.fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const record = {
        at: new Date(this.now()).toISOString(),
        event: String(event || 'diagnostic'),
        ...sanitizeValue(fields)
      };
      const line = `${JSON.stringify(record)}\n`;
      this.rotateIfNeeded(Buffer.byteLength(line));
      this.fs.appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Diagnostics must never change gateway behavior or request outcomes.
    }
  }
}

module.exports = { DiagnosticLog, errorDetails, maskEmail, redactText };
