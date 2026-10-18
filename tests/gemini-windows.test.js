'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AccountStore, normalizeAccount } = require('../src/account-store');
const { GeminiAccountStore } = require('../src/gemini-account-store');
const { robinAuthorizationKey, robinCredentialFingerprint } = require('../src/robin-auth');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { GeminiWindowsProvider, windowsGenerate, channelError, buildWindowsPrompt } = require('../src/gemini-windows-provider');
const { GeminiWindowsAuthProvider, normalizeCookies, parseBootstrap, windowsAuthorization,
  rotatedCookies, fetchWindowsBootstrap } = require('../src/gemini-windows-auth');
const { WebChannelDecoder, windowsInitialize, windowsMetadata, windowsResponse, WINDOWS_ARGON_VARIANT } = require('../src/gemini-windows-protocol');
const { accountFromWindowsCookies, findLoginBrowser, GeminiWindowsLogin } = require('../src/gemini-windows-login');
const { TerminalConsole } = require('../src/terminal-console');
const p = require('../src/robin-proto');

const cookies = [
  { name: 'SAPISID', value: 'test-sapisid', domain: '.google.com', expires: -1 },
  { name: '__Secure-1PSID', value: 'test-session', domain: '.google.com', expires: -1 }
];
const bootstrapData = { oPEP7c: 'windows@example.com', S06Grb: '12345', PI9WOb: 'test-server-token',
  d2zJAe: 'test-api-key', cfb2h: 'test-build', GK6dn: 'https://geminiweb-pa.clients6.google.com' };
const html = `window.WIZ_global_data = ${JSON.stringify(bootstrapData)};`;
const account = () => ({ providerType: 'robin', accountType: 'gemini-app', authMethod: 'gemini-windows-session',
  subjectId: '12345', email: 'windows@example.com', capabilities: ['gemini-4-argon'],
  providerMetadata: { geminiWindows: { cookies, instanceId: 'instance' } } });
const record = () => ({ ...parseBootstrap(html), cookies });
const frame = value => { const s = JSON.stringify(value); return Buffer.from(`${s.length}\n${s}`); };
const nest = (path, value) => path.reduceRight((data, n) => p.messageField(n, data), value);
const native = (text, { done = false, variant = WINDOWS_ARGON_VARIANT } = {}) => nest([2, 7, 1], p.concatFields([
  p.intField(1, done ? 1 : 0), nest([4, 4], p.concatFields([
    nest([5, 2], p.stringField(1, text)), p.intField(15, done ? 1 : 0), p.stringField(40, variant)
  ]))
]));

test('Windows WebChannel handles byte fragmentation and UTF-16 frame lengths', () => {
  const data = [[1, ['中文😀']], [2, ['noop']]]; const input = frame(data); const decoder = new WebChannelDecoder();
  const output = [];
  for (const byte of input) output.push(...decoder.push(Buffer.from([byte])));
  decoder.finish(); assert.deepEqual(output, data);
  assert.throws(() => new WebChannelDecoder().push(Buffer.from('wat\n')), /帧头/);
  assert.throws(() => new WebChannelDecoder({ maxFrameChars: 2 }).push(frame(data)), /超过限制/);
  const short = new WebChannelDecoder(); short.push(input.subarray(0, input.length - 1)); assert.throws(() => short.finish(), /截断/);
});

test('Windows payload uses the observed web model and never Mac device/surface metadata', () => {
  const input = windowsInitialize({ requestId: 'test-request' });
  assert.ok(input.includes(Buffer.from(WINDOWS_ARGON_VARIANT)));
  assert.ok(!input.includes(Buffer.from('GeminiMacOS')));
  const metadata = windowsMetadata({ requestId: 'r', instanceId: 'i', build: 'b' });
  const decoded = p.decodeFields(Buffer.from(metadata['x-goog-ext-525001261-bin'], 'base64'));
  assert.equal(p.stringValue(p.firstField(decoded, 5, 2)), WINDOWS_ARGON_VARIANT);
  assert.equal(p.firstField(decoded, 16), undefined); // No configurable thinking tiers.
  assert.deepEqual(windowsResponse(native('hello', { done: true })), { text: 'hello', done: true, modeVariantId: WINDOWS_ARGON_VARIANT });
  assert.deepEqual(windowsResponse(p.messageField(4, Buffer.alloc(0))), { closed: true });
});

test('Windows session imports only Google authentication cookies and rejects expired/foreign sessions', () => {
  assert.equal(normalizeCookies([...cookies, { name: 'SID', value: 'other', domain: 'example.com' }, { name: 'secret', value: 'other', domain: '.google.com' }]).length, 2);
  assert.throws(() => normalizeCookies(cookies.map(c => ({ ...c, expires: 1 }))), /不完整或已过期/);
  assert.throws(() => normalizeCookies(cookies.map(c => ({ ...c, value: 'header\ninjection' }))), /不完整/);
  assert.match(windowsAuthorization(cookies, 100000), /^SAPISIDHASH 100_[a-f0-9]{40}$/);
  const rotated = rotatedCookies(cookies, ['SAPISID=rotated; Domain=.google.com; Path=/; Max-Age=1000; Secure']);
  assert.equal(rotated.find(c => c.name === 'SAPISID').value, 'rotated');
  assert.equal(rotatedCookies(cookies, ['SAPISID=foreign; Domain=example.com; Path=/']).find(c => c.name === 'SAPISID').value, 'test-sapisid');
});

test('Windows bootstrap validates account and service without executing page scripts', () => {
  assert.equal(parseBootstrap(html).email, 'windows@example.com');
  assert.throws(() => parseBootstrap('window.WIZ_global_data={};'), /登录已失效/);
  assert.throws(() => parseBootstrap(html.replace('https://geminiweb-pa.clients6.google.com', 'https://example.com')), /未支持的服务地址/);
});

test('Windows bootstrap follows only same-origin redirects and bounds response headers', async () => {
  let calls = 0;
  const requestImpl = (url, options, callback) => {
    assert.equal(options.maxHeaderSize, 256 * 1024); assert.equal(url.origin, 'https://gemini.google.com');
    const req = new EventEmitter(); const res = new EventEmitter(); res.resume = () => {};
    calls++; res.statusCode = calls === 1 ? 302 : 200; res.headers = calls === 1 ? { location: '/app' } : {};
    queueMicrotask(() => { callback(res); if (res.statusCode === 200) { res.emit('data', Buffer.from(html)); res.emit('end'); } });
    return req;
  };
  assert.equal((await fetchWindowsBootstrap(cookies, { requestImpl })).subjectId, '12345');
  assert.equal(calls, 2);
  await assert.rejects(fetchWindowsBootstrap(cookies, { requestImpl: (url, options, callback) => {
    const req = new EventEmitter(); queueMicrotask(() => callback({ statusCode: 302, headers: { location: 'https://example.com/' }, resume() {} })); return req;
  } }), /HTTP 302/);
});

test('cookie-only accounts remain isolated from Cloud Code and credential rotation changes identity', () => {
  const value = normalizeAccount(account()); assert.ok(value);
  assert.equal(normalizeAccount({ ...account(), providerType: 'cloudcode' }), null);
  assert.equal(normalizeAccount({ ...account(), authMethod: 'gemini-oauth' }), null);
  const next = structuredClone(value); next.providerMetadata.geminiWindows.cookies[0].value = 'new';
  assert.notEqual(robinAuthorizationKey(value), robinAuthorizationKey(next));
  assert.notEqual(robinCredentialFingerprint(value), robinCredentialFingerprint(next));
});

test('Windows auth persists rotations, supports restart and never resurrects deleted accounts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-auth-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: dir, directoryName: 'robin-accounts' }); const saved = store.save(account());
  const changed = normalizeCookies(cookies.map(c => ({ ...c, value: c.value + '-rotated' })));
  const auth = new GeminiWindowsAuthProvider({ account: saved, store, bootstrap: async () => ({ ...record(), cookies: changed }) });
  const key = auth.authorizationKey; await auth.get();
  assert.equal(store.list()[0].providerMetadata.geminiWindows.cookies[0].value, changed[0].value);
  assert.ok(auth.matchesAuthorization(key, store.list()[0]));
  const pool = new RobinAccountPool({ store }); t.after(() => pool.stop());
  assert.ok(pool.entries.get(saved.id).provider instanceof GeminiWindowsProvider);
  const late = new GeminiWindowsAuthProvider({ account: store.list()[0], store, bootstrap: async () => { store.delete(saved.id); return record(); } });
  await assert.rejects(late.get(), /更换或删除/); assert.equal(store.list().length, 0);
});

function fakeChannel(reply = 'hello', variant = WINDOWS_ARGON_VARIANT) {
  const requests = []; let end;
  const fetchImpl = async (url, options) => {
    const u = new URL(url); requests.push({ url: u, options });
    if (options.body === 'count=0') return new Response(frame([[0, ['c', 'session', '', 8, 15, 30000]]]), { headers: { 'x-http-session-id': 'test-session' } });
    if (u.searchParams.get('RID') === 'rpc') {
      return new Response(new ReadableStream({ start(c) {
        end = () => { c.enqueue(frame([[3, [p.messageField(4, Buffer.alloc(0)).toString('base64')]]])); c.close(); };
        c.enqueue(frame([[1, [native(reply, { variant }).toString('base64')]]]));
        c.enqueue(frame([[2, [native(reply, { done: true, variant }).toString('base64')]]]));
      } }));
    }
    const body = new URLSearchParams(options.body);
    const data = Buffer.from(body.get('req0___data__'), 'base64');
    if (p.firstField(p.decodeFields(data), 4, 2)) end();
    return new Response('7\n[1,2,7]');
  };
  return { fetchImpl, requests };
}

test('Windows transport streams snapshots once, completes, and pins authentication destination', async () => {
  const fake = fakeChannel(); const deltas = [];
  const result = await windowsGenerate({ ...record(), endpoint: 'https://example.com/' }, 'hello', { fetchImpl: fake.fetchImpl, onDelta: d => deltas.push(d) });
  assert.equal(result.text, 'hello'); assert.equal(result.usageKnown, false); assert.equal(deltas.join(''), 'hello');
  assert.ok(fake.requests.every(r => r.url.origin === 'https://geminiweb-pa.clients6.google.com'));
  assert.ok(fake.requests.every(r => r.options.redirect === 'error'));
});

test('Windows transport refuses silent model downgrade and preserves upstream errors', async () => {
  const fake = fakeChannel('wrong model', 'other-variant');
  await assert.rejects(windowsGenerate(record(), 'test', { fetchImpl: fake.fetchImpl }), /拒绝静默降级/);
  const e = channelError({ __sm__: { status: [[{ error: { code: 412, message: 'Before proceeding, please accept our terms of service.' } }]] } });
  assert.equal(e.status, 412); assert.match(e.message, /please accept our terms/);
});

test('Windows completion does not wait for an open backchannel or its cancellation promise', async () => {
  const heldResponse = bytes => new Response(new ReadableStream({
    start(c) { c.enqueue(bytes); }, cancel() { return new Promise(() => {}); }
  }));
  const fetchImpl = async (_url, options) => {
    if (options.body === 'count=0') return heldResponse(frame([[0, ['c', 'session']]]));
    if (!options.method) return heldResponse(frame([[1, [native('DONE', { done: true }).toString('base64')]]]));
    return heldResponse(Buffer.from('7\n[1,2,3]'));
  };
  const result = await windowsGenerate(record(), 'test', { fetchImpl });
  assert.equal(result.text, 'DONE');
});

test('Windows compatibility tools are validated and never emitted as ordinary streaming text', async () => {
  const fake = fakeChannel('<ANTIGRAVITY_TOOL_CALLS>{"tool_calls":[{"name":"echo","arguments":{"value":"win"}}]}</ANTIGRAVITY_TOOL_CALLS>');
  const provider = new GeminiWindowsProvider({ auth: { get: async () => record() }, fetchImpl: fake.fetchImpl });
  const deltas = [];
  const result = await provider.send({ system: '', messages: [{ role: 'user', text: 'echo win' }],
    tools: [{ name: 'echo', schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] },
  'gemini-4-argon', { onDelta: d => deltas.push(d) });
  assert.equal(result.toolCalls[0].name, 'echo'); assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(deltas, []);
  await assert.rejects(provider.send({ messages: [{ parts: [{ type: 'media' }] }] }, 'gemini-4-argon'), /暂不支持附件/);
});

test('Windows function instructions describe external execution without impersonating a system contract', () => {
  const prompt = buildWindowsPrompt({ system: 'Use the available file tools.', messages: [{ role: 'user', text: 'Read my file' }],
    tools: [{ name: 'Read', schema: { type: 'object', properties: { file_path: { type: 'string' } } } }], toolChoice: 'required' });
  assert.doesNotMatch(prompt, /ANTIGRAVITY_CLI_COMPATIBILITY_CONTRACT|You are Antigravity|CLIENT_SYSTEM_BEGIN/);
  assert.match(prompt, /not changes to your service rules/); assert.match(prompt, /at least one available function/);
  assert.match(prompt, /file_path/); assert.match(prompt, /"role":"user","content":"Read my file"/);
});

test('Windows structured output is validated before streaming delivery', async () => {
  const normalized = { system: '', messages: [{ role: 'user', text: 'Return JSON' }], tools: [],
    structuredSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
  const good = new GeminiWindowsProvider({ auth: { get: async () => record() }, fetchImpl: fakeChannel('{"ok":true}').fetchImpl });
  const deltas = []; const result = await good.send(normalized, 'gemini-4-argon', { onDelta: d => deltas.push(d) });
  assert.deepEqual(JSON.parse(result.text), { ok: true }); assert.equal(deltas.join(''), result.text);
  const bad = new GeminiWindowsProvider({ auth: { get: async () => record() }, fetchImpl: fakeChannel('{"ok":"wrong"}').fetchImpl });
  await assert.rejects(bad.send(normalized, 'gemini-4-argon', { onDelta() { assert.fail('Invalid JSON leaked'); } }));
});

test('Windows repairs an undelivered tool envelope once without replaying a client call', async () => {
  let attempts = 0, channel;
  const fetchImpl = (url, options) => {
    if (options.body === 'count=0') channel = fakeChannel(++attempts === 1 ? 'I need a tool.' : '<ANTIGRAVITY_TOOL_CALLS>{"tool_calls":[{"name":"echo","arguments":{}}]}</ANTIGRAVITY_TOOL_CALLS>');
    return channel.fetchImpl(url, options);
  };
  const provider = new GeminiWindowsProvider({ auth: { get: async () => record() }, fetchImpl });
  const normalized = { system: '', messages: [{ role: 'user', text: 'echo' }], tools: [{ name: 'echo', schema: { type: 'object' } }], toolChoice: 'required' };
  const deltas = []; const result = await provider.send(normalized, 'gemini-4-argon', { onDelta: d => deltas.push(d) });
  assert.equal(attempts, 2); assert.equal(result.toolCalls.length, 1); assert.deepEqual(deltas, []);
  let failedAttempts = 0;
  const broken = new GeminiWindowsProvider({ auth: { get: async () => record() }, fetchImpl: (url, options) => {
    if (options.body === 'count=0') { failedAttempts++; channel = fakeChannel('no tool'); }
    return channel.fetchImpl(url, options);
  } });
  await assert.rejects(broken.send(normalized, 'gemini-4-argon'), error => error.code === 'invalid_tool_choice');
  assert.equal(failedAttempts, 2);
});

test('two Windows accounts rotate independently and retain affinity after cookie refresh', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-pool-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: dir, directoryName: 'robin-accounts' });
  store.save(account()); store.save({ ...account(), subjectId: '67890', email: 'second@example.com' });
  const pool = new RobinAccountPool({ store, providerFactory: saved => new GeminiWindowsProvider({
    auth: new GeminiWindowsAuthProvider({ account: saved, store, bootstrap: async () => ({ ...record(),
      email: saved.email, subjectId: saved.subjectId, cookies: normalizeCookies(cookies.map(c => ({ ...c, value: c.value + '-refresh' }))) }) }),
    fetchImpl: fakeChannel(saved.email).fetchImpl
  }) }); t.after(() => pool.stop());
  const normalized = { system: '', messages: [{ role: 'user', text: 'test' }], tools: [] };
  const first = await pool.send(normalized, 'gemini-4-argon', { sessionId: 'one', clientId: 'test' });
  const second = await pool.send(normalized, 'gemini-4-argon', { sessionId: 'two', clientId: 'test' });
  const again = await pool.send(normalized, 'gemini-4-argon', { sessionId: 'one', clientId: 'test' });
  assert.notEqual(first.text, second.text); assert.equal(first.text, again.text);
});

test('adding a Windows account does not route existing Robin attachments to an unsupported channel', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-mixed-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: dir, directoryName: 'robin-accounts' });
  store.save(account()); store.save({ ...account(), subjectId: 'oauth', email: 'oauth@example.com', authMethod: 'oauth', refreshToken: 'test-refresh' });
  const pool = new RobinAccountPool({ store, providerFactory: saved => ({ send: async () => {
    assert.equal(saved.authMethod, 'oauth'); return { text: 'attachment understood', toolCalls: [], usageKnown: false };
  } }) }); t.after(() => pool.stop());
  const result = await pool.send({ messages: [{ role: 'user', parts: [{ type: 'media', mimeType: 'image/png' }] }], tools: [] }, 'gemini-4-argon', { sessionId: 'mixed' });
  assert.equal(result.text, 'attachment understood');
});

test('Windows model substitution can fail over before delivery without claiming quota exhaustion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-failover-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: dir, directoryName: 'robin-accounts' });
  const first = store.save(account()); const second = store.save({ ...account(), subjectId: 'second', email: 'second@example.com' });
  const selected = [];
  const pool = new RobinAccountPool({ store, providerFactory: saved => ({ send: async () => {
    selected.push(saved.id);
    if (saved.id === first.id) throw Object.assign(new Error('different upstream variant'), { code: 'gemini_windows_model_mismatch', status: 409 });
    return { text: 'Argon response', toolCalls: [], usageKnown: false };
  } }) }); t.after(() => pool.stop()); pool.bind('new-request', first.id);
  const result = await pool.send({ messages: [{ role: 'user', text: 'test' }], tools: [] }, 'gemini-4-argon', { routingKey: 'new-request' });
  assert.equal(result.accountId, second.id); assert.deepEqual(selected, [first.id, second.id]);
  const health = store.list().find(a => a.id === first.id).providerMetadata.robinHealth;
  assert.equal(health.category, 'transient'); assert.equal(health.state, 'cooldown');
});

test('Windows model substitution never migrates an already issued client tool task', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-no-replay-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: dir, directoryName: 'robin-accounts' });
  const first = store.save(account()); store.save({ ...account(), subjectId: 'second', email: 'second@example.com' });
  let calls = 0;
  const pool = new RobinAccountPool({ store, providerFactory: saved => ({ send: async () => {
    assert.equal(saved.id, first.id);
    if (++calls === 1) return { text: '', toolCalls: [{ id: 'call-read', name: 'Read', arguments: {} }], usageKnown: false };
    throw Object.assign(new Error('different upstream variant'), { code: 'gemini_windows_model_mismatch', status: 409 });
  } }) }); t.after(() => pool.stop()); pool.bind('tool-task', first.id);
  const input = { messages: [{ role: 'user', text: 'test' }], tools: [] }, options = { sessionId: 'tool-task', routingKey: 'tool-task', clientId: 'test' };
  await pool.send(input, 'gemini-4-argon', options);
  await assert.rejects(pool.send(input, 'gemini-4-argon', options), error => error.code === 'gemini_windows_model_mismatch');
  assert.equal(calls, 2);
});

test('Windows login saves authenticated identity without spending inference quota', async () => {
  const created = await accountFromWindowsCookies(cookies, { bootstrap: async () => record(), generate: async () => assert.fail('No inference during login') });
  assert.equal(created.authMethod, 'gemini-windows-session');
  assert.ok(normalizeAccount(created));
  await assert.rejects(accountFromWindowsCookies(cookies, { bootstrap: async () => { throw new Error('login expired'); } }), /login expired/);
  assert.equal(findLoginBrowser({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => true }), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(findLoginBrowser({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: value => value.endsWith('msedge.exe') }), 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.throws(() => findLoginBrowser({ platform: 'win32', env: { ANTIGRAVITY_GEMINI_BROWSER: 'C:\\headless_shell.exe' }, exists: () => true }), /完整 Chrome\/Edge/);
  assert.throws(() => findLoginBrowser({ platform: 'darwin', env: {} }), /Windows 桌面/);
});

test('add-gemini preserves 1.5.1 OAuth and only add-gemini-win selects Windows login', async () => {
  const terminal = new TerminalConsole({ platform: 'win32' }); const selected = [];
  terminal.addWindowsAccount = async () => selected.push('windows');
  terminal.addRobinAccount = async () => selected.push('oauth');
  await terminal.handle('add-gemini'); await terminal.handle('add-gemini-win');
  terminal.platform = 'darwin'; await terminal.handle('add-gemini');
  assert.deepEqual(selected, ['oauth', 'windows', 'oauth']);
});

test('Windows credentials and OAuth for the same Google account coexist and route independently', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-terminal-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new GeminiAccountStore({ configDir: dir });
  const oauth = store.save({ ...account(), authMethod: 'gemini-oauth', refreshToken: 'test-refresh', providerMetadata: {} });
  const previous = store.windows.save({ ...account(), providerMetadata: { ...account().providerMetadata, robinHealth: { state: 'failed' } } });
  const other = store.windows.save({ ...account(), subjectId: 'other', email: 'other@example.com' });
  const oauthPath = path.join(store.oauth.directory, fs.readdirSync(store.oauth.directory)[0]);
  const before = fs.readFileSync(oauthPath);
  assert.notEqual(oauth.id, previous.id);
  let reloads = 0;
  const terminal = new TerminalConsole({ windowsLogin: { start: async () => account() },
    windowsAccountStore: store.windows, robinAccountStore: store.oauth,
    robinAccountPool: { reload() { reloads++; } }, output: { write() {} },
    commands: { models: async () => { throw new Error('Unrelated catalog is offline'); } } });
  await terminal.addWindowsAccount();
  const current = store.list().find(a => a.id === previous.id);
  assert.equal(current.createdAt, previous.createdAt); assert.equal(current.authMethod, 'gemini-windows-session');
  assert.equal(current.providerMetadata.robinQuota, undefined); assert.equal(current.providerMetadata.robinHealth, undefined);
  assert.equal(current.refreshToken, ''); assert.equal(current.accessToken, '');
  assert.ok(store.list().some(a => a.id === other.id)); assert.equal(reloads, 1); assert.equal(terminal.adding, '');
  assert.deepEqual(fs.readFileSync(oauthPath), before);
  const pool = new RobinAccountPool({ store }); t.after(() => pool.stop());
  assert.ok(pool.entries.get(current.id).provider instanceof GeminiWindowsProvider);
  assert.ok(!(pool.entries.get(oauth.id).provider instanceof GeminiWindowsProvider));
  store.update(current.id, { enabled: false, authMethod: 'gemini-oauth' });
  assert.equal(store.windows.list().find(a => a.id === current.id).authMethod, 'gemini-windows-session');
  assert.equal(store.windows.list().find(a => a.id === current.id).enabled, false);
  store.delete(current.id);
  assert.equal(store.windows.list().length, 1); assert.deepEqual(fs.readFileSync(oauthPath), before);
  assert.equal(pool.status().find(a => a.id === other.id).authMethod, 'gemini-windows-session');
});

test('failed or cancelled Windows login releases its lock and deletes only its own profile', async () => {
  let profile;
  const login = new GeminiWindowsLogin({ platform: 'win32', browserFinder: () => 'C:\\test-browser.exe',
    spawnImpl: (binary, args) => {
      profile = args.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      const child = new EventEmitter(); child.exitCode = 1; return child;
    } });
  await assert.rejects(login.start(), /异常退出/);
  assert.equal(login.active, null); assert.equal(fs.existsSync(profile), false);
  await assert.rejects(login.start(), /异常退出/); assert.equal(login.active, null);
  let cancelled = 0;
  const terminal = new TerminalConsole({ windowsLogin: { cancel() { cancelled++; } } });
  terminal.adding = 'windows'; await terminal.handle('cancel'); terminal.stop(); assert.equal(cancelled, 2);
});

test('Windows model catalog never contacts Google or performs inference', async () => {
  const provider = new GeminiWindowsProvider({ auth: { get: async () => assert.fail('No auth probe') } });
  provider.send = async () => assert.fail('No inference probe');
  assert.deepEqual(await provider.listModels(), ['gemini-4-argon']);
  provider.forgetConversations(); provider.stop();
  assert.deepEqual(await provider.listModels(), ['gemini-4-argon']);
  const controller = new AbortController(); controller.abort(new Error('cancel listing'));
  await assert.rejects(provider.listModels(controller.signal), /cancel listing/);
});

test('Windows HTTP terms errors retain the original upstream response', async () => {
  const body = '{"error":{"message":"Before proceeding, please accept our terms of service."}}';
  await assert.rejects(windowsGenerate(record(), 'test', { fetchImpl: async () => new Response(body, { status: 412 }) }),
    error => error.status === 412 && error.message === body);
});

test('dedicated Windows login reads only its own browser cookies and cleans up after success', async t => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => server.once('listening', r));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const methods = [], launches = []; let profile, child;
  server.on('connection', ws => ws.on('message', raw => {
    const { id, method } = JSON.parse(raw); methods.push(method);
    const result = method === 'Storage.getCookies' ? { cookies } : {};
    ws.send(JSON.stringify({ id, result }));
    if (method === 'Browser.close') child.exitCode = 0;
  }));
  const login = new GeminiWindowsLogin({ platform: 'win32', browserFinder: () => 'C:\\browser.exe',
    spawnImpl: (_binary, args) => {
      launches.push(args);
      const nextProfile = args.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      child = new EventEmitter(); child.exitCode = null;
      if (launches.length % 2 === 1) {
        profile = nextProfile;
        assert.ok(args.includes('https://gemini.google.com/app'));
        assert.ok(!args.some(a => /debugging|headless|automation|AutomationControlled/i.test(a)));
        const normalBrowser = child;
        queueMicrotask(() => { normalBrowser.exitCode = 0; normalBrowser.emit('exit', 0, null); });
      } else {
        assert.equal(nextProfile, profile);
        assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
        assert.ok(args.includes('--remote-debugging-port=0'));
        assert.ok(args.includes('about:blank'));
        assert.ok(!args.some(a => /^https?:/.test(a)));
        fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/test`);
      }
      return child;
    }, accountFactory: async input => { assert.deepEqual(input, normalizeCookies(cookies)); return account(); } });
  assert.equal((await login.start()).email, 'windows@example.com');
  assert.equal(launches.length, 2);
  assert.deepEqual(methods, ['Storage.getCookies', 'Browser.close']);
  assert.equal(login.active, null); assert.equal(fs.existsSync(profile), false);
  methods.length = 0;
  login.accountFactory = async () => { login.cancel(); return account(); };
  await assert.rejects(login.start(), /取消/);
  assert.deepEqual(methods, ['Storage.getCookies', 'Browser.close']);
  assert.equal(login.active, null); assert.equal(fs.existsSync(profile), false);
});

test('cancelling or timing out human login never starts cookie capture and releases the login lock', async () => {
  let profile, launches = 0;
  const login = new GeminiWindowsLogin({ platform: 'win32', timeoutMs: 25,
    browserFinder: () => 'C:\\chrome.exe', spawnImpl: (_binary, args) => {
      launches++;
      profile = args.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      const child = new EventEmitter(); child.exitCode = null; return child;
    } });
  await assert.rejects(login.start({ onReady: () => login.cancel() }), /取消/);
  assert.equal(launches, 1); assert.equal(login.active, null); assert.equal(fs.existsSync(profile), false);
  await assert.rejects(login.start(), /超时/);
  assert.equal(launches, 2); assert.equal(login.active, null); assert.equal(fs.existsSync(profile), false);
});

test('wrong-directory credentials are not silently converted, overwritten or migrated', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-store-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new GeminiAccountStore({ configDir: dir });
  const legacy = store.oauth.save(account());
  assert.deepEqual(store.list(), []);
  assert.equal(store.oauth.list()[0].id, legacy.id);
  const saved = store.windows.save({ ...account(), subjectId: 'different', email: 'different@example.com' });
  const auth = new GeminiWindowsAuthProvider({ account: saved, store, bootstrap: async () => ({
    ...record(), subjectId: saved.subjectId, email: saved.email,
    cookies: normalizeCookies(cookies.map(c => ({ ...c, value: c.value + '-rotated' })))
  }) });
  return auth.get().then(() => {
    assert.match(store.windows.list()[0].providerMetadata.geminiWindows.cookies[0].value, /rotated$/);
    assert.deepEqual(store.oauth.list()[0].providerMetadata.geminiWindows.cookies, cookies);
  });
});
