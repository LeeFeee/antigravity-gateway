'use strict';

const { pathToFileURL } = require('node:url');
const { localTimestamp } = require('./agy-context-state');

const NATIVE_ERROR_PREFIX = 'Encountered error in tool execution: ';

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

// The official write_to_file capture returns a text output with these time
// lines and a file URI. Image bytes separately use the captured view_file
// functionResponse.parts layout. Do not serialize client artifact/delivery
// objects here, or claim the extra image-tool semantics are official CLI text.
function nativeImageToolResponse(image, { createdAt, completedAt = Date.now() } = {}) {
  if (!image?.gatewayLocalPath) throw new Error('原生生图结果缺少已保存文件路径。');
  const output = [
    `Created At: ${localTimestamp(createdAt ?? completedAt)}`,
    `Completed At: ${localTimestamp(completedAt)}`,
    `Created file ${pathToFileURL(image.gatewayLocalPath).href} with requested content.`
  ];
  if (image.url) output.push(`Download URL: ${image.url}`);
  // This is necessary delivery semantics, not an invented JSON field or a
  // copied write_to_file instruction to execute an image as source code.
  output.push('The generated image is attached and has already been delivered to the user. Continue any requested client-tool work using this file or download URL; do not repeat the image delivery receipt in the visible answer.');
  return { output: output.join('\n') };
}

module.exports = { nativeImageToolResponse, nativeClientToolResponse, NATIVE_ERROR_PREFIX };
