'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgyWorker, DEFAULT_AGY_COMMAND, getVersion, listModels, redactDiagnostic, resolveAgyCommand, safeChildEnv, usageDelta } = require('../src/agy-worker');

const fakeAgy = path.join(__dirname, 'fixtures', 'fake-agy.js');

function makeWorker(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-worker-test-'));
  const worker = new AgyWorker({
    agyPath: process.execPath,
    prefixArgs: [fakeAgy],
    model: 'gemini-test-high',
    cwd: path.join(root, 'workspace'),
    logFile: path.join(root, 'log', 'agy.log'),
    timeoutMs: 2000,
    ...overrides
  });
  t.after(async () => { await worker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return worker;
}

test('listModels filters output and getVersion reads the CLI', async () => {
  assert.deepEqual(await listModels({ agyPath: process.execPath, prefixArgs: [fakeAgy] }), ['gemini-test-high', 'gemini-test-low']);
  assert.equal(await getVersion({ agyPath: process.execPath, prefixArgs: [fakeAgy] }), '9.9.9-test');
});

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

test('worker preserves a process across turns and converts cumulative usage to deltas', async (t) => {
  const worker = makeWorker(t);
  const deltas = [];
  const first = await worker.send('ONE', { onDelta: (delta) => deltas.push(delta) });
  const second = await worker.send('TWO');
  assert.equal(first.text, 'hello-1');
  assert.deepEqual(deltas, ['hel', 'lo-1']);
  assert.equal(first.conversationId, 'conversation-test-1');
  assert.deepEqual(first.usage, { input_tokens: 100, output_tokens: 10, thinking_tokens: 2, cache_read_tokens: 3, total_tokens: 112 });
  assert.deepEqual(second.usage, { input_tokens: 100, output_tokens: 10, thinking_tokens: 2, cache_read_tokens: 3, total_tokens: 112 });
});

test('worker reports upstream errors', async (t) => {
  const worker = makeWorker(t);
  await assert.rejects(worker.send('FAIL'), (error) => error.code === 'agy_upstream_error' && /失败/.test(error.message));
});

test('worker marks Antigravity internal tool use', async (t) => {
  const worker = makeWorker(t);
  const result = await worker.send('INTERNAL_TOOL');
  assert.equal(result.internalToolUsed, true);
});

test('worker times out and terminates its child', async (t) => {
  const worker = makeWorker(t, { timeoutMs: 50 });
  await assert.rejects(worker.send('TIMEOUT'), (error) => error.code === 'agy_timeout');
});

test('diagnostics redact tokens and usageDelta never goes negative', () => {
  assert.doesNotMatch(redactDiagnostic('Authorization: Bearer secret-value access_token=abc api_key=xyz client_secret=hidden'), /secret-value|=abc|=xyz|=hidden/);
  assert.deepEqual(usageDelta({ input_tokens: 2 }, { input_tokens: 5 }), {
    input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0
  });
});

test('child environment excludes unrelated credentials', () => {
  const env = safeChildEnv({ HOME: '/tmp/home', PATH: '/bin', OPENAI_API_KEY: 'secret', ANTIGRAVITY_GATEWAY_API_KEY: 'secret2' });
  assert.deepEqual(env, { HOME: '/tmp/home', PATH: '/bin' });
});

test('Windows child environment preserves OS and agy profile paths but excludes credentials', () => {
  const env = safeChildEnv({
    PATH: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\test',
    APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    OPENAI_API_KEY: 'secret'
  }, 'win32');
  assert.equal(env.USERPROFILE, 'C:\\Users\\test');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\test\\AppData\\Local');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.OPENAI_API_KEY, undefined);
});
