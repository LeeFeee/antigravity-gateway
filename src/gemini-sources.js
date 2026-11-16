'use strict';

const { decodeFields, field } = require('./gemini-wire');
const schema = require('./gemini-source-tree.json');

function text(bytes, tag) { return field(bytes, tag, 2)?.toString('utf8') || ''; }
function webSource(bytes) {
  const url = text(bytes, 1);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  } catch { return null; }
  return { url, title: text(bytes, 2), ...(text(bytes, 4) ? { snippet: text(bytes, 4) } : {}) };
}

// Follow captured message types rather than guessing that arbitrary protobuf
// strings/bytes are sources. These are upstream source metadata, not fetched
// page contents. Do not issue network requests for URLs found in a response.
function geminiResponseSources(modelResponse) {
  const tree = field(modelResponse, 5, 2);
  if (!tree) return [];
  const sources = [], pending = [{ bytes: tree, type: schema.root, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    if (++visited > 10000) throw new RangeError('Gemini source tree exceeds node limit');
    const { bytes, type, depth } = pending.pop();
    if (depth > 64) throw new RangeError('Gemini source tree exceeds depth limit');
    const fields = decodeFields(bytes);
    if (type === schema.annotatedString) {
      const content = text(fields, 1);
      for (const range of fields.filter(value => value.number === 2 && value.wireType === 2)) {
        const annotation = field(range.value, 3, 2), inline = annotation && field(annotation, 6, 2);
        const source = inline && field(inline, 3, 2);
        if (!source) continue;
        const parsed = webSource(source);
        if (!parsed) continue;
        const start = field(range.value, 1, 0), end = field(range.value, 2, 0);
        const excerpt = start !== undefined && end !== undefined && start >= 0n && end > start && end <= BigInt(content.length)
          ? content.slice(Number(start), Number(end)) : '';
        sources.push({ ...parsed, sourceId: text(inline, 1), ...(excerpt ? { annotatedText: excerpt } : {}) });
      }
      continue;
    }
    const children = new Map(schema.messages[type] || []);
    for (const value of [...fields].reverse()) {
      const child = children.get(value.number);
      if (child && value.wireType === 2) pending.push({ bytes: value.value, type: child, depth: depth + 1 });
    }
  }
  return sources;
}

function geminiDisplayText(raw, previous, sources) {
  if (!sources.length) return raw;
  // Native Google Search adds these balanced display-only spans in its final
  // frame, after streaming the same unmarked text. Accept that representation
  // change only when actual structured source annotations accompany it and
  // the resulting text still preserves every previously delivered character.
  const pattern = /\[span_(\d+)\]\((start|end)_span\)/g;
  const seen = new Set(); let active = null, pairs = 0;
  for (const match of raw.matchAll(pattern)) {
    if (match[2] === 'start') {
      if (active !== null || seen.has(match[1])) return raw;
      active = match[1]; seen.add(active);
    } else {
      if (active !== match[1]) return raw;
      active = null; pairs++;
    }
  }
  if (!pairs || active !== null) return raw;
  const plain = raw.replace(pattern, '');
  return plain.startsWith(previous) ? plain : raw;
}

module.exports = { geminiResponseSources, geminiDisplayText };
