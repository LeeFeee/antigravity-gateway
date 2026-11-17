'use strict';

const crypto = require('node:crypto');
const { GatewayError } = require('./protocol');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const advance = (prefix, message) => hash(prefix + '\0' + JSON.stringify(message));
function callKey(scope, model, prefix, message) {
  const call = message.function_call;
  let args = call.arguments;
  try { args = JSON.parse(args); } catch {}
  return hash(JSON.stringify([scope, model, prefix, message.content || null, call.name, args]));
}

// Deprecated Chat functions have no call ID on the client wire. Remember only
// the issued ID keyed by caller + model + complete submitted prefix + call.
// This is wire identifier translation, not conversation reconstruction or
// account affinity. No prompt, credential, account or tool execution is stored.
class LegacyChatCalls {
  constructor({ capacity = 2000, ttlMs = 24 * 60 * 60_000, now = Date.now } = {}) {
    this.entries = new Map(); this.capacity = capacity; this.ttlMs = ttlMs; this.now = now;
  }
  cleanup() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value);
  }
  resolve(scope, payload, model) {
    this.cleanup();
    if (!Array.isArray(payload.messages) || !payload.messages.some(message => message?.role === 'assistant' && message.function_call)) return new Map();
    let prefix = hash('chat-legacy-v1'); const ids = new Map();
    for (const [index, message] of (Array.isArray(payload.messages) ? payload.messages : []).entries()) {
      if (message?.role === 'assistant' && message.function_call) {
        const entry = this.entries.get(callKey(scope, model, prefix, message));
        if (!entry) throw new GatewayError('旧式 function_call 缺少本进程签发的调用 ID 映射。请重新发起工具请求，或使用保留 tool_call_id 的 tools/tool_calls 格式。', {
          code: 'legacy_function_call_not_found', status: 400
        });
        ids.set(index, entry.id);
      }
      prefix = advance(prefix, message);
    }
    return ids;
  }
  record(scope, payload, model, message, id) {
    if (!message?.function_call || !id) return;
    let prefix = hash('chat-legacy-v1');
    for (const item of payload.messages) prefix = advance(prefix, item);
    this.entries.set(callKey(scope, model, prefix, message), { id, expiresAt: this.now() + this.ttlMs });
    this.cleanup();
  }
}

module.exports = { LegacyChatCalls };
