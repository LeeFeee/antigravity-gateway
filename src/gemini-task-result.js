'use strict';

const { decodeFields, field, messageField: m, intField: i, concatFields: c } = require('./gemini-wire');
const { GatewayError } = require('./protocol');

const text = (bytes, tag) => field(bytes, tag, 2)?.toString('utf8') || '';

// ListConversationTurns is the native Task result readback endpoint. Only
// accept the current task/turn; never use it to rebuild the agent's history.
function geminiTaskResult(bytes, { conversationId, requestId, prompt, excludedRequestIds = new Set() }) {
  for (const turnField of decodeFields(bytes).filter(f => f.number === 1 && f.wireType === 2)) {
    const turn = turnField.value, ids = field(turn, 1, 2), request = field(turn, 3, 2);
    if (!ids || !request || text(ids, 1) !== conversationId) continue;
    const candidateId = text(ids, 2);
    if (!candidateId || excludedRequestIds.has(candidateId)) continue;
    if (requestId && candidateId !== requestId) continue;
    const query = field(request, 1, 2);
    if (!query || text(query, 1) !== prompt) continue;
    const saved = field(turn, 4, 2);
    if (!saved) continue;
    if (field(saved, 11, 0) === 1n || field(saved, 16, 0) === 1n) {
      throw new GatewayError('Gemini 任务被上游中止或执行失败。', { code: 'gemini_task_failed', status: 502 });
    }
    // SavedGenerateResponse and ClientGenerateResponse carry the same model
    // response objects with different surrounding field numbers. Translate
    // those captured fields without inventing completion, text or decisions.
    const generated = [m(2, ids)];
    for (const f of decodeFields(saved)) {
      const bytesTag = { 1: 1, 5: 6, 6: 8, 17: 30, 18: 25, 24: 39, 25: 40 }[f.number];
      const scalarTag = { 10: 9, 21: 32, 22: 41, 23: 42 }[f.number];
      if (f.wireType === 2 && bytesTag) generated.push(m(bytesTag, f.value));
      else if (f.wireType === 0 && scalarTag) generated.push(i(scalarTag, f.value));
    }
    return { requestId: candidateId, message: m(1003, m(1, c(generated))) };
  }
  return null;
}

module.exports = { geminiTaskResult };
