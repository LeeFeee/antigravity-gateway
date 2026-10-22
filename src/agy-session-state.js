'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileLease, acquireFileLease, cleanupPendingLeases } = require('./agy-file-lease');
const { compatibleHistoryModels } = require('./agy-request-profile');
const { streamErrorContent, isStreamError, validStreamContents, capturedCancellationPair } = require('./agy-stream-recovery');
const { CLAUDE_COMPACTION_PROFILE } = require('./agy-client-compaction');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const locks = new Map();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

// Compare the client-visible content, not signatures or gateway-only IDs.
// A response is restored only at the identical submitted history prefix.
function contentFingerprint(content) {
  let text = '';
  const parts = [];
  for (const part of content.parts || []) {
    if (part.thought) continue;
    if (typeof part.text === 'string') text += part.text;
    else if (part.functionCall) parts.push({ functionCall: part.functionCall });
    else if (part.functionResponse) parts.push({ functionResponse: part.functionResponse });
    else if (part.inlineData) parts.push({ inlineData: part.inlineData });
    else parts.push(part);
  }
  return hash(JSON.stringify(canonical({ role: content.role, text: content.role === 'model' ? text.trim() : text, parts })));
}

function historyKey(prefix, content) { return hash(`${prefix}\0${contentFingerprint(content)}`); }
function historyPrefix(contents) {
  let prefix = hash('agy-history-v1');
  for (const content of contents) prefix = historyKey(prefix, content);
  return prefix;
}

function newState(owner, key, now = Date.now()) {
  return { version: 1, owner, key, cascadeId: crypto.randomUUID(), trajectoryId: crypto.randomUUID(),
    requestIndex: 0, at: now, lastExecutionId: '', usedClaude: false, usedNonGemini: false, responses: {} };
}

function validTimeline(value) {
  return Array.isArray(value) && value.length <= 2048
    && value.every(entry => HASH.test(entry?.fingerprint) && typeof entry.timestamp === 'string' && entry.timestamp.length < 64
      && (entry.uploadedAt === undefined || (Number.isSafeInteger(entry.uploadedAt) && entry.uploadedAt >= 0))
      && (entry.contextSummary === undefined || typeof entry.contextSummary === 'boolean')
      && [entry.settingFrom, entry.settingTo].every(text => text === undefined || (typeof text === 'string' && text.length < 1024)));
}

function validState(value, owner, key) {
  return value?.version === 1 && value.owner === owner && value.key === key
    && UUID.test(value.cascadeId) && UUID.test(value.trajectoryId)
    && Number.isSafeInteger(value.requestIndex) && value.requestIndex >= 0
    && Number.isFinite(value.at) && (!value.lastExecutionId || UUID.test(value.lastExecutionId))
    && (value.nextStep === undefined || (Number.isSafeInteger(value.nextStep) && value.nextStep >= 0))
    && (value.lastImageUploadAt === undefined || (Number.isSafeInteger(value.lastImageUploadAt) && value.lastImageUploadAt >= 0))
    && (value.timeline === undefined || validTimeline(value.timeline))
    && (value.pendingCompaction === undefined || (HASH.test(value.pendingCompaction?.summaryHash)
      && (value.pendingCompaction.profile === undefined || value.pendingCompaction.profile === 'claude-code-2.1.285')
      && (value.pendingCompaction.retainedTimeline === undefined || validTimeline(value.pendingCompaction.retainedTimeline))))
    && (value.projections === undefined || (value.projections && typeof value.projections === 'object' && !Array.isArray(value.projections)
      && Object.entries(value.projections).every(([k, v]) => HASH.test(k) && typeof v?.model === 'string' && Number.isFinite(v.at)
        && Array.isArray(v.contents) && v.contents.length <= 3 && v.contents.every(c => c?.role === 'model' && Array.isArray(c.parts)))))
    && ['streamProjections', 'streamRecoveries'].every(group => value[group] === undefined || (value[group]
      && typeof value[group] === 'object' && !Array.isArray(value[group])
      && Object.entries(value[group]).every(([k, v]) => HASH.test(k) && typeof v?.model === 'string'
        && Number.isFinite(v.at) && validStreamContents(v.contents)
        && (group !== 'streamRecoveries' || typeof v.visibleText === 'string')
        && (v.terminal === undefined || typeof v.terminal === 'boolean')
        && (v.clientCancelled === undefined || typeof v.clientCancelled === 'boolean')
        && (v.retryCount === undefined || Number.isSafeInteger(v.retryCount) && v.retryCount >= 0 && v.retryCount <= 9))))
    && (value.toolStreamErrors === undefined || (value.toolStreamErrors && typeof value.toolStreamErrors === 'object' && !Array.isArray(value.toolStreamErrors)
      && Object.entries(value.toolStreamErrors).every(([k, v]) => HASH.test(k) && typeof v?.model === 'string' && Number.isFinite(v.at)
        && Number.isFinite(v.readyAt) && Number.isSafeInteger(v.retryCount) && v.retryCount > 0 && v.retryCount <= 9
        && (v.terminalRecorded === undefined || typeof v.terminalRecorded === 'boolean')
        && Array.isArray(v.calls) && v.calls.length > 0 && v.calls.length <= 64
        && new Set(v.calls.map(c => c?.id)).size === v.calls.length
        && v.calls.every(c => typeof c?.id === 'string' && c.id.length > 0 && typeof c.name === 'string' && c.name.length > 0))))
    && value.responses && typeof value.responses === 'object' && !Array.isArray(value.responses);
}

function restoreHistory(state, contents, model) {
  let prefix = hash('agy-history-v1');
  return contents.map(content => {
    const key = historyKey(prefix, content);
    prefix = key;
    const entry = state.responses[key];
    if (content.role === 'model' && compatibleHistoryModels(entry?.model, model) && Array.isArray(entry.content?.parts)
        && contentFingerprint(entry.content) === contentFingerprint(content)) {
      return structuredClone(entry.content);
    }
    return content;
  });
}

function recordResponse(state, contents, model, content, now = Date.now()) {
  if (!content.parts?.length) return;
  const key = historyKey(historyPrefix(contents), content);
  state.responses[key] = { model, content: structuredClone(content), at: now };
  pruneResponses(state);
}

function pruneResponses(state) {
  // Only server-produced parts are stored, including hidden native image-tool
  // output; never save submitted user history or arbitrary removed prefixes.
  const entries = ['responses', 'projections', 'streamProjections', 'streamRecoveries', 'toolStreamErrors'].flatMap(group => Object.entries(state[group] || {})
    .map(([key, value]) => ({ group, key, value }))).sort((a, b) => a.value.at - b.value.at);
  let bytes = Buffer.byteLength(JSON.stringify(state));
  while (entries.length > 512 || bytes > MAX_FILE_BYTES - 4096) {
    const item = entries.shift();
    if (!item) break;
    bytes -= Buffer.byteLength(JSON.stringify(item.value)) + item.key.length + 4;
    delete state[item.group][item.key];
  }
}

function restoreClientProjections(state, contents, model, { nativeErrors, pendingRecovery, clientProfile = '', restoreStreamRecovery = true } = {}) {
  let prefix = hash('agy-history-v1'), skipUntil = 0, awaitingToolError; const restored = [], toolNames = new Map();
  for (const [index, submitted] of contents.entries()) {
    if (index < skipUntil) continue;
    const content = { ...submitted, parts: submitted.parts.map(part => {
      const result = part.functionResponse, mapping = result && toolNames.get(result.id);
      return mapping && result.name === mapping.client ? { ...part, functionResponse: { ...result, name: mapping.native } } : part;
    }) };
    const key = historyKey(prefix, content);
    const stream = restoreStreamRecovery && content.role === 'model' ? state.streamProjections?.[key] : null;
    const entry = stream?.model === model ? stream : content.role === 'model' ? state.projections?.[key] : null;
    // Exact issued client-visible content AND full preceding history must
    // match. A copied receipt in another session or an edited prefix cannot
    // resurrect hidden exchanges or trigger broad text-pattern stripping.
    // Cross-model image/projection exchanges have not been captured yet.
    const replacement = entry?.model === model ? structuredClone(entry.contents) : [content];
    for (const part of content.parts) if (part.functionCall) toolNames.delete(part.functionCall.id);
    // Rename receipts only from an exact, previously issued call projection.
    // No global tool-name guessing, foreign-ID repair or rewriting old signed
    // client history when a tool adapter is first enabled mid-conversation.
    if (entry?.model === model) {
      const calls = replacement.flatMap(c => c.parts).filter(p => p.functionCall).map(p => p.functionCall);
      for (const p of content.parts) if (p.functionCall) {
        const matches = calls.filter(c => c.id === p.functionCall.id);
        if (matches.length === 1 && content.parts.filter(q => q.functionCall?.id === p.functionCall.id).length === 1
          && matches[0].name !== p.functionCall.name)
          toolNames.set(p.functionCall.id, { client: p.functionCall.name, native: matches[0].name });
      }
    }
    for (const item of replacement) {
      if (entry === stream && stream?.model === model && isStreamError(item)) nativeErrors?.add(restored.length);
      restored.push(item); prefix = historyKey(prefix, item);
      if (awaitingToolError) {
        const results = item.role === 'model' ? item.parts?.filter(p => p.functionResponse).map(p => p.functionResponse) || [] : [];
        // Only actual matching client tool receipts authorize the native error
        // after the call. Edited/removed prefixes, missing/duplicate/foreign
        // receipts and a new ordinary user turn must not invent tool results.
        if (!results.length || results.some(r => awaitingToolError.remaining.get(r.id) !== r.name)
          || new Set(results.map(r => r.id)).size !== results.length) awaitingToolError = null;
        else {
          for (const r of results) awaitingToolError.remaining.delete(r.id);
          if (!awaitingToolError.remaining.size) {
            if (awaitingToolError.entry.retryCount < 9) {
              const error = streamErrorContent();nativeErrors?.add(restored.length);
              restored.push(error);prefix = historyKey(prefix, error);
            } else if (pendingRecovery && !awaitingToolError.entry.terminalRecorded) {
              (pendingRecovery.terminalToolRecords ||= []).push(awaitingToolError.entry);
            }
            if (index === contents.length - 1) Object.assign(pendingRecovery || {}, { toolRecovery: awaitingToolError.entry });
            awaitingToolError = null;
          }
        }
      }
      const toolError = restoreStreamRecovery && state.toolStreamErrors?.[prefix];
      if (toolError?.model === model) awaitingToolError = { entry: toolError, remaining: new Map(toolError.calls.map(c => [c.id, c.name])) };
    }
    // Only the exact captured client pair after an exact issued projection of
    // an observed client cancellation is local UI state, not two native turns.
    // Ordinary user text, edited prefixes, unknown clients and timeout/HTTP
    // failures never authorize removing these strings from submitted history.
    if (clientProfile === CLAUDE_COMPACTION_PROFILE && entry?.model === model
      && entry.clientCancelled && capturedCancellationPair(contents, index + 1)) skipUntil = index + 3;
    // An interrupted API response may have delivered no assistant message at
    // all. Restore only an actually recorded hidden exchange at its exact
    // full prefix, either on an identical retry or before a new user turn.
    // Never insert it in front of an edited/echoed assistant response.
    const pending = restoreStreamRecovery && pendingRecovery && state.streamRecoveries?.[prefix];
    if (pending?.model === model && (index === contents.length - 1 || contents[index + 1].role === 'user')) {
      const recovery = structuredClone(pending);
      if (index === contents.length - 1) Object.assign(pendingRecovery, { recovery, inputContents: [...restored] });
      for (const item of recovery.contents) {
        if (isStreamError(item)) nativeErrors?.add(restored.length);
        restored.push(item); prefix = historyKey(prefix, item);
      }
      if (clientProfile === CLAUDE_COMPACTION_PROFILE && recovery.clientCancelled
        && capturedCancellationPair(contents, index + 1)) skipUntil = index + 3;
    }
  }
  return restored;
}

function recordStreamProjection(state, prefix, visible, model, contents, now = Date.now(), clientCancelled = false) {
  if (visible?.role !== 'model' || !visible.parts?.length || !validStreamContents(contents)) return;
  state.streamProjections ||= {};
  state.streamProjections[historyKey(historyPrefix(prefix), visible)] = { model, contents: structuredClone(contents), at: now,
    ...(clientCancelled ? { clientCancelled: true } : {}) };
  pruneResponses(state);
}

function recordStreamRecovery(state, prefix, model, contents, visibleText, now = Date.now(), terminal = false,
  retryCount = contents.filter(isStreamError).length, clientCancelled = false) {
  if (!validStreamContents(contents)) return;
  state.streamRecoveries ||= {};
  state.streamRecoveries[historyPrefix(prefix)] = { model, contents: structuredClone(contents), visibleText, at: now,
    retryCount: Math.min(9, Math.max(0, retryCount)), ...(terminal ? { terminal: true } : {}),
    ...(clientCancelled ? { clientCancelled: true } : {}) };
  pruneResponses(state);
}

function clearStreamRecovery(state, prefix) { if (state.streamRecoveries) delete state.streamRecoveries[historyPrefix(prefix)]; }

function recordToolStreamError(state, prefix, model, content, retryCount, readyAt, now = Date.now()) {
  const parts = content?.parts?.filter(p => p.functionCall) || [];
  if (!parts.length || parts.length > 64 || retryCount < 1 || retryCount > 9
    || parts.some(p => !p.functionCall.id || !p.functionCall.name || !p.thoughtSignature)) return;
  const calls = parts.map(p => ({ id: p.functionCall.id, name: p.functionCall.name }));
  if (new Set(calls.map(c => c.id)).size !== calls.length) return;
  state.toolStreamErrors ||= {};
  state.toolStreamErrors[historyPrefix([...prefix, content])] = { model, calls, retryCount, readyAt, at: now };
  pruneResponses(state);
}

function recordClientProjection(state, prefix, visible, model, contents, now = Date.now()) {
  if (!contents.length || contents.length > 3 || contents.some(c => c.role !== 'model')) return;
  state.projections ||= {};
  state.projections[historyKey(historyPrefix(prefix), visible)] = { model, contents: structuredClone(contents), at: now };
  pruneResponses(state);
}

async function waitUntil(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

class AgySessionStore {
  constructor({ directory = path.join(process.env.ANTIGRAVITY_GATEWAY_CONFIG_DIR || path.join(os.homedir(), '.antigravity-gateway'),
    'state', 'agy-sessions'), now = () => Date.now(), ttlMs = TTL_MS, capacity = 1024, directoryGuard = null, diagnosticReporter = null } = {}) {
    this.directory = directory;
    this.now = now;
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    this.directoryGuard = directoryGuard;
    this.diagnosticReporter = typeof diagnosticReporter === 'function' ? diagnosticReporter : null;
    this.memory = new Map();
    this.lastCleanup = 0;
  }

  bindDirectoryGuard(guard) {
    this.directoryGuard = guard;
  }

  async fileLock(file, signal) {
    return acquireFileLease(`${file}.lock`, signal, this.now, {
      directoryGuard: this.directoryGuard,
      onWaiting: (info) => {
        this.diagnosticReporter?.('wait_session_lock', { file, target: info.target });
      },
      onAcquired: (info) => {
        this.diagnosticReporter?.('acquired_session_lock', { file, target: info.target, elapsedMs: info.elapsedMs });
      }
    });
  }

  read(file, owner, key) {
    if (!file) {
      const state = this.memory.get(key);
      return state && this.now() - state.at < this.ttlMs ? structuredClone(state) : newState(owner, key, this.now());
    }
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('会话状态文件无效。');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (validState(state, owner, key) && this.now() - state.at < this.ttlMs) return state;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return newState(owner, key, this.now());
  }

  save(file, state) {
    state.at = this.now();
    if (!file) { this.memory.set(state.key, structuredClone(state)); return; }
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }

  cleanup() {
    for (const [key, value] of this.memory) if (this.now() - value.at >= this.ttlMs) this.memory.delete(key);
    while (this.memory.size > this.capacity) this.memory.delete(this.memory.keys().next().value);
    if (!this.directory || this.now() - this.lastCleanup < 60_000) return;
    this.lastCleanup = this.now();
    cleanupPendingLeases(this.directory, { directoryGuard: this.directoryGuard });
    const entries = [];
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      if (fs.existsSync(`${file}.lock`)) continue;
      try { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ file, at: stat.mtimeMs, bytes: stat.size }); }
      catch { /* Another process may have removed an expired entry. */ }
    }
    entries.sort((a, b) => a.at - b.at);
    let count = entries.length, bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      if (this.now() - entry.at < this.ttlMs && count <= this.capacity && bytes <= 256 * 1024 * 1024) break;
      let lease;
      try {
        // GC takes the same lease as writers. Checking for a lock and then
        // unlinking without acquiring it can race a newly started request.
        lease = new FileLease(`${entry.file}.lock`);
        if (!lease.tryAcquire()) continue;
        const stat = fs.lstatSync(entry.file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs === entry.at) {
          fs.unlinkSync(entry.file); count--; bytes -= entry.bytes;
        }
      } catch { /* Active lease or concurrent eviction: leave the entry alone. */ }
      finally {
        try { lease?.release(); lease?.dispose(); } catch { /* best-effort GC */ }
      }
    }
  }

  async transact(accountIdentity, sessionId, signal, callback) {
    const owner = hash(accountIdentity), key = hash(`${owner}\0${sessionId || crypto.randomUUID()}`);
    const file = this.directory ? path.join(this.directory, `${key}.json`) : '';
    const lockKey = file || `${owner}/${key}`;
    const previous = locks.get(lockKey) || Promise.resolve();
    let unlock;
    const done = new Promise(resolve => { unlock = resolve; });
    const queued = previous.then(() => done);
    locks.set(lockKey, queued);
    let releaseFile;
    try {
      await waitUntil(previous, signal);
      if (file) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        releaseFile = await this.fileLock(file, signal);
      }
      this.cleanup();
      const state = this.read(file, owner, key);
      const checkpoint = () => this.save(file, state);
      return await callback(state, checkpoint);
    } finally {
      try { releaseFile?.(); }
      finally {
        // Cancelled waiters cannot bypass the preceding operation's lease.
        previous.finally(() => { unlock(); if (locks.get(lockKey) === queued) locks.delete(lockKey); });
      }
    }
  }
}

module.exports = { AgySessionStore, canonical, contentFingerprint, historyPrefix, recordResponse, restoreHistory, newState, HASH,
  restoreClientProjections, recordClientProjection, recordStreamProjection, recordStreamRecovery, clearStreamRecovery, recordToolStreamError };
