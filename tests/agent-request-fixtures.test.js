'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, 'fixtures/agent-requests-20261107');
const load = name => JSON.parse(fs.readFileSync(path.join(root, `${name}.json`), 'utf8'));
const inference = fixture => fixture.captures.filter(item => item.method === 'POST' && /\/v1\/(messages|responses)(?:\?|$)/.test(item.path));
function objects(value) {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (value && typeof value === 'object') return [value, ...Object.values(value).flatMap(objects)];
  return [];
}
const resultsIn = body => objects(body.messages || body.input).filter(item => ['tool_result', 'function_call_output'].includes(item.type));

for (const agent of ['claude', 'hermes', 'pi', 'dsh']) {
  test(`${agent}:真实读取结果已被客户端回传，恢复进程重放先前历史`, () => {
    for (const scenario of ['first', 'read', 'thinking', 'resume']) {
      const fixture = load(`${agent}-${scenario}`);
      assert.equal(fixture.evidence, 'actual-client-loopback-capture');
      assert.equal(fixture.realModelValidated, false);
      assert.equal(fixture.outcome.code, 0);
      assert.equal(fixture.outcome.timedOut, false);
      assert.ok(inference(fixture).length);
      assert.ok(inference(fixture).some(item => item.body.stream === true));
    }
    const read = load(`${agent}-read`);
    assert.equal(read.outcome.returnedReadTool, true);
    const returned = inference(read).slice(1).map(item => JSON.stringify(item.body.messages || item.body.input)).join('\n');
    assert.match(returned, /PROBE_FIXTURE_LINE_1/);
    assert.match(returned, /PROBE_FIXTURE_LINE_2/);
    const resumed = inference(load(`${agent}-resume`)).filter(item => item.stage === 'resumed-process');
    assert.ok(resumed.length);
    const history = JSON.stringify(resumed.at(-1).body);
    assert.match(history, /This is a synthetic local protocol probe/);
    assert.match(history, /Continue the synthetic local probe/);
    assert.match(history, /LOCAL_CAPTURE_OK/);
  });
}

for (const agent of ['claude', 'hermes', 'pi', 'dsh']) {
  test(`${agent}:真实读取错误、双调用关联与PNG媒体未丢失`, () => {
    for (const scenario of ['read-error', 'parallel-read', 'image']) {
      const fixture = load(`${agent}-${scenario}`);
      assert.equal(fixture.outcome.code, 0);
      assert.equal(fixture.outcome.timedOut, false);
      assert.equal(fixture.outcome.returnedReadTool, true);
    }
    const errors = inference(load(`${agent}-read-error`)).flatMap(item => resultsIn(item.body));
    assert.ok(errors.some(item => /not found|does not exist|ENOENT/.test(JSON.stringify(item))));
    if (agent === 'claude') assert.ok(errors.some(item => item.is_error === true));
    const parallel = inference(load(`${agent}-parallel-read`)).map(item => resultsIn(item.body)).find(items => items.length >= 2);
    assert.ok(parallel);
    assert.equal(new Set(parallel.map(item => item.call_id || item.tool_use_id)).size, 2);
    assert.match(JSON.stringify(parallel), /PROBE_FIXTURE_LINE_1/);
    assert.match(JSON.stringify(parallel), /PROBE_SECOND_FILE_LINE_1/);
    const media = inference(load(`${agent}-image`)).flatMap(item => resultsIn(item.body)).flatMap(objects)
      .filter(item => ['image', 'input_image'].includes(item.type));
    assert.ok(media.length, '图片必须保留在工具结果结构中');
    const encoded = media[0].source?.data || media[0].image_url.split(',')[1];
    const bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 2);
    assert.equal(bytes.readUInt32BE(20), 2);
  });
}

test('直接图片输入与Hermes CLI限制分别有证据', () => {
  for (const agent of ['claude', 'pi']) {
    const fixture = load(`${agent}-image-input`);
    assert.equal(fixture.outcome.code, 0);
    assert.ok(objects(inference(fixture)[0].body).some(item => ['image', 'input_image'].includes(item.type)));
  }
  const hermes = load('hermes-image-input');
  assert.equal(hermes.outcome.code, 2);
  assert.equal(hermes.outcome.generationCount, 0);
  assert.match(hermes.stderr, /Unsupported gateway CLI options: --image/);
});

test('身份对照保留真实框架与明确用户SOUL的不同来源', () => {
  const main = name => inference(load(name)).find(item => item.body.tools?.length).body;
  assert.match(main('hermes-identity').instructions, /^You are Hermes Agent, built by Nous Research\. Be direct:/);
  assert.match(main('hermes-first').instructions, /^PROBE_USER_SOUL:/);
  assert.match(JSON.stringify(main('claude-first').messages), /Attribution for git commits and pull requests/);
  assert.match(JSON.stringify(main('dsh-first').input), /Approval policy:/);
});

test('Claude延迟工具引用对应下一轮实际新增声明', () => {
  const fixture = load('claude-tool-search');
  assert.equal(fixture.outcome.code, 0);
  assert.equal(fixture.outcome.returnedDiscoveryTool, true);
  const turns = inference(fixture);
  const initial = new Set(turns[0].body.tools.map(tool => tool.name));
  const later = turns[1].body;
  const declared = new Set(later.tools.map(tool => tool.name));
  const references = later.messages.flatMap(message => message.content || []).filter(block => block.type === 'tool_result')
    .flatMap(block => Array.isArray(block.content) ? block.content : []).filter(block => block.type === 'tool_reference');
  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.equal(initial.has(reference.tool_name), false);
    assert.equal(declared.has(reference.tool_name), true);
  }
});

test('捕获证据不包含实际鉴权或用户主目录，字段结构完整', () => {
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(raw, /\/Users\/[a-zA-Z0-9_.-]+\//);
    const fixture = JSON.parse(raw);
    for (const capture of fixture.captures) {
      for (const [key, value] of Object.entries(capture.headers)) {
        if (/^(authorization|x-api-key|cookie|set-cookie)$/i.test(key)) assert.equal(value, '<FAKE_API_KEY>');
      }
    }
  }
});
