'use strict';

const { toolChoiceRule, normalizeStructured, normalizeStructuredAsync, GatewayError } = require('./protocol');
const { localTimestamp } = require('./agy-context-state');
const { projectSimple } = require('./antigravity-tool-contract');
const { runSync, runAsync } = require('./schema-steps');
const { compileSchema, compileSchemaAsync } = require('./schema-contract');

// Captured from real agy 1.5.2 --json-schema requests.
// This is a local adapter contract, never a private upstream schema/field.
const FINISH_DESCRIPTION = "Finish your task and end the interaction. Don't call this tool unless you are confident that your solution is correct, for example after you've written tests, executed them, and verified the task is complete.";

function* prepareStructuredOutputSteps(normalized, { checkpoint = false, compiler = compileSchema } = {}) {
  const schema = normalized.structuredSchema;
  if (schema == null) return { normalized, schema: null };
  yield compiler(schema);
  if (schema === false) throw new GatewayError('结构化输出 Schema 无法产生任何合法结果。', { code: 'invalid_structured_schema', status: 400 });
  const fallback = () => ({ normalized, schema: null,
    instructions: checkpoint ? '' : 'When returning the final answer, return exactly one JSON value matching the following JSON Schema, without Markdown fences or extra prose. '
      + 'Client tool calls may still be used when required; this schema constrains the final answer, not the tool arguments.\n'
      + JSON.stringify(schema) });
  const choice = toolChoiceRule(normalized.toolChoice);
  // Never steal a client tool/property or satisfy required client work with
  // an internal terminal tool. Unobserved root shapes keep the legacy path.
  if (checkpoint || normalized.autoMode || schema?.type !== 'object'
      || (normalized.tools || []).some(tool => tool.name === 'finish')
      || ['named', 'required'].includes(choice.mode)
      || ['allOf', 'anyOf', 'oneOf', '$ref', 'enum', 'const'].some(key => schema[key] !== undefined)) {
    return fallback();
  }
  const projected = projectSimple(schema);
  // Complex contracts keep the JSON response path with local validation; do
  // not silently weaken their constraints in a protobuf finish declaration.
  if (!projected) return fallback();
  const tool = { name: 'finish', description: FINISH_DESCRIPTION, schema: { ...schema }, nativeSchema: projected.wire };
  // agy's captured protobuf Schema omits JSON Schema additionalProperties.
  // Keep the original strict schema locally for validation, unchanged.
  delete tool.schema.additionalProperties;
  return { schema, normalized: { ...normalized,
    tools: [...(choice.mode === 'none' ? [] : normalized.tools || []), tool],
    toolChoice: choice.mode === 'none' ? 'auto' : normalized.toolChoice
  } };
}

function* finishResultSteps(schema, calls, normalize = normalizeStructured) {
  if (!schema || !calls.some(call => call.name === 'finish')) return null;
  if (calls.length !== 1) throw new GatewayError('结构化完成工具不能与其他工具混合调用。', { code: 'invalid_structured_output', status: 502 });
  const call = calls[0];
  let args = call.arguments;
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { args = null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new GatewayError('结构化完成工具未返回 JSON 对象。', { code: 'invalid_structured_output', status: 502 });
  }
  // No reserved metadata names in 1.5.2: these may be business properties.
  return { call, text: yield normalize(JSON.stringify(args), schema) };
}

function finishResponse(call, now = Date.now()) {
  return { role: 'model', parts: [{ functionResponse: { id: call.id, name: 'finish', response: {
    output: `Created At: ${localTimestamp(now)}\nCompleted At: ${localTimestamp(now)}\nTask is complete. Summarize what you did and do not call any more tools.`
  } } }] };
}

const prepareStructuredOutput = (...args) => runSync(prepareStructuredOutputSteps(...args));
const prepareStructuredOutputAsync = (normalized, options = {}) => runAsync(prepareStructuredOutputSteps(normalized, { ...options, compiler: schema => compileSchemaAsync(schema, options.schemaOptions || { signal: options.signal }) }));
const finishResult = (...args) => runSync(finishResultSteps(...args));
const finishResultAsync = (schema, calls, options) => runAsync(finishResultSteps(schema, calls, (text, contract) => normalizeStructuredAsync(text, contract, options)));
module.exports = { prepareStructuredOutput, prepareStructuredOutputAsync, finishResult, finishResultAsync, finishResponse, FINISH_DESCRIPTION };
