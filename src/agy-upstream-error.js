'use strict';

function upstreamError(body) {
  try { return JSON.parse(String(body || '{}'))?.error; } catch { return null; }
}

function isModelCapacityFailure(status, body) {
  const error = upstreamError(body);
  return status === 503 && error?.status === 'UNAVAILABLE'
    && Array.isArray(error.details) && error.details.some(detail =>
      detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
      && detail.reason === 'MODEL_CAPACITY_EXHAUSTED');
}

function isUnspecifiedResourceExhaustion(status, body) {
  const error = upstreamError(body);
  return status === 429 && error?.status === 'RESOURCE_EXHAUSTED'
    && (error.details == null || (Array.isArray(error.details) && error.details.length === 0));
}

// Observed daily endpoint: explicit model-capacity 503; fallback endpoint:
// generic 429 without quota details. The latter must not erase the former.
// Concrete quota/auth/request errors and successful fallback remain authoritative.
function selectGenerationFailure(last, capacity) {
  return capacity && isUnspecifiedResourceExhaustion(last?.status, last?.diagnostic)
    ? capacity : last;
}

module.exports = { upstreamError, isModelCapacityFailure, selectGenerationFailure };
