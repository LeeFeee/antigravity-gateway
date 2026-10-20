'use strict';

const crypto = require('node:crypto');

// Actual Hermes 0.21.7 CLI capture, 2026-10-20. Its generic SDK header and
// missing session header are not identity. This selects translation only;
// it never authenticates callers or grants conversation/permission access.
const HERMES_CLIENT_PROFILE = 'hermes-0.21.7-captured';
const DEFAULT_IDENTITY_HASH = '36c1f5a2e92cd1d018311eaf4c8f1e8886672eae78212e033c681d0e3d5d506f';
const FRAMEWORK_START = 'You run on Hermes Agent (by Nous Research). When the user needs help with Hermes itself';
const FRAMEWORK_LENGTH = 4317;
const FRAMEWORK_HASH = 'c680bfe86ab9861fa9b99505a58a9108a0adc410697b968b2962bd3315f5192a';
const CODING_LENGTH = 2830;
const CODING_HASH = 'd0a8f74f631c04073d4140863d8f1ea156fe01e55d35e67cd7081d920c2f1a32';
const hashes = {
  patch: 'b2231b85b7abd2ea50087dc273e0b45c4102942a4fada126b05f6a369f139db2',
  read_file: '8ad33974c3ce593d41ef977072a83bf4263a148da840f8621f017ff3dbf53ea0',
  terminal: '9564255be226c07928fa5aced00f4c2972a3f968ae7229b2614b8f0ae680241a',
  write_file: '47ef947c13abdd48a4e8391ceba2e97c9d5726f60331fb9bb9511a19c8543ccf'
};
function stable(value, depth = 0) {
  // Deep unknown schemas cannot equal a captured declaration; do not recurse
  // without a bound while selecting an optional capability profile.
  if (depth > 64) return null;
  return Array.isArray(value) ? value.map(v => stable(v, depth + 1)) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key], depth + 1)])) : value;
}
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');
function capturedHermesTool(tool) {
  return !tool.internal && tool.kind === 'function' && Object.hasOwn(hashes, tool.name)
    && hash({ description: tool.description, schema: tool.schema }) === hashes[tool.name];
}
function frameworkRange(text) {
  let from = 0, found;
  for (;;) {
    const start = text.indexOf(FRAMEWORK_START, from);
    if (start < 0) return found;
    const end = start + FRAMEWORK_LENGTH;
    if ((start === 0 || text.slice(start - 2, start) === '\n\n')
        && (end === text.length || text.slice(end, end + 2) === '\n\n')
        && hash(text.slice(start, end)) === FRAMEWORK_HASH) {
      // A quoted duplicate is ambiguous: never guess which copy owns the
      // actual framework or rewrite user content to force native naming.
      if (found) return undefined;
      found = { start, end };
    }
    from = start + FRAMEWORK_START.length;
  }
}
function capturedHermesClient(normalized) {
  return normalized.protocol === 'chat'
    && frameworkRange(String(normalized.system || ''))
    && (normalized.tools || []).some(capturedHermesTool) ? HERMES_CLIENT_PROFILE : '';
}
function toolReferences(text, mappings) {
  // Only call on an exactly captured framework block/declaration, never user
  // messages, parameter values, arbitrary project rules or tool results.
  return text.replace(/\b(read_file|write_file)\b/g, name => mappings.get(name)?.name || name)
    .replace(/\bterminal\b(?= for:)|(?<=\bin )\bterminal\b|(?<=`)terminal(?=`)/g, name => mappings.get(name)?.name || name)
    .replace(/(?<=\buse )patch\b|(?<=\buse ')patch(?=')|(?<=`)patch(?=`)/g, name => mappings.get(name)?.name || name);
}
function hermesSystemText(text, mappings, { identity = 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.' } = {}) {
  const range = frameworkRange(text);
  if (!range) return text;
  let prefix = text.slice(0, range.start), end = range.end;
  if (hash(prefix.replace(/\n\n$/, '')) === DEFAULT_IDENTITY_HASH) {
    prefix = prefix.replace(/^You are Hermes Agent, built by Nous Research\./, identity);
  }
  let translated = toolReferences(text.slice(range.start, end), mappings)
    .replace(/^You run on Hermes Agent \(by Nous Research\)\. /, '')
    .replace('Hermes delivers their message', 'The runtime delivers their message');
  // The optional coding brief is a separately captured contiguous block.
  // Stop before project context, skills, memory and volatile runtime hints.
  const coding = text.slice(end + 2, end + 2 + CODING_LENGTH);
  if (text.slice(end, end + 2) === '\n\n' && hash(coding) === CODING_HASH
      && (end + 2 + CODING_LENGTH === text.length || text.slice(end + 2 + CODING_LENGTH, end + 4 + CODING_LENGTH) === '\n\n')) {
    // This captured brief still mentions the older multi-mode patch API, but
    // the captured executor schema has only path/old_string/new_string/
    // replace_all. Remove those unsupported fixed hints, not user examples
    // or argument values, and do not add a fictitious mode to the declaration.
    const supportedCoding = mappings.has('patch') ? coding
      .replace(" in `mode='replace'`", '')
      .replace(" Reach for `mode='patch'` (V4A) only when an edit genuinely spans several files at once.", '') : coding;
    translated += '\n\n' + toolReferences(supportedCoding, mappings);
    end += 2 + CODING_LENGTH;
  }
  // A custom SOUL identity, project rules and real runtime are user/client
  // context, not a provider brand template. Preserve them byte for byte.
  return prefix + translated + text.slice(end);
}

module.exports = { HERMES_CLIENT_PROFILE, capturedHermesClient, capturedHermesTool, hermesSystemText, toolReferences };
