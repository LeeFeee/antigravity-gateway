'use strict';

const crypto = require('node:crypto');

// agy 1.4.2 / Flash High: observed on the wire with controlled HTTP
// errors and real CLI restart/recovery. Do not extrapolate to other models,
// transport exceptions, image generation or the Gemini App transports.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const CAPTURED_MODEL = 'gemini-3.8-flash-high';

function retryInfoMs(status, body) {
  if (status !== 429) return 0;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return 0; }
  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return 0;
  const info = details.find(value => value?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
  const duration = info?.retryDelay;
  if (typeof duration !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(duration)) return 0;
  const milliseconds = Number(duration.slice(0, -1)) * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function nativeRetryDecision(status, body) {
  if (!RETRY_STATUSES.has(status)) return null;
  const minimumMs = retryInfoMs(status, body);
  return { retryable: minimumMs <= 30_000, minimumMs };
}

function uniform53() {
  return Number(crypto.randomBytes(8).readBigUInt64LE() & 0x1fffffffffffffn) / 0x20000000000000;
}

function nativeRetryDelayMs(retry, { checkpoint = false, minimumMs = 0, random = uniform53 } = {}) {
  // Installed native binary confirms multiplicative downward jitter (range .4),
  // not additive jitter. Wire captures independently confirm its intervals.
  // Checkpoint's observed CLI policy is fixed 1s, not agent's exponential curve.
  if (checkpoint) return Math.max(1000, minimumMs);
  const nominal = Math.min(30_000, 4000 * 2 ** Math.max(0, retry));
  return Math.max(4000, nominal * (1 - 0.4 * random()), minimumMs);
}

module.exports = { CAPTURED_MODEL, nativeRetryDecision, nativeRetryDelayMs, retryInfoMs };
