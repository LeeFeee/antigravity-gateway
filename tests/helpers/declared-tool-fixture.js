'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Legacy history fixtures describe client tools. A fake upstream must now
// issue a function actually declared in its request, with the observed MCP
// envelope, while preserving the fixture's IDs/signatures/response ordering.
// This helper never changes production validation or accepts unknown calls.
function declaredCall(body, call) {
  const declarations = body.request.tools?.flatMap(tool => tool.functionDeclarations) || [];
  if (declarations.some(tool => tool.name === call.name)) return structuredClone(call);
  const candidates = ['json', ''].map(suffix => 'mcp_gateway_tool_' + crypto.createHash('sha256')
    .update(call.name + '\0' + suffix).digest('hex').slice(0, 16) + (suffix ? '_' + suffix : ''));
  const declaration = candidates.map(name => declarations.find(tool => tool.name === name)).find(Boolean);
  assert.ok(declaration, `Fixture calls undeclared client tool ${call.name}`);
  const args = typeof call.args === 'string' ? JSON.parse(call.args) : call.args;
  return { ...call, name: declaration.name, args: declaration.parameters.properties.argumentsJson
    ? { argumentsJson: JSON.stringify(args), toolSummary: 'Fixture tool execution' }
    : { ...args, toolSummary: 'Fixture tool execution' } };
}

function declaredParts(body, parts) {
  return parts.map(part => part.functionCall ? { ...part, functionCall: declaredCall(body, part.functionCall) } : structuredClone(part));
}

function fixtureTools(...names) {
  return names.map(name => ({ name, kind: 'function', schema: { type: 'object' } }));
}

module.exports = { declaredCall, declaredParts, fixtureTools };
