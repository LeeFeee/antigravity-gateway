'use strict';

const crypto = require('node:crypto');
const { canonical, contentFingerprint, recordResponse, restoreHistory, restoreClientProjections } = require('./agy-session-state');
const { streamErrorContent } = require('./agy-stream-recovery');
const { modelProfile } = require('./agy-request-profile');
const { saveImageReference } = require('./agy-image-references');
const { CLAUDE_COMPACTION_PROFILE, capturedSummaryReplacement } = require('./agy-client-compaction');
const MAX_TIMELINE = 2048;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function localTimestamp(now) {
  const date = new Date(now), pad = n => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset(), suffix = offset === 0 ? 'Z'
    : `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${suffix}`;
}

function textContent(content) { return content.parts.map(p => p.text || '').join(''); }
function summaryContent(content) { return content.role === 'user' && /^<CONTEXT_SUMMARY>\n[\s\S]*\n<\/CONTEXT_SUMMARY>\s*$/.test(textContent(content)); }
function nativeWrapped(content) {
  return summaryContent(content) || /^<USER_REQUEST>\n[\s\S]*\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>\n/.test(textContent(content));
}
function eventWeight(content) { return Math.max(1, content.parts.filter(p => p.functionResponse).length); }

// Reuse only monotonic, unambiguous historical anchors. This preserves stable
// timestamps when a client trims/rewrites an earlier prefix without restoring
// any removed prompt or trusting a repeated "OK" as a signature-cache key.
function alignTimeline(previous, current) {
  const matches = new Map();
  let start = 0;
  while (start < previous.length && start < current.length && previous[start].fingerprint === current[start]) {
    matches.set(start, previous[start]); start++;
  }
  const oldPositions = new Map(), newCounts = new Map();
  for (let i = start; i < previous.length; i++) {
    const fingerprint = previous[i].fingerprint;
    oldPositions.set(fingerprint, oldPositions.has(fingerprint) ? -1 : i);
  }
  for (let i = start; i < current.length; i++) newCounts.set(current[i], (newCounts.get(current[i]) || 0) + 1);
  let last = start - 1;
  for (let i = start; i < current.length; i++) {
    const at = oldPositions.get(current[i]);
    if (at > last && newCounts.get(current[i]) === 1) { matches.set(i, previous[at]); last = at; }
  }
  return matches;
}

function imageLayout(content) {
  return content.role === 'user' && content.parts.length > 0 && content.parts.every(p => typeof p.text === 'string'
    || (p.inlineData?.data && /^image\//.test(p.inlineData.mimeType)));
}

function wireContent(content, entry, { checkpointInstruction = false, nativeStreamError = false, imageStore, cascadeId, savedPaths } = {}) {
  let parts = content.parts.map(part => {
    if (part.functionCall) return { ...part, functionCall: { ...part.functionCall, args: canonical(part.functionCall.args) } };
    if (part.functionResponse) return { ...part, functionResponse: { ...part.functionResponse, response: canonical(part.functionResponse.response) } };
    return part;
  });
  if (entry.contextSummary && !summaryContent(content)) {
    return { role: content.role, parts: [{ text: `<CONTEXT_SUMMARY>\n${textContent(content)}\n</CONTEXT_SUMMARY>` }] };
  }
  // Captured agy user attachments are one wrapped text part followed by the
  // images, with real local upload paths in ADDITIONAL_METADATA. Other media
  // layouts remain unchanged until their native request shape is verified.
  if (!checkpointInstruction && !nativeStreamError && imageLayout(content) && !nativeWrapped(content)) {
    const images = parts.filter(p => p.inlineData);
    const paths = images.map((p, index) => saveImageReference(p, imageStore,
      { cascadeId, uploadedAt: entry.uploadedAt, index, count: images.length })).filter(Boolean);
    for (const file of paths) savedPaths?.add(file);
    let metadata = `The current local time is: ${entry.timestamp}.\n`;
    if (paths.length) metadata += `\nThe user has uploaded ${paths.length} image(s):\n${paths.map(p => `- ${p}`).join('\n')}\nYou can embed ${paths.length === 1 ? 'this image' : 'these images'} in an artifact if you need the USER to review ${paths.length === 1 ? 'it' : 'them'}.\n`;
    let text = `<USER_REQUEST>\n${textContent(content)}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n${metadata}</ADDITIONAL_METADATA>`;
    if (entry.settingTo) text += `\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${entry.settingFrom || 'None'} to ${entry.settingTo}. No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\n</USER_SETTINGS_CHANGE>`;
    parts = [{ text }, ...images];
  }
  return { role: content.role, parts };
}

function prepareNativeContext(state, sourceContents, model, { metadata, now = Date.now(), checkpoint = false, compactionProfile = '', clientProfile = '', imageStore, restoreStreamRecovery = true } = {}) {
  const nativeErrors = new Set(), pendingRecovery = {};
  sourceContents = restoreClientProjections(state, sourceContents, model, { nativeErrors, clientProfile, restoreStreamRecovery,
    ...(!checkpoint ? { pendingRecovery } : {}) });
  const inputContents = pendingRecovery.inputContents || sourceContents;
  const streamRecovery = pendingRecovery.recovery || null;
  const pending = state.pendingCompaction;
  // Claude's captured checkpoint omits a completed answer that it preserves
  // after the summary. Retain only its previously observed timeline metadata;
  // never put omitted content/signatures back into the client's request.
  const previous = [...(Array.isArray(state.timeline) ? state.timeline : []),
    ...(pending?.profile === CLAUDE_COMPACTION_PROFILE && Array.isArray(pending.retainedTimeline)
      && sourceContents.some(content => capturedSummaryReplacement(content, pending)) ? pending.retainedTimeline : [])];
  const fingerprints = sourceContents.map(contentFingerprint);
  const matches = alignTimeline(previous, fingerprints);
  const lastMatch = matches.size ? Math.max(...matches.keys()) : -1;
  let nextStep = Number.isSafeInteger(state.nextStep) && state.nextStep >= 0 ? state.nextStep : 0;
  const displayName = modelProfile(model, metadata).displayName;
  let needsSetting = state.currentModel !== model;
  const lastIndex = sourceContents.length - 1;
  const instructionIndex = checkpoint && sourceContents[lastIndex]?.role === 'user' && !matches.has(lastIndex) ? lastIndex : -1;
  const retainedTimeline = checkpoint && compactionProfile === CLAUDE_COMPACTION_PROFILE && instructionIndex >= 0
    && fingerprints.slice(0, instructionIndex).every((fingerprint, index) => previous[index]?.fingerprint === fingerprint)
    ? previous.slice(instructionIndex).slice(-MAX_TIMELINE) : [];
  const replacementIndex = pending ? sourceContents.findIndex((content, i) => !matches.has(i) && content.role === 'user'
    && (summaryContent(content) || capturedSummaryReplacement(content, pending) || digest(textContent(content).trim()) === pending.summaryHash)) : -1;
  const entries = sourceContents.map((content, index) => {
    const existing = matches.get(index);
    const entry = existing || { fingerprint: fingerprints[index], timestamp: localTimestamp(now) };
    if (index === replacementIndex && capturedSummaryReplacement(content, pending)) entry.contextSummary = true;
    if (imageLayout(content) && content.parts.some(p => p.inlineData) && !nativeWrapped(content) && entry.uploadedAt === undefined) {
      entry.uploadedAt = Math.max(now, (state.lastImageUploadAt || 0) + 1);
      state.lastImageUploadAt = entry.uploadedAt;
    }
    if (existing) return entry;
    if (needsSetting && content.role === 'user' && index !== instructionIndex && index > lastMatch) {
      if (displayName && displayName !== model && !nativeWrapped(content)) {
        entry.settingFrom = state.currentModelDisplay || 'None'; entry.settingTo = displayName;
      }
      needsSetting = false; state.currentModel = model; state.currentModelDisplay = displayName || '';
    }
    // A checkpoint instruction is not a user-input step. A received summary
    // replaces context after the checkpoint; it does not create another step.
    if (index > lastMatch && index !== instructionIndex && index !== replacementIndex) nextStep += eventWeight(content);
    return entry;
  });
  if (replacementIndex >= 0) delete state.pendingCompaction;
  // A terminal tool-read failure still executes its received call in agy.
  // Count its final error only after actual receipts, without a recovery user.
  // Repeated API retries cannot consume this error or execution boundary again.
  for (const entry of new Set(pendingRecovery.terminalToolRecords || [])) {
    if (entry.terminalRecorded) continue;
    entry.terminalRecorded = true;nextStep += 1;state.lastExecutionId = crypto.randomUUID();
  }
  state.nextStep = nextStep;
  state.timeline = entries.filter((_, i) => i !== instructionIndex).slice(-MAX_TIMELINE);
  const restored = restoreHistory(state, sourceContents, model);
  const savedPaths = new Set();
  const contents = restored.map((c, i) => wireContent(c, entries[i], {
    checkpointInstruction: i === instructionIndex, nativeStreamError: nativeErrors.has(i), imageStore, cascadeId: state.cascadeId, savedPaths
  }));
  return { sourceContents, inputContents, streamRecovery, toolRecovery: pendingRecovery.toolRecovery, step: Math.max(1, nextStep), checkpoint, compactionProfile, retainedTimeline, imagePaths: savedPaths,
    contents };
}

function continueInterruptedStream(state, context, model, response, now = Date.now()) {
  interruptNativeContext(state, context, model, response, now);
  const partial = response.text ? [{ role: 'model', parts: [{ text: response.text,
    ...(response.signature ? { thoughtSignature: response.signature } : {}) }] }] : [];
  const error = streamErrorContent();
  state.nextStep += 1;
  state.timeline = [...(state.timeline || []), { fingerprint: contentFingerprint(error), timestamp: localTimestamp(now) }].slice(-MAX_TIMELINE);
  const contents = [...partial, error];
  context.sourceContents = [...context.sourceContents, ...contents];
  context.contents = [...context.contents, ...contents];
  context.step = state.nextStep;
  return contents;
}

function completeNativeContext(state, context, model, content, now = Date.now()) {
  if (!content.parts.length) return;
  state.nextStep = Math.max(context.step, state.nextStep || 0) + 1;
  if (context.checkpoint) {
    state.pendingCompaction = { summaryHash: digest(content.parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()),
      ...(context.compactionProfile === CLAUDE_COMPACTION_PROFILE ? { profile: context.compactionProfile,
        ...(context.retainedTimeline?.length ? { retainedTimeline: context.retainedTimeline } : {}) } : {}) };
  } else {
    // A changed/unknown client continuation must not leave a stale profile
    // that could reclassify a later, unrelated user message as the summary.
    if (state.pendingCompaction?.profile === CLAUDE_COMPACTION_PROFILE) delete state.pendingCompaction;
    recordResponse(state, context.sourceContents, model, content, now);
    state.timeline = [...(state.timeline || []), { fingerprint: contentFingerprint(content), timestamp: localTimestamp(now) }].slice(-MAX_TIMELINE);
  }
}

function interruptNativeContext(state, context, model, { receivedContent = false, text = '', signature = '' } = {}, now = Date.now()) {
  if (context.checkpoint || !receivedContent) return;
  // Real agy cancellation captures distinguish no response from thought-only
  // output: the latter consumes an agent step, but its unfinished thinking is
  // absent from the resumed history. Keep only actual partial visible text.
  state.nextStep = Math.max(context.step, state.nextStep || 0) + 1;
  if (!text) return;
  const content = { role: 'model', parts: [{ text, ...(signature ? { thoughtSignature: signature } : {}) }] };
  recordResponse(state, context.sourceContents, model, content, now);
  state.timeline = [...(state.timeline || []), { fingerprint: contentFingerprint(content), timestamp: localTimestamp(now) }].slice(-MAX_TIMELINE);
}

function interruptCheckpointContext(state, context, { terminalFailure = false } = {}) {
  if (!context.checkpoint) return;
  // Captured checkpoint retries do not each create an error step. Only a
  // terminal HTTP failure consumes one; cancellation (including backoff and
  // partial summary text) consumes none and never installs a partial summary.
  if (terminalFailure) state.nextStep = Math.max(context.step, state.nextStep || 0) + 1;
  if (context.retainedTimeline?.length) {
    state.timeline = [...(state.timeline || []), ...context.retainedTimeline].slice(-MAX_TIMELINE);
  }
  delete state.pendingCompaction;
}

module.exports = { prepareNativeContext, completeNativeContext, interruptNativeContext, interruptCheckpointContext, continueInterruptedStream, alignTimeline, localTimestamp };
