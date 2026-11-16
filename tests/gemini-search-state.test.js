'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/gemini/task-search-status.json');
const { geminiSearchState } = require('../src/gemini-search-state');
const { messageField: m, stringField: s, intField: i, concatFields: c } = require('../src/gemini-wire');

test('captured native Task search uses structured tool identity and does not prematurely complete', () => {
  let state = null;
  for (const value of fixture.updates) state = geminiSearchState(Buffer.from(value, 'base64'), state);
  assert.equal(state.protocol, 'task');
  assert.equal(state.taskToolUsed, true);
  assert.equal(state.state, undefined);
  assert.deepEqual(state.sources, []);
});

test('a client tool or model-written Google Search label is not native search execution', () => {
  const permission = m(1, c([s(1, 'external_client'), s(2, 'search')]));
  const update = m(13, c([m(1, c([s(5, 'Google Search'), i(4, 1), m(8, permission)])),
    m(7, c([s(1, 'Google Search'), i(4, 1), m(3, permission)])), s(4, 'Google Search completed') ]));
  assert.equal(geminiSearchState(update), null);
});
