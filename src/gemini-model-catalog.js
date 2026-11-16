'use strict';

const { decodeFields, field, readVarint } = require('./gemini-wire');

// These mappings are corroborated by GetUserStatus mode policy and completed
// real ProcessQuery responses, including returned model attribution/levels.
const VERIFIED_MODELS = Object.freeze([
  Object.freeze({ upstreamId: '56fdd199312815e2', category: 1, variant: '', name: 'gemini-4-hydrogen', displayName: '4 Hydrogen', attribution: '使用了 4 Hydrogen 模型', defaultThinkingLevel: 1 }),
  // The native task request and its completed MCP loop use the variant
  // "argon". Category 8 also contains Carbon; its legacy hash is not an
  // interchangeable Argon routing ID.
  Object.freeze({ upstreamId: 'argon', category: 8, variant: 'argon', name: 'gemini-4-argon', displayName: '4 Argon', attribution: '使用了 4 Argon 模型', defaultThinkingLevel: 1 })
]);
// This upstream exposes the app's Task mode only. Chat High/Medium policy
// entries are not Task capabilities and must never enter the public registry.
const VERIFIED_THINKING_LEVELS = Object.freeze({ low: 1 });

function text(input, number) { return field(input, number, 2)?.toString('utf8') || ''; }
function number(input, tag) { const value = field(input, tag, 0); return value === undefined ? null : Number(value); }
function repeated(input, tag) { return decodeFields(input).filter(f => f.number === tag && f.wireType === 2).map(f => f.value); }
function packedNumbers(input, tag) {
  const output = [];
  for (const f of decodeFields(input).filter(f => f.number === tag)) {
    if (f.wireType === 0) output.push(Number(f.value));
    else if (f.wireType === 2) {
      let offset = 0;
      while (offset < f.value.length) { const item = readVarint(f.value, offset); output.push(Number(item.value)); offset = item.offset; }
    }
  }
  return output;
}

function parseGeminiModelCatalog(response) {
  const visibleIds = new Set(repeated(response, 18).flatMap(category => repeated(category, 1).map(id => id.toString('utf8'))));
  const policyBytes = field(response, 34, 2);
  const policies = [];
  if (policyBytes) for (const config of repeated(policyBytes, 2)) {
    const mode = field(config, 1, 2);
    if (!mode) continue;
    const category = number(mode, 3);
    if (category === null) continue;
    const thinkingLevels = repeated(config, 2).map(level => ({
      title: text(level, 2), description: text(level, 3), value: number(level, 4),
      disabled: number(level, 5) === 1, routingVariantId: text(level, 13)
    })).filter(level => level.value !== null);
    policies.push({
      category, disabled: number(mode, 4) === 1, modeVariantId: text(mode, 5),
      title: text(mode, 6), displayName: text(mode, 7), attribution: text(mode, 8),
      description: text(mode, 14), implicitThinkingLevel: number(config, 3), thinkingLevels,
      nativeFeatureGates: packedNumbers(mode, 15), hosts: packedNumbers(config, 4),
      thinkingMenuStyle: number(mode, 17)
    });
  }
  const legacyModels = repeated(response, 17).map(config => {
    const id = text(config, 1), category = number(config, 23);
    return {
      id, category, legacyTitle: text(config, 2), displayName: text(config, 26) || text(config, 2),
      bardMode: number(config, 4), visible: visibleIds.has(id)
    };
  }).filter(model => model.id);
  // A category may contain several variants and separate Chat/Task policies.
  // A Map keyed only by category silently loses Argon/Carbon or thinking
  // levels, depending on the server's serialization order.
  const models = policies.flatMap(policy => legacyModels.filter(model => model.category === policy.category).map(legacy => ({
    ...legacy, id: policy.modeVariantId || legacy.id, legacyId: legacy.id,
    title: policy.title || legacy.legacyTitle, displayName: policy.displayName || legacy.displayName,
    available: legacy.visible && !policy.disabled, policy
  })));
  return { onboardingStatus: number(response, 1), subscriptionTier: number(response, 21), policyName: policyBytes ? text(policyBytes, 1) : '', models, legacyModels };
}

function publicGeminiModels(catalog) {
  if (catalog?.onboardingStatus !== 1) return [];
  const output = [];
  for (const known of VERIFIED_MODELS) {
    const native = catalog.models.find(model => model.id === known.upstreamId && model.category === known.category
      && model.policy?.modeVariantId === known.variant && model.policy.hosts.includes(2) && model.available);
    if (!native) continue;
    const variants = [];
    for (const [levelName, value] of Object.entries(VERIFIED_THINKING_LEVELS)) {
      const level = native.policy.thinkingLevels.find(item => item.value === value && !item.disabled);
      if (!level) continue;
      const descriptor = {
        id: `${known.name}-${levelName}-g`, name: `${known.displayName} ${levelName}`, provider: 'gemini',
        upstreamId: known.upstreamId, modeCategory: known.category, thinkingLevel: value, thinking: levelName,
        modeVariantId: native.policy.modeVariantId, routingVariantId: level.routingVariantId,
        legacyModelId: native.legacyId, taskThinkingLevels: native.policy.thinkingLevels.filter(item => !item.disabled).map(item => item.value),
        mode: 'task', bardMode: native.bardMode, source: 'Google Gemini API'
      };
      variants.push(descriptor);
      if (value === known.defaultThinkingLevel) output.push({ ...descriptor, id: `${known.name}-g`, name: known.displayName, aliasOf: descriptor.id });
    }
    output.push(...variants);
  }
  return output;
}

function resolveGeminiModel(publicId, catalog) {
  return publicGeminiModels(catalog).find(model => model.id === publicId) || null;
}

function matchesGeminiModel(model, metadata) {
  if (metadata.category !== model.modeCategory || metadata.thinkingLevel !== model.thinkingLevel) return false;
  const known = VERIFIED_MODELS.find(item => item.upstreamId === model.upstreamId && item.category === model.modeCategory);
  if (!known) return false;
  // Real completed Task turns can omit the optional variant ID. The native
  // attribution field (not model-written answer text) still identifies Argon
  // unambiguously; category 8 and the legacy model ID alone do not. Never let
  // attribution override an explicitly different returned variant or level.
  if (metadata.modeVariantId) return metadata.modeVariantId === (model.modeVariantId || known.upstreamId);
  return metadata.attribution === known.attribution;
}

module.exports = { VERIFIED_MODELS, VERIFIED_THINKING_LEVELS, parseGeminiModelCatalog, publicGeminiModels, resolveGeminiModel, matchesGeminiModel };
