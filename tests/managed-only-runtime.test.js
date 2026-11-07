'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DirectAntigravityProvider } = require('../src/direct-provider');

test('provider construction does not activate environment credentials or local login state', async t => {
  const replacements = {
    ANTIGRAVITY_ACCESS_TOKEN: 'unused-test-access-token',
    ANTIGRAVITY_REFRESH_TOKEN: 'unused-test-refresh-token',
    ANTIGRAVITY_PROJECT_ID: 'unused-test-project',
    ANTIGRAVITY_AUTH_FILE: '/nonexistent/unused-account.json'
  };
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, process.env[key]]));
  Object.assign(process.env, replacements);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const provider = new DirectAntigravityProvider({
    fetchImpl: async () => { throw new Error('must not send any request'); },
    sessionStore: { directory: null }
  });
  assert.equal(provider.localAuth, null);
  assert.equal(provider.authFile, '');
  assert.equal(provider.isConfigured(), false);
  assert.equal(provider.loadAuth().accessToken, '');
  await assert.rejects(provider.access(), { code: 'direct_auth_missing' });
});
