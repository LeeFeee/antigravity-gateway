'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { field } = require('../src/gemini-wire');
const { geminiResponseSources, geminiDisplayText } = require('../src/gemini-sources');
const fixture = require('./fixtures/gemini/search-display.json');

test('captured final Google Search annotation preserves all previously streamed text', () => {
  const response = Buffer.from(fixture.modelResponseBase64, 'base64');
  const sources = geminiResponseSources(response), raw = field(field(response, 2, 2), 1, 2).toString();
  assert.equal(sources.length, 1);
  assert.equal(new URL(sources[0].url).hostname, 'support.google.com');
  assert.equal(sources[0].annotatedText, fixture.previousText);
  assert.equal(geminiDisplayText(raw, fixture.previousText, sources), fixture.previousText);
  assert.equal(geminiDisplayText(raw, '', sources), fixture.previousText);
});

test('literal, unbalanced and substantive rewrites are not hidden as citation formatting', () => {
  const source = [{ url: 'https://example.invalid/', title: 'source' }];
  const raw = '[span_0](start_span)literal[span_0](end_span)';
  assert.equal(geminiDisplayText(raw, '', []), raw);
  assert.equal(geminiDisplayText(raw, raw, source), raw);
  assert.equal(geminiDisplayText(raw, 'changed', source), raw);
  for (const invalid of ['[span_0](start_span)unclosed', '[span_0](start_span)x[span_1](end_span)',
    '[span_0](start_span)[span_1](start_span)x[span_1](end_span)[span_0](end_span)']) {
    assert.equal(geminiDisplayText(invalid, '', source), invalid);
  }
  assert.equal(geminiDisplayText('prefix '+raw, 'prefix ', source), 'prefix literal');
});
