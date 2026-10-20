'use strict';

// Observed agy 1.4.2 agent requests, not optional fields from a protocol schema.
// The live account catalog takes precedence over this captured offline default.
const AGY_SESSION_ID = '-3750763034362895579';
const CAPTURED_MODELS = Object.freeze({
  'gemini-3.8-flash-high': Object.freeze({ model: 'MODEL_PLACEHOLDER_M318',
    displayName: 'Gemini 3.8 Flash (High)', maxOutputTokens: 65536, supportsThinking: true, thinkingBudget: -1 }),
  'gemini-3.8-flash-medium': Object.freeze({ model: 'MODEL_PLACEHOLDER_M319',
    displayName: 'Gemini 3.8 Flash (Medium)', maxOutputTokens: 65536, supportsThinking: true, thinkingBudget: 4000 }),
  'gemini-3.8-flash-low': Object.freeze({ model: 'MODEL_PLACEHOLDER_M320',
    displayName: 'Gemini 3.8 Flash (Low)', maxOutputTokens: 65536, supportsThinking: true, thinkingBudget: 1000 })
});

// Fresh official high/medium/low switch captures preserve previous text and
// tool-call signatures in both directions. Do not infer compatibility from a
// broad "gemini-*" prefix, a provider name or an unobserved model alias.
const SHARED_HISTORY = new Set(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']);
function compatibleHistoryModels(source, target) {
  return typeof source === 'string' && source.length > 0 && typeof target === 'string' && target.length > 0
    && (source === target || (SHARED_HISTORY.has(source) && SHARED_HISTORY.has(target)));
}

function modelProfile(model, metadata) { return metadata || CAPTURED_MODELS[model] || {}; }

function generationProfile(normalized, model, metadata) {
  const profile = modelProfile(model, metadata);
  const generation = { ...(profile.maxOutputTokens > 0 ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    ...normalized.generationConfig };
  if (profile.supportsThinking && Number.isFinite(profile.thinkingBudget)) {
    generation.thinkingConfig = { includeThoughts: true, thinkingBudget: profile.thinkingBudget };
  }
  return Object.keys(generation).length ? generation : null;
}

function agentEnvelope({ model, project, contents, systemInstruction, tools, generationConfig, toolConfig, state, metadata, step, requestType = 'agent', now = Date.now() }) {
  const profile = modelProfile(model, metadata);
  step = Math.max(1, step ?? contents.reduce((sum, c) => sum + Math.max(1, c.parts.filter(p => p.functionResponse).length), 0));
  const labels = {
    cascade_id: state.cascadeId,
    ...(state.lastExecutionId ? { last_execution_id: state.lastExecutionId } : {}),
    last_step_index: String(step - 1),
    ...(profile.model ? { model_enum: profile.model } : {}),
    request_id: `${state.trajectoryId}-${state.requestIndex}`,
    root_cascade_id: state.cascadeId,
    trajectory_id: state.trajectoryId,
    used_claude: String(Boolean(state.usedClaude)),
    used_claude_conservative: 'false',
    used_non_gemini_model: String(Boolean(state.usedNonGemini))
  };
  return {
    project,
    requestId: `${requestType}/${state.cascadeId}/${now}/${state.trajectoryId}/${step}`,
    request: {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      labels,
      ...(generationConfig ? { generationConfig } : {}),
      ...(toolConfig ? { toolConfig } : {}),
      sessionId: AGY_SESSION_ID
    },
    model,
    userAgent: 'antigravity',
    requestType
  };
}

// The observed Schema is a protobuf JSON object, not a client JSON Schema.
// Keep the compatibility cleaner separate; only the upstream representation
// uses enum names and the observed field/map ordering.
function nativeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const result = {};
  const order = ['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required'];
  for (const key of [...order, ...Object.keys(schema).filter(k => !order.includes(k)).sort()]) {
    if (schema[key] === undefined) continue;
    const value = schema[key];
    if (key === 'type' && typeof value === 'string') result[key] = value.toUpperCase();
    else if (key === 'properties') result[key] = Object.fromEntries(Object.keys(value).sort().map(k => [k, nativeSchema(value[k])]));
    else if (key === 'items' || key === 'additionalProperties') result[key] = nativeSchema(value);
    else if (['prefixItems', 'anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) result[key] = value.map(nativeSchema);
    else result[key] = value;
  }
  return result;
}

module.exports = { AGY_SESSION_ID, CAPTURED_MODELS, agentEnvelope, generationProfile, modelProfile, nativeSchema, compatibleHistoryModels };
