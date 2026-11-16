'use strict';

const { field, decodeFields } = require('./gemini-wire');
const text = (bytes, tag) => field(bytes, tag, 2)?.toString('utf8') || '';
const repeated = (bytes, tag) => decodeFields(bytes).filter(value => value.number === tag && value.wireType === 2).map(value => value.value);

function googleSearchPermission(permission) {
  const call = permission && field(permission, 1, 2);
  return !!call && text(call, 1) === 'google' && text(call, 2) === 'search';
}

// Current native app has two distinct search progress envelopes. Task mode
// reports typed permission IDs and allToolsUsed, not ToolProcessingState.
// Do not infer a search from explanatory text, tool display names or URLs.
function geminiSearchState(update, previous = null) {
  const tool = field(update, 2, 2);
  if (tool && text(tool, 1) === 'google') {
    const state = field(tool, 3, 0), data = field(tool, 2, 2);
    return { ...previous, protocol: 'chat',
      state: state === undefined ? previous?.state : Number(state),
      ...(data && text(data, 1) ? { request: text(data, 1) } : {}) };
  }
  const task = field(update, 13, 2);
  if (!task) return previous;
  const calls = repeated(task, 1).filter(call => field(call, 4, 0) === 1n && googleSearchPermission(field(call, 8, 2)));
  const used = repeated(task, 7).some(item => field(item, 4, 0) === 1n && googleSearchPermission(field(item, 3, 2)));
  if (!calls.length && !used) return previous;
  const sources = calls.flatMap(call => repeated(call, 11)).flatMap(source => {
    const url = text(source, 1);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return [];
    } catch { return []; }
    return [{ url, title: text(source, 3) }];
  });
  return { ...previous, protocol: 'task', taskToolUsed: used || !!previous?.taskToolUsed,
    sources: [...(previous?.sources || []), ...sources] };
}

module.exports = { geminiSearchState };
