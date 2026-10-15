'use strict';
require('./helpers/gateway-environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResponsesTextEmitter } = require('../antigravity-gateway');
const { responsesResponse } = require('../src/protocol');

function harness() {
  const frames = [];
  const res = { write: (chunk) => frames.push(chunk), end() { this.ended = true; } };
  const events = () => frames.join('').split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
  const emitter = createResponsesTextEmitter(res, 'gemini-4-argon', 'resp_live');
  return { emitter, res, events, frames };
}

test('Responses streams text before completion with stable IDs and monotonic event sequence', () => {
  const { emitter, res, events } = harness();
  emitter.onDelta('第一行\n');
  assert.equal(events().at(-1).type, 'response.output_text.delta');
  assert.equal(res.ended, undefined);
  emitter.onDelta('第二行');
  const body = responsesResponse('gemini-4-argon', {
    text: '第一行\n第二行', toolCalls: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
  }, 'resp_live');
  emitter.finish(body);
  const all = events();
  assert.deepEqual(all.map((event) => event.sequence_number), all.map((_event, i) => i));
  assert.equal(all.filter((event) => event.type === 'response.created').length, 1);
  assert.equal(all.filter((event) => event.type === 'response.completed').length, 1);
  assert.equal(all.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''), body.output[0].content[0].text);
  assert.ok(all.filter((event) => event.item_id).every((event) => event.item_id === body.output[0].id));
  assert.equal(all.at(-1).response.id, 'resp_live');
  assert.equal(all.at(-1).response.usage.total_tokens, 14);
  assert.equal(res.ended, true);
});

test('Responses live emitter preserves one image receipt and one structured image result', () => {
  const { emitter, events } = harness();
  emitter.onDelta('完成。');
  const image = { id: 'file_image', filename: 'image.png', mimeType: 'image/png', data: 'aW1hZ2U=',
    url: 'https://gateway.example/v1/files/file_image/content', gatewayLocalPath: '/gateway/image.png' };
  emitter.finish(responsesResponse('gemini-test', {
    text: '完成。', toolCalls: [], images: [image], usage: {}
  }, 'resp_live'));
  const all = events();
  const text = all.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('');
  assert.equal(text.split('Image artifact delivery:').length - 1, 1);
  assert.equal(text.split('完成。').length - 1, 1);
  const imageItems = all.filter((event) => event.type === 'response.output_item.done' && event.item.type === 'image_generation_call');
  assert.equal(imageItems.length, 1);
  assert.equal(imageItems[0].output_index, 1);
  assert.equal(all.at(-1).response.output[1].result, image.data);
});

test('Responses emitter handles empty and buffered-only answers without phantom messages', () => {
  for (const text of ['', '直接完成']) {
    const { emitter, events, res } = harness();
    emitter.finish(responsesResponse('gemini-test', { text, toolCalls: [], usage: {} }, 'resp_live'));
    const all = events();
    assert.equal(all.at(-1).response.output.length, text ? 1 : 0);
    assert.equal(res.ended, true);
  }
});
