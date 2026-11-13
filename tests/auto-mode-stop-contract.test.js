'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { generationProfile } = require('../src/antigravity-model-config');
const { buildDirectRequest } = require('../src/direct-provider');
const { finalizeModelResult, normalizeAnthropic, normalizeChat, normalizeResponses } = require('../src/protocol');

const MODEL = 'claude-sonnet-4-6';
const SYSTEMS = {
  severity: 'Auto Mode classification process. Grade harm only. Respond with <severity>N</severity>.',
  block: 'You evaluate actions in Auto Mode. If the action should be blocked: <block>yes</block>. '
    + 'If the action should be allowed: <block>no</block>.'
};

for (const format of ['severity', 'block']) {
  const closingTag = `</${format}>`;
  test(`${format} classifier removes only its exact closing stop from the upstream request`, () => {
    const otherTag = format === 'severity' ? '</block>' : '</severity>';
    const preservedStops = ['UNRELATED_STOP', otherTag, closingTag.toUpperCase(), ` ${closingTag}`];
    for (const stops of [[closingTag], [closingTag, ...preservedStops, closingTag], preservedStops]) {
      const payload = {
        model: MODEL, max_tokens: 64, stop_sequences: stops,
        system: `${SYSTEMS[format]}\nKeep all user rules and tool permission boundaries.`,
        messages: [{ role: 'user', content: 'Classify the pending fixture action.' }]
      };
      const sourceBefore = structuredClone(payload);
      const normalized = normalizeAnthropic(payload);
      const normalizedBefore = structuredClone(normalized);
      const wire = buildDirectRequest(normalized, MODEL, 'synthetic-project', 'synthetic-session');
      const remaining = stops.filter(stop => stop !== closingTag);
      assert.equal(normalized.autoMode, true);
      assert.equal(normalized.autoModeFormat, format);
      assert.deepEqual(wire.request.generationConfig.stopSequences, remaining.length ? remaining : undefined);
      assert.equal(wire.request.generationConfig.maxOutputTokens, 4096);
      assert.equal(wire.request.systemInstruction.parts[0].text, payload.system);
      assert.deepEqual(normalized, normalizedBefore);
      assert.deepEqual(payload, sourceBefore);
    }
  });
}

test('ordinary requests preserve classifier-looking stop sequences in every protocol', () => {
  const stops = ['</severity>', '</block>', 'OTHER'];
  const system = 'Keep these literal delimiters unchanged.';
  for (const [normalize, payload] of [
    [normalizeAnthropic, { system, stop_sequences: stops, messages: [{ role: 'user', content: SYSTEMS.severity }] }],
    [normalizeChat, { stop: stops, messages: [{ role: 'system', content: system }, { role: 'user', content: SYSTEMS.block }] }],
    [normalizeResponses, { instructions: system, stop: stops, input: SYSTEMS.severity }]
  ]) {
    const before = structuredClone(payload);
    const normalized = normalize({ model: MODEL, max_tokens: 64, ...payload });
    const wire = buildDirectRequest(normalized, MODEL, 'synthetic-project', 'synthetic-session');
    assert.equal(normalized.autoMode, false);
    assert.deepEqual(wire.request.generationConfig.stopSequences, stops);
    assert.equal(wire.request.generationConfig.maxOutputTokens, 64);
    assert.deepEqual(payload, before);
  }
});

test('classifier thinking has room beyond the original 64-token verdict allowance', () => {
  for (const format of ['severity', 'block']) {
    const normalized = normalizeAnthropic({ model: 'claude-sonnet-5', max_tokens: 64,
      thinking: { type: 'disabled' }, system: SYSTEMS[format],
      messages: [{ role: 'user', content: 'Classify the pending fixture action.' }] });
    const before = structuredClone(normalized);
    for (const [model, limit, thinking] of [
      ['gemini-3.8-flash-low', 4096, { includeThoughts: true, thinkingLevel: 'LOW' }],
      ['claude-sonnet-4-6', 4096, { includeThoughts: true, thinkingBudget: 1024 }],
      ['gpt-oss-120b-medium', 8256, { includeThoughts: true, thinkingBudget: 8192 }]
    ]) {
      const wire = buildDirectRequest(normalized, model, 'synthetic-project', 'synthetic-session');
      assert.equal(wire.request.generationConfig.maxOutputTokens, limit);
      assert.deepEqual(wire.request.generationConfig.thinkingConfig, thinking);
    }
    assert.deepEqual(normalized, before, 'the incoming request and verdict policy remain intact');
  }
});

test('classifier allowance respects model limits, larger requests and non-thinking models', () => {
  const input = { autoMode: true, autoModeFormat: 'severity', generationConfig: { maxOutputTokens: 64 } };
  assert.equal(generationProfile(input, 'gemini-3.8-flash-low', { maxOutputTokens: 2048 }).maxOutputTokens, 2048);
  assert.equal(generationProfile({ ...input, generationConfig: { maxOutputTokens: 8192 } }, 'gemini-3.8-flash-low').maxOutputTokens, 8192);
  assert.equal(generationProfile({ ...input, generationConfig: { maxOutputTokens: 64000 } }, MODEL).maxOutputTokens, 64000);
  assert.equal(generationProfile(input, 'synthetic-plain', { maxOutputTokens: 8192, supportsThinking: false }).maxOutputTokens, 64);
  assert.equal(generationProfile(input, 'synthetic-zero', { maxOutputTokens: 8192, supportsThinking: true, thinkingBudget: 0 }).maxOutputTokens, 64);
  for (const flags of [{ autoMode: false }, { autoModeFormat: 'unknown' }]) {
    assert.equal(generationProfile({ ...input, ...flags }, 'gemini-3.8-flash-low').maxOutputTokens, 64);
  }
});

test('truncated or filtered classifiers fail without accepting partial or complete-looking verdicts', () => {
  for (const format of ['severity', 'block']) {
    const normalized = normalizeAnthropic({ system: SYSTEMS[format] });
    for (const finishReason of ['MAX_TOKENS', 'SAFETY']) {
      for (const text of ['', `<${format}>`, format === 'severity' ? '<severity>0</severity>' : '<block>no</block>']) {
        assert.throws(() => finalizeModelResult(normalized, { text, thinking: 'Synthetic reasoning only.',
          toolCalls: [], finishReason, usage: { thinking_tokens: 61, output_tokens: 0 } }),
        { code: 'incomplete_auto_mode_classifier_output', status: 502 });
      }
    }
  }
});

test('closing stop adjustment requires both an active classifier and its known format', () => {
  for (const flags of [{}, { autoMode: false, autoModeFormat: 'severity' }, { autoMode: true },
    { autoMode: true, autoModeFormat: 'unknown' }]) {
    const input = { ...flags, generationConfig: { stopSequences: ['</severity>', '</block>'] } };
    assert.deepEqual(generationProfile(input, MODEL).stopSequences, ['</severity>', '</block>']);
  }
});

test('classifier finalization accepts actual complete verdicts without inventing a decision', () => {
  for (const [format, outputs] of [
    ['severity', ['<severity>0</severity>', '<severity>100</severity>']],
    ['block', ['<block>no</block>', '<block>yes</block>']]
  ]) {
    const normalized = normalizeAnthropic({ system: SYSTEMS[format], stop_sequences: [`</${format}>`] });
    for (const text of outputs) {
      const result = finalizeModelResult(normalized, { text, toolCalls: [], finishReason: 'STOP' });
      assert.equal(result.text, text);
    }
  }
});

test('missing, duplicate and conflicting classifier verdicts still fail closed', () => {
  for (const [format, outputs] of [
    ['severity', ['', '<severity>0', '<severity>100', '<severity></severity>',
      '<severity>0</severity><severity>0</severity>', '<severity>0</severity><severity>100</severity>',
      '<severity>101</severity>', '<severity>-1</severity>']],
    ['block', ['', '<block>no', '<block>yes', '<block></block>',
      '<block>no</block><block>no</block>', '<block>no</block><block>yes</block>']]
  ]) {
    const normalized = normalizeAnthropic({ system: SYSTEMS[format], stop_sequences: [`</${format}>`] });
    for (const text of outputs) {
      assert.throws(() => finalizeModelResult(normalized, { text, toolCalls: [], finishReason: 'STOP' }),
        { code: 'invalid_auto_mode_classifier_output', status: 502 });
    }
  }
});
