'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeAnthropic, normalizeResponses, normalizeToolCalls } = require('../src/protocol');

const fixtureDirectory = path.join(__dirname, 'fixtures', 'agent-requests-20261107');
const fixtures = fs.readdirSync(fixtureDirectory).filter(name => name.endsWith('.json'))
  .map(name => ({ name, value: JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8')) }));

function inferenceCaptures(fixture) {
  return (fixture.captures || []).filter(capture => capture.body && typeof capture.body === 'object'
    && /\/v1\/(messages|responses)(?:\?|$)/.test(capture.path));
}
function normalize(capture) {
  return capture.path.includes('/messages') ? normalizeAnthropic(capture.body) : normalizeResponses(capture.body);
}

for (const fixture of fixtures) {
  const captures = inferenceCaptures(fixture.value);
  if (!captures.length) continue;
  test(`current capture normalizes complete declarations and history: ${fixture.name}`, () => {
    for (const capture of captures) {
      const before = JSON.stringify(capture);
      const normalized = normalize(capture);
      assert.deepEqual(normalized.tools.map(tool => tool.name), (capture.body.tools || []).map(tool => tool.name));
      for (const tool of normalized.tools) {
        const original = capture.body.tools.find(item => item.name === tool.name);
        assert.deepEqual(tool.schema, original.input_schema ?? original.parameters ?? { type: 'object' });
      }
      assert.equal(JSON.stringify(capture), before);
      assert.ok(normalized.messages.every(message => !['developer', 'system'].includes(message.role)));
    }
  });
}

test('Claude ToolSearch references survive normalization alongside expanded declarations', () => {
  const fixture = fixtures.find(item => item.name === 'claude-tool-search.json');
  assert.ok(fixture);
  const normalized = inferenceCaptures(fixture.value).map(normalize);
  const references = normalized.flatMap(item => item.messages.flatMap(message => message.parts || []))
    .filter(part => part.type === 'tool_result' && part.references?.length);
  assert.ok(references.length > 0);
  assert.ok(references.some(part => part.references.includes('CronCreate')));
  assert.ok(references.some(part => part.content.includes('"tool_reference"')));
  assert.ok(normalized.some(item => item.tools.some(tool => tool.name === 'CronCreate')));
});

test('Responses developer instructions remain instructions, including stored legacy messages', () => {
  const normalized = normalizeResponses({
    instructions: 'Keep project rules.',
    input: [{ role: 'developer', content: 'Keep tool permissions.' },
      { role: 'system', content: [{ type: 'input_text', text: 'Use Chinese.' }] },
      { role: 'user', content: 'Read the fixture.' }]
  }, { system: '', messages: [{ role: 'developer', text: 'Legacy instruction.' }] });
  assert.match(normalized.system, /Legacy instruction/);
  assert.match(normalized.system, /Keep tool permissions/);
  assert.match(normalized.system, /Use Chinese/);
  assert.deepEqual(normalized.messages.map(message => message.role), ['user']);
});

test('actual image tool results preserve media without duplicating base64 inside output text', () => {
  const seen = new Set();
  for (const fixture of fixtures) {
    for (const capture of inferenceCaptures(fixture.value)) {
      const normalized = normalize(capture);
      for (const message of normalized.messages) for (const part of message.parts || []) {
        if (part.type !== 'tool_result' || !part.media?.length) continue;
        for (const media of part.media) {
          if (!media.data) continue;
          seen.add(fixture.value.agent);
          assert.equal(media.mediaType, 'image/png');
          assert.ok(Buffer.from(media.data, 'base64').length > 0);
          assert.ok(!part.content.includes(media.data));
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['claude', 'dsh', 'hermes', 'pi']);
});

test('original complex tool contracts are enforced at the final client boundary', () => {
  const tool = { name: 'choose', schema: { type: 'object', properties: {
    choice: { oneOf: [{ type: 'integer', minimum: 2 }, { const: { all: true } }] }
  }, required: ['choice'], additionalProperties: false } };
  assert.equal(normalizeToolCalls([{ name: 'choose', arguments: { choice: { all: true } } }], [tool])[0].name, 'choose');
  for (const args of [{ choice: 1 }, { choice: '2' }, { choice: 2, extra: true }]) {
    assert.throws(() => normalizeToolCalls([{ name: 'choose', arguments: args }], [tool]), { code: 'invalid_tool_call' });
  }
});
