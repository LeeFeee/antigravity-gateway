'use strict';

const crypto = require('node:crypto');

// agy 1.4.2 / Flash High: observed on the wire with controlled HTTP
// errors and real CLI restart/recovery. Do not extrapolate to other models,
// transport exceptions, image generation or the Gemini App transports.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const CAPTURED_MODEL = 'gemini-3.8-flash-high';
const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
const RETRY_INFO_TYPE = 'type.googleapis.com/google.rpc.RetryInfo';
// Reasons classified as immediately non-retryable on the same account/endpoint
// in Antigravity language_server (utils.classifyGenAIAPIError / IsRetryableAPIError).
const NON_RETRYABLE_REASONS = new Set([
  'MODEL_CAPACITY_EXHAUSTED',
  'MONETIZATION_DENIED',
  'INSUFFICIENT_G1_CREDITS_BALANCE',
  'VALIDATION_REQUIRED',
  'FAILED_PRECONDITION'
]);

function parseUpstreamError(body) {
  let parsed;
  try { parsed = JSON.parse(String(body || '')); } catch { return null; }
  const error = parsed?.error;
  if (!error || typeof error !== 'object') return null;
  const details = Array.isArray(error.details) ? error.details : [];
  return { error, details, statusText: typeof error.status === 'string' ? error.status : '' };
}

function positiveDuration(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?(?:ms|[smhd]))+$/.test(value)) return false;
  return [...value.matchAll(/\d+(?:\.\d+)?/g)].some(match => Number(match[0]) > 0);
}

function errorInfoReasons(details) {
  return details
    .filter(item => item?.['@type'] === ERROR_INFO_TYPE && typeof item.reason === 'string')
    .map(item => item.reason);
}

function hasHardQuotaReset(details, now = Date.now()) {
  const quota = details.find(item => item?.['@type'] === ERROR_INFO_TYPE && item.reason === 'QUOTA_EXHAUSTED');
  if (!quota) return false;
  return Boolean(
    Date.parse(quota.metadata?.quotaResetTimeStamp) > now
    || positiveDuration(quota.metadata?.quotaResetDelay)
    || details.some(item => item?.['@type'] === RETRY_INFO_TYPE
      && /^\d+(?:\.\d{1,9})?s$/.test(item.retryDelay || '') && positiveDuration(item.retryDelay))
  );
}

/**
 * Determine whether an upstream HTTP error represents an account/model hard quota
 * or billing wall rather than a transient rate limit.
 */
function isHardQuotaError(status, body, { requireReset = true, now = Date.now() } = {}) {
  if (status === 402) return true;
  const parsed = parseUpstreamError(body);
  if (!parsed) return false;
  const reasons = errorInfoReasons(parsed.details);
  if (reasons.some(reason => reason === 'INSUFFICIENT_G1_CREDITS_BALANCE' || reason === 'MONETIZATION_DENIED')) {
    return true;
  }
  if (status !== 429) return false;
  if (!reasons.includes('QUOTA_EXHAUSTED')) return false;
  return requireReset ? hasHardQuotaReset(parsed.details, now) : true;
}

function hasNonRetryableReason(body) {
  const parsed = parseUpstreamError(body);
  if (!parsed) return false;
  return errorInfoReasons(parsed.details).some(reason => NON_RETRYABLE_REASONS.has(reason));
}

/**
 * Return true when an upstream failure should abort retries on the current account
 * immediately instead of backing off and re-issuing identical requests.
 */
function isNonRetryableUpstreamError(status, body, now = Date.now()) {
  if (status === 402) return true;
  if (retryInfoMs(status, body) > 30_000) return true;
  if (hasNonRetryableReason(body)) return true;
  const parsed = parseUpstreamError(body);
  if (!parsed) return false;
  return status === 429 && hasHardQuotaReset(parsed.details, now);
}

function retryInfoMs(status, body) {
  if (status !== 429) return 0;
  const parsed = parseUpstreamError(body);
  if (!parsed) return 0;
  const info = parsed.details.find(value => value?.['@type'] === RETRY_INFO_TYPE);
  const duration = info?.retryDelay;
  if (typeof duration !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(duration)) return 0;
  const milliseconds = Number(duration.slice(0, -1)) * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function nativeRetryDecision(status, body, now = Date.now()) {
  if (!RETRY_STATUSES.has(status)) return null;
  const minimumMs = retryInfoMs(status, body);
  if (isNonRetryableUpstreamError(status, body, now)) return { retryable: false, minimumMs };
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

module.exports = {
  CAPTURED_MODEL,
  NON_RETRYABLE_REASONS,
  hasNonRetryableReason,
  isHardQuotaError,
  isNonRetryableUpstreamError,
  nativeRetryDecision,
  nativeRetryDelayMs,
  retryInfoMs
};
