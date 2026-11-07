'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, parseMessage, finalizeEvidence } = require('../scripts/verify-claude-search-gateway');

test('full isolated gateway forwards search HTTP/SSE and validates historical receipts before upstream I/O',
  { timeout: 45000, skip: process.platform !== 'darwin' ? 'The process-isolated fixture requires macOS Seatbelt.' : false }, async () => {
    const result = await run({ runCli: false });
    assert.equal(result.passed, true, result.failure?.stack);
    assert.equal(result.scenarios.length, 11);
    assert.equal(result.temporaryDirectoryRemoved, true);
    assert.equal(result.upstream.filter(entry => entry.body?.requestType === 'web_search').length, 3);
  });

test('search SSE parser rejects truncated, unfinished or post-completion content', () => {
  const events = [
    { type: 'message_start', message: { content: [], usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'result' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  ];
  const wire = list => list.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  assert.equal(parseMessage(wire(events), true).content[0].text, 'result');
  for (const invalid of [wire(events.slice(0, -1)), wire(events).slice(0, -1), wire(events.filter(event => event.type !== 'content_block_stop')),
    wire(events.filter(event => event.type !== 'message_delta')), wire([...events, events[2]])]) assert.throws(() => parseMessage(invalid, true));
});

test('successful assertions cannot override changed source or incomplete cleanup', () => {
  const success = { sourceUnchanged: true, temporaryDirectoryRemoved: true, gatewayStopped: true, clientStopped: true, fakeGoogleStopped: true };
  assert.equal(finalizeEvidence({ ...success }).passed, true);
  for (const key of Object.keys(success)) assert.equal(finalizeEvidence({ ...success, [key]: false }).passed, false, key);
  assert.equal(finalizeEvidence({ ...success, failure: { message: 'Controlled assertion failure' } }).passed, false);
});
