'use strict';

const { runSync, runAsync } = require('./schema-steps');
const { ToolContractError } = require('./antigravity-tool-contract');
const { createToolReceiptTransform, restoreToolReceipt } = require('./agy-tool-results');

// Translate only the history supplied in this request. An optional exact native
// projection remains authoritative, but absent account-local state never makes
// client history ineligible. This neither restores missing turns nor records a
// synthetic upstream response or a cross-account projection.
function* translateSubmittedToolHistorySteps(contents, toolAdapter, verifiedToolSteps = new Set()) {
  if (!toolAdapter?.toProvider || !toolAdapter.records?.length) return contents;
  const declared = new Set(toolAdapter.records.map(record => record.clientName));
  const counts = new Map(), resultCounts = new Map(), calls = new Map(), replacements = new Map();
  for (const content of contents) for (const part of content.parts) {
    const id = part.functionCall?.id;
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
    const resultId = part.functionResponse?.id;
    if (resultId) resultCounts.set(resultId, (resultCounts.get(resultId) || 0) + 1);
  }
  for (const [index, content] of contents.entries()) for (const part of content.parts) {
    const call = part.functionCall;
    if (call) {
      if (!call.id || counts.get(call.id) !== 1 || (resultCounts.get(call.id) || 0) > 1
        || verifiedToolSteps.has(index) || !declared.has(call.name)) continue;
      let converted;
      try { converted = yield toolAdapter.toProvider({ ...call, arguments: call.args }); }
      catch (error) {
        // Historical tools may have changed schemas since execution. Keep the
        // client's actual call/result in that case; the upstream decides whether
        // it accepts that history. Do not treat today's schema as past evidence.
        if (error instanceof ToolContractError) continue;
        throw error;
      }
      const candidate = { part, client: call.name, native: converted.name };
      calls.set(call.id, candidate);
      replacements.set(part, { ...part, functionCall: { ...call, name: converted.name, args: converted.arguments } });
      continue;
    }
    const receipt = part.functionResponse, candidate = receipt && calls.get(receipt.id);
    if (!candidate) continue;
    calls.delete(receipt.id);
    if (receipt.name !== candidate.client) { replacements.delete(candidate.part); continue; }
    try {
      const transform = createToolReceiptTransform(receipt, candidate.native, toolAdapter);
      replacements.set(part, { ...part, functionResponse: restoreToolReceipt(receipt, candidate.native, transform) });
    } catch (error) {
      // A previously referenced tool may no longer be declared. Keep both sides
      // of that exchange unchanged instead of inventing a replacement reference.
      if (!(error instanceof ToolContractError)) throw error;
      replacements.delete(candidate.part);
    }
  }
  if (!replacements.size) return contents;
  return contents.map(content => content.parts.some(part => replacements.has(part))
    ? { ...content, parts: content.parts.map(part => replacements.get(part) || part) } : content);
}

const translateSubmittedToolHistory = (...args) => runSync(translateSubmittedToolHistorySteps(...args));
const translateSubmittedToolHistoryAsync = (...args) => runAsync(translateSubmittedToolHistorySteps(...args));
module.exports = { translateSubmittedToolHistory, translateSubmittedToolHistoryAsync };
