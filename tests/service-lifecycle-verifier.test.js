'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { assertOwnedCommand } = require('../scripts/verify-service-lifecycle');

test('actual lifecycle harness can only mutate its own random service target and plist', () => {
  const own = { domain: 'gui/501', target: 'gui/501/io.github.leefeee.antigravity-gateway-verify-1234', plist: '/private/tmp/test/home/Library/LaunchAgents/owned.plist' };
  for (const args of [['print', own.target], ['bootstrap', own.domain, own.plist], ['bootout', own.domain, own.plist], ['bootout', own.target], ['kickstart', '-k', own.target]]) {
    assert.doesNotThrow(() => assertOwnedCommand('/bin/launchctl', args, own));
  }
  for (const args of [['bootout', own.domain], ['kickstart', '-k', 'gui/501/io.github.leefeee.antigravity-gateway'],
    ['bootout', own.domain, '/Users/real/Library/LaunchAgents/io.github.leefeee.antigravity-gateway.plist'], ['bootstrap', 'gui/0', own.plist]]) {
    assert.throws(() => assertOwnedCommand('/bin/launchctl', args, own));
  }
  assert.throws(() => assertOwnedCommand('/bin/sh', [], own));
  assert.throws(() => assertOwnedCommand('/bin/launchctl', ['print', 'gui/501/io.github.leefeee.antigravity-gateway'], { ...own, target: 'gui/501/io.github.leefeee.antigravity-gateway' }));
});
