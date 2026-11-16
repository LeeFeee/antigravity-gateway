'use strict';

const { decodeFields, field } = require('./gemini-wire');

function resetTime(bytes) {
  if (!bytes) return '';
  const seconds = field(bytes, 1, 0), nanos = field(bytes, 2, 0) ?? 0n;
  if (seconds === undefined || seconds <= 0n || seconds > 8640000000000n || nanos < 0n || nanos >= 1000000000n) return '';
  const date = new Date(Number(seconds) * 1000 + Number(nanos) / 1e6);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : '';
}

// Current app descriptors and actual GetUsageInfo responses agree on these
// fields. GXU is a fraction of a window, not tokens, images or AI credits.
// No subscription product name or per-model allocation is inferred from a
// numeric userTier. Unknown credit pools remain separate and unmeasured.
function geminiQuotaSnapshot(bytes, now = Date.now()) {
  const buckets = [], unsupportedPoolTypes = [], counts = new Map();
  for (const value of decodeFields(bytes).filter(value => value.number === 3 && value.wireType === 2)) {
    const type = Number(field(value.value, 1, 0) ?? 0n);
    const window = { 1: '5h', 2: 'weekly' }[type];
    if (!window) { unsupportedPoolTypes.push(type); continue; }
    counts.set(window, (counts.get(window) || 0) + 1);
    const pool = field(value.value, 2, 2);
    const raw = pool && field(pool, 2, 5), used = raw?.readFloatLE(0);
    const known = Number.isFinite(used) && used >= 0 && used <= 1;
    buckets.push({ id: `gemini-gxu-${window}`, window, unit: 'window_fraction', known,
      displayName: pool && field(pool, 3, 2)?.toString('utf8') || window,
      usedFraction: known ? used : null, remainingFraction: known ? 1 - used : null,
      resetTime: pool ? resetTime(field(pool, 1, 2)) : '', available: known ? used < 1 : null });
  }
  for (const bucket of buckets) if (counts.get(bucket.window) !== 1) {
    Object.assign(bucket, { known: false, usedFraction: null, remainingFraction: null, available: null });
  }
  const body = field(bytes, 4, 2);
  const tier = field(bytes, 2, 0);
  return { providerType: 'gemini', source: 'GetUsageInfo', observedAt: new Date(now).toISOString(),
    userTier: tier === undefined ? null : Number(tier), modelSpecific: false, unsupportedPoolTypes,
    groups: buckets.length ? [{ id: 'gemini-gxu', displayName: 'Gemini GXU',
      description: body && field(body, 1, 2)?.toString('utf8') || '', buckets,
      available: buckets.some(bucket => bucket.available === false) ? false : buckets.every(bucket => bucket.known) ? true : null }] : [] };
}

module.exports = { geminiQuotaSnapshot };
