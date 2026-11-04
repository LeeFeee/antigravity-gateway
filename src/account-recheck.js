'use strict';

const crypto = require('node:crypto');
const RECHECK_TIMEOUT_MS = 45_000;

function recheckSignal(signal) {
  const deadline = AbortSignal.timeout(RECHECK_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function probeAccountInference(provider, models, signal) {
  const candidates = [...new Set(models || [])].filter(model => typeof model === 'string'
    && !/image|imagen|embedding|video|veo|audio|tts/i.test(model));
  const model = candidates.find(model => /^gemini-.*flash.*(?:low|lite)$/i.test(model))
    || candidates.find(model => /^gemini-.*flash/i.test(model))
    || candidates.find(model => /^gemini-/i.test(model)) || candidates[0];
  if (!model) throw Object.assign(new Error('未找到可用于实际推理检测的模型，账号异常状态保持不变。'), {
    code: 'account_recheck_model_missing', status: 503
  });
  signal?.throwIfAborted();
  // A fresh, tool-free request on this exact provider, never through pool
  // rotation or a caller's conversation. The answer is not stored in logs.
  const sessionId = `account-recheck-${crypto.randomUUID()}`;
  try {
    const result = await provider.send({ system: '', messages: [{ role: 'user', text: '请只回复：OK。' }],
      tools: [], toolChoice: null, stream: false }, model, { signal, sessionId, reuseConversation: false });
    signal?.throwIfAborted();
    if (typeof result?.text !== 'string' || !result.text.trim() || result.toolCalls?.length) {
      throw Object.assign(new Error('实际推理未返回正常文本，账号异常状态保持不变。'), {
        code: 'account_recheck_inference_incomplete', status: 502
      });
    }
    return { model };
  } finally {
    // A malformed tool response must not leave an orphan native task behind.
    try { provider.cancelTask?.(sessionId); } catch { /* preserve the actual probe outcome */ }
  }
}

module.exports = { RECHECK_TIMEOUT_MS, recheckSignal, probeAccountInference };
