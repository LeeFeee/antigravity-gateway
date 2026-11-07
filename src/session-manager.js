'use strict';

const crypto = require('node:crypto');
const { detectNativeCompaction } = require('./agy-client-compaction');
const { capturedNativeClient } = require('./agy-client-profile');

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

function digest(...values) {
  return crypto.createHash('sha256').update(values.map((value) => String(value || '')).join('\0')).digest('hex');
}

function safeLabel(value) {
  return String(value || 'unknown-client').replace(/[^A-Za-z0-9._+:/-]+/g, '_').slice(0, 48) || 'unknown-client';
}

function explicitClientId(req, payload = {}) {
  const dshUserId = firstString(header(req, 'x-deepseek-harness-user-id'));
  return firstString(
    header(req, 'x-client-id'),
    header(req, 'x-agent-id'),
    header(req, 'x-client-name'),
    payload?.metadata?.client_id,
    payload?.metadata?.agent_id,
    payload?.client_id,
    payload?.agent_id,
    dshUserId ? `deepseek-harness/${dshUserId}` : ''
  );
}

function clientIdentity(req, payload = {}) {
  return explicitClientId(req, payload) || firstString(header(req, 'user-agent'), 'unknown-client');
}

function explicitSessionId(req, payload = {}, { legacy = true, cacheKey = true } = {}) {
  return firstString(
    header(req, 'x-session-id'),
    header(req, 'x-claude-session-id'),
    header(req, 'x-claude-code-session-id'),
    header(req, 'x-codex-session-id'),
    header(req, 'x-deepseek-harness-session-id'),
    header(req, 'x-client-session-id'),
    header(req, 'session-id'),
    header(req, 'session_id'),
    header(req, 'conversation-id'),
    header(req, 'x-conversation-id'),
    header(req, 'x-thread-id'),
    payload?.metadata?.session_id,
    payload?.metadata?.conversation_id,
    payload?.metadata?.thread_id,
    cacheKey ? payload?.prompt_cache_key : '',
    payload?.session_id,
    payload?.conversation_id,
    payload?.thread_id,
    // Retained last for clients that historically used these fields as their
    // only stable conversation identifier.
    legacy ? payload?.metadata?.user_id : '',
    legacy ? payload?.user : ''
  );
}

function explicitParentSessionId(req, payload = {}) {
  return firstString(
    header(req, 'x-parent-session-id'),
    header(req, 'parent-session-id'),
    payload?.metadata?.parent_session_id,
    payload?.metadata?.parent_conversation_id,
    payload?.parent_session_id,
    payload?.parent_conversation_id
  );
}

function explicitAffinityId(req, payload = {}) {
  return firstString(
    header(req, 'x-routing-affinity-id'),
    header(req, 'x-affinity-id'),
    payload?.metadata?.routing_affinity_id,
    payload?.metadata?.affinity_id,
    payload?.routing_affinity_id,
    payload?.affinity_id,
    header(req, 'x-session-affinity')
  );
}

function credentialScope(req) {
  const authorization = firstString(header(req, 'authorization'), header(req, 'x-api-key'));
  const address = String(req?.socket?.remoteAddress || '');
  return digest(authorization, address);
}

function clientScope(req, payload = {}) {
  return digest(credentialScope(req), clientIdentity(req, payload));
}

function responseScope(req, payload = {}) {
  return digest(clientScope(req, payload), explicitSessionId(req, payload));
}

function callerScope(req) {
  return responseScope(req);
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

function auxiliaryScope(req, normalized) {
  const dsh = firstString(header(req, 'x-deepseek-harness-session-id'));
  if (!dsh) return '';
  if (dsh && header(req, 'x-deepseek-harness-compact') === '1') return 'compaction';
  // Clients can send no-tool auxiliary and main tool requests under one ID.
  // Partition the declared tool surface, not natural-language intent. A tool
  // result stays on the main task even if the client omitted its definitions.
  if (normalized.tools?.length === 0 && !(normalized.messages || []).some(message => (
    (message.parts || []).some(part => part?.type === 'tool_result')
  ))) return 'no-client-tools';
  return '';
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

  alias(kind, scope, raw) {
    const aliasKey = `${kind}\0${scope}\0${raw}`;
    let entry = this.aliases.get(aliasKey);
    if (!entry) {
      entry = { id: digest(aliasKey), at: Date.now() };
      this.aliases.set(aliasKey, entry);
    } else entry.at = Date.now();
    return entry.id;
  }

  resolveIdentity(req, payload = {}, normalized = {}, previous = null) {
    this.cleanup();
    const scope = clientScope(req, payload);
    const explicit = explicitSessionId(req, payload);
    const parent = explicitParentSessionId(req, payload);
    const explicitAffinity = explicitAffinityId(req, payload);
    const fallback = fallbackSeed(payload, normalized);
    const conversationRaw = firstString(explicit, fallback);
    const affinityRaw = firstString(explicitAffinity, parent, explicit, fallback);
    const auxiliary = auxiliaryScope(req, normalized);
    const nativeCompaction = detectNativeCompaction(req, normalized);
    const nativeClientProfile = capturedNativeClient(req, normalized);
    const reliableConversation = Boolean(previous?.sessionId || explicitSessionId(req, payload, { legacy: false }));
    return {
      clientId: scope,
      clientLabel: safeLabel(clientIdentity(req, payload)),
      sessionId: previous?.sessionId || this.alias('conversation', scope, conversationRaw),
      routingKey: previous?.routingKey || this.alias('affinity', scope, affinityRaw),
      requestId: `req_${crypto.randomUUID().replaceAll('-', '')}`,
      ...(auxiliary ? { auxiliaryScope: auxiliary } : {}),
      ...(nativeCompaction ? { nativeCompaction } : {}),
      ...(nativeClientProfile ? { nativeClientProfile } : {}),
      sessionSource: previous?.sessionId ? 'previous_response' : explicit ? 'explicit' : 'fallback',
      affinitySource: previous?.routingKey ? 'previous_response' : explicitAffinity ? 'explicit' : parent ? 'parent' : explicit ? 'conversation' : 'fallback',
      // A legacy user identifier or a prompt fingerprint is not evidence of
      // one conversation. Never attach such a caller to saved upstream history.
      reuseConversation: reliableConversation
    };
  }

  resolve(req, payload = {}, normalized = {}, previous = null) {
    return this.resolveIdentity(req, payload, normalized, previous).sessionId;
  }

  getResponse(id, req, payload = {}) {
    this.cleanup();
    const response = this.responses.get(String(id || ''));
    if (!response || response.scope !== responseScope(req, payload)) return null;
    response.at = Date.now();
    return response;
  }

  hasResponse(id) {
    this.cleanup();
    return this.responses.has(String(id || ''));
  }

  bindResponse(id, req, value, payload = {}) {
    this.cleanup();
    this.responses.set(id, { ...value, scope: responseScope(req, payload), at: Date.now() });
  }
}

module.exports = {
  SessionManager,
  callerScope,
  clientScope,
  credentialScope,
  explicitAffinityId,
  explicitClientId,
  explicitParentSessionId,
  explicitSessionId,
  fallbackSeed,
  responseScope
};
