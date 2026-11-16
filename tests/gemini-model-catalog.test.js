'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/gemini/native-mode-policy-1.144.4.1467.json');
const { parseGeminiModelCatalog, publicGeminiModels, resolveGeminiModel, matchesGeminiModel } = require('../src/gemini-model-catalog');
const { geminiGenerationMessages } = require('../src/gemini-request-profile');
const { field } = require('../src/gemini-wire');

function catalog() { return parseGeminiModelCatalog(Buffer.from(fixture.protobufBase64, 'base64')); }

test('missing Task variant needs exact native attribution and cannot conceal another model or thinking level', () => {
  const model = resolveGeminiModel('gemini-4-argon-low-g', catalog());
  const actual = { category: 8, thinkingLevel: 1, attribution: '使用了 4 Argon 模型', modelId: '56fdd199312815e2' };
  assert.equal(matchesGeminiModel(model, actual), true);
  assert.equal(matchesGeminiModel(model, { ...actual, modeVariantId: 'argon' }), true);
  for (const change of [
    { attribution: undefined }, { attribution: '使用了 4 Carbon 模型' }, { attribution: '使用了 旧版 模型' },
    { modeVariantId: '95a4c0abcba24364' }, { category: 1 }, { thinkingLevel: undefined }, { thinkingLevel: 2 }
  ]) assert.equal(matchesGeminiModel(model, { ...actual, ...change }), false);
  assert.equal(matchesGeminiModel({ ...model, thinkingLevel: 2 }, actual), false);
  const hydrogen = resolveGeminiModel('gemini-4-hydrogen-low-g', catalog());
  assert.equal(matchesGeminiModel(hydrogen, { category: 1, thinkingLevel: 1, attribution: '使用了 4 Hydrogen 模型' }), true);
  assert.equal(matchesGeminiModel(hydrogen, { category: 1, thinkingLevel: 1, attribution: '使用了 4 Hydrogen 模型', modeVariantId: 'argon' }), false);
});

test('native policy keeps Argon/Carbon and Chat/Task entries in the same category', () => {
  const actual = catalog();
  assert.equal(actual.models.length, 7);
  const group = actual.models.filter(model => model.category === 8);
  assert.deepEqual(group.map(model => [model.id, model.policy.hosts]), [
    ['argon', [1]], ['95a4c0abcba24364', [1]], ['argon', [2]]
  ]);
  const models = publicGeminiModels(actual);
  assert.equal(models.length, 4);
  assert.ok(models.every(model => !model.id.includes('carbon')));
  assert.ok(models.every(model => model.mode === 'task'));
  assert.equal(resolveGeminiModel('gemini-4-argon-high-g', actual), null);
  assert.equal(resolveGeminiModel('gemini-4-hydrogen-medium-g', actual), null);
  const low = resolveGeminiModel('gemini-4-argon-low-g', actual);
  assert.equal(low.upstreamId, 'argon');
  assert.equal(low.thinkingLevel, 1);
  assert.deepEqual(low.taskThinkingLevels, [1]);
  assert.equal(resolveGeminiModel('gemini-4-argon-g', actual).aliasOf, 'gemini-4-argon-low-g');
});

test('missing visibility, disabled policy and pending onboarding never publish routable aliases', () => {
  const actual = catalog();
  actual.onboardingStatus = 7;
  assert.deepEqual(publicGeminiModels(actual), []);
  actual.onboardingStatus = 1;
  actual.models.filter(model => model.category === 8).forEach(model => { model.available = false; });
  assert.equal(resolveGeminiModel('gemini-4-argon-g', actual), null);
  assert.equal(resolveGeminiModel('arbitrary-model-g', actual), null);
});

test('Chat visibility does not publish a Task model and Task does not require Chat', () => {
  const actual = catalog();
  const chatOnly = { ...actual, models: actual.models.filter(model => model.policy.hosts.includes(1)) };
  assert.deepEqual(publicGeminiModels(chatOnly), []);
  const taskOnly = { ...actual, models: actual.models.filter(model => model.policy.hosts.includes(2)) };
  assert.deepEqual(publicGeminiModels(taskOnly), publicGeminiModels(actual));
});

test('every generation uses Task, including requests with no client tools or Auto review', () => {
  const actual = catalog();
  const low = resolveGeminiModel('gemini-4-argon-low-g', actual);
  for (const tools of [false, true]) {
    assert.throws(() => geminiGenerationMessages({ model: { ...low, thinkingLevel: 2 }, prompt: 'full input', tools }),
      error => error.code === 'gemini_task_thinking_unsupported');
    const initial = field(geminiGenerationMessages({ model: low, prompt: 'full input', tools })[0], 1000, 2);
    const generate = field(field(initial, 1001, 2), 1, 2);
    assert.equal(field(generate, 66, 2).toString(), 'argon');
    assert.equal(field(generate, 48, 0), 1n);
    assert.equal(field(generate, 26, 0), 41n);
    assert.equal(field(generate, 49, 0), 1n);
    assert.ok(field(generate, 51, 2));
  }
});
