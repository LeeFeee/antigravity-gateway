'use strict';

const { isModelCapacityFailure } = require('./agy-upstream-error');

// Preserve Google's structured status at both JSON and SSE boundaries. A bare
// "check quota" message does not establish exhausted credit or a billing wall.
// Internal error codes remain unchanged for account routing and diagnostics.
function clientError(error) {
  const code = error.code || 'gateway_error';
  const message = error.message || 'Gateway error';
  if (code === 'direct_upstream_error' && isModelCapacityFailure(error.status, error.details)) {
    return { type: 'overloaded_error', code: 'model_capacity_exhausted', message,
      gateway_code: code, upstream_status: 'UNAVAILABLE', upstream_reason: 'MODEL_CAPACITY_EXHAUSTED' };
  }
  if (error.status === 429 && code === 'direct_upstream_error') {
    let upstream;
    try { upstream = JSON.parse(error.details); } catch { /* no structured evidence */ }
    if (upstream?.error?.status === 'RESOURCE_EXHAUSTED') {
      return { type: 'rate_limit_error', code: 'resource_exhausted', message,
        gateway_code: code, upstream_status: 'RESOURCE_EXHAUSTED' };
    }
  }
  return { type: code, code, message };
}

module.exports = { clientError };
