'use strict';

const { GatewayError } = require('./protocol');

// A protobuf Struct object adds Struct + map entry + Value messages at each
// level; an array adds ListValue + Value. The captured full Codex catalog
// exceeds Google's recursion limit of 50 after the MCP result envelopes.
// Reserve room for those envelopes, and transport only deep tool arguments
// as JSON text. The original schema remains verbatim in the declaration and
// the normal client-schema validator still checks the decoded arguments.
const MAX_TOOL_MESSAGE_DEPTH = 32;
function geminiValueMessageDepth(value) {
  if (!value || typeof value !== 'object') return 0;
  let child = 0;
  for (const item of Object.values(value)) child = Math.max(child, geminiValueMessageDepth(item));
  return (Array.isArray(value) ? 2 : 3) + child;
}

function prepareGeminiToolSchema(tool) {
  if (geminiValueMessageDepth(tool) <= MAX_TOOL_MESSAGE_DEPTH) return { tool, encoded: false };
  return { encoded: true, tool: { ...tool,
    description: `${tool.description || ''}\nTransport encoding: pass the complete original argument object as JSON in arguments_json. The connected client receives the decoded object, not this transport wrapper.`,
    inputSchema: { type: 'object', properties: {
      arguments_json: { type: 'string', description: `JSON encoding of an argument object conforming to this complete original JSON Schema:\n${JSON.stringify(tool.inputSchema)}` }
    }, required: ['arguments_json'], additionalProperties: false }
  } };
}

function decodeGeminiToolArguments(args, encoded) {
  if (!encoded) return args;
  const invalid = () => new GatewayError('Gemini 工具参数的 JSON 传输编码无效。', { code: 'gemini_tool_arguments_encoding_invalid', status: 502 });
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).length !== 1 || typeof args.arguments_json !== 'string') throw invalid();
  let decoded;
  try { decoded = JSON.parse(args.arguments_json); } catch { throw invalid(); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw invalid();
  return decoded;
}

module.exports = { geminiValueMessageDepth, prepareGeminiToolSchema, decodeGeminiToolArguments };
