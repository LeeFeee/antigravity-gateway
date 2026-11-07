'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verify } = require('../scripts/verify-managed-oauth-refresh');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-refresh-mock-'));
  const sourceDir = path.join(root, 'source'); fs.mkdirSync(sourceDir);
  const account = { id: 'private-id', email: 'private@example.invalid', subjectId: 'private-subject', projectId: 'private-project',
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
    enabled: true, providerType: 'cloudcode', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  const file = path.join(sourceDir, 'private@example.invalid.json'); fs.writeFileSync(file, JSON.stringify(account));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceDir, account, file, reportFile: path.join(root, 'result.json') };
}
test('standalone verification refreshes exactly once using only copied credentials and exports no source identity', async t => {
  const input = await fixture(t), original = fs.readFileSync(input.file);
  let calls = 0, closed = 0;
  const result = await verify({ sourceDir: input.sourceDir, reportFile: input.reportFile, binaryResolver: () => '/unused/mock', transportFactory: options => {
    assert.equal(options.env.HOME.includes('agw-refresh-only-'), true);
    assert.equal(Object.keys(options.env).length, 4);
    return { close: () => closed++, fetch: async (url, options) => {
      calls++; assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), input.account.refreshToken);
      return new Response(JSON.stringify({ access_token: 'synthetic-renewed', expires_in: 3600 }));
    } };
  } });
  assert.equal(calls, 1); assert.equal(closed, 1); assert.equal(result.passed, true);
  assert.equal(result.report.newGoogleAuthorizationVerified, false); assert.equal(result.report.generationRequests, 0);
  assert.equal(result.report.privateRootMode, '700'); assert.deepEqual(result.report.privateAccountModes, ['600']);
  assert.equal(result.report.originalBytesUnchanged, true); assert.equal(result.report.temporaryCredentialsRemoved, true);
  assert.deepEqual(fs.readFileSync(input.file), original);
  const serialized = fs.readFileSync(input.reportFile, 'utf8');
  for (const secret of [input.account.email, input.account.id, input.account.subjectId, input.account.projectId,
    input.account.accessToken, input.account.refreshToken, input.account.clientSecret, 'synthetic-renewed']) assert.equal(serialized.includes(secret), false);
});
test('rejected refresh records only HTTP status, makes no retry, and removes the credential copy', async t => {
  const input = await fixture(t);
  let calls = 0;
  const result = await verify({ sourceDir: input.sourceDir, reportFile: input.reportFile, binaryResolver: () => '/unused/mock',
    transportFactory: () => ({ close() {}, async fetch() { calls++; return new Response(JSON.stringify({ error_description: input.account.refreshToken }), { status: 400 }); } }) });
  assert.equal(calls, 1); assert.equal(result.passed, false); assert.equal(result.report.observations[0].status, 400);
  assert.equal(result.report.temporaryCredentialsRemoved, true); assert.equal(result.report.originalBytesUnchanged, true);
  assert.equal(fs.readFileSync(input.reportFile, 'utf8').includes(input.account.refreshToken), false);
});
