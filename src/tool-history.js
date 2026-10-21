'use strict';

// These are protocol checks, not task decisions. A self-contained request can
// be forwarded without an old transport connection; an orphan receipt cannot.
function trailingToolResultIds(normalized) {
  const ids = [];
  for (let index = (normalized.messages || []).length - 1; index >= 0; index--) {
    const results = (normalized.messages[index].parts || []).filter(part => part?.type === 'tool_result' && part.id);
    if (!results.length) break;
    ids.push(...results.map(part => String(part.id)));
  }
  return [...new Set(ids)];
}

function hasToolResultHistory(normalized, ids = trailingToolResultIds(normalized)) {
  if (!ids.length) return false;
  const wanted = new Set(ids.map(String)), calls = new Map(), received = new Set();
  for (const message of normalized.messages || []) {
    for (const part of message.parts || []) {
      const id = String(part?.id || '');
      if (!wanted.has(id)) continue;
      if (part.type === 'tool_call') {
        if (message.role !== 'assistant' || !part.name || calls.has(id)) return false;
        calls.set(id, part);
      } else if (part.type === 'tool_result') {
        const call = calls.get(id);
        if (message.role !== 'user' || !call || received.has(id)
            || (part.name && part.name !== call.name)) return false;
        received.add(id);
      }
    }
  }
  return received.size === wanted.size;
}

module.exports = { trailingToolResultIds, hasToolResultHistory };
