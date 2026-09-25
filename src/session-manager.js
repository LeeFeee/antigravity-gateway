'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_CAPACITY = 2000;

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function header(req, name) {
  const value = req?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function explicitSessionId(req, payload = {}) {
  return firstString(
    header(req, 'x-session-id'),
    header(req, 'x-claude-session-id'),
    header(req, 'x-codex-session-id'),
    header(req, 'x-client-session-id'),
    header(req, 'session-id'),
    header(req, 'conversation-id'),
    header(req, 'x-conversation-id'),
    header(req, 'x-thread-id'),
    payload?.metadata?.parent_session_id,
    payload?.metadata?.session_id,
    payload?.metadata?.user_id,
    payload?.metadata?.conversation_id,
    payload?.metadata?.thread_id,
    payload?.prompt_cache_key,
    payload?.session_id,
    payload?.conversation_id,
    payload?.thread_id,
    payload?.user
  );
}

function credentialScope(req) {
  const authorization = firstString(header(req, 'authorization'), header(req, 'x-api-key'));
  const address = String(req?.socket?.remoteAddress || '');
  return crypto.createHash('sha256').update(`${authorization}\0${address}`).digest('hex');
}

function callerScope(req) {
  const clientSession = firstString(header(req, 'x-session-id'), header(req, 'x-claude-session-id'), header(req, 'x-codex-session-id'), header(req, 'x-client-session-id'), header(req, 'session-id'));
  return crypto.createHash('sha256').update(`${credentialScope(req)}\0${clientSession}`).digest('hex');
}

function fallbackSeed(payload = {}, normalized = {}) {
  const first = normalized.messages?.find((message) => message?.role === 'user') || normalized.messages?.[0] || {};
  return JSON.stringify({
    model: normalized.model || payload.model || '',
    role: first.role || '',
    text: String(first.text || '').slice(0, 4096),
    media: (first.parts || []).filter((part) => part?.type === 'media').slice(0, 4)
      .map((part) => ({ id: part.id, mediaType: part.mediaType, filename: part.filename }))
  });
}

class SessionManager {
  constructor({ ttlMs = DEFAULT_TTL_MS, capacity = DEFAULT_CAPACITY } = {}) {
    this.ttlMs = Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.capacity = Math.max(100, Number(capacity) || DEFAULT_CAPACITY);
    this.responses = new Map();
    this.aliases = new Map();
  }

  cleanup() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, value] of this.responses) if (value.at < cutoff) this.responses.delete(id);
    for (const [id, value] of this.aliases) if (value.at < cutoff) this.aliases.delete(id);
    while (this.responses.size > this.capacity) this.responses.delete(this.responses.keys().next().value);
    while (this.aliases.size > this.capacity * 2) this.aliases.delete(this.aliases.keys().next().value);
  }

  resolve(req, payload = {}, normalized = {}, previous = null) {
    this.cleanup();
    const scope = callerScope(req);
    const explicit = explicitSessionId(req, payload);
    const raw = firstString(explicit, previous?.sessionId, fallbackSeed(payload, normalized));
    const aliasKey = `${scope}\0${raw}`;
    let entry = this.aliases.get(aliasKey);
    if (!entry) {
      entry = { id: crypto.createHash('sha256').update(aliasKey).digest('hex'), at: Date.now() };
      this.aliases.set(aliasKey, entry);
    } else entry.at = Date.now();
    return entry.id;
  }

  getResponse(id, req) {
    this.cleanup();
    const response = this.responses.get(String(id || ''));
    if (!response || response.scope !== callerScope(req)) return null;
    response.at = Date.now();
    return response;
  }

  hasResponse(id) {
    this.cleanup();
    return this.responses.has(String(id || ''));
  }

  bindResponse(id, req, value) {
    this.cleanup();
    this.responses.set(id, { ...value, scope: callerScope(req), at: Date.now() });
  }
}

module.exports = { SessionManager, callerScope, credentialScope, explicitSessionId, fallbackSeed };
