'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessInternalImage } = require('../scripts/verify-gateway-media');
const captured = require('./fixtures/gateway-internal-image-landscape-20261107/internal-image.json');

test('real internal image evidence preserves a tool call despite JSON object key ordering', () => {
  const assessment = assessInternalImage(captured.trace, captured.http, captured.saved);
  assert.deepEqual(assessment.nativeStatuses, [200, 200, 200]);
  assert.equal(assessment.checks.originalToolCallRetained, true);
  assert.equal(assessment.passed, true);
});

test('internal image evidence still rejects changed arguments, call IDs and signatures', () => {
  for (const [mutate, failedCheck] of [
    [part => { part.functionCall.args.Prompt += ' changed'; }, 'originalToolCallRetained'],
    [part => { part.functionCall.id += '_changed'; }, 'originalToolCallRetained'],
    [part => { part.thoughtSignature.sha256 = '0'.repeat(64); }, 'observedSignatureRetained']
  ]) {
    const trace = structuredClone(captured.trace);
    const last = trace.filter(event => event.type === 'native-request'
      && /:(?:streamGenerateContent|generateContent)/.test(event.url)).at(-1);
    const part = last.body.request.contents.flatMap(content => content.parts || []).find(part => part.functionCall);
    assert.ok(part);
    mutate(part);
    const assessment = assessInternalImage(trace, captured.http, captured.saved);
    assert.equal(assessment.checks[failedCheck], false);
    assert.equal(assessment.passed, false);
  }
});
