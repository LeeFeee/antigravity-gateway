'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { GeminiAccountStore } = require('../src/gemini-account-store');
const { RobinAccountPool } = require('../src/robin-account-pool');
const { SESSION_TTL_MS, QUOTA_TTL_MS, QUOTA_RETRY_MS } = require('../src/account-scheduling');
const { REFRESH_INTERVAL_MS, TARGETED_REFRESH_MIN_INTERVAL_MS } = require('../src/quota-manager');

const NOW = Date.parse('2026-10-18T00:00:00Z');
const HOUR = 3_600_000;
const MODEL = 'gemini-4-argon';
const CHANNELS = ['cloudcode', 'oauth', 'windows'];
const normalized = { messages: [], tools: [] };

function snapshot({ remaining = 0.5, weeklyHours = 24, fiveHours = 2, fiveRemaining = 0.5, unknown = false } = {}) {
  const available = remaining > 0 && fiveRemaining > 0;
  return {
    fetchedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + QUOTA_TTL_MS).toISOString(),
    available: unknown ? true : available,
    groups: unknown ? [] : [{ id: 'gemini', available, buckets: [
      { window: 'weekly', remainingFraction: remaining, resetTime: new Date(NOW + weeklyHours * HOUR).toISOString(), available: remaining > 0 },
      { window: '5h', remainingFraction: fiveRemaining, resetTime: new Date(NOW + fiveHours * HOUR).toISOString(), available: fiveRemaining > 0 }
    ] }]
  };
}

function fixture(t, channel, definitions, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-shared-scheduling-'));
  const isCloud = channel === 'cloudcode';
  const store = isCloud ? new AccountStore({ configDir: dir }) : new GeminiAccountStore({ configDir: dir });
  let time = NOW, reads = 0;
  const snapshots = new Map();
  definitions.forEach((definition, index) => {
    const id = `account-${index}`;
    const windows = channel === 'windows' || channel === 'mixed' && index % 2 === 1;
    const quota = snapshot(definition);
    snapshots.set(id, quota);
    store.save({ id, subjectId: id, email: `${id}@example.com`, accessToken: 'test-only', projectId: 'test',
      providerType: isCloud ? 'cloudcode' : 'robin', accountType: isCloud ? 'antigravity' : 'gemini-app',
      authMethod: windows ? 'gemini-windows-session' : 'oauth', capabilities: [MODEL], weight: definition.weight || 1,
      providerMetadata: {
        [windows ? 'geminiWindowsQuota' : 'robinQuota']: quota,
        ...(windows ? { geminiWindows: { cookies: [{ name: 'SID', value: 'test-only', domain: '.google.com' }] } } : {})
      }
    });
  });
  const factory = record => ({
    listModels: async () => [MODEL],
    send: async (_input, _model, options) => {
      if (send) await send(record.id, options);
      return { text: record.id, toolCalls: [], usage: {} };
    }
  });
  const pool = isCloud
    ? new AccountPool({ store, now: () => time, providerFactory: factory })
    : new RobinAccountPool({ store, now: () => time, providerFactory: factory });
  if (isCloud) pool.quotaManager = {
    get: id => {
      reads++;
      const quota = snapshots.get(id);
      return Date.parse(quota?.expiresAt) > time ? quota : null;
    },
    getSchedulingSnapshot: id => pool.quotaManager.get(id)
  };
  else {
    const get = pool.quotaSnapshot.bind(pool);
    pool.quotaSnapshot = account => { reads++; return get(account); };
  }
  t.after(() => { pool.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const setQuota = (id, definition) => {
    const quota = snapshot(definition);
    snapshots.set(id, quota);
    if (!isCloud) {
      const account = store.list().find(item => item.id === id);
      const key = account.authMethod === 'gemini-windows-session' ? 'geminiWindowsQuota' : 'robinQuota';
      store.update(id, { providerMetadata: { ...account.providerMetadata, [key]: quota } });
    }
  };
  return { pool, store, factory, setQuota, reads: () => reads, advance: ms => { time += ms; },
    pick: (key = '', excluded = new Set(), options) => pool.selectAccount(MODEL, key, excluded, options)?.account.id,
    bind: (key, id) => isCloud ? pool.bindSession(key, id) : pool.bind(key, id) };
}

test('all three channels produce the same complete weighted sequence, not just the same first pick', t => {
  const cases = [
    { definitions: [{ remaining: 0.6, weeklyHours: 12, fiveHours: 1 },
      { remaining: 0.8, weeklyHours: 20, fiveHours: 0.5 }, { remaining: 0.2, weeklyHours: 2, fiveHours: 4 }], counts: [20, 40, 80] },
    { definitions: [{ weight: 1 }, { weight: 2 }, { weight: 3 }], counts: [20, 40, 60], length: 120 },
    { definitions: [{ fiveHours: 1 }, { fiveHours: 3 }, { fiveHours: 4 }], counts: [70, 35, 35] },
    { definitions: [{ unknown: true }, { unknown: true }, { unknown: true }], counts: [40, 40, 40], length: 120 }
  ];
  for (const { definitions, counts, length = 140 } of cases) {
    const sequences = CHANNELS.map(channel => {
      const state = fixture(t, channel, definitions);
      return Array.from({ length }, () => state.pick());
    });
    assert.deepEqual(sequences[1], sequences[0]);
    assert.deepEqual(sequences[2], sequences[0]);
    assert.deepEqual(definitions.map((_, i) => sequences[0].filter(id => id === `account-${i}`).length), counts);
  }
});

test('all channels preserve sticky bindings without quota reads, weight spending, or sliding renewal', t => {
  for (const channel of CHANNELS) {
    const state = fixture(t, channel, [{ remaining: 0 }, { remaining: 1, weeklyHours: 1 }]);
    state.bind('family', 'account-0');
    const beforeReads = state.reads(), beforeWeights = [...state.pool.weights];
    state.advance(1000);
    assert.equal(state.pick('family'), 'account-0', channel);
    state.bind('family', 'account-0');
    assert.equal(state.pool.sessions.get('family').at, NOW);
    assert.equal(state.reads(), beforeReads);
    assert.deepEqual([...state.pool.weights], beforeWeights);
    state.advance(SESSION_TTL_MS - 1000);
    assert.equal(state.pick('family'), 'account-0', 'same boundary semantics');
    state.advance(1);
    // Both quota snapshots have expired; ordinary equal-weight rotation resumes.
    assert.equal(state.pick('family'), 'account-0');
    assert.equal(state.pick('another'), 'account-1');
    assert.ok(state.reads() > beforeReads);
  }
});

test('all channels skip depleted budgets with alternatives and retain the final fallback', t => {
  for (const channel of CHANNELS) {
    const state = fixture(t, channel, [{ fiveRemaining: 0 }, { remaining: 0 }, {}]);
    for (let i = 0; i < 10; i++) assert.equal(state.pick(), 'account-2', channel);
    assert.equal(state.pick('', new Set(['account-1', 'account-2'])), 'account-0');
    assert.equal(state.pick('', new Set(['account-0', 'account-2'])), 'account-1');
    assert.equal(state.pick('', new Set(['account-0', 'account-1', 'account-2'])), undefined);
    assert.ok(state.pool.entries.size === 3, 'advisory exhaustion never removes credentials');
  }
});

test('all channels re-read quota on failover and try each account at most once', async t => {
  for (const channel of CHANNELS) {
    const calls = [];
    let state;
    state = fixture(t, channel, [{}, { remaining: 0.9, weeklyHours: 1 }, { remaining: 0.5, weeklyHours: 168 }], async id => {
      calls.push(id);
      if (id === 'account-0') {
        state.setQuota('account-2', { remaining: 0.9, weeklyHours: 0.1 });
        throw Object.assign(new Error('quota exhausted'), { status: 429 });
      }
    });
    state.bind('family', 'account-0');
    const result = await state.pool.send(normalized, MODEL, { routingKey: 'family' });
    assert.deepEqual(calls, ['account-0', 'account-2'], channel);
    assert.equal(result.accountId, 'account-2');
    assert.equal(state.pool.sessions.get('family').accountId, 'account-2');

    const failed = [];
    const exhausted = fixture(t, channel, [{}, {}, {}], async id => {
      failed.push(id); throw Object.assign(new Error('quota exhausted'), { status: 429 });
    });
    await assert.rejects(exhausted.pool.send(normalized, MODEL), /quota exhausted/);
    assert.equal(failed.length, 3); assert.equal(new Set(failed).size, 3);
    assert.equal(exhausted.pick(), undefined, 'actual upstream failures apply cooldowns');
  }
});

test('session-only clients, bindRouting=false and persisted affinity have matching semantics', async t => {
  for (const channel of CHANNELS) {
    const state = fixture(t, channel, [{}, {}]);
    const first = await state.pool.send(normalized, MODEL, { sessionId: 'chat' });
    assert.equal(state.pool.sessions.get('chat').accountId, first.accountId);
    const again = await state.pool.send(normalized, MODEL, { sessionId: 'chat' });
    assert.equal(again.accountId, first.accountId);
    await state.pool.send(normalized, MODEL, { routingKey: 'auxiliary', bindRouting: false });
    assert.equal(state.pool.sessions.has('auxiliary'), false);
    const restored = channel === 'cloudcode'
      ? new AccountPool({ store: state.store, now: () => NOW, providerFactory: state.factory })
      : new RobinAccountPool({ store: state.store, now: () => NOW, providerFactory: state.factory });
    assert.equal(restored.selectAccount(MODEL, 'chat', new Set()).account.id, first.accountId);
    restored.stop();
  }
});

test('all channels use the same quota retry delay and transient cooldown boundaries', async t => {
  for (const channel of CHANNELS) {
    for (const [status, details, delay] of [[429, '', 60_000], [429, 'retryDelay: 2m', 120_000], [503, '', 15_000]]) {
      const state = fixture(t, channel, [{}, {}], async () => {
        throw Object.assign(new Error(status === 429 ? 'quota exhausted' : 'upstream unavailable'), { status, details });
      });
      await assert.rejects(state.pool.send(normalized, MODEL));
      state.advance(delay - 1);
      assert.equal(state.pick(), undefined, `${channel}: still cooling down`);
      state.advance(1);
      assert.ok(state.pick(), `${channel}: retry at the same boundary`);
    }
  }
});

test('all channels filter disabled, unsupported and unhealthy credentials before quota ranking', t => {
  for (const channel of CHANNELS) {
    const state = fixture(t, channel, [{}, {}, {}, {}]);
    state.store.update('account-0', { enabled: false }); state.pool.reload();
    const unsupported = state.pool.entries.get('account-1'), unhealthy = state.pool.entries.get('account-2');
    if (channel === 'cloudcode') {
      unsupported.supportedModels = new Set(['other-model']);
      unhealthy.cooldownUntil = NOW + HOUR;
    } else {
      unsupported.models = new Set(['other-model']); unsupported.catalogKnown = true;
      state.pool.saveHealth(unhealthy, 'account', 'authentication_error', 'invalid credentials', Infinity);
    }
    for (let i = 0; i < 5; i++) assert.equal(state.pick(), 'account-3', channel);
    assert.equal(state.pick('', new Set(['account-3'])), undefined);
  }
});

test('OAuth and Windows accounts in one pool receive the same quota-derived weights', t => {
  const state = fixture(t, 'mixed', [{ fiveHours: 1 }, { fiveHours: 1 }, { fiveHours: 4 }, { fiveHours: 4 }]);
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 120; i++) counts[Number(state.pick().split('-')[1])]++;
  assert.deepEqual(counts, [40, 40, 20, 20]);
});

test('Gemini scheduling starts missing-quota refresh without waiting and throttles it for five minutes', async t => {
  for (const channel of ['oauth', 'windows']) {
    const state = fixture(t, channel, [{ unknown: true }]);
    let resolve, calls = 0;
    state.pool.entries.get('account-0').provider.getQuota = () => { calls++; return new Promise(done => { resolve = done; }); };
    for (let i = 0; i < 5; i++) assert.equal(state.pick(), 'account-0');
    assert.equal(calls, 1);
    resolve(snapshot({ unknown: true }));
    await Promise.all(state.pool.quotaRefreshes.values());
    state.pick(); assert.equal(calls, 1);
    state.advance(QUOTA_RETRY_MS); state.pick(); assert.equal(calls, 2);
    resolve(snapshot()); await Promise.all(state.pool.quotaRefreshes.values());
  }
});

test('all three channels share quota timing and one affinity setting including its legacy alias', () => {
  assert.equal(REFRESH_INTERVAL_MS, QUOTA_TTL_MS);
  assert.equal(TARGETED_REFRESH_MIN_INTERVAL_MS, QUOTA_RETRY_MS);
  const code = `process.stdout.write(JSON.stringify([
    require('./src/account-pool').SESSION_TTL_MS,
    require('./src/robin-account-pool').ROBIN_SESSION_TTL_MS,
    require('./src/robin-conversations').CONVERSATION_TTL_MS
  ]))`;
  for (const [globalValue, legacyValue, expected] of [
    [undefined, undefined, 18_000_000], ['12', '99', 12_000], [undefined, '99', 99_000],
    ['0', '99', 0], ['invalid', '99', 18_000_000]
  ]) {
    const env = { ...process.env };
    delete env.ANTIGRAVITY_AFFINITY_TTL_SECONDS; delete env.ANTIGRAVITY_ROBIN_AFFINITY_TTL_SECONDS;
    if (globalValue !== undefined) env.ANTIGRAVITY_AFFINITY_TTL_SECONDS = globalValue;
    if (legacyValue !== undefined) env.ANTIGRAVITY_ROBIN_AFFINITY_TTL_SECONDS = legacyValue;
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' }));
    assert.deepEqual(actual, [expected, expected, expected]);
  }
});
