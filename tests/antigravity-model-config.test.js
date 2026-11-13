'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/agy-1.5.6-wire.json');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { CAPTURED_MODELS, resolveModelConfiguration, generationProfile,
  assertGenerationCompatibility } = require('../src/antigravity-model-config');

test('every captured public model keeps its verified thinking configuration despite client or catalog defaults', () => {
  for (const [model, captured] of Object.entries(fixture.models)) {
    for (const metadata of [undefined, {}, { supportsThinking: false },
      { supportsThinking: true, thinkingLevel: 1, thinkingBudget: 99999, maxOutputTokens: 8192 }]) {
      const normalized = { thinking: { type: 'disabled' }, reasoningEffort: 'none',
        reasoning_effort: 'low', reasoning: { effort: 'low' }, includeThinking: false,
        generationConfig: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 }, maxOutputTokens: 4096 } };
      const before = structuredClone(normalized);
      const config = generationProfile(normalized, model, metadata);
      assert.deepEqual(config.thinkingConfig, captured.generationConfig.thinkingConfig, model);
      assert.equal(config.maxOutputTokens, 4096);
      assert.deepEqual(normalized, before);
      assert.equal(resolveModelConfiguration(model, metadata).thinkingSource, 'captured');
    }
  }
});

test('Messages and Responses give identical named profiles without validating ignored client effort values', () => {
  for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']) {
    for (const effort of ['none', 'low', 'medium', 'high', 'unsupported', 0, null]) {
      const anthropic = normalizeAnthropic({ model, messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 2345, temperature: 0, top_p: 0.5, thinking: { type: 'disabled', budget_tokens: 0 },
        reasoning_effort: effort, output_config: { effort } });
      const responses = normalizeResponses({ model, input: 'hello', max_output_tokens: 2345,
        temperature: 0, top_p: 0.5, reasoning: { effort, summary: 'auto' } });
      const expected = { maxOutputTokens: 2345, temperature: 0, topP: 0.5,
        thinkingConfig: fixture.models[model].generationConfig.thinkingConfig };
      assert.deepEqual(generationProfile(anthropic, model), expected);
      assert.deepEqual(generationProfile(responses, model), expected);
    }
  }
});

test('the profile removes only generation-level thinking controls and preserves real client contracts', () => {
  const args = { thinking: false, reasoning_effort: 'business', reasoning: { effort: 0 },
    thinkingConfig: { enabled: false }, max_tokens: 0, tool_choice: [] };
  const normalized = {
    toolChoice: { type: 'tool', name: 'business' },
    tools: [{ name: 'business', schema: { type: 'object', properties: {
      thinking: { type: 'boolean' }, reasoning_effort: { type: 'string' }
    } } }],
    messages: [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'call', name: 'business', arguments: args }] }],
    generationConfig: { maxOutputTokens: 321, temperature: 0, topP: 0.2, topK: 7, stopSequences: ['STOP'],
      thinking: { type: 'disabled' }, thinking_config: { thinkingBudget: 0 }, thinkingConfig: null,
      thinkingBudget: 0, thinkingLevel: 'LOW', includeThoughts: false,
      reasoning_effort: 'none', reasoningEffort: 'low', reasoning: { effort: 'none' },
      include_reasoning: false, includeThinking: false }
  };
  const before = structuredClone(normalized);
  assert.deepEqual(generationProfile(normalized, 'gemini-3.8-flash-high'), {
    maxOutputTokens: 321, temperature: 0, topP: 0.2, topK: 7, stopSequences: ['STOP'],
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' }
  });
  assert.deepEqual(normalized, before);
});

test('legacy names have stable defaults and resolved configuration objects cannot mutate later requests', () => {
  const model = 'claude-sonnet-4-6';
  const first = resolveModelConfiguration(model, { model: 'FRESH_ENUM', maxOutputTokens: 32000,
    supportsThinking: true, thinkingBudget: 64000 });
  assert.equal(first.publicModel, model);
  assert.equal(first.upstreamModel, model);
  assert.equal(first.profile.model, 'FRESH_ENUM');
  assert.equal(first.profile.maxOutputTokens, 32000);
  assert.deepEqual(first.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
  first.thinkingConfig.thinkingBudget = 9;
  first.profile.thinkingBudget = 10;
  assert.equal(resolveModelConfiguration(model).thinkingConfig.thinkingBudget, 1024);
  assert.equal(CAPTURED_MODELS[model].thinkingBudget, 1024);
});

test('unrecognized names never invent a tier and real catalog entries can describe other models', () => {
  for (const model of ['unknown-high', 'gemini-3.8-flash-max', 'toString', '__proto__']) {
    const normalized = { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } }, reasoningEffort: 'high' };
    assert.equal(generationProfile(normalized, model), null);
    assert.equal(resolveModelConfiguration(model).thinkingSource, 'none');
  }
  for (const [number, level] of [[1, 'LOW'], [2, 'MEDIUM'], [3, 'HIGH']]) {
    const config = generationProfile({}, 'actual-catalog-model', {
      supportsThinking: true, thinkingLevel: number, thinkingBudget: -1, maxOutputTokens: 16000
    });
    assert.deepEqual(config, { maxOutputTokens: 16000, thinkingConfig: { includeThoughts: true, thinkingLevel: level } });
  }
  assert.deepEqual(generationProfile({}, 'actual-catalog-budget', {
    supportsThinking: true, thinkingBudget: 4096
  }), { thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 } });
});

test('verified forced-tool incompatibility is a model capability error, never a client-thinking conflict', () => {
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
    for (const input of [{}, { includeThinking: false, reasoningEffort: 'none' },
      { includeThinking: true, reasoningEffort: 'high' }]) {
      const generation = generationProfile(input, model), before = structuredClone(generation);
      assert.throws(() => assertGenerationCompatibility(model, generation, 'ANY'), {
        name: 'ModelCapabilityError', status: 400, code: 'model_capability_conflict'
      });
      assert.deepEqual(generation, before);
      for (const mode of [undefined, 'AUTO', 'NONE']) {
        assert.doesNotThrow(() => assertGenerationCompatibility(model, generation, mode));
      }
    }
  }
  assert.doesNotThrow(() => assertGenerationCompatibility('gemini-3.8-flash-high',
    generationProfile({}, 'gemini-3.8-flash-high'), 'ANY'));
  assert.doesNotThrow(() => assertGenerationCompatibility('claude-future-model',
    { thinkingConfig: { thinkingBudget: 1024 } }, 'ANY'));
});
