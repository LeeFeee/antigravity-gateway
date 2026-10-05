'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function redactText(value) {
  return String(value || '')
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*[=:]\s*)[^\s,;&}]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[REDACTED_JWT]')
    .slice(0, 1200);
}

function errorDetails(error) {
  if (!error) return {};
  return {
    errorName: String(error.name || ''),
    errorCode: String(error.code || error.cause?.code || ''),
    status: Number(error.status) || 0,
    message: redactText(error.message || error),
    details: redactText(error.details || error.cause?.message || '')
  };
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
      /^(?:accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|authorization)$/i.test(key)
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
