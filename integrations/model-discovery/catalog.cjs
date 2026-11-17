'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const positive = (...values) => values.find(v => Number.isSafeInteger(v) && v > 0);

// Membership comes from data; the parallel Codex catalogue supplies capacities.
// Never infer a provider, model ID or thinking tier from a name.
function parseCatalog(body) {
  if (!Array.isArray(body?.data) || !body.data.length) throw new Error('网关模型目录为空或格式无效');
  const details = new Map((Array.isArray(body.models) ? body.models : []).map(m => [m.slug || m.id, m]));
  const seen = new Set();
  return body.data.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id)) {
      throw new Error('网关模型目录包含无效或重复 ID');
    }
    seen.add(row.id);
    const m = { ...details.get(row.id), ...row };
    const level = LEVELS.includes(m.default_reasoning_level) ? m.default_reasoning_level : undefined;
    return {
      id: row.id, name: m.display_name || m.name || row.id,
      input: m.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
      contextWindow: positive(m.context_window, m.contextWindow),
      maxTokens: positive(m.max_output_tokens, m.maxOutputTokens),
      level,
      reasoning: !!level || m.reasoning === true || Number(m.fixed_thinking_config?.thinkingBudget) > 0,
    };
  });
}

function toPiModels(models, config) {
  const old = new Map((config.models || []).map(m => [m.id, m]));
  return models.map(m => {
    const previous = old.get(m.id) || {};
    return {
      id: m.id, name: m.name, api: config.api, baseUrl: config.baseUrl,
      input: m.input, reasoning: m.reasoning || previous.reasoning === true,
      // A missing upstream output limit is a client budget, not a claimed model capacity.
      contextWindow: m.contextWindow || previous.contextWindow || 128000,
      maxTokens: m.maxTokens || previous.maxTokens || 16384,
      cost: previous.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(previous.compat ? { compat: previous.compat } : {}),
      ...(m.level ? { thinkingLevelMap: Object.fromEntries(LEVELS.map(l => [l, l === m.level ? l : null])) } : {}),
    };
  });
}

function toDshModels(models, config) {
  const old = new Map((config.models || []).map(m => [m.id, m]));
  return models.map(m => {
    const previous = old.get(m.id) || {};
    return {
      id: m.id, name: m.name, input: m.input,
      contextWindow: m.contextWindow || previous.contextWindow || config.defaultContextWindow || 128000,
      maxTokens: m.maxTokens || previous.maxTokens || config.defaultMaxTokens || 16384,
      reasoningEfforts: m.level ? { [m.level]: m.level } : previous.reasoningEfforts || false,
      ...(previous.compat ? { compat: previous.compat } : {}),
    };
  });
}

function listingUrl(baseUrl, api) {
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(api === 'anthropic-messages' && !base.endsWith('/v1') ? `${base}/v1/models` : `${base}/models`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效的网关地址');
  return url.href;
}

async function readBounded(response) {
  const chunks = []; let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('网关模型目录没有响应体');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error('网关模型目录超过 4 MiB');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

class Catalog {
  constructor(cacheDir) { this.cacheDir = cacheDir; this.entries = new Map(); this.pending = new Map(); }
  async load({ baseUrl, api, apiKey, headers = {}, signal, force = false, allowNetwork = true }) {
    const url = listingUrl(baseUrl, api);
    const requestHeaders = new Headers(headers);
    if (apiKey) {
      if (api === 'anthropic-messages') requestHeaders.set('x-api-key', apiKey);
      else requestHeaders.set('authorization', `Bearer ${apiKey}`);
    }
    if (api === 'anthropic-messages') requestHeaders.set('anthropic-version', '2023-06-01');
    // Cache isolation follows both endpoint and credential; credentials never reach disk.
    const key = crypto.createHash('sha256').update(JSON.stringify([url, [...requestHeaders]])).digest('hex');
    const file = path.join(this.cacheDir, `${key}.json`);
    let entry = this.entries.get(key);
    if (!entry) {
      try {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (stored.version === 1 && Number.isFinite(stored.at)) entry = { at: stored.at, models: parseCatalog(stored.body), body: stored.body };
      } catch { /* Missing/corrupt cache never changes client configuration. */ }
    }
    if (!allowNetwork) {
      if (entry) return { ...entry, stale: true };
      throw new Error('没有已缓存的网关模型目录');
    }
    if (entry && !force && Date.now() - entry.at < 30000) return { ...entry, stale: false };
    // Requests with their own cancellation must not cancel a different caller.
    if (!signal && this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      try {
        const timeout = AbortSignal.timeout(10000);
        const response = await fetch(url, { headers: requestHeaders, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`模型目录 HTTP ${response.status}`); }
        const body = await readBounded(response);
        const models = parseCatalog(body);
        // Persist only whitelisted catalogue fields, never arbitrary endpoint data.
        const safe = { data: models.map(m => ({ id: m.id, display_name: m.name, input_modalities: m.input,
          context_window: m.contextWindow, max_output_tokens: m.maxTokens,
          default_reasoning_level: m.level, reasoning: m.reasoning })) };
        entry = { at: Date.now(), models, body: safe };
        this.entries.set(key, entry);
        let cacheError;
        try {
          fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
          const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
          try {
            fs.writeFileSync(temp, JSON.stringify({ version: 1, at: entry.at, body: safe }), { mode: 0o600 });
            fs.renameSync(temp, file);
          } finally { fs.rmSync(temp, { force: true }); }
        } catch { cacheError = '模型目录已刷新，但本地缓存写入失败'; }
        return { ...entry, stale: false, cacheError };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (entry) return { ...entry, stale: true, error: error.message };
        throw error;
      }
    })();
    if (!signal) this.pending.set(key, task);
    try { return await task; } finally { if (!signal) this.pending.delete(key); }
  }
}
module.exports = { Catalog, parseCatalog, toPiModels, toDshModels, listingUrl };
