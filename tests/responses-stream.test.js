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

// Consume the actual UTF-8 SSE bytes, including splits inside multibyte input,
// rather than reading the final response and assuming its deltas were correct.
function consumeToolStream(frames) {
  const bytes = Buffer.from(frames.join(''), 'utf8'), decoder = new TextDecoder();
  let wire = '';
  for (let offset = 0; offset < bytes.length; offset += 7) wire += decoder.decode(bytes.subarray(offset, offset + 7), { stream: true });
  wire += decoder.decode();
  const events = [], calls = new Map(); let sentinel = 0;
  for (const frame of wire.split('\n\n').filter(Boolean)) {
    const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    if (data === '[DONE]') { sentinel++; continue; }
    const event = JSON.parse(data); events.push(event);
    const tool = event.item && ['function_call', 'custom_tool_call'].includes(event.item.type);
    if (event.type === 'response.output_item.added' && tool) {
      const field = event.item.type === 'custom_tool_call' ? 'input' : 'arguments';
      assert.equal(event.item[field], '', 'The item starts empty so deltas cannot duplicate its input');
      assert.equal(calls.has(event.item.id), false);
      calls.set(event.item.id, { item: structuredClone(event.item), index: event.output_index, field, inputDone: false, itemDone: false });
    } else if (/^response\.(?:function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(event.type)) {
      const call = calls.get(event.item_id);
      assert.ok(call, 'Tool input must follow its output_item.added');
      assert.equal(event.output_index, call.index);
      assert.equal(call.inputDone, false);
      const family = call.field === 'input' ? 'custom_tool_call_input' : 'function_call_arguments';
      assert.ok(event.type.startsWith(`response.${family}.`));
      if (event.type.endsWith('.delta')) call.item[call.field] += event.delta;
      else {
        assert.equal(call.item[call.field], event[call.field]);
        call.inputDone = true;
      }
    } else if (event.type === 'response.output_item.done' && tool) {
      const call = calls.get(event.item.id);
      assert.ok(call?.inputDone, 'A completed tool item needs its complete input event');
      assert.equal(event.output_index, call.index);
      assert.equal(call.itemDone, false);
      call.item.status = event.item.status;
      assert.deepEqual(call.item, event.item);
      call.itemDone = true;
    }
  }
  assert.equal(sentinel, 1);
  assert.ok(wire.endsWith('data: [DONE]\n\n'));
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  assert.equal(events.filter(event => event.type === 'response.created').length, 1);
  assert.ok([...calls.values()].every(call => call.inputDone && call.itemDone));
  const terminal = events.at(-1);
  assert.equal(terminal.type, `response.${terminal.response.status}`);
  assert.equal(events.filter(event => ['response.completed', 'response.incomplete'].includes(event.type)).length, 1);
  const reconstructed = [...calls.values()].sort((a, b) => a.index - b.index).map(call => call.item);
  assert.deepEqual(terminal.response.output.filter(item => ['function_call', 'custom_tool_call'].includes(item.type)), reconstructed);
  return { events, reconstructed, response: terminal.response };
}

test('Responses custom and function tool SSE reconstruct exact mixed inputs with UTF-8, escapes and newlines', () => {
  const patch = '*** Begin Patch\n*** Add File: 中文 😀.txt\n+"引号" \\ 路径\n+data: [DONE]\n*** End Patch\n';
  const args = { cmd: 'printf "%s\\n" "中文😀"\nnext\tline', workdir: '/tmp/a b', tty: false };
  const raw = '{"text":"literal JSON, not function arguments"}\r\n尾行 🧪';
  for (const liveText of [false, true]) {
    const { emitter, frames, res } = harness();
    if (liveText) emitter.onDelta('准备工具。\n');
    const body = responsesResponse('gemini-test', { text: liveText ? '准备工具。\n' : '', usage: {}, toolCalls: [
      { id: 'call_patch', name: 'apply_patch', kind: 'custom', input: patch },
      { id: 'call_exec', name: 'exec_command', arguments: args },
      { id: 'call_raw', name: 'raw_input', kind: 'custom', input: raw }
    ] }, 'resp_live');
    const expected = structuredClone(body.output.filter(item => item.type !== 'message'));
    emitter.finish(body);
    const consumed = consumeToolStream(frames);
    assert.deepEqual(consumed.reconstructed, expected);
    assert.deepEqual(JSON.parse(consumed.reconstructed[1].arguments), args);
    assert.equal(consumed.response.status, 'completed');
    assert.equal(consumed.events.filter(event => event.type === 'response.custom_tool_call_input.delta').length, 2);
    assert.equal(consumed.events.filter(event => event.type === 'response.custom_tool_call_input.done').length, 2);
    assert.equal(res.ended, true);
  }
});

test('Responses empty custom input retains call identity and incomplete termination', () => {
  const { emitter, frames, res } = harness();
  const body = responsesResponse('gemini-test', { text: '', toolCalls: [
    { id: 'call_empty', name: 'raw_input', kind: 'custom', input: '' }
  ], usage: {}, finishReason: 'MAX_TOKENS' }, 'resp_live');
  emitter.finish(body);
  const consumed = consumeToolStream(frames);
  assert.equal(consumed.reconstructed[0].input, '');
  assert.equal(consumed.reconstructed[0].call_id, 'call_empty');
  assert.equal(consumed.reconstructed[0].status, 'incomplete');
  assert.equal(consumed.events.at(-1).type, 'response.incomplete');
  assert.deepEqual(consumed.response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(res.ended, true);
});
