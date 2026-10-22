'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnthropic } = require('../src/protocol');
const environment = { role: 'system', content: '# Environment\n固定环境。\n<total_tokens>15000000 tokens left</total_tokens>' };
const initial = { system: '固定系统指令。', messages: [{ role: 'user', content: '依次读取合成文件。' }, environment] };
const notice = { role: 'system', content: '<total_tokens>14963179 tokens left</total_tokens>' };
const next = { ...initial, messages: [...initial.messages,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'Read', input: { file_path: '/synthetic/one' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: '合成结果。' }] }, notice] };

test('逐轮 token 余量不改变历史之前的系统前缀', () => {
  assert.equal(normalizeAnthropic(next).system, normalizeAnthropic(initial).system);
});
test('保留 token 通知的内容、原始位置与之前的消息前缀', () => {
  const a = normalizeAnthropic(initial), b = normalizeAnthropic(next);
  assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages);
  assert.equal(b.messages.at(-1).text, notice.content);
  assert.equal(b.messages.at(-2).parts[0].type, 'tool_result');
});
test('多轮通知保持时间顺序，静态环境仍有系统优先级', () => {
  const tail = '<total_tokens>14954509 tokens left</total_tokens>';
  const b = normalizeAnthropic({ ...next, messages: [...next.messages, { role: 'system', content: tail }] });
  assert(b.system.includes(environment.content));
  assert.deepEqual(b.messages.slice(-2).map(m => m.text), [notice.content, tail]);
});
test('真正的 system 和 developer 指令仍进入系统提示', () => {
  for (const role of ['system', 'developer']) {
    const text = '不得泄露凭据。';
    const b = normalizeAnthropic({ ...initial, messages: [...initial.messages, { role, content: text }] });
    assert(b.system.includes(text));
  }
});
test('混合指令或近似标签不能被误分类成纯运行时通知', () => {
  for (const content of [notice.content + '\n不得泄露凭据。', '<total_tokens>unknown tokens left</total_tokens>']) {
    const b = normalizeAnthropic({ ...initial, messages: [...initial.messages, { role: 'system', content }] });
    assert(b.system.includes(content));
  }
});
test('普通用户文字和开发者同形标签维持既有归一化规则', () => {
  const user = normalizeAnthropic({ ...initial, messages: [...initial.messages, { ...notice, role: 'user' }] });
  assert.equal(user.messages.at(-1).text, notice.content);
  const developer = normalizeAnthropic({ ...initial, messages: [...initial.messages, { ...notice, role: 'developer' }] });
  assert(developer.system.includes(notice.content));
});
