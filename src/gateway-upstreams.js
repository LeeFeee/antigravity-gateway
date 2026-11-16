'use strict';

const { VERIFIED_MODELS, VERIFIED_THINKING_LEVELS } = require('./gemini-model-catalog');
const { GatewayError } = require('./protocol');

const GEMINI_MODEL_IDS = new Set(VERIFIED_MODELS.flatMap(model => [
  `${model.name}-g`, ...Object.keys(VERIFIED_THINKING_LEVELS).map(level => `${model.name}-${level}-g`)
]));

class GatewayUpstreams {
  constructor({ antigravity, gemini }) {
    this.antigravity = antigravity;
    this.gemini = gemini;
    this.sessions = new Map();
  }

  providerFor(model) {
    if (GEMINI_MODEL_IDS.has(model)) return 'gemini';
    if (String(model).endsWith('-g')) throw new GatewayError('未注册的 Google Gemini API 模型。', { code: 'unknown_gemini_model', status: 404 });
    return 'cloudcode';
  }

  poolFor(model) { return this.providerFor(model) === 'gemini' ? this.gemini : this.antigravity; }

  async listModels(signal, options) {
    const results = await Promise.allSettled([this.antigravity, this.gemini].map(pool =>
      pool.hasManagedAccounts() ? pool.listModels(signal, options) : Promise.resolve([])));
    const models = [...new Set(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))];
    if (!models.length) {
      const error = results.find(result => result.status === 'rejected');
      if (error) throw error.reason;
    }
    return models;
  }

  sessionKey(identity) {
    if (!identity?.clientId || !(identity.reuseConversation || identity.affinitySource === 'parent')) return '';
    return `${identity.clientId}\0${identity.routingKey || identity.sessionId}`;
  }

  remember(identity, model) {
    const key = this.sessionKey(identity);
    if (!key) return;
    const now = Date.now();
    for (const [entry, value] of this.sessions) if (now - value.at > 3600000) this.sessions.delete(entry);
    this.sessions.delete(key);
    this.sessions.set(key, { provider: this.providerFor(model), at: now });
    while (this.sessions.size > 2000) this.sessions.delete(this.sessions.keys().next().value);
  }

  reviewModel(model) { return this.providerFor(model) === 'gemini' ? 'gemini-4-hydrogen-low-g' : 'gemini-3.8-flash-low'; }

  classifierModel(identity) {
    const key = this.sessionKey(identity), associated = key && this.sessions.get(key);
    if (associated && Date.now() - associated.at <= 3600000) {
      return associated.provider === 'gemini' ? 'gemini-4-hydrogen-low-g' : 'gemini-3.8-flash-low';
    }
    // Keep the established Sonnet 5 classifier route when there is no recorded
    // main turn. Adding a Gemini account must not reject an existing client.
    return 'gemini-3.8-flash-low';
  }
}

module.exports = { GatewayUpstreams, GEMINI_MODEL_IDS };
