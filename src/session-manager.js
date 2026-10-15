'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_CAPACITY = 2000;

class SessionIdentityError extends Error {
  constructor(message, code) { super(message); this.name = 'SessionIdentityError'; this.code = code; this.status = 409; }
}

function trailingToolResultIds(normalized) {
  const ids = [];
  for (let index = (normalized.messages || []).length - 1; index >= 0; index--) {
    const results = (normalized.messages[index].parts || []).filter(part => part?.type === 'tool_result' && part.id);
    if (!results.length) break;
    ids.push(...results.map(part => String(part.id)));
  }
  return [...new Set(ids)];
}

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
  if (!firstString(header(req, 'x-deepseek-harness-session-id'))) return '';
  if (header(req, 'x-deepseek-harness-compact') === '1') return 'compaction';
  // DSH sends title-only and main tool requests under the same session ID.
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
    this.toolOwners = new Map();
    this.toolBindings = new Map();
  }

  cleanup() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, value] of this.responses) if (value.at < cutoff) this.responses.delete(id);
    for (const [id, value] of this.aliases) if (value.at < cutoff) this.aliases.delete(id);
    for (const binding of this.toolBindings.values()) if (binding.at < cutoff) this.removeToolBinding(binding);
    while (this.responses.size > this.capacity) this.responses.delete(this.responses.keys().next().value);
    while (this.aliases.size > this.capacity * 2) this.aliases.delete(this.aliases.keys().next().value);
    while (this.toolBindings.size > this.capacity) this.removeToolBinding(this.toolBindings.values().next().value);
  }

  removeToolBinding(binding) {
    this.toolBindings.delete(binding.bindingKey);
    const owners = this.toolOwners.get(binding.lookupKey);
    owners?.delete(binding.sessionId);
    if (!owners?.size) this.toolOwners.delete(binding.lookupKey);
  }

  toolOwner(taskProvider, clientId, ids) {
    let matches;
    for (const id of ids) {
      const owners = this.toolOwners.get(digest(taskProvider, clientId, id));
      if (!owners?.size) throw new SessionIdentityError('工具结果找不到当前客户端的活动任务。', 'tool_session_not_found');
      matches = matches ? new Set([...matches].filter(sessionId => owners.has(sessionId))) : new Set(owners.keys());
    }
    if (matches?.size !== 1) throw new SessionIdentityError('工具结果无法唯一关联到一个活动任务，请提供明确的会话 ID。', 'tool_session_ambiguous');
    const lookup = this.toolOwners.get(digest(taskProvider, clientId, ids[0]));
    return lookup.get([...matches][0]);
  }

  bindToolCalls(identity, calls) {
    if (!identity.anonymousTask || !identity.taskProvider) return;
    this.cleanup();
    for (const binding of this.toolBindings.values()) {
      if (binding.taskProvider === identity.taskProvider && binding.clientId === identity.clientId
          && binding.sessionId === identity.sessionId) this.removeToolBinding(binding);
    }
    for (const call of calls || []) {
      if (!call?.id) continue;
      const lookupKey = digest(identity.taskProvider, identity.clientId, call.id);
      const bindingKey = digest(lookupKey, identity.sessionId);
      const binding = { lookupKey, bindingKey, taskProvider: identity.taskProvider, clientId: identity.clientId,
        sessionId: identity.sessionId, routingKey: identity.routingKey, at: Date.now() };
      const owners = this.toolOwners.get(lookupKey) || new Map();
      owners.set(identity.sessionId, binding);
      this.toolOwners.set(lookupKey, owners);
      this.toolBindings.set(bindingKey, binding);
    }
    this.cleanup();
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

  resolveIdentity(req, payload = {}, normalized = {}, previous = null, { taskProvider = '' } = {}) {
    this.cleanup();
    const scope = clientScope(req, payload);
    const explicit = explicitSessionId(req, payload);
    const parent = explicitParentSessionId(req, payload);
    const explicitAffinity = explicitAffinityId(req, payload);
    const fallback = fallbackSeed(payload, normalized);
    const nativeExplicit = taskProvider ? explicitSessionId(req, payload, { legacy: false, cacheKey: false }) : explicit;
    const conversationRaw = firstString(nativeExplicit, explicit, fallback);
    const affinityRaw = firstString(explicitAffinity, parent, explicit, fallback);
    const auxiliary = auxiliaryScope(req, normalized);
    const reliableConversation = Boolean(previous?.sessionId || (taskProvider ? nativeExplicit
      : explicitSessionId(req, payload, { legacy: false })));
    let anonymousTask = Boolean(previous?.anonymousTask), owner;
    if (taskProvider && !reliableConversation) {
      anonymousTask = true;
      const ids = trailingToolResultIds(normalized);
      if (ids.length) owner = this.toolOwner(taskProvider, scope, ids);
    }
    return {
      clientId: scope,
      clientLabel: safeLabel(clientIdentity(req, payload)),
      sessionId: previous?.sessionId || owner?.sessionId || (anonymousTask
        ? digest('anonymous-task', taskProvider, scope, crypto.randomUUID())
        : this.alias('conversation', scope, conversationRaw)),
      routingKey: previous?.routingKey || owner?.routingKey || this.alias('affinity', scope, affinityRaw),
      requestId: `req_${crypto.randomUUID().replaceAll('-', '')}`,
      ...(auxiliary ? { auxiliaryScope: auxiliary } : {}),
      sessionSource: previous?.sessionId ? 'previous_response' : owner ? 'tool_result' : anonymousTask ? 'anonymous' : explicit ? 'explicit' : 'fallback',
      affinitySource: previous?.routingKey ? 'previous_response' : explicitAffinity ? 'explicit' : parent ? 'parent' : explicit ? 'conversation' : 'fallback',
      // A legacy user identifier or a prompt fingerprint is not evidence of
      // one conversation. Never attach such a caller to saved upstream history.
      reuseConversation: reliableConversation,
      ...(taskProvider ? { taskProvider } : {}),
      ...(anonymousTask ? { anonymousTask: true } : {})
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
  SessionIdentityError,
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
