'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayUpstreams } = require('../src/gateway-upstreams');
const { SessionManager } = require('../src/session-manager');

function routing() {
  const pools = { antigravity: { hasManagedAccounts: () => true }, gemini: { hasManagedAccounts: () => true } };
  const sessions = new SessionManager();
  return {
    upstreams: new GatewayUpstreams(pools),
    identity: (id, model) => sessions.resolveIdentity({ headers: {
      'user-agent': 'claude-cli/2.1.322', 'x-claude-code-session-id': id
    } }, { model }, { model })
  };
}

test('separate classifier requests inherit their own session main upstream and model switches', () => {
  const { upstreams, identity } = routing();
  upstreams.remember(identity('gemini-task', 'gemini-4-argon-low-g'), 'gemini-4-argon-low-g');
  upstreams.remember(identity('agy-task', 'gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(upstreams.classifierModel(identity('gemini-task', 'claude-sonnet-5')), 'gemini-4-hydrogen-low-g');
  assert.equal(upstreams.classifierModel(identity('agy-task', 'claude-sonnet-5')), 'gemini-3.8-flash-low');
  upstreams.remember(identity('gemini-task', 'gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(upstreams.classifierModel(identity('gemini-task', 'claude-sonnet-5')), 'gemini-3.8-flash-low');
});

test('adding Gemini accounts preserves the original classifier route without a recorded main turn', () => {
  const { upstreams, identity } = routing();
  upstreams.remember(identity('other-task', 'gemini-4-argon-low-g'), 'gemini-4-argon-low-g');
  assert.equal(upstreams.classifierModel(identity('new-task', 'claude-sonnet-5')), 'gemini-3.8-flash-low');
  assert.equal(upstreams.classifierModel(), 'gemini-3.8-flash-low');
});

test('server safeguards continue using the triggering request model', () => {
  const { upstreams } = routing();
  assert.equal(upstreams.reviewModel('gemini-4-argon-low-g'), 'gemini-4-hydrogen-low-g');
  assert.equal(upstreams.reviewModel('gemini-3.8-flash-high'), 'gemini-3.8-flash-low');
});
