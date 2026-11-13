#!/usr/bin/env node
'use strict';
// Offline integration replay only. No sockets, credentials, provider or CLI.
const fs = require('node:fs');
const { withClaude322Billing } = require('../tests/helpers/claude-capture');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { buildDirectRequest } = require('../src/direct-provider');
const { newState, recordClientProjection } = require('../src/agy-session-state');
const { completeNativeContext } = require('../src/agy-context-state');
const { sourceSnapshot } = require('./verify-real-client-gateway');
const ROOT = path.resolve(__dirname, '../tests/fixtures/agent-compaction-20261107');
const SELECTED = Object.fromEntries(['claude', 'pi', 'dsh', 'hermes'].map(agent => [agent, `verified/${agent}-compact.json`]));
const MODEL = 'claude-sonnet-4-6';
const SIGNATURE = 'MOCK_NATIVE_SIGNATURE_FOR_OFFLINE_COMPACTION_REPLAY';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalized(capture) { return capture.path.includes('/messages') ? normalizeAnthropic(withClaude322Billing(structuredClone(capture.body))) : normalizeResponses(structuredClone(capture.body)); }
function build(capture, state) { const source = normalized(capture), native = { state, now: 1793988700000 }; const request = buildDirectRequest(source, MODEL, 'mock-project', 'mock-session', '', null, native); return { source, native, request }; }
function replay(agent) {
  const file = SELECTED[agent], raw = fs.readFileSync(path.join(ROOT, file));
  const fixture = JSON.parse(raw);
  const captures = fixture.captures.filter(c => c.method === 'POST' && /\/v1\/(messages|responses)/.test(c.path));
  const firstCapture = captures.find(c => c.phase === 'seed1' && c.body.tools?.length);
  const state = newState('mock-account', `compaction-${agent}`), first = build(firstCapture, state);
  const receiptCapture = captures.find(c => c !== firstCapture && c.phase === 'seed1' && /"(?:tool_use|function_call)"/.test(JSON.stringify(c.body)));
  if (!receiptCapture) throw Error(`No real client tool history for ${agent}`);
  const candidate = build(receiptCapture, newState('', ''));
  const visibleIndex = candidate.native.context.sourceContents.findIndex(c => c.parts.some(p => p.functionCall));
  const visible = candidate.native.context.sourceContents[visibleIndex];
  const nativeContent = { role: 'model', parts: visible.parts.map(part => {
    if (!part.functionCall) return structuredClone(part);
    const call = part.functionCall, converted = first.native.toolAdapter.toProvider({ id: call.id, name: call.name, arguments: call.args });
    return { functionCall: { id: converted.id, name: converted.name, args: converted.arguments }, thoughtSignature: SIGNATURE };
  }) };
  // This is explicitly synthetic upstream output. Its projection is saved at
  // the actual first request prefix, not at a rewritten later prefix.
  recordClientProjection(state, first.native.context.sourceContents, visible, MODEL, [nativeContent], 1793988700000, { kind: 'client_tools' });
  completeNativeContext(state, first.native.context, MODEL, nativeContent, 1793988700000);
  const firstReceipt = build(receiptCapture, structuredClone(state));
  const rows = captures.map((capture, index) => {
    const result = build(capture, structuredClone(state));
    const inputCalls = result.source.messages.flatMap(m => (m.parts || []).filter(p => p.type === 'tool_call'));
    const parts = result.request.request.contents.flatMap(c => c.parts);
    const restored = parts.filter(p => p.functionCall && p.thoughtSignature === SIGNATURE);
    const cleaned = sanitizeClientIdentity(result.source);
    const hasSoul = result.source.system.includes('PROBE_USER_SOUL:');
    return { index, phase: capture.phase, path: capture.path, profile: cleaned.metadata.profile,
      inputToolCalls: inputCalls.map(c => ({ id: c.id, name: c.name })), nativeToolNames: parts.filter(p => p.functionCall).map(p => p.functionCall.name),
      unrestoredToolCalls: result.native.context.unrestoredToolCalls, restoredMockSignatures: restored.length,
      noSignatureInventedForSummaryText: inputCalls.length > 0 || restored.length === 0,
      userSoulPreserved: !hasSoul || result.request.request.systemInstruction.parts.some(p => p.text.includes('PROBE_USER_SOUL: You are a fixture assistant. Preserve this user-authored identity.')),
      sourceMessageDigest: digest(result.source.messages), sourceSystemDigest: digest(result.source.system),
      inputChars: JSON.stringify(capture.body.messages || capture.body.input).length, tools: result.source.tools.length };
  });
  return { agent, version: fixture.version, file, fixtureSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    evidence: 'offline-real-client-fixture-normalize-buildDirectRequest-prepareNativeContext-with-synthetic-native-projection',
    originalPrefixMatchesFirstReceipt: digest(first.native.context.sourceContents) === digest(candidate.native.context.sourceContents.slice(0, visibleIndex)),
    firstReceiptRestored: firstReceipt.native.context.unrestoredToolCalls.length === 0,
    mockNativeName: nativeContent.parts.find(p => p.functionCall).functionCall.name,
    projectionCount: Object.keys(state.projections).length, rows };
}
function main() {
  const report = { generatedAt: new Date().toISOString(), source: sourceSnapshot(), realModelValidated: false,
    nativeResponseIsSynthetic: true, signature: SIGNATURE, records: Object.keys(SELECTED).map(replay) };
  report.failures = report.records.flatMap(record => record.rows.filter(row => ['compact', 'after'].includes(row.phase) && row.unrestoredToolCalls.length).map(row => ({ agent: record.agent, ...row })));
  fs.writeFileSync(path.join(ROOT, 'offline-replay.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ agents: report.records.map(r => ({ agent: r.agent, firstReceiptRestored: r.firstReceiptRestored, prefixMatches: r.originalPrefixMatchesFirstReceipt })), failures: report.failures.map(r => ({ agent: r.agent, index: r.index, phase: r.phase, missing: r.unrestoredToolCalls })) }));
}
if (require.main === module) main();
module.exports = { replay, SELECTED, ROOT, SIGNATURE };
