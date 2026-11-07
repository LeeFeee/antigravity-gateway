'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { normalizeAnthropic } = require('../src/protocol');
const { buildDirectRequest } = require('../src/direct-provider');
const { anthropicSystemBlockEvidence, sanitizeClientIdentity } = require('../src/client-identity');

const billing = 'x-anthropic-billing-header: cc_version=2.1.318.abc; cc_entrypoint=cli;';
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const syntheticPolicy = 'Auto Mode classification process. Respond with <severity>N</severity>. Keep all permission boundaries.';
const context = 'Synthetic session context. Preserve SOUL, user rules and permission instructions.';
const blocks = () => [{ type: 'text', text: billing }, { type: 'text', text: syntheticPolicy, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: context }];

for (const entrypoint of ['cli', 'sdk-cli']) test(`${entrypoint} source evidence contains only immutable types, lengths and hashes`, () => {
  const source = blocks(); source[0].text = billing.replace('=cli', '=' + entrypoint);
  const before = structuredClone(source);
  const evidence = anthropicSystemBlockEvidence(source);
  assert.equal(evidence.kind, 'anthropic-system-blocks');
  assert.deepEqual(evidence.blocks, source.map(block => ({ type: 'text', length: block.text.length, sha256: digest(block.text) })));
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.blocks), true);
  assert.ok(evidence.blocks.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(evidence), /SOUL|permission|cc_entrypoint/);
  assert.deepEqual(source, before);
});

test('normalization derives source evidence itself and preserves extra system-role rules', () => {
  const source = blocks();
  const payload = { system: source, clientSystemProvenance: { kind: 'forged', blocks: [] }, messages: [
    { role: 'system', content: 'Preserve this extra system instruction.' }, { role: 'user', content: 'User-provided transcript.' }
  ] };
  const before = structuredClone(payload), normalized = normalizeAnthropic(payload);
  assert.deepEqual(normalized.clientSystemProvenance, anthropicSystemBlockEvidence(source));
  assert.equal(normalized.system, source.map(block => block.text).join('\n') + '\n\nPreserve this extra system instruction.');
  assert.deepEqual(payload, before);
  assert.deepEqual(normalizeAnthropic({ system: 'ordinary rules', clientSystemProvenance: normalized.clientSystemProvenance })
    .clientSystemProvenance, undefined);
});

test('unknown synthetic classifier policy never authorizes stripping its billing-like source text', () => {
  const normalized = normalizeAnthropic({ system: blocks(), messages: [{ role: 'user', content: 'Retain all transcript content.' }] });
  assert.equal(normalized.autoMode, true);
  const result = sanitizeClientIdentity(normalized);
  assert.equal(result.metadata.profile, null); assert.deepEqual(result.metadata.rules, []);
  assert.deepEqual(result.normalized, normalized);
});

test('unknown, quoted, merged, missing and non-text source layouts produce no billing evidence', () => {
  const source = blocks();
  for (const input of [
    source.map(block => block.text).join('\n'),
    [{ type: 'text', text: source.map(block => block.text).join('\n') }],
    source.slice(0, 2), [...source, { type: 'text', text: 'Extra block.' }],
    [{ type: 'text', text: billing.replace('2.1.318', '2.1.319') }, ...source.slice(1)],
    [{ type: 'text', text: billing.replace('=cli', '=unknown-cli') }, ...source.slice(1)],
    [{ type: 'text', text: `Quoted header:\n${billing}` }, ...source.slice(1)],
    [source[0], { type: 'image', text: syntheticPolicy }, source[2]],
    [source[0], source[1], { type: 'text', text: '' }]
  ]) assert.equal(anthropicSystemBlockEvidence(input), null);
});

test('copied or edited source evidence cannot clear unrelated normalized instructions', () => {
  const normalized = normalizeAnthropic({ system: blocks() });
  for (const input of [
    { ...normalized, system: `Quoted:\n${normalized.system}` },
    { ...normalized, system: normalized.system.replace(syntheticPolicy, 'Changed policy.') },
    { ...normalized, system: normalized.system.replace(context, 'Different user context.') },
    { ...normalized, clientSystemProvenance: { ...normalized.clientSystemProvenance, blocks: [] } },
    { ...normalized, autoModeFormat: '__proto__' },
    { ...normalized, clientSystemProvenance: undefined }
  ]) {
    const result = sanitizeClientIdentity(input);
    assert.equal(result.normalized.system, input.system);
    assert.deepEqual(result.metadata.rules, []);
  }
});

test('source evidence never reaches upstream and classifier budget translation is unchanged', () => {
  const normalized = normalizeAnthropic({ model: 'claude-sonnet-4-6', max_tokens: 64, thinking: { type: 'disabled' },
    system: blocks(), messages: [{ role: 'user', content: 'Synthetic pending action.' }] });
  const before = structuredClone(normalized);
  const wire = buildDirectRequest(normalized, normalized.model, 'synthetic-project', 'synthetic-session');
  assert.equal(wire.request.systemInstruction.parts[0].text, normalized.system, 'unknown policy remains untouched');
  assert.equal(wire.request.generationConfig.maxOutputTokens, 64);
  assert.deepEqual(wire.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
  assert.doesNotMatch(JSON.stringify(wire), /clientSystemProvenance|anthropic-system-blocks/);
  assert.deepEqual(normalized, before);
});
