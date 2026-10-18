'use strict';

// All transports share one policy; credentials, quota acquisition, health and
// active upstream task ownership remain the responsibility of each provider.
const DEFAULT_SESSION_TTL_SECONDS = 5 * 60 * 60;
const configuredSeconds = Number(process.env.ANTIGRAVITY_AFFINITY_TTL_SECONDS
  ?? process.env.ANTIGRAVITY_ROBIN_AFFINITY_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
const SESSION_TTL_MS = Math.max(0, Number.isFinite(configuredSeconds)
  ? configuredSeconds : DEFAULT_SESSION_TTL_SECONDS) * 1000;
const SESSION_CAPACITY = 2000;
const QUOTA_TTL_MS = 30 * 60_000;
const QUOTA_RETRY_MS = 5 * 60_000;
const TRANSIENT_COOLDOWN_MS = 15_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

function durationMs(value) {
  const source = String(value || '');
  let total = 0;
  let matched = false;
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)(ms|[smhd])/gi)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += amount * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] || 0);
  }
  return matched ? total : 0;
}

function retryDelay(details, fallback = DEFAULT_COOLDOWN_MS) {
  const source = String(details || '');
  const resetAt = source.match(/(?:quotaResetTimeStamp|resetTime|reset_at)[^0-9]{0,16}(\d{4}-\d{2}-\d{2}T[^"'\s,}]+)/i);
  if (resetAt) {
    const delay = Date.parse(resetAt[1]) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return Math.max(1000, Math.min(MAX_COOLDOWN_MS, delay));
  }
  const duration = source.match(/(?:quotaResetDelay|retryDelay|retry_after|retry after|reset after)[^0-9]{0,24}((?:\d+(?:\.\d+)?(?:ms|[smhd]))+)/i);
  const milliseconds = durationMs(duration?.[1]);
  if (milliseconds > 0) return Math.max(1000, Math.min(MAX_COOLDOWN_MS, milliseconds));
  const seconds = source.match(/(?:retry_after|retry after)[^0-9]{0,8}(\d+(?:\.\d+)?)/i);
  return seconds ? Math.max(1000, Math.min(MAX_COOLDOWN_MS, Number(seconds[1]) * 1000)) : fallback;
}

function affinityActive(binding, now) {
  return Boolean(binding && SESSION_TTL_MS > 0 && binding.at >= now - SESSION_TTL_MS);
}

function geminiGroup(snapshot) {
  return (snapshot?.groups || []).find((group) => /gemini/i.test([
    group?.id, group?.displayName, group?.description
  ].filter(Boolean).join(' ')));
}

function geminiWeeklyPressure(snapshot, now) {
  const bucket = geminiGroup(snapshot)?.buckets?.find((item) => (
    String(item?.window || '').toLowerCase() === 'weekly'
    || String(item?.id || '').toLowerCase().endsWith('-weekly')
  ));
  const raw = bucket?.remainingFraction;
  const remaining = raw == null || String(raw).trim() === '' || typeof raw === 'boolean' ? NaN : Number(raw);
  const resetAt = Date.parse(bucket?.resetTime || '');
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt) || resetAt <= now) return { kind: 'unknown', band: 0 };
  if (remaining <= 0 || bucket.available === false) return { kind: 'exhausted', band: 0 };
  const hours = Math.max((resetAt - now) / 3_600_000, 1 / 60);
  const pressure = Math.min(1, remaining) / hours;
  return { kind: 'pressure', band: Math.floor(Math.log2(pressure)) };
}

function geminiFiveHourResetTime(snapshot, now) {
  const bucket = geminiGroup(snapshot)?.buckets?.find((item) => String(item?.window || '').toLowerCase() === '5h');
  const resetTime = Date.parse(bucket?.resetTime || '');
  return Number.isFinite(resetTime) && resetTime > now ? resetTime : Infinity;
}

function quotaRank(entry, snapshot, now, depleted = false) {
  const weekly = geminiWeeklyPressure(snapshot, now);
  return {
    entry, depleted: depleted ? 1 : 0,
    lane: { pressure: 0, unknown: 1, exhausted: 2 }[weekly.kind],
    band: weekly.band, resetTime: geminiFiveHourResetTime(snapshot, now)
  };
}

function compareQuotaRanks(left, right) {
  return left.depleted - right.depleted
    || left.lane - right.lane
    || right.band - left.band
    || (left.resetTime === right.resetTime ? 0 : left.resetTime < right.resetTime ? -1 : 1);
}

function weightedPickWithRanks(ranks, weights) {
  if (!ranks.length) return null;
  // A snapshot is advisory: exhausted accounts are last-resort fallbacks, not
  // permanent exclusions. Real upstream failures are handled by pool cooldowns.
  let candidates = ranks.filter((rank) => !rank.depleted && rank.lane !== 2);
  if (!candidates.length) candidates = ranks.filter((rank) => !rank.depleted);
  if (!candidates.length) candidates = ranks;

  const pressureRanks = candidates.filter((rank) => rank.lane === 0);
  const maxBand = pressureRanks.length ? Math.max(...pressureRanks.map((rank) => rank.band)) : null;
  const nearestResetByBand = new Map();
  for (const rank of candidates) {
    if (!Number.isFinite(rank.resetTime)) continue;
    const key = `${rank.lane}:${rank.band}`;
    nearestResetByBand.set(key, Math.min(nearestResetByBand.get(key) ?? Infinity, rank.resetTime));
  }
  const effectiveWeight = (rank) => {
    const accountWeight = Math.max(1, Number(rank.entry.account.weight) || 1);
    let weeklyWeight = 1;
    if (rank.lane === 0 && maxBand != null) {
      const difference = rank.band - maxBand;
      weeklyWeight = difference >= 0 ? 4 : difference === -1 ? 2 : 1;
    }
    const nearestReset = nearestResetByBand.get(`${rank.lane}:${rank.band}`);
    const fiveHourWeight = Number.isFinite(nearestReset) && rank.resetTime === nearestReset ? 2 : 1;
    return accountWeight * weeklyWeight * fiveHourWeight;
  };
  const total = candidates.reduce((sum, rank) => sum + effectiveWeight(rank), 0);
  let selected = null;
  let selectedWeight = -Infinity;
  for (const rank of candidates) {
    const id = rank.entry.account.id;
    const current = (weights.get(id) || 0) + effectiveWeight(rank);
    weights.set(id, current);
    if (current > selectedWeight) {
      selected = rank.entry;
      selectedWeight = current;
    }
  }
  if (selected) weights.set(selected.account.id, (weights.get(selected.account.id) || 0) - total);
  return selected;
}

module.exports = {
  SESSION_TTL_MS, SESSION_CAPACITY, QUOTA_TTL_MS, QUOTA_RETRY_MS, TRANSIENT_COOLDOWN_MS,
  durationMs, retryDelay, affinityActive,
  geminiWeeklyPressure, geminiFiveHourResetTime, quotaRank, compareQuotaRanks, weightedPickWithRanks
};
