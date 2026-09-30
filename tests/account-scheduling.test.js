'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountPool, geminiWeeklyPressure } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');

const NOW = Date.parse('2026-09-30T00:00:00Z');
const HOUR = 3_600_000;
function group(id, remaining, weeklyHours, fiveHours) {
  return { id, buckets: [
    { id: `${id}-weekly`, window: 'weekly', remainingFraction: remaining, resetTime: new Date(NOW + weeklyHours * HOUR).toISOString() },
    { id: `${id}-5h`, window: '5h', remainingFraction: 0.5, resetTime: new Date(NOW + fiveHours * HOUR).toISOString() }
  ] };
}
function fixture(t, definitions, behavior = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-scheduling-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: directory });
  const accounts = definitions.map((definition, index) => store.save({
    email: `${index}@example.com`, accessToken: 'test-access', refreshToken: 'test-refresh', projectId: 'test-project',
    weight: definition.weight || 1
  }));
  const pool = new AccountPool({
    store, fallbackProvider: {}, now: () => NOW,
    providerFactory: (record) => ({
      send: async (...args) => {
        if (behavior.send) await behavior.send(record, ...args);
        return { text: record.id, toolCalls: [], usage: {} };
      },
      generateImage: async (...args) => {
        if (behavior.image) await behavior.image(record, ...args);
        return { data: 'aW1hZ2U=', mimeType: 'image/png', usage: {} };
      }
    })
  });
  let reads = 0;
  const refreshes = [];
  const snapshots = new Map(accounts.map((account, index) => [account.id, {
    available: definitions[index].available !== false,
    expiresAt: new Date(NOW + HOUR).toISOString(),
    groups: definitions[index].groups || [group('gemini', definitions[index].remaining ?? 0.5, definitions[index].weeklyHours ?? 24, definitions[index].fiveHours ?? 2)]
  }]));
  pool.quotaManager = {
    getSchedulingSnapshot: (id) => { reads++; return snapshots.get(id); },
    get: (id) => snapshots.get(id),
    refreshAccount: async (id, options) => { refreshes.push({ id, options }); }
  };
  return { pool, accounts, snapshots, refreshes, reads: () => reads };
}

test('Gemini weekly pressure uses fractional values, logarithmic bands, and a one-minute floor', () => {
  assert.deepEqual(geminiWeeklyPressure({ groups: [group('gemini', 0.2, 2, 4)] }, NOW), { kind: 'pressure', band: -4 });
  assert.deepEqual(geminiWeeklyPressure({ groups: [group('gemini', 0.6, 12, 1)] }, NOW), { kind: 'pressure', band: -5 });
  assert.deepEqual(geminiWeeklyPressure({ groups: [group('gemini', 0.5, 1 / 3600, 1)] }, NOW), { kind: 'pressure', band: 4 });
  for (const value of [null, undefined, '', 'invalid']) {
    assert.equal(geminiWeeklyPressure({ groups: [group('gemini', value, 1, 1)] }, NOW).kind, 'unknown');
  }
  for (const hours of [0, -1]) assert.equal(geminiWeeklyPressure({ groups: [group('gemini', 0, hours, 1)] }, NOW).kind, 'unknown');
  assert.equal(geminiWeeklyPressure({ groups: [group('gemini', 0, 1, 1)] }, NOW).kind, 'exhausted');
  const denied = group('gemini', 0.8, 1, 1);
  denied.buckets[0].available = false;
  assert.equal(geminiWeeklyPressure({ groups: [denied] }, NOW).kind, 'exhausted');
});

test('all requested model families use Gemini weekly bands then Gemini five-hour resets', async (t) => {
  const { pool, accounts } = fixture(t, [
    { groups: [group('gemini', 0.6, 12, 1), group('3p', 0.9, 0.1, 0.1)] },
    { groups: [group('gemini', 0.8, 20, 0.5), group('3p', 0, 24, 0.1)] },
    { groups: [group('gemini', 0.2, 2, 4), group('3p', 0.1, 168, 4)] }
  ]);
  for (const model of ['gemini-test', 'claude-test', 'gpt-test', 'custom-model']) {
    assert.deepEqual(pool.orderedCandidates(model, '').map((entry) => entry.account.id), [accounts[2].id, accounts[1].id, accounts[0].id]);
    assert.equal((await pool.send({}, model)).accountId, accounts[2].id);
  }
});

test('missing Gemini weekly data falls back to five-hour resets and never uses 3p weekly data', (t) => {
  const { pool, accounts } = fixture(t, [
    { groups: [{ id: 'gemini', buckets: [group('gemini', 0.5, 24, 3).buckets[1]] }, group('3p', 0.9, 0.1, 0.1)] },
    { groups: [{ id: 'gemini', buckets: [group('gemini', 0.5, 24, 1).buckets[1]] }, group('3p', 0, 24, 4)] }
  ]);
  assert.equal(pool.orderedCandidates('claude-test', '')[0].account.id, accounts[1].id);
});

test('unknown pressure and weekly exhaustion remain advisory fallback lanes', async (t) => {
  const { pool, accounts, snapshots } = fixture(t, [
    { remaining: 0, weeklyHours: 1, fiveHours: 0.1 },
    { groups: [] },
    { remaining: 0.5, weeklyHours: 24, fiveHours: 4 }
  ]);
  assert.deepEqual(pool.orderedCandidates('gemini-test', '').map((entry) => entry.account.id), [accounts[2].id, accounts[1].id, accounts[0].id]);
  pool.entries.get(accounts[2].id).account.enabled = false;
  pool.entries.get(accounts[1].id).account.enabled = false;
  assert.equal((await pool.send({}, 'gemini-test')).accountId, accounts[0].id);
  pool.entries.get(accounts[2].id).account.enabled = true;
  snapshots.get(accounts[2].id).available = false;
  assert.equal(pool.orderedCandidates('gemini-test', '')[0].account.id, accounts[0].id);
});

test('same-band equal-reset accounts rotate fairly and candidate inspection does not alter weights', async (t) => {
  const { pool, accounts } = fixture(t, Array.from({ length: 10 }, () => ({})));
  const counts = new Map(accounts.map((account) => [account.id, 0]));
  for (let index = 0; index < 300; index++) {
    const before = [...pool.weights];
    pool.orderedCandidates('gemini-test', '');
    assert.deepEqual([...pool.weights], before);
    const result = await pool.send({}, 'gemini-test');
    counts.set(result.accountId, counts.get(result.accountId) + 1);
  }
  assert.deepEqual([...counts.values()], Array(10).fill(30));
});

test('configured weights apply only to accounts tied in both quota priorities', async (t) => {
  const { pool, accounts } = fixture(t, [{ weight: 1 }, { weight: 2 }, { weight: 3 }]);
  const counts = accounts.map(() => 0);
  for (let index = 0; index < 120; index++) {
    const result = await pool.send({}, 'gemini-test');
    counts[accounts.findIndex((account) => account.id === result.accountId)]++;
  }
  assert.deepEqual(counts, [20, 40, 60]);
});

test('successful sticky, child, tool and preferred image continuations skip pressure and rotation', async (t) => {
  const { pool, accounts, reads, refreshes } = fixture(t, [{ remaining: 0.5, weeklyHours: 168 }, { remaining: 0.9, weeklyHours: 1 }]);
  pool.sessions.set('family', { accountId: accounts[0].id, at: NOW });
  const before = [...pool.weights];
  for (const sessionId of ['parent', 'child', 'tool']) {
    assert.equal((await pool.send({}, 'gemini-test', { routingKey: 'family', sessionId })).accountId, accounts[0].id);
  }
  assert.equal((await pool.generateImage({}, { routingKey: 'family', accountId: accounts[0].id, bindRouting: false })).accountId, accounts[0].id);
  assert.equal(reads(), 0);
  assert.equal(refreshes.length, 0);
  assert.deepEqual([...pool.weights], before);
});

test('failover recomputes pressure from current snapshots and never retries an attempted account', async (t) => {
  let state;
  const attempts = [];
  state = fixture(t, [{}, { remaining: 0.9, weeklyHours: 1 }, { remaining: 0.5, weeklyHours: 168 }], {
    send: async (record) => {
      attempts.push(record.id);
      if (record.id === state.accounts[0].id) {
        state.snapshots.get(state.accounts[2].id).groups = [group('gemini', 0.9, 0.1, 2)];
        throw Object.assign(new Error('quota exhausted'), { status: 429 });
      }
    }
  });
  state.pool.sessions.set('family', { accountId: state.accounts[0].id, at: NOW });
  const result = await state.pool.send({}, 'gemini-test', { routingKey: 'family' });
  assert.deepEqual(attempts, [state.accounts[0].id, state.accounts[2].id]);
  assert.equal(result.accountId, state.accounts[2].id);
  assert.equal(state.pool.sessions.get('family').accountId, result.accountId);
});

test('image failover uses weekly pressure without migrating an auxiliary parent affinity', async (t) => {
  let state;
  const attempts = [];
  state = fixture(t, [{}, { remaining: 0.9, weeklyHours: 1 }, { remaining: 0.5, weeklyHours: 168 }], {
    image: async (record) => {
      attempts.push(record.id);
      if (record.id === state.accounts[0].id) throw Object.assign(new Error('image quota exhausted'), { status: 429 });
    }
  });
  state.pool.sessions.set('family', { accountId: state.accounts[0].id, at: NOW });
  const result = await state.pool.generateImage({}, { routingKey: 'family', accountId: state.accounts[0].id, bindRouting: false });
  assert.deepEqual(attempts, [state.accounts[0].id, state.accounts[1].id]);
  assert.equal(result.accountId, state.accounts[1].id);
  assert.equal(state.pool.sessions.get('family').accountId, state.accounts[0].id);
});

test('failed accounts are attempted once and schema errors still stop without failover', async (t) => {
  let calls = 0;
  const { pool } = fixture(t, [{}, {}, {}], { send: async () => {
    calls++;
    throw Object.assign(new Error('quota exhausted'), { status: 429 });
  } });
  await assert.rejects(pool.send({}, 'gemini-test'), /quota exhausted/);
  assert.equal(calls, 3);
  for (const entry of pool.entries.values()) entry.modelCooldowns.clear();
  for (const entry of pool.entries.values()) entry.provider.send = async () => {
    calls++;
    throw Object.assign(new Error('invalid schema'), { status: 400 });
  };
  await assert.rejects(pool.send({}, 'gemini-test'), /invalid schema/);
  assert.equal(calls, 4);
});
