'use strict';

const { prepareToolAdapter } = require('./agy-tool-adapter');

// Share the captured client capability mappings, not Cloud Code's envelope,
// identity, tool metadata, signatures or recovery state. These names belong
// to external_client's MCP catalog on Robin, never to an invented built-in.
function prepareRobinClientAdapter(normalized, clientProfile = '') {
  const adapter = prepareToolAdapter(normalized, { clientProfile, target: 'robin' });
  if (!adapter.adapted) return adapter;
  const messages = (normalized.messages || []).map(message => {
    if (message.role !== 'assistant' || !message.parts?.length
        || message.parts.some(part => !['text', 'tool_call'].includes(part.type))) return message;
    let changed = false;
    const parts = message.parts.map(part => {
      if (part.type !== 'tool_call') return part;
      const mapped = adapter.toProvider(part);
      if (mapped !== part) changed = true;
      return mapped;
    });
    if (!changed) return message;
    // Render typed history, never replace names in user prose, file paths,
    // shell commands, quoted JSON or client tool results.
    const text = parts.map(part => part.type === 'text' ? part.text
      : `[ASSISTANT_TOOL_CALL id=${part.id || ''} name=${part.name}]\n${typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments)}`)
      .filter(Boolean).join('\n');
    return { ...message, parts, text };
  });
  return { ...adapter, normalized: { ...adapter.normalized, messages } };
}

module.exports = { prepareRobinClientAdapter };
