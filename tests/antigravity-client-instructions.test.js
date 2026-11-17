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

test('dsh web expands only the verified GUI abbreviation and retains every rule and tool', () => {
  const framework = require('./fixtures/dsh-web-0.2.1-rc.2-framework.json');
  const record = require('./fixtures/agent-requests-20261107/dsh-first.json');
  const request = structuredClone(record.captures.find(item => item.path.startsWith('/v1/responses') && item.body?.model).body);
  const source = normalizeResponses(request), paragraphs = source.system.split('\n\n');
  paragraphs.splice(2, 0, framework.fileReference);
  source.system = paragraphs.join('\n\n') + '\n\n' + framework.checkoutContext + '\n\n' + framework.guiContext;
  const { normalized, metadata } = sanitizeClientIdentity(source);
  const before = structuredClone(normalized);
  const result = prepareAntigravityClientInstructions(normalized, metadata.profile);
  assert.equal(result.system, before.system.replace('no implicit DOM, route, or screenshot context',
    'no implicit Document Object Model, route, or screenshot context'));
  assert.deepEqual({ ...result, system: before.system }, before);
  assert.deepEqual(normalized, before);
  assert.equal(prepareAntigravityClientInstructions(result, metadata.profile), result);
  for (const suffix of ['\n\n# SOUL\n' + framework.guiContext, '\n\n<quote>\n' + framework.guiContext + '\n</quote>']) {
    const userOwned = { ...normalized, system: normalized.system + suffix };
    assert.equal(prepareAntigravityClientInstructions(userOwned, metadata.profile), userOwned);
  }
  const changed = { ...normalized, system: normalized.system.replace('The browser provides', 'My browser provides') };
  assert.equal(prepareAntigravityClientInstructions(changed, metadata.profile), changed);
  for (const profile of [null, { ...metadata.profile, evidence: [] }, { ...metadata.profile, templateVersion: 'unknown' }]) {
    assert.equal(prepareAntigravityClientInstructions(normalized, profile), normalized);
  }
});

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

test('interactive Claude CLI applies the same exact policy conversion and preserves its leading newline and user context', () => {
  const captured = require('./fixtures/claude-tui-2.1.318-framework.json');
  const userContext = '\n# Session-specific guidance\nKeep all permission rules.\n\n# Memory\nUser quotation: DoS attacks and C2 frameworks.\n';
  const { normalized, metadata } = sanitizeClientIdentity(normalizeAnthropic({
    model: 'gemini-3.8-flash-low',
    system: [captured.billingTemplate.replace('2.1.318', '2.1.322'), captured.identity,
      captured.corePrefix + userContext].map(text => ({ type: 'text', text })),
    tools: [{ name: 'owned_tool', description: 'DoS attacks and C2 frameworks.', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: '你好' }]
  }));
  assert.deepEqual(metadata.profile.evidence, ['claude-tui-system-template']);
  const original = structuredClone(normalized);
  const result = prepareAntigravityClientInstructions(normalized, metadata.profile);
  assert.notEqual(result.system, original.system);
  assert.equal(result.system, original.system.replace('DoS attacks', 'denial-of-service attacks')
    .replace('C2 frameworks', 'command-and-control frameworks'));
  assert.ok(result.system.startsWith('\n'));
  assert.ok(result.system.endsWith(userContext));
  assert.deepEqual({ ...result, system: original.system }, original);
  assert.deepEqual(normalized, original);
  assert.equal(prepareAntigravityClientInstructions(result, metadata.profile), result);
  const customized = { ...normalized, system: normalized.system.replace('IMPORTANT: Assist', 'IMPORTANT: Always assist') };
  assert.equal(prepareAntigravityClientInstructions(customized, metadata.profile), customized);
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

test('interactive Hermes steering identity is converted only inside the verified framework region', () => {
  const { normalized, metadata } = hermesFixture();
  const { text } = require('./fixtures/hermes-midturn-steering-0.23.1.json');
  const source = { ...normalized, system: normalized.system.replace('# Tool-use enforcement', text + '\n\n# Tool-use enforcement') };
  const original = structuredClone(source);
  const result = prepareAntigravityClientInstructions(source, metadata.profile);
  const withoutSteering = prepareAntigravityClientInstructions(normalized, metadata.profile);
  assert.equal(result.system, withoutSteering.system.replace('# Tool-use enforcement',
    text.replace('Hermes delivers', 'The client delivers') + '\n\n# Tool-use enforcement'));
  assert.deepEqual({ ...result, system: original.system }, original);
  assert.deepEqual(source, original);
  assert.equal(prepareAntigravityClientInstructions(result, metadata.profile), result);

  const userQuote = '\n\n# Project Context\n\n' + text;
  assert.ok(prepareAntigravityClientInstructions({ ...source, system: source.system + userQuote }, metadata.profile).system.endsWith(userQuote));
  const custom = text.replace('Hermes delivers', 'Hermes delivers my customized instructions');
  const changed = { ...normalized, system: normalized.system.replace('# Tool-use enforcement', custom + '\n\n# Tool-use enforcement') };
  assert.ok(prepareAntigravityClientInstructions(changed, metadata.profile).system.includes(custom));
});
