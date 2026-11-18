'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isModelCapacityFailure, selectGenerationFailure } = require('../src/agy-upstream-error');
const { clientError } = require('../src/client-error');
const { errorCategory } = require('../src/account-pool');
const capturedCapacity = require('./fixtures/agy-capacity-error-20261118.json');
const capacity = { status: 503, diagnostic: JSON.stringify(capturedCapacity) };
const generic = { status: 429, diagnostic: JSON.stringify({ error: {
  code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED'
} }) };

test('observed capacity evidence survives a fallback endpoint generic 429', () => {
  assert.equal(isModelCapacityFailure(503, capacity.diagnostic), true);
  assert.equal(selectGenerationFailure(generic, capacity), capacity);
  assert.equal(selectGenerationFailure(generic), generic);
  assert.equal(selectGenerationFailure(capacity, capacity), capacity);
});

test('explicit quota, auth, request and transport errors are not replaced by capacity', () => {
  const explicit = { status: 429, diagnostic: JSON.stringify({ error: {
    status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ description: 'quota exceeded' }] }]
  } }) };
  for (const failure of [explicit, { status: 401 }, { status: 400 }, { error: new Error('connection failed') },
    { status: 429, diagnostic: 'not JSON' }, { status: 429, diagnostic: '{"error":{"status":"OTHER"}}' }]) {
    assert.equal(selectGenerationFailure(failure, capacity), failure);
  }
  assert.equal(isModelCapacityFailure(429, capacity.diagnostic), false);
  assert.equal(isModelCapacityFailure(503, '{}'), false);
});

test('captured capacity response is a transient upstream error, not quota depletion', () => {
  const error = { status: 503, code: 'direct_upstream_error',
    message: capturedCapacity.error.message, details: capacity.diagnostic };
  assert.equal(errorCategory(error), 'transient');
  assert.deepEqual(clientError(error), {
    type: 'overloaded_error', code: 'model_capacity_exhausted', message: capturedCapacity.error.message,
    gateway_code: 'direct_upstream_error', upstream_status: 'UNAVAILABLE', upstream_reason: 'MODEL_CAPACITY_EXHAUSTED'
  });
  assert.equal(clientError({ status: 429, code: 'direct_upstream_error', details: generic.diagnostic }).code, 'resource_exhausted');
});
