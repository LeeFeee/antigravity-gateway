'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixedSource, createGuard, REWRITE, CACHE } = require('./probe.cjs');

test('metadata guard admits only the approved two-step cache-only sequence', async () => {
  const fixed = fixedSource(), observations = [], calls = [];
  const guard = createGuard({ fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response('{}', { status: 200 });
  } }, fixed, { observations }, AbortSignal.timeout(10000));
  const rewrite = { method: 'POST', body: JSON.stringify({ originalUri: fixed.originalUri }) };
  const cache = { method: 'POST', body: JSON.stringify({ url: fixed.targetUrl, liveFetch: false }) };
  await assert.rejects(guard.fetch(CACHE, cache));
  await assert.rejects(guard.fetch(REWRITE, { method: 'POST', body: JSON.stringify({ originalUri: 'https://different.invalid' }) }));
  await guard.fetch(REWRITE, rewrite);
  await assert.rejects(guard.fetch(CACHE, cache));
  assert.throws(() => guard.confirmRewrite('https://different.invalid'));
  guard.confirmRewrite(fixed.targetUrl);
  await assert.rejects(guard.fetch(CACHE, { method: 'POST', body: JSON.stringify({ url: fixed.targetUrl, liveFetch: true }) }));
  await guard.fetch(CACHE, cache);
  await assert.rejects(guard.fetch(CACHE, cache));
  assert.equal(calls.length, 2);
  assert.equal(guard.count, 2);
  assert.equal(observations.length, 2);
});

test('metadata guard rejects generation, credentials, alternate hosts and extra JSON fields before dispatch', async () => {
  const fixed = fixedSource(); let dispatched = 0;
  const guard = createGuard({ fetch: async () => { dispatched++; } }, fixed, { observations: [] });
  const valid = { method: 'POST', body: JSON.stringify({ originalUri: fixed.originalUri }) };
  for (const url of [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
    'https://oauth2.googleapis.com/token',
    'https://cloudcode-pa.googleapis.com/v1internal:rewriteUri',
    REWRITE + '?alt=json'
  ]) await assert.rejects(guard.fetch(url, valid));
  await assert.rejects(guard.fetch(REWRITE, { ...valid, body: JSON.stringify({ originalUri: fixed.originalUri, project: 'extra' }) }));
  assert.equal(dispatched, 0);
});

test('independent cache-only batch uses the prior verified URL and dispatches at most once', async () => {
  const cacheOnly = require('./cache-only.cjs');
  const fixed = cacheOnly.fixedSource(), observations = []; let dispatched = 0;
  const guard = cacheOnly.createGuard({ fetch: async () => { dispatched++; return new Response('{}', { status: 404 }); } }, fixed, { observations });
  const request = { method: 'POST', body: JSON.stringify({ url: fixed.targetUrl, liveFetch: false }) };
  await assert.rejects(guard.fetch(REWRITE, { method: 'POST', body: JSON.stringify({ originalUri: fixed.originalUri }) }));
  await assert.rejects(guard.fetch(CACHE, { ...request, body: JSON.stringify({ url: fixed.targetUrl, liveFetch: true }) }));
  await assert.rejects(guard.fetch(CACHE, { ...request, body: JSON.stringify({ url: 'https://different.invalid', liveFetch: false }) }));
  const response = await guard.fetch(CACHE, request);
  assert.equal(response.status, 404);
  await assert.rejects(guard.fetch(CACHE, request));
  assert.equal(dispatched, 1);
  assert.equal(guard.count, 1);
  assert.equal(observations[0].status, 404);
});
