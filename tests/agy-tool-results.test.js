'use strict';
const assert = require('node:assert/strict'), test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { nativeImageToolResponse } = require('../src/agy-tool-results');
const { localTimestamp } = require('../src/agy-context-state');
const { buildDirectRequest } = require('../src/direct-provider');

test('generated-image result uses captured native text envelope without local artifact fields', () => {
  const image = { gatewayLocalPath: path.resolve('fixture image #1.png'), url: 'https://gateway.example/v1/files/file_test/content' };
  const createdAt = 1792399120000, completedAt = createdAt + 4000;
  const response = nativeImageToolResponse(image, { createdAt, completedAt });
  assert.deepEqual(Object.keys(response), ['output']);
  assert.ok(response.output.startsWith(`Created At: ${localTimestamp(createdAt)}\nCompleted At: ${localTimestamp(completedAt)}\nCreated file ${pathToFileURL(image.gatewayLocalPath).href} with requested content.\n`));
  assert.ok(response.output.includes(`Download URL: ${image.url}`));
  assert.match(response.output, /already been delivered/);
  assert.doesNotMatch(JSON.stringify(response), /"artifact"|"delivery"|"gateway_path"|"handled_by"|execute this code/);
});

test('local-only image results need no public URL and cannot invent a missing saved path', () => {
  const output = nativeImageToolResponse({ gatewayLocalPath: path.resolve('image.png') }).output;
  assert.doesNotMatch(output, /Download URL:|undefined/);
  assert.throws(() => nativeImageToolResponse({}), /缺少已保存文件路径/);
});

test('ordinary client JSON tool results are not stripped or converted as private image metadata', () => {
  const result = { artifact: { gateway_path: '/user/data', url: 'https://example.com' }, delivery: { handled_by: 'user' } };
  const request = buildDirectRequest({ messages: [
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c', name: 'client_tool', arguments: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c', name: 'client_tool', content: JSON.stringify(result) }] }
  ] }, 'gemini-test', 'p', 's');
  assert.deepEqual(request.request.contents.at(-1).parts[0].functionResponse.response.output, result);
});
