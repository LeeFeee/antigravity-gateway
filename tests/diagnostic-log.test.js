'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DiagnosticLog, errorDetails, maskEmail } = require('../src/diagnostic-log');

test('diagnostic log writes timestamped JSONL and redacts credentials', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = new DiagnosticLog({ directory, now: () => Date.parse('2026-10-05T14:00:00.000Z') });
  logger.write('auth_failed', {
    account: maskEmail('someone@example.com'),
    message: 'authorization=secret-value Bearer abc.def.ghi',
    nested: { refresh_token: 'refresh-secret' }
  });
  const record = JSON.parse(fs.readFileSync(logger.file, 'utf8').trim());
  assert.equal(record.at, '2026-10-05T14:00:00.000Z');
  assert.equal(record.event, 'auth_failed');
  assert.equal(record.account, 's***e@e***.com');
  assert.doesNotMatch(JSON.stringify(record), /secret-value|abc\.def\.ghi|refresh-secret/);
  assert.match(record.message, /\[REDACTED\]/);
});

test('diagnostic error details exclude stacks and redact token-shaped values', () => {
  const error = Object.assign(new Error('refresh_token=very-secret failed'), {
    code: 'refresh_failed',
    status: 401,
    details: 'Bearer header-secret'
  });
  const details = errorDetails(error);
  assert.equal(details.errorCode, 'refresh_failed');
  assert.equal(details.status, 401);
  assert.doesNotMatch(JSON.stringify(details), /very-secret|header-secret/);
  assert.equal(Object.prototype.hasOwnProperty.call(details, 'stack'), false);
});

test('diagnostic log rotates without changing the caller outcome', () => {
  const calls = [];
  const fsImpl = {
    mkdirSync: () => {},
    statSync: () => ({ size: 128 * 1024 }),
    rmSync: (...args) => calls.push(['rm', ...args]),
    renameSync: (...args) => calls.push(['rename', ...args]),
    appendFileSync: (...args) => calls.push(['append', ...args])
  };
  const logger = new DiagnosticLog({ directory: '/diagnostics', fsImpl, maxBytes: 64 * 1024 });
  assert.doesNotThrow(() => logger.write('rotation_test', { ok: true }));
  assert.deepEqual(calls.map(([name]) => name), ['rm', 'rename', 'append']);
});
