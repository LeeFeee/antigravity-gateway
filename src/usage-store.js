'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SAVE_INTERVAL_MS = 5 * 60_000;
const SUMMARY_INTERVAL_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

function zeroCounters() {
  return {
    clientRequests: 0, upstreamCalls: 0, successfulUpstreamCalls: 0, failedUpstreamCalls: 0,
    inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, totalTokens: 0
  };
}

function add(target, source) {
  for (const key of Object.keys(zeroCounters())) target[key] = (Number(target[key]) || 0) + (Number(source[key]) || 0);
  return target;
}

function hourKey(timestamp) {
  return new Date(Math.floor(timestamp / HOUR_MS) * HOUR_MS).toISOString();
}

function normalizedState(raw = {}) {
  const now = Date.now();
  return {
    version: 1,
    lifetime: add(zeroCounters(), raw.lifetime || {}),
    hourly: raw.hourly && typeof raw.hourly === 'object' ? raw.hourly : {},
    byModel: raw.byModel && typeof raw.byModel === 'object' ? raw.byModel : {},
    byAccount: raw.byAccount && typeof raw.byAccount === 'object' ? raw.byAccount : {},
    dashboard: {
      lifetime: add(zeroCounters(), raw.dashboard?.lifetime || raw.lifetime || {}),
      hourly: raw.dashboard?.hourly && typeof raw.dashboard.hourly === 'object' ? raw.dashboard.hourly : {},
      lifetimeUpdatedAt: raw.dashboard?.lifetimeUpdatedAt || new Date(now).toISOString(),
      hourlyUpdatedAt: raw.dashboard?.hourlyUpdatedAt || new Date(now).toISOString()
    },
    savedAt: raw.savedAt || ''
  };
}

class UsageStore {
  constructor({ configDir, fsImpl = fs, now = () => Date.now() } = {}) {
    if (!configDir) throw new Error('UsageStore requires configDir');
    this.fs = fsImpl;
    this.now = now;
    this.directory = path.join(configDir, 'usage');
    this.file = path.join(this.directory, 'usage-state.json');
    this.state = this.load();
    this.dirty = false;
    this.timer = null;
    this.refreshDashboard(true);
  }

  load() {
    try { return normalizedState(JSON.parse(this.fs.readFileSync(this.file, 'utf8'))); }
    catch { return normalizedState(); }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), SAVE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.dirty) this.save();
  }

  recordClientRequest() {
    this.state.lifetime.clientRequests += 1;
    const bucket = this.bucket();
    bucket.clientRequests += 1;
    this.dirty = true;
  }

  recordUpstream({ usage = {}, model = '', accountId = '', success = true, count = true } = {}) {
    const values = {
      upstreamCalls: count ? 1 : 0,
      successfulUpstreamCalls: count && success ? 1 : 0,
      failedUpstreamCalls: count && !success ? 1 : 0,
      inputTokens: Math.max(0, Number(usage.input_tokens) || 0),
      outputTokens: Math.max(0, Number(usage.output_tokens) || 0),
      thinkingTokens: Math.max(0, Number(usage.thinking_tokens) || 0),
      cachedTokens: Math.max(0, Number(usage.cache_read_tokens) || 0),
      totalTokens: Math.max(0, Number(usage.total_tokens) || 0)
    };
    if (!values.totalTokens) values.totalTokens = values.inputTokens + values.outputTokens + values.thinkingTokens;
    add(this.state.lifetime, values);
    add(this.bucket(), values);
    if (model) add((this.state.byModel[model] ||= zeroCounters()), values);
    if (accountId) add((this.state.byAccount[accountId] ||= zeroCounters()), values);
    this.dirty = true;
  }

  bucket() {
    const key = hourKey(this.now());
    return (this.state.hourly[key] ||= zeroCounters());
  }

  refreshDashboard(force = false) {
    const now = this.now();
    const lifetimeAt = Date.parse(this.state.dashboard.lifetimeUpdatedAt) || 0;
    const hourlyAt = Date.parse(this.state.dashboard.hourlyUpdatedAt) || 0;
    if ((force && !this.state.dashboard.lifetimeUpdatedAt) || now - lifetimeAt >= SUMMARY_INTERVAL_MS) {
      this.state.dashboard.lifetime = { ...this.state.lifetime };
      this.state.dashboard.lifetimeUpdatedAt = new Date(now).toISOString();
      this.dirty = true;
    }
    if ((force && !Object.keys(this.state.dashboard.hourly).length) || hourKey(now) !== hourKey(hourlyAt)) {
      this.state.dashboard.hourly = this.last24Hours(this.state.hourly);
      this.state.dashboard.hourlyUpdatedAt = new Date(now).toISOString();
      this.dirty = true;
    }
    this.prune();
  }

  last24Hours(source = this.state.hourly) {
    const output = {};
    const end = Math.floor(this.now() / HOUR_MS) * HOUR_MS;
    for (let index = 23; index >= 0; index -= 1) {
      const key = hourKey(end - index * HOUR_MS);
      output[key] = add(zeroCounters(), source[key] || {});
    }
    return output;
  }

  prune() {
    const cutoff = this.now() - 31 * 24 * HOUR_MS;
    for (const key of Object.keys(this.state.hourly)) if (Date.parse(key) < cutoff) delete this.state.hourly[key];
  }

  tick() {
    this.refreshDashboard();
    if (this.dirty) this.save();
  }

  save() {
    this.fs.mkdirSync(this.directory, { recursive: true });
    this.state.savedAt = new Date(this.now()).toISOString();
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
    this.fs.renameSync(temporary, this.file);
    this.dirty = false;
  }

  summary({ live = false } = {}) {
    const lifetime = live ? this.state.lifetime : this.state.dashboard.lifetime;
    const hourly = live ? this.last24Hours() : this.state.dashboard.hourly;
    return {
      lifetime: { ...lifetime },
      hourly: Object.entries(hourly).map(([at, values]) => ({ at, ...values })),
      lifetimeUpdatedAt: this.state.dashboard.lifetimeUpdatedAt,
      hourlyUpdatedAt: this.state.dashboard.hourlyUpdatedAt,
      savedAt: this.state.savedAt,
      byModel: live ? this.state.byModel : undefined,
      byAccount: live ? this.state.byAccount : undefined
    };
  }
}

module.exports = { HOUR_MS, SAVE_INTERVAL_MS, SUMMARY_INTERVAL_MS, UsageStore, hourKey, zeroCounters };
