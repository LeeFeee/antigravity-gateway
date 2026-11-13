'use strict';

const { CAPTURED_MODELS, thinkingLevel, modelProfile, generationProfile,
  resolveModelConfiguration, assertGenerationCompatibility } = require('./antigravity-model-config');

// Observed Google Antigravity API protocol requests from agy 1.5.6 (2026-11-12).
const AGY_SESSION_ID = '-3750763034362895579';

const AGY_CLI_VERSION = '1.5.6';
const AGY_BUILD = '1018951551';
// OAuth keeps its own Go user agent and the dashboard's state-bound callback.
const AGY_OAUTH_PROFILE = Object.freeze({
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  userinfoEndpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
  userAgent: 'Go-http-client/2.0',
  scopes: Object.freeze([
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
    'https://www.googleapis.com/auth/aicode',
    'openid'
  ])
});
function cliUserAgent({ platform = process.platform, arch = process.arch, authMethod = 'consumer' } = {}) {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  return `antigravity/cli/${AGY_CLI_VERSION} (aidev_client; os_type=${os}; arch=${cpu}; cl=${AGY_BUILD}; auth_method=${authMethod})`;
}

// Fresh official high/medium/low switch captures preserve previous text and
// tool-call signatures in both directions. Do not infer compatibility from a
// broad "gemini-*" prefix, a provider name or an unobserved model alias.
const SHARED_HISTORY = new Set(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']);
function compatibleHistoryModels(source, target) {
  return typeof source === 'string' && source.length > 0 && typeof target === 'string' && target.length > 0
    && (source === target || (SHARED_HISTORY.has(source) && SHARED_HISTORY.has(target)));
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
    used_claude: String(Boolean(state.usedClaude) || /claude/i.test(model)),
    used_claude_conservative: String(Boolean(state.usedClaude) || /claude/i.test(model)),
    used_non_gemini_model: String(Boolean(state.usedNonGemini) || !/^gemini-/i.test(model))
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

module.exports = { AGY_SESSION_ID, AGY_CLI_VERSION, AGY_BUILD, AGY_OAUTH_PROFILE, cliUserAgent, thinkingLevel,
  CAPTURED_MODELS, agentEnvelope, generationProfile, modelProfile, nativeSchema, compatibleHistoryModels,
  resolveModelConfiguration, assertGenerationCompatibility };
