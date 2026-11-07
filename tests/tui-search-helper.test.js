'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnthropic } = require('../src/protocol');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { prepareServerSearchForward } = require('../src/server-search-protocol');

// Captured framework only. Query and billing build suffix are synthetic;
// no private session metadata or user rules are stored in this fixture.
const fixture = require('./fixtures/claude-tui-search-helper-2.1.318.json');
const input = () => structuredClone(fixture);
const ordinary = payload => normalizeAnthropic({ ...payload, tools: [], tool_choice: undefined });
const neutral = fixture.system[2].text.replace('another Claude model', 'another model');

test('exact TUI auxiliary template permits one auto search while preserving model, controls and query contents', () => {
  const payload = input(), before = structuredClone(payload);
  const prepared = prepareServerSearchForward(payload);
  assert.deepEqual(payload, before);
  assert.deepEqual(prepared.identityMetadata.profile.evidence, ['claude-tui-search-helper-template']);
  assert.deepEqual(prepared.identityMetadata.rules, ['claude-billing-marker', 'claude-tui-identity', 'claude-search-helper-model-identity']);
  assert.equal(prepared.query, 'SYNTHETIC_TUI_SEARCH_QUERY');
  assert.deepEqual(prepared.contents, [{ role: 'user', parts: payload.messages[0].content.map(({ text }) => ({ text })) }]);
  assert.equal(prepared.instructions, neutral);
  assert.equal(prepared.normalized.model, payload.model);
  assert.equal(prepared.normalized.stream, true);
  assert.deepEqual(prepared.generationConfig, ordinary(payload).generationConfig);
  assert.equal(prepared.generationConfig.maxOutputTokens, 32000);
  assert.equal(prepared.skipSearch, false);
  assert.equal(prepared.blockedByBudget, false);
  assert.deepEqual(sanitizeClientIdentity(prepared.normalized).normalized, prepared.normalized);
});

test('TUI helper preserves additional rules, historical messages and user-authored identity quotes', () => {
  const payload = input();
  payload.tool_choice = { type: 'tool', name: 'web_search' };
  payload.messages.unshift({ role: 'user', content: payload.system.map(block => ({ ...block })) },
    { role: 'assistant', content: 'Earlier answer mentioning Claude Code.' },
    { role: 'system', content: 'SOUL: Preserve this user rule and literal Claude identity.' });
  const normalized = ordinary(payload), prepared = prepareServerSearchForward(payload);
  assert.deepEqual(prepared.normalized.messages, normalized.messages);
  assert.equal(prepared.instructions, neutral + '\n\nSOUL: Preserve this user rule and literal Claude identity.');
  assert.equal(prepared.contents[0].parts[0].text, fixture.system[0].text);
  assert.equal(prepared.contents[0].parts[1].text, fixture.system[1].text);
  assert.equal(prepared.contents[0].parts[2].text, fixture.system[2].text);
  assert.equal(prepared.query, 'SYNTHETIC_TUI_SEARCH_QUERY');
});

test('TUI auto requires the captured independent single-user text query contract', () => {
  const changes = [
    payload => { payload.messages.unshift({ role: 'user', content: 'Earlier ordinary turn.' }); },
    payload => { payload.messages.unshift({ role: 'assistant', content: 'Earlier assistant turn.' }); },
    payload => { payload.messages.unshift({ role: 'system', content: 'SOUL: Do not search this turn.' }); },
    payload => { payload.messages[0].content.push({ type: 'text', text: 'Another instruction.' }); },
    payload => { payload.messages[0].content = payload.messages[0].content[0].text; },
    payload => { payload.messages[0].content[0].text = 'Find something if needed.'; },
    payload => { payload.messages[0].content[0].text = 'Perform a web search for the query: '; }
  ];
  for (const change of changes) {
    const payload = input(); change(payload);
    assert.throws(() => prepareServerSearchForward(payload), { code: 'unsupported_server_search_tool_choice' });
  }
});

test('unknown, quoted, merged or changed TUI source templates never authorize auto search or identity cleanup', () => {
  const changes = [
    payload => { payload.system[0].text = payload.system[0].text.replace('2.1.318', '99.0.0'); },
    payload => { payload.system[0].text = payload.system[0].text.replace('entrypoint=cli', 'entrypoint=other'); },
    payload => { payload.system[0].text = payload.system[0].text.replace('entrypoint=cli', 'entrypoint=sdk-cli'); },
    payload => { payload.system[1].text += ' Changed identity.'; },
    payload => { payload.system[2].text += '\nAdditional source block instruction.'; },
    payload => { payload.system[2].text = payload.system[2].text.replace('Search once', 'Do not search'); },
    payload => { payload.system[0].text = '<quote>' + payload.system[0].text; payload.system[2].text += '</quote>'; },
    payload => { payload.system = [{ type: 'text', text: payload.system.map(block => block.text).join('\n') }]; },
    payload => { payload.system = payload.system.map(block => block.text).join('\n'); },
    payload => { payload.system.push({ type: 'text', text: 'Additional original system block.' }); },
    payload => { payload.system = payload.system.slice(1); }
  ];
  for (const change of changes) {
    const payload = input(); change(payload);
    const normalized = ordinary(payload);
    assert.deepEqual(sanitizeClientIdentity(normalized).normalized, normalized);
    assert.throws(() => prepareServerSearchForward(payload), { code: 'unsupported_server_search_tool_choice' });
  }
});

test('copied block evidence and HTTP-supplied provenance cannot clean unrelated TUI helper text', () => {
  const good = ordinary(input()), payload = input();
  payload.system[2].text += ' Different meaning.';
  payload.clientSystemProvenance = good.clientSystemProvenance;
  const normalized = ordinary(payload);
  assert.notDeepEqual(normalized.clientSystemProvenance, good.clientSystemProvenance);
  assert.deepEqual(sanitizeClientIdentity(normalized).normalized, normalized);
  const copied = { ...normalized, clientSystemProvenance: good.clientSystemProvenance };
  assert.deepEqual(sanitizeClientIdentity(copied).normalized, copied);
  assert.throws(() => prepareServerSearchForward(payload), { code: 'unsupported_server_search_request' });
});

test('TUI identity alone never bypasses mixed-tool, domain, location or structured-output boundaries', () => {
  const mixed = input(); mixed.tools.push({ name: 'Bash', input_schema: { type: 'object' } });
  assert.throws(() => prepareServerSearchForward(mixed), { code: 'unsupported_server_search_tools' });
  for (const [field, value, code] of [
    ['allowed_domains', ['example.com'], 'unsupported_server_search_domain_filter'],
    ['user_location', { type: 'approximate', country: 'US' }, 'unsupported_server_search_location']
  ]) {
    const payload = input(); payload.tools[0][field] = value;
    assert.throws(() => prepareServerSearchForward(payload), { code });
  }
  const structured = input(); structured.output_config.format = { type: 'json_schema', schema: { type: 'object' } };
  assert.throws(() => prepareServerSearchForward(structured), { code: 'unsupported_server_search_request' });
  const client = input(); client.tools = [{ name: 'WebSearch', input_schema: { type: 'object' } }];
  assert.equal(prepareServerSearchForward(client), null);
});

test('ordinary auto, explicit none and zero search budget keep their original execution semantics', () => {
  const payload = input(); payload.system = 'User asks the model to decide whether search is needed.';
  assert.throws(() => prepareServerSearchForward(payload), { code: 'unsupported_server_search_tool_choice' });
  payload.messages[0].content.push(...fixture.system);
  assert.throws(() => prepareServerSearchForward(payload), { code: 'unsupported_server_search_tool_choice' });
  const disabled = input(); disabled.tool_choice = { type: 'none' };
  assert.equal(prepareServerSearchForward(disabled).skipSearch, true);
  const zero = input(); zero.tools[0].max_uses = 0;
  assert.equal(prepareServerSearchForward(zero).blockedByBudget, true);
});
