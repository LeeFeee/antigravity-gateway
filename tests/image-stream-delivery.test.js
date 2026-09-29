'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatTextEmitter, createAnthropicTextEmitter } = require('../antigravity-gateway');
const { chatResponse, anthropicResponse } = require('../src/protocol');
const { artifactReceipt, streamTextRemainder } = require('../src/artifacts');
const image = { id: 'file_test', mimeType: 'image/jpeg', filename: 'circle.jpg', gatewayLocalPath: '/gateway/media/file_test.bin', url: 'http://localhost/v1/files/file_test/content' };
for (const protocol of ['chat', 'anthropic']) {
  for (const prefix of ['', 'Generating now.', 'Image ready.']) {
    test(`${protocol} delivers native image receipt after prefix ${JSON.stringify(prefix)}`, () => {
      const frames = [];
      const res = { write: (s) => frames.push(s), end() { this.ended = true; } };
      const emitter = protocol === 'chat' ? createChatTextEmitter(res, 'gemini-test') : createAnthropicTextEmitter(res, 'gemini-test');
      emitter.onDelta(prefix);
      const result = { text: 'Image ready.', images: [image], toolCalls: [], usage: { input_tokens: 3, output_tokens: 4 } };
      emitter.finish(protocol === 'chat' ? chatResponse('gemini-test', result) : anthropicResponse('gemini-test', result));
      const events = frames.join('').split('\n').filter(s => s.startsWith('data: ') && s !== 'data: [DONE]').map(s => JSON.parse(s.slice(6)));
      const text = events.map(e => protocol === 'chat' ? e.choices?.[0]?.delta?.content || '' : e.type === 'content_block_delta' ? e.delta.text : '').join('');
      assert.ok(text.includes(image.url));
      assert.ok(text.includes(image.gatewayLocalPath));
      assert.equal(text.split('Image artifact delivery:').length - 1, 1);
      assert.equal(text.split('Image ready.').length - 1, 1);
      if (prefix) assert.ok(text.startsWith(prefix));
      assert.equal(res.ended, true);
    });
  }
}
test('ordinary streamed prefixes and completed answers are not replayed', () => {
  assert.equal(streamTextRemainder('Hello', 'Hello world'), ' world');
  assert.equal(streamTextRemainder('Hello', 'Hello'), '');
  assert.equal(streamTextRemainder('Hello', ''), '');
});

for (const protocol of ['chat', 'anthropic']) {
  test(`${protocol} stream de-duplicates a canonical receipt echoed by the model`, () => {
    const frames = [];
    const res = { write: (s) => frames.push(s), end() { this.ended = true; } };
    const emitter = protocol === 'chat' ? createChatTextEmitter(res, 'gemini-test') : createAnthropicTextEmitter(res, 'gemini-test');
    emitter.onDelta('Generating now.');
    const receipt = artifactReceipt([image]);
    const result = { text: `Image ready.\n\n${receipt}`, images: [image], toolCalls: [], usage: { input_tokens: 3, output_tokens: 4 } };
    emitter.finish(protocol === 'chat' ? chatResponse('gemini-test', result) : anthropicResponse('gemini-test', result));
    const events = frames.join('').split('\n').filter(s => s.startsWith('data: ') && s !== 'data: [DONE]').map(s => JSON.parse(s.slice(6)));
    const text = events.map(e => protocol === 'chat' ? e.choices?.[0]?.delta?.content || '' : e.type === 'content_block_delta' ? e.delta.text : '').join('');
    assert.equal(text.split('Image artifact delivery:').length - 1, 1);
    assert.equal(text.split('Image ready.').length - 1, 1);
    assert.ok(text.startsWith('Generating now.'));
  });
}
