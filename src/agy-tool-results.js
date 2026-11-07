'use strict';


const NATIVE_ERROR_PREFIX = 'Encountered error in tool execution: ';
const CLIENT_TOOL_RESULT = Symbol('clientToolResult');

class ToolReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolReceiptError';
    this.code = 'invalid_tool_reference';
    this.status = 400;
  }
}

function attachClientToolResult(response, part, parsedResult) {
  Object.defineProperty(response, CLIENT_TOOL_RESULT, {
    value: { part, parsedResult }, enumerable: false
  });
  return response;
}

function clientToolResultSource(response) {
  const source = response?.[CLIENT_TOOL_RESULT];
  if (!source) return null;
  return { isError: source.part.isError === true, parsedResult: source.parsedResult,
    raw: source.part.content ?? source.part.result ?? '', references: source.part.references || [],
    hasResponse: Boolean(source.part.response && typeof source.part.response === 'object'),
    ...(Array.isArray(source.part.resultSegments) ? { resultSegments: source.part.resultSegments } : {}) };
}

function createToolReceiptTransform(response, nativeName, toolAdapter) {
  const source = clientToolResultSource(response), references = [];
  for (const reference of source?.references || []) {
    const client = typeof reference === 'string' ? reference : reference?.tool_name ?? reference?.name;
    const existing = references.find(entry => entry.client === client);
    if (existing) { existing.count++; continue; }
    if (!toolAdapter?.toProviderReferences) throw receiptError('动态工具结果缺少当次声明的引用映射。');
    references.push({ client, count: 1, providers: toolAdapter.toProviderReferences([client]) });
  }
  return { mode: source && /^mcp_gateway_tool_[a-f0-9]{16,64}(?:_json)?$/.test(nativeName) ? 'mcp' : 'native', references };
}

function receiptError(message) {
  return new ToolReceiptError(message);
}

function referenceName(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'tool_reference') return '';
  const names = ['tool_name', 'name'].filter(key => Object.hasOwn(block, key)).map(key => block[key]);
  if (!names.length || names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== 1) {
    throw receiptError('工具引用缺少名称，或名称字段不一致。');
  }
  return names[0];
}

function renderResultSegments(segments) {
  return segments.map(segment => {
    if (segment?.type === 'text' && typeof segment.text === 'string') return segment.text;
    if (referenceName(segment)) return JSON.stringify(segment);
    throw receiptError('工具结果来源分段无效。');
  }).join('\n');
}

function remapResultReferences(value, references, segments) {
  if (!references.length) return value;
  const names = new Map(references.map(entry => [entry.client, entry.providers]));
  const counts = new Map();
  function mapBlock(block) {
    const client = referenceName(block);
    if (!client || !names.has(client)) return [block];
    counts.set(client, (counts.get(client) || 0) + 1);
    return names.get(client).map(name => ({ ...block,
      ...(Object.hasOwn(block, 'tool_name') ? { tool_name: name } : {}),
      ...(Object.hasOwn(block, 'name') ? { name } : {}) }));
  }
  let result = value;
  if (segments) {
    const mapped = segments.flatMap(segment => segment.type === 'text' ? [segment] : mapBlock(segment));
    result = renderResultSegments(mapped);
    if (typeof value !== 'string') {
      if (segments.length === 1 && referenceName(segments[0])) result = mapped.length === 1 ? mapped[0] : mapped;
      else { try { result = JSON.parse(result); } catch { /* Mixed blocks remain text. */ } }
    }
  }
  else if (Array.isArray(value)) result = value.flatMap(mapBlock);
  else if (value && typeof value === 'object') {
    const mapped = mapBlock(value);
    result = mapped.length === 1 ? mapped[0] : mapped;
  }
  // Normalization joins real content blocks with newlines. Only complete
  // structured reference blocks recorded by the parser may be rewritten;
  // ordinary prose, quoted names and nested business data stay untouched.
  else if (typeof value === 'string') result = value.split(/(\r?\n)/).map(line => {
    let block;
    try { block = JSON.parse(line); } catch { return line; }
    const mapped = mapBlock(block);
    return mapped.length === 1 && mapped[0] === block ? line : mapped.map(item => JSON.stringify(item)).join('\n');
  }).join('');
  // Legacy flattened receipts lack segment provenance. Ambiguous copies must
  // still fail instead of authorizing broad replacement of ordinary text.
  if (references.some(entry => counts.get(entry.client) !== entry.count)) {
    throw receiptError('工具引用内容与结构化来源不一致，无法无损恢复。');
  }
  return result;
}

function restoreToolReceipt(response, nativeName, transform) {
  const source = clientToolResultSource(response);
  let body = response.response;
  // Gateway-owned media services can supply an explicit native response.
  // HTTP normalization does not accept this internal override; preserve its
  // prepared output instead of exposing a private local delivery placeholder.
  if (source && !source.hasResponse && (transform.mode === 'mcp' || source.resultSegments && transform.references.length)) {
    const raw = source.isError ? source.raw : source.parsedResult;
    // Explicit failures use the official MCP error field. A successful value
    // containing an "error" key remains output; no text heuristic changes it.
    if (source.resultSegments && renderResultSegments(source.resultSegments) !== source.raw) {
      throw receiptError('工具结果来源分段与原始内容不一致。');
    }
    const mapped = remapResultReferences(raw, transform.references, source.resultSegments);
    const value = source.isError && typeof mapped !== 'string' ? JSON.stringify(mapped) : mapped;
    body = transform.mode === 'mcp' ? { [source.isError ? 'error' : 'output']: value }
      : nativeClientToolResponse({ isError: source.isError, content: value }, mapped);
  } else if (transform.references.length && body && typeof body === 'object') {
    body = { ...body };
    for (const key of ['output', 'error']) if (Object.hasOwn(body, key)) body[key] = remapResultReferences(body[key], transform.references);
  }
  return { ...response, name: nativeName, response: body };
}

function nativeClientToolResponse(part, parsedResult) {
  if (part.response && typeof part.response === 'object') return part.response;
  if (!part.isError) return { output: parsedResult };
  // Both real agy permission-rejection and missing-file captures use output
  // text, not a new error/isError JSON field. Preserve the client's raw error
  // bytes (including JSON-looking text) and never fabricate execution times
  // for a tool that ran outside this gateway.
  const raw = part.content ?? part.result ?? '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const alreadyNative = /^(?:Created At: [^\r\n]+\r?\nCompleted At: [^\r\n]+\r?\n)?Encountered error in tool execution:/.test(text);
  return { output: alreadyNative ? text : NATIVE_ERROR_PREFIX + text };
}

// Captured official generate_image output uses these timestamps and its saved
// local image path; image bytes travel separately in functionResponse.parts.
// Download/delivery guidance below is gateway-specific, not official CLI text.
function nativeImageToolResponse(image, { createdAt, completedAt = Date.now() } = {}) {
  const { localTimestamp } = require('./agy-context-state');
  if (!image?.gatewayLocalPath) throw new Error('原生生图结果缺少已保存文件路径。');
  const output = [
    `Created At: ${localTimestamp(createdAt ?? completedAt)}`,
    `Completed At: ${localTimestamp(completedAt)}`,
    `Generated image is saved at ${image.gatewayLocalPath}.`
  ];
  if (image.url) output.push(`Download URL: ${image.url}`);
  // This is necessary delivery semantics, not an invented JSON field or a
  // copied write_to_file instruction to execute an image as source code.
  output.push('The generated image is attached and has already been delivered to the user. Continue any requested client-tool work using this file or download URL; do not repeat the image delivery receipt in the visible answer.');
  return { output: output.join('\n') };
}

module.exports = { ToolReceiptError, nativeImageToolResponse, nativeClientToolResponse, attachClientToolResult,
  clientToolResultSource, createToolReceiptTransform, restoreToolReceipt, NATIVE_ERROR_PREFIX };
