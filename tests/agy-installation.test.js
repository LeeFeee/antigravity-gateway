'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_AGY_COMMAND, resolveAgyCommand } = require('../src/agy-installation');

test('default CLI command is portable and resolved from PATH', () => {
  assert.equal(DEFAULT_AGY_COMMAND, 'agy');
  assert.equal(resolveAgyCommand('/custom/bin/agy'), '/custom/bin/agy');
});

test('Windows CLI resolution finds the official LOCALAPPDATA installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-windows-cli-test-'));
  const binary = path.join(root, 'agy', 'bin', 'agy.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'test');
  assert.equal(resolveAgyCommand('', {
    platform: 'win32',
    env: { LOCALAPPDATA: root },
    homeDir: path.join(root, 'home')
  }), binary);
  fs.rmSync(root, { recursive: true, force: true });
});
