'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { buildDirectRequest } = require('../src/direct-provider');
const { assessEvidence, declarations } = require('../scripts/verify-client-gateway');
const directory = path.join(__dirname, 'fixtures/client-gateway-20261107');

for (const agent of ['claude', 'hermes', 'pi', 'dsh']) for (const scenario of ['text', 'read']) {
  test(`actual ${agent}/${scenario}: verified gateway chain and current converter retain its native contract`, () => {
    const record = JSON.parse(fs.readFileSync(path.join(directory, `${agent}-${scenario}.json`), 'utf8'));
    assert.equal(record.evidence, 'actual-cli-real-gateway-synthetic-google-upstream');
    assert.equal(record.realModelValidated, false); assert.equal(record.tlsValidated, false);
    assert.deepEqual(record.upstreamErrors, []);
    assert.equal(assessEvidence(agent, scenario, record.upstream, record.clientHTTP, record.outcome).passed, true);
    const client = record.clientHTTP.find(item => /^\/v1\/(messages|responses)(?:\?|$)/.test(item.path));
    const normalized = agent === 'claude' ? normalizeAnthropic(client.body) : normalizeResponses(client.body);
    const rebuilt = buildDirectRequest(normalized, client.body.model, 'synthetic-project', 'synthetic-session');
    assert.equal(rebuilt.request.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
    assert.equal(rebuilt.requestType, 'agent');
    assert.doesNotMatch(rebuilt.request.systemInstruction?.parts.map(part => part.text).join('\n') || '',
      /You are a Claude agent, built on Anthropic's Claude Agent SDK\.|You are a coding assistant running inside pi, a coding agent harness\.|You are an AI agent powered by DeepSeek Harness\./);
    const reader = declarations(rebuilt).find(tool => tool.name === 'read_file');
    assert.ok(reader, 'the actual installed-client reading declaration has a verified native subset');
    assert.deepEqual(reader.parameters.required, ['Path', 'StartLine', 'EndLine']);
    if (scenario === 'read') {
      assert.deepEqual(record.assessment.issuedNativeNames, ['read_file']);
      assert.deepEqual(record.assessment.nativeResultNames, ['read_file']);
      const call = record.upstream.find(item => item.issuedToolCall).issuedToolCall;
      assert.deepEqual(call.args, { Path: '/tmp/client-gateway-verify/work/probe-input.txt', StartLine: 1, EndLine: 2 });
    }
    const catalog = JSON.parse(record.clientHTTP.find(item => item.path === '/v1/models').responseBody);
    assert.equal(catalog.data[0].supports_video, true);
    assert.equal(catalog.data[0].supported_mime_types['video/mp4'], true);
    assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(item => item.effort), ['high']);
  });
}
