'use strict';

const { toolChoiceRule, normalizeStructured, GatewayError } = require('./protocol');
const { localTimestamp } = require('./agy-context-state');

// Captured from real agy 1.4.2 --json-schema requests and resumed history.
// This is a local adapter contract, never a private upstream schema/field.
const FINISH_DESCRIPTION = "Finish your task and end the interaction. Don't call this tool unless you are confident that your solution is correct, for example after you've written tests, executed them, and verified the task is complete.";
const FINISH_METADATA = Object.freeze({
  toolAction: { type: 'string', description: "Brief 2-5 word phrase in -ing form describing the specific action. Capitalize like a sentence. Some examples: 'Analyzing directory', 'Searching the web', 'Checking git status', 'Running tests', 'Searching code'." },
  toolSummary: { type: 'string', description: "Brief 2-5 word noun phrase describing the specific task. Capitalize like a sentence. Some examples: 'Directory analysis', 'Web search', 'Git status check', 'Test execution', 'Code search'." }
});

function prepareStructuredOutput(normalized, { checkpoint = false } = {}) {
  const schema = normalized.structuredSchema;
  const choice = toolChoiceRule(normalized.toolChoice);
  // Never steal a client tool/property or satisfy required client work with
  // an internal terminal tool. Unobserved root shapes keep the legacy path.
  if (checkpoint || normalized.autoMode || schema?.type !== 'object'
      || (normalized.tools || []).some(tool => tool.name === 'finish')
      || ['named', 'required'].includes(choice.mode)
      || ['allOf', 'anyOf', 'oneOf', '$ref', 'enum', 'const'].some(key => schema[key] !== undefined)
      || Object.keys(FINISH_METADATA).some(key => Object.hasOwn(schema.properties || {}, key)
        || schema.required?.includes(key))) {
    return { normalized, schema: null };
  }
  const tool = { name: 'finish', description: FINISH_DESCRIPTION, schema: {
    ...schema,
    properties: { ...schema.properties, ...FINISH_METADATA },
    required: [...(schema.required || []), 'toolSummary', 'toolAction']
  } };
  // agy's captured protobuf Schema omits JSON Schema additionalProperties.
  // Keep the original strict schema locally for validation, unchanged.
  delete tool.schema.additionalProperties;
  return { schema, normalized: { ...normalized,
    tools: [...(choice.mode === 'none' ? [] : normalized.tools || []), tool],
    toolChoice: choice.mode === 'none' ? 'auto' : normalized.toolChoice
  } };
}

function finishResult(schema, calls) {
  if (!schema || !calls.some(call => call.name === 'finish')) return null;
  if (calls.length !== 1) throw new GatewayError('结构化完成工具不能与其他工具混合调用。', { code: 'invalid_structured_output', status: 502 });
  const call = calls[0];
  let args = call.arguments;
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { args = null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new GatewayError('结构化完成工具未返回 JSON 对象。', { code: 'invalid_structured_output', status: 502 });
  }
  const { toolAction, toolSummary, ...value } = args;
  return { call, text: normalizeStructured(JSON.stringify(value), schema) };
}

function finishResponse(call, now = Date.now()) {
  return { role: 'model', parts: [{ functionResponse: { id: call.id, name: 'finish', response: {
    output: `Created At: ${localTimestamp(now)}\nCompleted At: ${localTimestamp(now)}\nTask is complete. Summarize what you did and do not call any more tools.`
  } } }] };
}

module.exports = { prepareStructuredOutput, finishResult, finishResponse, FINISH_DESCRIPTION, FINISH_METADATA };
