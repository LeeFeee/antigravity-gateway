'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { replay, SELECTED, ROOT } = require('../scripts/verify-agent-compaction-replay');
for (const agent of Object.keys(SELECTED)) {
  test(`${agent} 真实压缩样本经规范化和完整上游构造，旧调用恢复一次native投影而摘要不伪造签名`, () => {
    const record = replay(agent);
    assert.equal(record.originalPrefixMatchesFirstReceipt, true);
    assert.equal(record.firstReceiptRestored, true);
    assert.equal(record.projectionCount, 1);
    const selected = record.rows.filter(row => ['compact','after'].includes(row.phase));
    assert.ok(selected.some(row => row.phase === 'compact'));
    assert.ok(selected.some(row => row.phase === 'after'));
    for (const row of record.rows) {
      assert.deepEqual(row.unrestoredToolCalls, [], `${agent} ${row.index}`);
      assert.equal(row.restoredMockSignatures, row.inputToolCalls.length);
      assert.equal(row.noSignatureInventedForSummaryText, true);
      assert.equal(row.userSoulPreserved, true);
    }
    assert.ok(selected.filter(row => row.phase === 'after').every(row => row.inputToolCalls.length === 0));
    if (agent === 'claude' || agent === 'dsh') assert.equal(selected.find(row => row.phase === 'compact').profile.client, agent);
    if (agent === 'pi') assert.ok(selected.filter(row => row.phase === 'compact').every(row => row.profile === null));
  });
}
test('四份最终证据均真实触发压缩且续聊带客户端摘要，标注仅合成本地上游', () => {
  for (const [agent, file] of Object.entries(SELECTED)) {
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, file)));
    assert.equal(fixture.error, undefined);
    assert.equal(fixture.realModelValidated, false);
    assert.equal(fixture.syntheticProvider.uniqueMessageIds, true);
    assert.ok(fixture.captures.some(c => c.phase === 'after' && JSON.stringify(c.body).includes('COMPACTION_SYNTHETIC_CHECKPOINT')));
    if (agent === 'claude') assert.match(fixture.compactOutcome, /"local_command":"compact"/);
    if (agent === 'pi') assert.match(fixture.runs.find(r => r.phase === 'compact').stdout, /"command":"compact","success":true/);
    if (agent === 'dsh') assert.ok(fixture.captures.some(c => c.phase === 'compact' && JSON.stringify(c.body).includes('You are now acting as a compaction engine')));
    if (agent === 'hermes') {
      const outcome = JSON.parse(fixture.compactOutcome);
      assert.equal(outcome.summary.noop, false);
      assert.equal(outcome.summary.fallback_used, false);
      assert.equal(outcome.summary.aborted, false);
      const request = fixture.captures.find(c => c.phase === 'compact' && c.method === 'POST');
      assert.equal(request.path, '/v1/responses');
      assert.equal(request.body.instructions, 'You are a helpful assistant.');
      assert.equal(request.body.tools, undefined);
    }
  }
});
