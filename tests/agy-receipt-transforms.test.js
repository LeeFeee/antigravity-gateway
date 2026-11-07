'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgySessionStore, newState, contentFingerprint, recordClientProjection, recordStreamProjection,
  restoreClientProjections, recordResponse } = require('../src/agy-session-state');
const { prepareNativeContext } = require('../src/agy-context-state');
const { attachClientToolResult, nativeClientToolResponse, NATIVE_ERROR_PREFIX } = require('../src/agy-tool-results');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');

const models = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'];
const model = models[0];
const user = text => ({ role: 'user', parts: [{ text }] });
const answer = (text, signature) => ({ role: 'model', parts: [{ text, ...(signature ? { thoughtSignature: signature } : {}) }] });
const call = (id, name, args = {}, signature) => ({ role: 'model', parts: [{ functionCall: { id, name, args },
  ...(signature ? { thoughtSignature: signature } : {}) }] });
const nativeName = 'mcp_gateway_tool_1234567890abcdef';

function receipt(id, name, content, { isError = false, references = [], media } = {}) {
  let parsed = content;
  if (typeof content === 'string') { try { parsed = JSON.parse(content); } catch { /* plain text */ } }
  const source = { type: 'tool_result', id, name, content, ...(isError ? { isError } : {}), ...(references.length ? { references } : {}) };
  const response = { id, name, response: nativeClientToolResponse(source, parsed), ...(media ? { parts: media } : {}) };
  attachClientToolResult(response, source, parsed);
  return { role: 'model', parts: [{ functionResponse: response }] };
}

function issue(state, prefix, visible, native, target = model, kind = 'client_tools', now = Date.now()) {
  recordClientProjection(state, prefix, visible, target, [native], now, kind ? { kind } : {});
}

test('client receipt provenance is non-enumerable and absent from wire JSON and content fingerprints', () => {
  const content = receipt('one', 'Search', 'private result', { isError: true, references: ['Read'] });
  const response = content.parts[0].functionResponse;
  assert.equal(Object.getOwnPropertySymbols(response).length, 1);
  assert.equal(Object.getOwnPropertyDescriptor(response, Object.getOwnPropertySymbols(response)[0]).enumerable, false);
  const wireCopy = JSON.parse(JSON.stringify(content));
  assert.equal(contentFingerprint(content), contentFingerprint(wireCopy));
  assert.doesNotMatch(JSON.stringify(content), /parsedResult|references|clientToolResult|isError/);
});

test('only proven MCP calls move explicit errors to response.error and preserve raw bytes and media', () => {
  for (const content of ['false', '0', 'null', ' { "code": 7 }\n', '', NATIVE_ERROR_PREFIX + 'actual upstream text']) {
    const state = newState('a', 's'), prefix = [user('read')];
    const visible = call('one', 'Read'), native = call('one', nativeName, { toolSummary: 'Read file' }, 'signature');
    issue(state, prefix, visible, native);
    const media = [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }];
    const result = receipt('one', 'Read', content, { isError: true, media });
    const before = JSON.stringify(result);
    const restored = restoreClientProjections(state, [...prefix, visible, result], model);
    assert.deepEqual(restored[1], native);
    assert.deepEqual(restored[2].parts[0].functionResponse, { id: 'one', name: nativeName, response: { error: content }, parts: media });
    assert.equal(JSON.stringify(result), before);
  }
  for (const content of ['{"error":"ordinary data"}', NATIVE_ERROR_PREFIX + 'literal success']) {
    const state = newState('a', 's'), prefix = [user('read')], visible = call('one', 'Read');
    issue(state, prefix, visible, call('one', nativeName));
    const result = receipt('one', 'Read', content);
    assert.deepEqual(restoreClientProjections(state, [...prefix, visible, result], model).at(-1).parts[0].functionResponse.response,
      result.parts[0].functionResponse.response);
  }
});

test('native file-tool errors retain their original output rules while IDs select distinct same-name calls', () => {
  const state = newState('a', 's'), prefix = [user('read both')];
  const visible = { role: 'model', parts: [...call('one', 'Read').parts, ...call('two', 'Read').parts] };
  const native = { role: 'model', parts: [...call('one', 'read_file', { Path: '/tmp/a.txt', StartLine: 1, EndLine: 1 }).parts,
    ...call('two', nativeName).parts] };
  issue(state, prefix, visible, native);
  const results = { role: 'model', parts: [...receipt('two', 'Read', 'denied', { isError: true }).parts,
    ...receipt('one', 'Read', 'missing', { isError: true }).parts] };
  const output = restoreClientProjections(state, [...prefix, visible, results], model).at(-1).parts;
  assert.deepEqual(output.map(part => part.functionResponse.name), [nativeName, 'read_file']);
  assert.deepEqual(output.map(part => part.functionResponse.response), [{ error: 'denied' }, { output: NATIVE_ERROR_PREFIX + 'missing' }]);
});

test('gateway-owned native response overrides never expose private media placeholders through MCP conversion', () => {
  const state = newState('a', 's'), prefix = [user('image')], visible = call('one', 'ImageService');
  issue(state, prefix, visible, call('one', nativeName));
  const source = { type: 'tool_result', content: 'private-local-placeholder', isError: true,
    response: { output: 'Created file file:///generated.png with requested content.' } };
  const response = attachClientToolResult({ id: 'one', name: 'ImageService', response: nativeClientToolResponse(source, source.content) }, source, source.content);
  const restored = restoreClientProjections(state, [...prefix, visible, { role: 'model', parts: [{ functionResponse: response }] }], model);
  assert.deepEqual(restored.at(-1).parts[0].functionResponse.response, source.response);
  assert.doesNotMatch(JSON.stringify(restored), /private-local-placeholder/);
  assert.doesNotMatch(JSON.stringify(state.receiptTransforms), /private-local-placeholder|Created file/);
});

test('foreign IDs, edited prefixes/calls, missing projections and repeated receipts cannot borrow a mapping', () => {
  const prefix = [user('original')], visible = call('one', 'Read'), native = call('one', nativeName, {}, 'signature');
  const cases = [
    [prefix, visible, receipt('foreign', 'Read', 'denied', { isError: true }), model],
    [prefix, visible, receipt('one', 'OtherRead', 'denied', { isError: true }), model],
    [[user('edited')], visible, receipt('one', 'Read', 'denied', { isError: true }), model],
    [prefix, call('one', 'Read', { changed: true }), receipt('one', 'Read', 'denied', { isError: true }), model],
    [prefix, visible, receipt('one', 'Read', 'denied', { isError: true }), 'unverified-model']
  ];
  for (const [history, submitted, result, target] of cases) {
    const state = newState('a', 's'); issue(state, prefix, visible, native);
    const output = restoreClientProjections(state, [...history, submitted, result], target);
    assert.deepEqual(output.at(-1), result);
    assert.equal(state.receiptTransforms, undefined);
  }
  const state = newState('a', 's'); issue(state, prefix, visible, native);
  const result = receipt('one', 'Read', 'denied', { isError: true });
  assert.deepEqual(restoreClientProjections(newState('b', 's'), [...prefix, visible, result], model).at(-1), result);
  assert.deepEqual(restoreClientProjections(state, [...prefix, visible, result, result], model).at(-1), result);
  const duplicates = { role: 'model', parts: [...result.parts, ...result.parts] };
  assert.deepEqual(restoreClientProjections(state, [...prefix, visible, duplicates], model).at(-1), duplicates);
});

function adapter(version = 1) {
  const readSchema = version === 1 ? { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }
    : { oneOf: [{ type: 'string' }, { type: 'null' }] };
  return prepareAntigravityTools({ tools: [
    { name: 'Search', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
    { name: 'ReadTarget', schema: readSchema }
  ] });
}

function mappedCall(toolAdapter, id, name, args, signature) {
  const upstream = toolAdapter.toProvider({ id, name, arguments: args });
  return { visible: call(id, name, args), native: call(id, upstream.name, upstream.arguments, signature) };
}

test('two tool rounds and signed answers replay exact receipt mappings after restarts, declaration changes and deletion', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-receipt-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldAdapter = adapter(), changedAdapter = adapter(2);
  assert.notEqual(oldAdapter.toProviderName('ReadTarget'), changedAdapter.toProviderName('ReadTarget'));
  const prefix = [user('private prompt')];
  const search = mappedCall(oldAdapter, 'search', 'Search', { query: 'files' }, 'search-signature');
  const read = mappedCall(oldAdapter, 'read', 'ReadTarget', { path: '/tmp/a.txt' }, 'read-signature');
  const reference = { type: 'tool_reference', tool_name: 'ReadTarget' };
  const privateResult = 'private-result-not-persisted\n' + JSON.stringify(reference) + '\nUse ReadTarget literally here.';
  const firstResult = () => receipt('search', 'Search', privateResult, { references: ['ReadTarget'] });
  const secondResult = () => receipt('read', 'ReadTarget', '0', { isError: true });
  const transact = callback => new AgySessionStore({ directory }).transact('account', 'session', null,
    async (state, checkpoint) => { await callback(state); checkpoint(); });
  let firstNativeReceipt, secondNativeReceipt, cascade;
  await transact(state => { cascade = state.cascadeId; issue(state, prefix, search.visible, search.native); });
  await transact(state => {
    const context = prepareNativeContext(state, [...prefix, search.visible, firstResult()], model, { toolAdapter: oldAdapter });
    firstNativeReceipt = context.sourceContents.at(-1);
    assert.match(firstNativeReceipt.parts[0].functionResponse.response.output, new RegExp(oldAdapter.toProviderName('ReadTarget')));
    assert.match(firstNativeReceipt.parts[0].functionResponse.response.output, /Use ReadTarget literally here\./);
    issue(state, context.sourceContents, read.visible, read.native);
  });
  changedAdapter.toProviderReferences = () => assert.fail('Old receipts must not use new declaration mappings');
  const history = () => [...prefix, search.visible, firstResult(), read.visible, secondResult()];
  await transact(state => {
    assert.equal(state.cascadeId, cascade);
    const context = prepareNativeContext(state, history(), model, { toolAdapter: changedAdapter });
    assert.deepEqual(context.sourceContents[1], search.native);
    assert.deepEqual(context.sourceContents[2], firstNativeReceipt);
    assert.deepEqual(context.sourceContents[3], read.native);
    secondNativeReceipt = context.sourceContents[4];
    assert.deepEqual(secondNativeReceipt.parts[0].functionResponse.response, { error: '0' });
    recordResponse(state, context.sourceContents, model, answer('DONE', 'answer-signature'));
  });
  await transact(state => {
    assert.equal(state.cascadeId, cascade);
    const emptyAdapter = prepareAntigravityTools({ tools: [] });
    const context = prepareNativeContext(state, [...history(), answer('DONE'), user('continue')], models[2], { toolAdapter: emptyAdapter });
    assert.deepEqual(context.sourceContents[2], firstNativeReceipt);
    assert.deepEqual(context.sourceContents[4], secondNativeReceipt);
    assert.equal(context.contents[5].parts[0].thoughtSignature, 'answer-signature');
    assert.equal(Object.keys(state.receiptTransforms).length, 2);
    assert.ok(Object.values(state.receiptTransforms).every(entry => entry.version === 1));
  });
  const saved = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
  assert.equal(saved.length, 1);
  const serialized = fs.readFileSync(path.join(directory, saved[0]), 'utf8');
  assert.doesNotMatch(serialized, /private-result-not-persisted|private prompt|Use ReadTarget literally here|"parsedResult"/);
});

test('structured dynamic references expand declared views, while ambiguous flattened text fails without mutation', () => {
  const toolAdapter = prepareAntigravityTools({ tools: [
    { name: 'Search', schema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'ReadTarget', schema: { type: 'object', properties: { path: { type: 'string' } } } }
  ] });
  const prefix = [user('search')], search = mappedCall(toolAdapter, 'search', 'Search', {}, 'signature');
  const reference = { type: 'tool_reference', tool_name: 'ReadTarget', annotation: 'keep' };
  for (const value of [reference, [reference, { nested: reference }]]) {
    const state = newState('a', 's'); issue(state, prefix, search.visible, search.native);
    const result = receipt('search', 'Search', value, { references: ['ReadTarget'] });
    const output = restoreClientProjections(state, [...prefix, search.visible, result], model, { toolAdapter }).at(-1).parts[0].functionResponse.response.output;
    const mapped = toolAdapter.toProviderNames('ReadTarget').map(tool_name => ({ ...reference, tool_name }));
    assert.deepEqual(output, Array.isArray(value) ? [...mapped, { nested: reference }] : mapped);
  }
  const state = newState('a', 's'); issue(state, prefix, search.visible, search.native);
  const ambiguous = receipt('search', 'Search', [JSON.stringify(reference), JSON.stringify(reference)].join('\n'), { references: ['ReadTarget'] });
  const before = JSON.stringify(ambiguous);
  assert.throws(() => restoreClientProjections(state, [...prefix, search.visible, ambiguous], model, { toolAdapter }), { code: 'invalid_tool_reference' });
  assert.equal(JSON.stringify(ambiguous), before);
  assert.equal(state.receiptTransforms, undefined);
});

test('only explicitly marked client-tool projections share the verified model family', () => {
  const prefix = [user('read')], visible = call('one', 'Read'), native = call('one', nativeName, {}, 'signature');
  for (const source of models) for (const target of models) {
    for (const kind of ['client_tools', undefined]) {
      const state = newState('a', 's'); issue(state, prefix, visible, native, source, kind || null);
      const output = restoreClientProjections(state, [...prefix, visible], target);
      assert.deepEqual(output[1], source === target || kind === 'client_tools' ? native : visible);
      assert.deepEqual(restoreClientProjections(state, [...prefix, visible], 'unverified-model')[1], visible);
    }
    const state = newState('a', 's');
    recordStreamProjection(state, prefix, visible, source, [native]);
    assert.deepEqual(restoreClientProjections(state, [...prefix, visible], target)[1], source === target ? native : visible);
  }
});

test('receipt metadata shares the bounded cache and cannot authorize restoration after call projection eviction', () => {
  const state = newState('a', 's'), prefix = [user('read')];
  for (let index = 0; index < 270; index++) {
    const visible = call(`call-${index}`, 'Read'), native = call(`call-${index}`, nativeName);
    issue(state, prefix, visible, native, model, 'client_tools', index * 2);
    restoreClientProjections(state, [...prefix, visible, receipt(`call-${index}`, 'Read', `private-receipt-${index}`)], model, { now: index * 2 + 1 });
  }
  assert.equal(Object.keys(state.projections).length + Object.keys(state.receiptTransforms).length, 512);
  assert.doesNotMatch(JSON.stringify(state.receiptTransforms), /private-receipt/);
  const result = receipt('call-269', 'Read', 'private-receipt-269');
  state.projections = {};
  assert.deepEqual(restoreClientProjections(state, [...prefix, call('call-269', 'Read'), result], model).at(-1), result);
});
