'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const seconds = Number(process.env.ANTIGRAVITY_ROBIN_AFFINITY_TTL_SECONDS || 5 * 60 * 60);
const CONVERSATION_TTL_MS = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 5 * 60 * 60_000;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const ownerKey = account => hash(JSON.stringify(['robin', account?.id || '', account?.subjectId || account?.email || '']));

function validCursor(value) {
  return value && /^c_[A-Za-z0-9_-]{8,128}$/.test(value.conversationId)
    && /^r_[A-Za-z0-9_-]{8,128}$/.test(value.parentRequestId)
    && /^r(?:c)?_[A-Za-z0-9_-]{8,128}$/.test(value.parentResponseId);
}

// Store transport cursors only. The client's submitted messages remain the
// authoritative context; no prompts, answers or tool results are saved here.
class RobinConversationStore {
  constructor({ account, directory, ttlMs = CONVERSATION_TTL_MS, capacity = 4096, now = () => Date.now() } = {}) {
    this.owner = ownerKey(account);
    this.file = directory && account?.id ? path.join(directory, `robin-conversations-${this.owner.slice(0, 24)}.json`) : '';
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : CONVERSATION_TTL_MS;
    this.capacity = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 4096;
    this.now = now;
    this.cursors = new Map();
    if (this.file) {
      try {
        const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (stored.owner === this.owner) {
          for (const [key, value] of Object.entries(stored.cursors || {})) {
            if (/^[a-f0-9]{64}$/.test(key) && validCursor(value) && Number.isFinite(value.at)
                && this.ttlMs > 0 && this.now() - value.at < this.ttlMs) this.cursors.set(key, value);
          }
        }
      } catch { /* No valid persisted cursor. */ }
    }
    this.trim();
  }

  matches(account) { return this.owner === ownerKey(account); }

  get(sessionId) {
    const key = hash(sessionId), value = this.cursors.get(key);
    if (!value) return null;
    if (this.ttlMs <= 0 || this.now() - value.at >= this.ttlMs) {
      this.cursors.delete(key);
      return null;
    }
    return { conversationId: value.conversationId, parentRequestId: value.parentRequestId, parentResponseId: value.parentResponseId };
  }

  set(sessionId, cursor) {
    if (!sessionId || !validCursor(cursor) || this.ttlMs <= 0) return;
    const key = hash(sessionId);
    this.cursors.delete(key);
    this.cursors.set(key, { conversationId: cursor.conversationId, parentRequestId: cursor.parentRequestId,
      parentResponseId: cursor.parentResponseId, at: this.now() });
    this.trim(); this.save();
  }

  trim() {
    for (const [key, value] of this.cursors) if (this.now() - value.at >= this.ttlMs) this.cursors.delete(key);
    while (this.cursors.size > this.capacity) this.cursors.delete(this.cursors.keys().next().value);
  }

  save() {
    if (!this.file) return;
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, `${JSON.stringify({ owner: this.owner, cursors: Object.fromEntries(this.cursors) })}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* Best-effort cursor persistence. */ }
    }
  }

  forget() {
    this.cursors.clear();
    if (this.file) { try { fs.unlinkSync(this.file); } catch { /* No prior state. */ } }
  }
}

module.exports = { CONVERSATION_TTL_MS, RobinConversationStore };
