'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ServerSearchContractError, validateServerSearchTool, ServerSearchReceipts } = require('../src/server-search-contract');

const tool = overrides => ({ type: 'web_search_20250305', name: 'web_search', ...overrides });
function source(overrides = {}) {
  const url = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/public-fixture-reference';
  return { url, finalUrl: url, title: 'Example source', page_age: '2026-11-07',
    provenance: { kind: 'google_search_result', verifiedFinalUrl: false, contentKind: 'metadata_only', evidenceId: 'fixture:source-1' }, ...overrides };
}

function receipts(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-search-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new ServerSearchReceipts({ directory }), scope: 'owner:fixture', callId: 'srvtoolu_fixture' };
}
function code(expected) { return error => error instanceof ServerSearchContractError && error.code === expected && error.status === 400; }

test('validates and preserves current SDK configuration without changing caller intent', () => {
  const input = tool({ max_uses: 8, allowed_domains: ['Example.com/blog', 'docs.example.org/*/articles'],
    allowed_callers: ['direct'], cache_control: { type: 'ephemeral', ttl: '1h' }, strict: true, defer_loading: false,
    user_location: { type: 'approximate', city: 'Kuala Lumpur', country: 'MY', timezone: 'Asia/Kuala_Lumpur', region: null } });
  const before = JSON.stringify(input), result = validateServerSearchTool(input);
  assert.deepEqual(result, input); assert.notEqual(result, input); assert.equal(JSON.stringify(input), before);
  assert.equal(validateServerSearchTool(tool({ max_uses: 0 })).max_uses, 0);
  assert.deepEqual(validateServerSearchTool(tool({ max_uses: null, allowed_domains: null, user_location: null })),
    tool({ max_uses: null, allowed_domains: null, user_location: null }));
  assert.deepEqual(validateServerSearchTool(tool({ allowed_callers: ['code_execution_20260120'] })).allowed_callers, ['code_execution_20260120']);
});

test('rejects unsupported tool versions, unknown semantic fields and malformed limits', () => {
  for (const input of [tool({ type: 'web_search_20260318' }), tool({ name: 'other' })]) assert.throws(() => validateServerSearchTool(input), code('unsupported_server_search_tool'));
  for (const input of [tool({ max_uses: -1 }), tool({ max_uses: 1.2 }), tool({ max_uses: '8' }), tool({ max_uses: Infinity }),
    tool({ search_profile: 'unknown' }), tool({ allowed_domains: [], blocked_domains: [] }), tool({ allowed_domains: 'example.com' }),
    tool({ strict: null }), tool({ allowed_callers: [] }), tool({ allowed_callers: ['unknown'] }),
    tool({ allowed_callers: ['direct', 'direct'] }), tool({ cache_control: { type: 'ephemeral', ttl: '2h' } })]) {
    assert.throws(() => validateServerSearchTool(input), code('invalid_server_search_tool'));
  }
});

test('domain filters reject schemes, ports, credentials, Unicode lookalikes and host wildcards', () => {
  for (const domain of ['https://example.com', 'example.com:443', '*.example.com', 'ex*.com', 'аmazon.com',
    'example.com@evil.test', 'example.com?x=1', 'example.com/#part', 'example.com/../x', 'example.com/%2e%2e/x', 'example.com/%XX', 'bad..test']) {
    assert.throws(() => validateServerSearchTool(tool({ allowed_domains: [domain] })), code('invalid_server_search_tool'), domain);
  }
});

test('validates location types, ISO countries, IANA zones and unknown nested fields', () => {
  for (const location of [{ type: 'approximate' }, { type: 'exact', city: 'London' }, { type: 'approximate', country: 'ZZ' },
    { type: 'approximate', timezone: 'Invented/Zone' }, { type: 'approximate', city: '' },
    { type: 'approximate', city: 'London', latitude: 1 }]) {
    assert.throws(() => validateServerSearchTool(tool({ user_location: location })), code('invalid_server_search_tool'));
  }
});

test('persistent private random key restores authenticated source after restart without model/session lock-in', t => {
  const ctx = receipts(t), original = source(), metadata = { model: 'claude-sonnet-4-6', session: 'first', thinkingBudget: 1024 };
  const result = ctx.store.issueResult({ ...ctx, source: original, metadata });
  assert.match(result.encrypted_content, /^agyws1\.r\./);
  assert.equal(result.encrypted_content.includes(original.url), false);
  assert.equal(fs.statSync(ctx.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(ctx.store.keyPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(ctx.store.keyPath).length, 32);
  const restarted = new ServerSearchReceipts({ directory: ctx.directory });
  const restored = restarted.restoreResult({ ...ctx, result });
  assert.deepEqual(restored.source, original); assert.deepEqual(restored.metadata, metadata);
  assert.notEqual(ctx.store.issueResult({ ...ctx, source: original }).encrypted_content, result.encrypted_content);
});

test('scope, call ID, key and visible source fields cannot be changed', t => {
  const ctx = receipts(t), result = ctx.store.issueResult({ ...ctx, source: source() });
  for (const edit of [{ scope: 'other-owner' }, { callId: 'srvtoolu_other' },
    { result: { ...result, url: 'https://evil.test' } }, { result: { ...result, title: 'Changed' } },
    { result: { ...result, page_age: null } }, { result: { ...result, type: 'different' } }]) {
    assert.throws(() => ctx.store.restoreResult({ ...ctx, result, ...edit }), code('invalid_server_search_receipt'));
  }
  const other = receipts(t);
  assert.throws(() => other.store.restoreResult({ ...ctx, result }), code('invalid_server_search_receipt'));
});

test('rejects altered ciphertext/tag, invalid encoding and unknown receipt versions', t => {
  const ctx = receipts(t), result = ctx.store.issueResult({ ...ctx, source: source() });
  const parts = result.encrypted_content.split('.');
  for (const index of [2, 3, 4]) {
    const altered = [...parts]; altered[index] = (altered[index][0] === 'A' ? 'B' : 'A') + altered[index].slice(1);
    assert.throws(() => ctx.store.restoreResult({ ...ctx, result: { ...result, encrypted_content: altered.join('.') } }), code('invalid_server_search_receipt'));
  }
  for (const token of [result.encrypted_content + '=', result.encrypted_content.replace('agyws1', 'agyws2'), '']) {
    assert.throws(() => ctx.store.restoreResult({ ...ctx, result: { ...result, encrypted_content: token } }), code('invalid_server_search_receipt'));
  }
});

test('corrupt persistent key is not silently replaced, and symlink key is rejected', t => {
  const ctx = receipts(t);
  fs.writeFileSync(ctx.store.keyPath, 'bad');
  assert.throws(() => new ServerSearchReceipts({ directory: ctx.directory }), error => error.code === 'server_search_key_error');
  assert.equal(fs.readFileSync(ctx.store.keyPath, 'utf8'), 'bad');
  fs.unlinkSync(ctx.store.keyPath);
  const target = path.join(ctx.directory, 'other-key'); fs.writeFileSync(target, crypto.randomBytes(32), { mode: 0o600 });
  fs.symlinkSync(target, ctx.store.keyPath);
  assert.throws(() => new ServerSearchReceipts({ directory: ctx.directory }), error => error.code === 'server_search_key_error');
});

test('concurrent processes publish one complete key and every issued result survives restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-search-key-race-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const worker = `const {ServerSearchReceipts} = require(process.argv[1]);
    const store = new ServerSearchReceipts({directory: process.argv[2]});
    process.stdout.write(JSON.stringify(store.issueResult({scope:'owner',callId:'srvtoolu_concurrent',
      source:JSON.parse(process.argv[3])})));`;
  const results = await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath,
    ['-e', worker, require.resolve('../src/server-search-contract'), directory, JSON.stringify(source())], { timeout: 10000 })));
  const store = new ServerSearchReceipts({ directory });
  for (const result of results) {
    assert.equal(result.stderr, '');
    assert.deepEqual(store.restoreResult({ scope: 'owner', callId: 'srvtoolu_concurrent', result: JSON.parse(result.stdout) }).source, source());
  }
  assert.deepEqual(fs.readdirSync(directory), [path.basename(store.keyPath)]);
});

test('rejects unsupported source fields and invalid JSON metadata instead of silently discarding them', t => {
  const ctx = receipts(t);
  assert.throws(() => ctx.store.issueResult({ ...ctx, source: source({ summary: 'unverified model output' }) }), code('invalid_server_search_source'));
  for (const metadata of [{ counter: NaN }, { helper: () => 'not JSON' }, { missing: undefined }]) {
    assert.throws(() => ctx.store.issueResult({ ...ctx, source: source(), metadata }), code('invalid_server_search_receipt'));
  }
  const store = new ServerSearchReceipts({ directory: ctx.directory, now: () => NaN });
  assert.throws(() => store.issueResult({ ...ctx, source: source() }), error => error.code === 'server_search_key_error');
});

function rawGoogleSource(overrides = {}) {
  const url = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/public-fixture-reference';
  return { url, finalUrl: url, title: 'upstream.example',
    provenance: { kind: 'google_search_result', verifiedFinalUrl: false, contentKind: 'metadata_only', evidenceId: 'fixture:raw-google-grounding' }, ...overrides };
}

test('passes through real unresolved Google references and preserves the unverified state in receipts', t => {
  const ctx = receipts(t), raw = rawGoogleSource();
  const result = ctx.store.issueResult({ ...ctx, source: raw });
  assert.equal(result.url, raw.url);
  const restored = new ServerSearchReceipts({ directory: ctx.directory }).restoreResult({ ...ctx, result });
  assert.deepEqual(restored.source, raw); assert.equal(restored.source.provenance.verifiedFinalUrl, false);
  assert.equal(ctx.store.issueCitation, undefined);
  assert.equal(ctx.store.restoreCitation, undefined);
});

test('unverified source cannot invent a resolved URL, source text or content provenance', t => {
  const ctx = receipts(t);
  for (const raw of [rawGoogleSource({ finalUrl: 'https://github.com/example' }),
    rawGoogleSource({ text: 'unread page content' }),
    rawGoogleSource({ text: 'generated text', provenance: { kind: 'google_search_result', verifiedFinalUrl: false,
      contentKind: 'source_text', evidenceId: 'fixture:raw' } }),
    rawGoogleSource({ provenance: { kind: 'google_source_content', verifiedFinalUrl: false,
      contentKind: 'metadata_only', evidenceId: 'fixture:raw' } })]) {
    assert.throws(() => ctx.store.issueResult({ ...ctx, source: raw }), code('invalid_server_search_source'));
  }
});

test('opaque receipt preserves the exact original upstream URL without normalizing its spelling', t => {
  const ctx = receipts(t), url = 'https://EXAMPLE.com:443/a/../b?source=%2f#link';
  const result = ctx.store.issueResult({ ...ctx, source: source({ url, finalUrl: url }) });
  assert.equal(result.url, url);
  assert.equal(ctx.store.restoreResult({ ...ctx, result }).source.url, url);
});
