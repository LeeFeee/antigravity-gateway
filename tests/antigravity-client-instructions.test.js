'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const capture = require('./fixtures/agent-requests-20261107/pi-first.json');
const { normalizeResponses, normalizeAnthropic } = require('../src/protocol');
const { withClaude322Billing } = require('./helpers/claude-capture');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { prepareAntigravityClientInstructions } = require('../src/antigravity-client-instructions');

function fixture() {
  const request = capture.captures.find(item => item.path.startsWith('/v1/responses') && item.body?.model);
  return sanitizeClientIdentity(normalizeResponses(request.body));
}

test('verified Pi reference expands one abbreviation without changing context, references or tools', () => {
  const { normalized, metadata } = fixture();
  const original = structuredClone(normalized);
  const result = prepareAntigravityClientInstructions(normalized, metadata.profile);
  assert.equal(result.system, original.system.replace('non-LLM models', 'models other than large language models,'));
  assert.deepEqual({ ...result, system: original.system }, original);
  assert.deepEqual(normalized, original);
  assert.equal(prepareAntigravityClientInstructions(result, metadata.profile), result);
});

test('user quotations and customized or unknown client reference lines are untouched', () => {
  const { normalized, metadata } = fixture();
  const user = '\n\n<project_context>\nUser rule: non-LLM models; keep this exact phrase.\n'
    + normalized.system.slice(normalized.system.indexOf('<docs>'), normalized.system.indexOf('</docs>') + 7)
    + '\n</project_context>';
  const source = { ...normalized, system: normalized.system + user };
  assert.ok(prepareAntigravityClientInstructions(source, metadata.profile).system.endsWith(user));
  for (const profile of [null, { ...metadata.profile, client: 'custom' }, { ...metadata.profile, templateVersion: 'unknown' }]) {
    assert.equal(prepareAntigravityClientInstructions(source, profile), source);
  }
  const changed = { ...normalized, system: normalized.system.replace('codemode scripts and non-LLM', 'my custom scripts and non-LLM') };
  assert.equal(prepareAntigravityClientInstructions(changed, metadata.profile), changed);
});

function claudeFixture() {
  const captured = require('./fixtures/client-gateway-20261107/failures/claude-read-compact-template.json');
  const body = captured.clientHTTP.find(item => item.path.startsWith('/v1/messages')).body;
  return sanitizeClientIdentity(normalizeAnthropic(withClaude322Billing(body)));
}

test('verified Claude policy expands abbreviations while preserving every refusal and authorization requirement', () => {
  const { normalized, metadata } = claudeFixture();
  const original = structuredClone(normalized);
  const result = prepareAntigravityClientInstructions(normalized, metadata.profile);
  assert.notEqual(result.system, original.system);
  assert.equal(result.system, original.system.replace('DoS attacks', 'denial-of-service attacks')
    .replace('C2 frameworks', 'command-and-control frameworks'));
  assert.deepEqual({ ...result, system: original.system }, original);
  assert.deepEqual(normalized, original);
  assert.equal(prepareAntigravityClientInstructions(result, metadata.profile), result);
});

test('Claude policy conversion does not modify user quotations or customized policies', () => {
  const { normalized, metadata } = claudeFixture();
  const quoted = '\n\nUser quotation:\n' + normalized.system;
  const source = { ...normalized, system: normalized.system + quoted };
  assert.ok(prepareAntigravityClientInstructions(source, metadata.profile).system.endsWith(quoted));
  for (const profile of [null, { ...metadata.profile, templateVersion: 'unknown' }, { ...metadata.profile, evidence: [] }]) {
    assert.equal(prepareAntigravityClientInstructions(source, profile), source);
  }
  const customized = { ...normalized, system: normalized.system.replace('IMPORTANT: Assist', 'IMPORTANT: Always assist') };
  assert.equal(prepareAntigravityClientInstructions(customized, metadata.profile), customized);
});

test('Claude full SDK template used for Sonnet retains the same policy expansion', () => {
  const captured = require('./fixtures/agent-requests-20261107/claude-first.json');
  const body = captured.captures.find(item => item.path.startsWith('/v1/messages') && item.body?.model).body;
  const { normalized, metadata } = sanitizeClientIdentity(normalizeAnthropic(withClaude322Billing(body)));
  assert.ok(metadata.profile.evidence.includes('claude-sdk-system-template'));
  const result = prepareAntigravityClientInstructions(normalized, metadata.profile);
  assert.notEqual(result.system, normalized.system);
  assert.equal(result.system, normalized.system.replace('DoS attacks', 'denial-of-service attacks')
    .replace('C2 frameworks', 'command-and-control frameworks'));
  assert.deepEqual({ ...result, system: normalized.system }, normalized);
});

function hermesFixture() {
  const captured = require('./fixtures/agent-requests-20261107/hermes-identity.json');
  const body = captured.captures.find(item => item.path.startsWith('/v1/responses') && item.body?.model).body;
  return sanitizeClientIdentity(normalizeResponses(body));
}

test('Hermes compatibility converts only verified framework text and outer environment labels', () => {
  const { normalized, metadata } = hermesFixture();
  const original = structuredClone(normalized);
  const result = prepareAntigravityClientInstructions(normalized, metadata.profile);
  assert.match(result.system, /^Respond directly and in proportion to the request/);
  assert.match(result.system, /Always report a blocker honestly instead of inventing a result/);
  assert.match(result.system, /# Model execution requirements/);
  const project = normalized.system.slice(normalized.system.indexOf('# Project Context'), normalized.system.lastIndexOf('# Hermes runtime environment'));
  assert.ok(result.system.includes(project));
  const runtime = normalized.system.slice(normalized.system.lastIndexOf('# Hermes runtime environment') + '# Hermes runtime environment'.length,
    normalized.system.lastIndexOf('<!-- End Hermes runtime environment -->'));
  assert.ok(result.system.includes('# Client runtime environment' + runtime + '<!-- End client runtime environment -->'));
  assert.deepEqual({ ...result, system: original.system }, original);
  assert.deepEqual(normalized, original);
  assert.equal(prepareAntigravityClientInstructions(result, metadata.profile), result);
});

test('Hermes preserves custom SOUL, quoted framework text and customized completion guidance', () => {
  const { normalized, metadata } = hermesFixture();
  const quoted = '\n\nUser quoted framework:\n' + normalized.system.slice(0, normalized.system.indexOf('## Skills'));
  const source = { ...normalized, system: normalized.system.replace('# Hermes runtime environment', '# Project Context' + quoted + '\n\n# Hermes runtime environment') };
  assert.ok(prepareAntigravityClientInstructions(source, metadata.profile).system.includes(quoted));
  const customIntro = 'My custom SOUL. Be direct: match the length of your reply to the weight of the ask.';
  const custom = { ...normalized, system: customIntro + normalized.system.slice(normalized.system.indexOf('\n\n')) };
  assert.ok(prepareAntigravityClientInstructions(custom, metadata.profile).system.startsWith(customIntro));
  const changed = { ...normalized, system: normalized.system.replace('working artifact backed by real tool output', 'custom deliverable policy') };
  assert.ok(prepareAntigravityClientInstructions(changed, metadata.profile).system.includes('custom deliverable policy'));
  for (const profile of [null, { ...metadata.profile, templateVersion: 'unknown' }, { ...metadata.profile, evidence: [] }]) {
    assert.equal(prepareAntigravityClientInstructions(source, profile), source);
  }
});
