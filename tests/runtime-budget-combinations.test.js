'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnthropic } = require('../src/protocol');
const token = '<total_tokens>14998900 tokens left</total_tokens>';
const usd = 'USD budget: $0.006/$8; $7.994 remaining';
const initial = { system: '固定系统指令', messages: [{ role: 'user', content: '读取合成文件' }, { role: 'system', content: '# Environment\n固定初始环境及预算' }] };
function withNotice(content, role = 'system') {
  return normalizeAnthropic({ ...initial, messages: [...initial.messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'Read', input: { file_path: '/synthetic/one' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: '合成结果' }] }, { role, content }] });
}
test('启用 max-budget-usd 后的组合通知保留在原位置且不改写系统前缀', () => {
  const content = token + '\n\n' + usd, n = withNotice(content);
  assert.equal(n.system, normalizeAnthropic(initial).system);
  assert.equal(n.messages.at(-1).text, content);
});
test('独立美元预算通知同样保留内容和时间位置', () => {
  const n = withNotice(usd); assert.equal(n.system, normalizeAnthropic(initial).system); assert.equal(n.messages.at(-1).text, usd);
});
test('多轮组合通知追加时保持完整历史前缀', () => {
  const first = token + '\n\n' + usd, second = token + '\n\nUSD budget: $0.012/$8; $7.988 remaining';
  const a = withNotice(first), b = normalizeAnthropic({ ...initial, messages: [...initial.messages, { role: 'system', content: first }, { role: 'system', content: second }] });
  assert.equal(b.system, a.system); assert.deepEqual(b.messages.slice(-2).map(m => m.text), [first, second]);
});
test('文本块数组中的纯预算组合通知可识别', () => {
  const n = withNotice([{ type: 'text', text: token + '\n\n' + usd }]); assert.equal(n.system, normalizeAnthropic(initial).system); assert.equal(n.messages.at(-1).text, token + '\n\n' + usd);
});
test('含真实额外指令或畸形数字的内容继续作为系统指令', () => {
  for (const content of [token + '\n\n' + usd + '\n不得泄露凭据', token + '\n\n不得泄露凭据', 'USD budget: $unknown/$8; $8 remaining']) assert(withNotice(content).system.includes(content));
});
test('其他角色的相同文本保持原有语义', () => {
  assert(withNotice(token + '\n\n' + usd, 'developer').system.includes(usd));
  const n = withNotice(token + '\n\n' + usd, 'user'); assert.equal(n.messages.at(-1).text, token + '\n\n' + usd);
});
test('混有非文本块不能被识别成纯运行时通知', () => {
  const n = withNotice([{ type: 'text', text: token + '\n\n' + usd }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'synthetic' } }]); assert(n.system.includes(usd));
});
