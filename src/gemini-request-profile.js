'use strict';

const crypto = require('node:crypto');
const { GatewayError } = require('./protocol');
const { messageField: m, stringField: s, intField: i, boolField: b,
  bytesField: x, concatFields: c, varint } = require('./gemini-wire');

// Current app capture: 1.144.4.1467. These are protocol fields, not a claim
// that a Mac application is installed on the gateway host. No User-Agent was
// present on captured main RPCs. OAuth/telemetry headers are separate profiles.
const GEMINI_CLIENT_VERSION = '1.144.4.1467';
const GEMINI_BUNDLE_ID = 'com.google.GeminiMacOS';
const TASK_FEATURE_MODE = 41;
const TOOL_CAPABILITIES = Object.freeze([668, 669, 777, 873, 724, 776, 726, 809]);
// Without MULTI_MODE_PICKER, GetUserStatus omits Task policies even for an
// account that can execute tasks. Isolated real calls identified 903 (not
// 591/935 or eligibilityCheckType) as the required catalog capability.
const MODE_POLICY_CAPABILITY = 903;

function geminiRequestHeaders() {
  return { 'x-ios-bundle-identifier': GEMINI_BUNDLE_ID, 'accept-language': 'zh_CN' };
}

function geminiRequestMetadata({ modelId = '', tools = false, deviceId = '', timezone = '' } = {}) {
  return c([
    m(3, c([s(1, GEMINI_CLIENT_VERSION), ...(deviceId ? [s(17, deviceId)] : [])])),
    i(4, 21), i(5, 1), s(7, 'zh-CN'),
    ...(modelId ? [s(16, modelId)] : []),
    m(6, x(2, c([MODE_POLICY_CAPABILITY, ...(tools ? TOOL_CAPABILITIES : [])].map(varint)))),
    ...(timezone ? [m(19, s(1, timezone))] : [])
  ]);
}

function requestError(message, code) { return new GatewayError(message, { code, status: 400 }); }

function geminiGenerationMessages({ prompt, model, deviceId = crypto.randomUUID().toUpperCase(), confirmation }) {
  if (typeof prompt !== 'string' || !prompt.length) throw requestError('Gemini 请求缺少完整提示。', 'gemini_prompt_missing');
  if (!model || model.provider !== 'gemini' || !model.upstreamId || !Number.isInteger(model.modeCategory)
    || !Number.isInteger(model.thinkingLevel)) throw requestError('Gemini 模型必须由模型目录明确解析。', 'gemini_model_unresolved');
  // Every generation, including text-only and Auto review requests, uses
  // the native Task protocol. Client tool count must not select Chat mode.
  if (!model.taskThinkingLevels?.includes(model.thinkingLevel)) {
    throw requestError('Gemini 任务模式不支持所选模型的思考档位，不能自动降档。', 'gemini_task_thinking_unsupported');
  }
  const query = s(1, prompt);
  const identifiers = confirmation ? c([s(1, confirmation.conversationId), s(2, confirmation.requestId), s(3, confirmation.responseId)]) : Buffer.alloc(0);
  const generate = c([
    m(1, query), m(4, identifiers), b(5, true), m(6, i(1, 1)), m(8, i(1, 1)),
    i(17, 2), i(18, 1), i(47, model.modeCategory), i(48, model.thinkingLevel),
    // Hydrogen uses its legacy ID when no named variant exists. Argon must
    // use "argon" in both metadata and the variant, not the Carbon family ID.
    s(66, model.modeVariantId || model.upstreamId),
    ...(model.routingVariantId ? [s(67, model.routingVariantId)] : []),
    // Current native descriptor: PromptSource.ACTION_BLOCKS = 5. A card
    // button response is control input, not another ordinary user message.
    ...(confirmation ? [m(30, i(1, 5)), b(45, true)] : []),
    i(26, TASK_FEATURE_MODE), b(49, true), m(51, c([
      s(1, deviceId), s(2, 'Connected agent'), b(5, true)
    ]))
  ]);
  const initial = c([
    m(1, geminiRequestMetadata({ modelId: model.upstreamId, tools: true, deviceId })),
    m(2, s(1, crypto.randomUUID().toUpperCase())), x(1001, m(1, generate)),
    x(1004, Buffer.alloc(0)), x(1007, Buffer.alloc(0)), x(1013, Buffer.alloc(0))
  ]);
  return [x(1000, initial), x(1007, query), x(1007, m(2, Buffer.alloc(0)))];
}

module.exports = { GEMINI_CLIENT_VERSION, GEMINI_BUNDLE_ID, TASK_FEATURE_MODE, TOOL_CAPABILITIES,
  geminiRequestHeaders, geminiRequestMetadata, geminiGenerationMessages };
