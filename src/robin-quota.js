'use strict';

const { decodeFields, firstField, stringValue } = require('./robin-proto');

// GetUsageInfoResponse.userTier uses UserSubscriptionTier. The permanently
// authorized, known Google AI Pro account returns TIER1 (wire value 2), which
// gives us a direct product-level mapping for this value. Leave every other
// tier unnamed until it is verified against an account of that tier.
const ROBIN_PLAN_NAMES = new Map([[2, 'Google AI Pro']]);

// GetUsageInfoResponse. Decode only verified GXU budget fields; credits and
// future pool types are not interchangeable with task-mode usage fractions.
function robinQuotaSnapshot(buffer, now = Date.now()) {
  const fields = decodeFields(buffer);
  const userTier = Number(firstField(fields, 2, 0)?.value || 0);
  const buckets = [];
  for (const field of fields) {
    if (field.number !== 3 || field.wireType !== 2) continue;
    const usage = decodeFields(field.value);
    const type = Number(firstField(usage, 1, 0)?.value || 0);
    const window = type === 1 ? '5h' : type === 2 ? 'weekly' : '';
    const gxu = firstField(usage, 2, 2);
    if (!window || !gxu) continue;
    const pool = decodeFields(gxu.value);
    const usedField = firstField(pool, 2, 5);
    // Optional Float: absence is unknown, not an unused/full quota.
    const used = usedField ? usedField.value.readFloatLE(0) : NaN;
    if (!Number.isFinite(used) || used < 0 || used > 1) continue;
    const timestamp = firstField(pool, 1, 2);
    let resetTime = '';
    if (timestamp) {
      const parts = decodeFields(timestamp.value);
      const seconds = Number(firstField(parts, 1, 0)?.value || 0);
      const nanos = Number(firstField(parts, 2, 0)?.value || 0);
      const milliseconds = seconds * 1000 + nanos / 1e6;
      if (seconds > 0 && nanos >= 0 && nanos < 1e9 && Number.isFinite(new Date(milliseconds).valueOf())) {
        resetTime = new Date(milliseconds).toISOString();
      }
    }
    buckets.push({
      id: `robin-gxu-${window}`, window,
      displayName: stringValue(firstField(pool, 3, 2)),
      remainingFraction: 1 - used, resetTime, available: used < 1
    });
  }
  return {
    providerType: 'robin', fetchedAt: new Date(now).toISOString(),
    userTier,
    ...(ROBIN_PLAN_NAMES.has(userTier) ? { planName: ROBIN_PLAN_NAMES.get(userTier) } : {}),
    groups: buckets.length ? [{
      id: 'gemini-robin', displayName: 'Gemini App',
      description: 'Argon 任务模式额度', buckets,
      available: buckets.every((bucket) => bucket.available)
    }] : []
  };
}

module.exports = { robinQuotaSnapshot };
