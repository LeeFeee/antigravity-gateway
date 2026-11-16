'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geminiQuotaSnapshot } = require('../src/gemini-quota');
const { messageField: m, intField: i, concatFields: c } = require('../src/gemini-wire');

function window(type, used) {
  const value = Buffer.alloc(5); value[0] = 0x15; value.writeFloatLE(used, 1);
  return m(3, c([i(1, type), m(2, value)]));
}

test('explicit unused GXU and missing usage have different availability', () => {
  const unused = geminiQuotaSnapshot(window(1, 0));
  assert.equal(unused.groups[0].buckets[0].remainingFraction, 1);
  const missing = geminiQuotaSnapshot(m(3, c([i(1, 1), m(2, Buffer.alloc(0))])));
  assert.equal(missing.groups[0].available, null);
  assert.equal(missing.groups[0].buckets[0].remainingFraction, null);
});

test('credits, invalid percentages and ambiguous windows cannot look like measured remaining quota', () => {
  const credits = geminiQuotaSnapshot(window(3, 0));
  assert.deepEqual(credits.groups, []);
  assert.deepEqual(credits.unsupportedPoolTypes, [3]);
  for (const used of [NaN, Infinity, -0.1, 1.1]) assert.equal(geminiQuotaSnapshot(window(1, used)).groups[0].available, null);
  const duplicate = geminiQuotaSnapshot(c([window(1, 0), window(1, 1)]));
  assert.ok(duplicate.groups[0].buckets.every(bucket => !bucket.known));
  assert.equal(duplicate.groups[0].available, null);
});

test('exhausted window is reported without inventing a plan name or per-model allocation', () => {
  const result = geminiQuotaSnapshot(c([i(2, 2), window(1, 1), window(2, 0.5)]));
  assert.equal(result.groups[0].available, false);
  assert.equal(result.modelSpecific, false);
  assert.equal(result.planName, undefined);
  assert.equal(result.userTier, 2);
});
