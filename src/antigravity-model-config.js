'use strict';

// Google Antigravity API protocol: agy 1.5.2 request captures, 2026-11-06.
// These are exact discovered IDs, not inferred combinations of model suffixes.
const CAPTURED_MODELS = Object.freeze({
  'gemini-3.8-flash-high': Object.freeze({ model: 'MODEL_PLACEHOLDER_M318',
    displayName: 'Gemini 3.8 Flash (High)', maxOutputTokens: 65536, supportsThinking: true, thinkingLevel: 'HIGH' }),
  'gemini-3.8-flash-medium': Object.freeze({ model: 'MODEL_PLACEHOLDER_M319',
    displayName: 'Gemini 3.8 Flash (Medium)', maxOutputTokens: 65536, supportsThinking: true, thinkingLevel: 'MEDIUM' }),
  'gemini-3.8-flash-low': Object.freeze({ model: 'MODEL_PLACEHOLDER_M320',
    displayName: 'Gemini 3.8 Flash (Low)', maxOutputTokens: 65536, supportsThinking: true, thinkingLevel: 'LOW' }),
  'claude-sonnet-4-6': Object.freeze({ model: 'MODEL_PLACEHOLDER_M35',
    maxOutputTokens: 64000, supportsThinking: true, thinkingBudget: 1024 }),
  'claude-opus-4-6-thinking': Object.freeze({ model: 'MODEL_PLACEHOLDER_M26',
    maxOutputTokens: 64000, supportsThinking: true, thinkingBudget: 1024 }),
  'gpt-oss-120b-medium': Object.freeze({ model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    maxOutputTokens: 32768, supportsThinking: true, thinkingBudget: 8192 })
});

// Numeric directory values paired with actual generation captures.
const THINKING_LEVELS = Object.freeze({ 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH' });
function thinkingLevel(value) {
  return (Object.hasOwn(THINKING_LEVELS, value) ? THINKING_LEVELS[value] : '')
    || (['LOW', 'MEDIUM', 'HIGH'].includes(value) ? value : '');
}

function capturedProfile(model) {
  return typeof model === 'string' && Object.hasOwn(CAPTURED_MODELS, model) ? CAPTURED_MODELS[model] : undefined;
}

function modelProfile(model, metadata) {
  const catalog = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return { ...capturedProfile(model), ...catalog };
}

function profileThinking(profile) {
  if (!profile?.supportsThinking) return undefined;
  const level = thinkingLevel(profile.thinkingLevel);
  if (level) return { includeThoughts: true, thinkingLevel: level };
  if (Number.isFinite(profile.thinkingBudget)) {
    return { includeThoughts: true, thinkingBudget: profile.thinkingBudget };
  }
  return undefined;
}

function resolveModelConfiguration(model, metadata) {
  const profile = modelProfile(model, metadata);
  const captured = profileThinking(capturedProfile(model));
  // A known public name is a fixed contract even if a fresh directory reports
  // different defaults. Other directory fields (limits, labels) remain live.
  // Unknown names are only assigned thinking from their actual directory entry;
  // a suffix such as "-high" alone is not evidence of a supported configuration.
  const thinkingConfig = captured || profileThinking(profile);
  return {
    publicModel: model,
    upstreamModel: model,
    profile,
    thinkingConfig,
    thinkingSource: captured ? 'captured' : thinkingConfig ? 'catalog' : 'none'
  };
}

// Only generation-level controls are removed. Do not recurse into tools,
// messages, schemas, or a business argument that happens to share these names.
const CLIENT_THINKING_FIELDS = new Set([
  'thinking', 'thinkingConfig', 'thinking_config', 'thinkingLevel', 'thinkingBudget',
  'includeThoughts', 'reasoning', 'reasoning_effort', 'reasoningEffort',
  'include_reasoning', 'includeThinking'
]);
function generationProfile(normalized = {}, model, metadata) {
  const resolved = resolveModelConfiguration(model, metadata);
  const client = normalized?.generationConfig;
  const generation = {
    ...(resolved.profile.maxOutputTokens > 0 ? { maxOutputTokens: resolved.profile.maxOutputTokens } : {}),
    ...(client && typeof client === 'object' && !Array.isArray(client)
      ? Object.fromEntries(Object.entries(client).filter(([key]) => !CLIENT_THINKING_FIELDS.has(key))) : {})
  };
  // Google removes matched stop sequences from its response. Let an identified
  // classifier generate its actual closing tag so strict XML validation can
  // check the complete verdict; never reconstruct a missing verdict or tag.
  const classifierClosingTag = normalized.autoMode && (normalized.autoModeFormat === 'severity'
    ? '</severity>' : normalized.autoModeFormat === 'block' ? '</block>' : null);
  if (classifierClosingTag && Array.isArray(generation.stopSequences)
    && generation.stopSequences.includes(classifierClosingTag)) {
    generation.stopSequences = generation.stopSequences.filter(stop => stop !== classifierClosingTag);
    if (!generation.stopSequences.length) delete generation.stopSequences;
  }
  if (resolved.thinkingConfig) generation.thinkingConfig = resolved.thinkingConfig;
  return Object.keys(generation).length ? generation : null;
}

// Proven by actual forced-tool requests; do not infer a restriction for every
// future model containing "claude" in its name.
const NO_THINKING_WITH_FORCED_TOOLS = new Set(['claude-sonnet-4-6', 'claude-opus-4-6-thinking']);
class ModelCapabilityError extends Error {
  constructor(model) {
    super(`模型 ${model} 的固定思考配置不支持强制工具调用。请使用自动工具选择，或选择支持该组合的模型。`);
    this.name = 'ModelCapabilityError';
    this.code = 'model_capability_conflict';
    this.status = 400;
  }
}

function assertGenerationCompatibility(model, generationConfig, toolMode) {
  if (toolMode === 'ANY' && generationConfig?.thinkingConfig && NO_THINKING_WITH_FORCED_TOOLS.has(model)) {
    throw new ModelCapabilityError(model);
  }
}

module.exports = { CAPTURED_MODELS, thinkingLevel, modelProfile, resolveModelConfiguration,
  generationProfile, assertGenerationCompatibility, ModelCapabilityError };
