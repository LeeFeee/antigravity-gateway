'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccountPool, durationMs, retryDelay, modelGroup, classifyWeeklyBucket } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { ManagedAccountAuthProvider } = require('../src/managed-account-auth');

// ── weekly-pressure 测试辅助 ────────────────────────────────────────────────
// 固定时间基准:所有 resetTime 相对 FIXED_NOW 造,避免依赖真实时钟漂移。
const FIXED_NOW = Date.parse('2026-09-29T10:00:00Z');

function useFixedNow(t) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  t.after(() => { Date.now = realNow; });
}

// 造一个压力恰为 target 的 weekly 桶:remaining 固定 0.5,resetTime = now + 0.5/target 小时。
function pressureBucket(target, { remaining = 0.5 } = {}) {
  const hours = remaining / target;
  return { id: 'weekly', window: 'weekly', remainingFraction: remaining, resetTime: new Date(FIXED_NOW + hours * 3_600_000).toISOString(), available: true };
}

// 真实快照形状(groups[].buckets[]),两个额度组可分别给桶或 null(缺组)。
function snapshot({ gemini = null, p3 = null, expiresAt = new Date(FIXED_NOW + 30 * 60_000).toISOString() } = {}) {
  const groups = [];
  if (gemini) groups.push({ id: 'gemini', buckets: [gemini] });
  if (p3) groups.push({ id: '3p', buckets: [p3] });
  return { available: true, observedAt: new Date(FIXED_NOW).toISOString(), expiresAt, groups };
}

function poolFromSnapshot(store, quotaById, { strategy = 'weekly-pressure' } = {}) {
  const pool = new AccountPool({ store, fallbackProvider: {}, strategy });
  pool.quotaManager = {
    get: (id) => quotaById[id]?.get ?? null,
    peek: (id) => quotaById[id]?.peek ?? null
  };
  return pool;
}

function tempStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-account-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new AccountStore({ configDir: directory });
}

function account(email) {
  return { email, accessToken: `access-${email}`, refreshToken: `refresh-${email}`, projectId: `project-${email}` };
}

test('account store persists ordinary JSON and replaces refreshed credentials', (t) => {
  const store = tempStore(t);
  const first = store.save(account('one@example.com'));
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].refreshToken, 'refresh-one@example.com');
  store.save({ ...first, accessToken: 'new-access', refreshToken: 'new-refresh' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].accessToken, 'new-access');
  assert.equal(store.list()[0].refreshToken, 'new-refresh');
});

test('managed account refresh writes the new tokens back to its JSON record', async (t) => {
  const store = tempStore(t);
  const saved = store.save({
    ...account('refresh@example.com'),
    expiresAt: '2020-01-01T00:00:00.000Z',
    clientId: 'client',
    clientSecret: 'secret'
  });
  const auth = new ManagedAccountAuthProvider({
    account: saved,
    store,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }), { status: 200 })
  });
  assert.deepEqual(auth.provider.clientCredentials, [{ clientId: 'client', clientSecret: 'secret' }]);
  const record = await auth.get();
  assert.equal(record.accessToken, 'access-new');
  assert.equal(store.list()[0].accessToken, 'access-new');
  assert.equal(store.list()[0].refreshToken, 'refresh-new');
  assert.equal(store.list()[0].clientId, 'client');
  assert.equal(store.list()[0].clientSecret, 'secret');
});

test('account pool rotates new sessions but keeps one session on one account', async (t) => {
  const store = tempStore(t);
  const first = store.save(account('one@example.com'));
  const second = store.save(account('two@example.com'));
  const calls = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async (_normalized, model) => {
        calls.push([record.id, model]);
        return { text: record.email, toolCalls: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
      },
      listModels: async () => ['gemini-3.8-flash-high'],
      modelInfo: () => null
    })
  });
  await pool.send({}, 'claude-sonnet-4-6', { sessionId: 'session-a' });
  await pool.send({}, 'claude-sonnet-4-6', { sessionId: 'session-a' });
  await pool.send({}, 'claude-sonnet-4-6', { sessionId: 'session-b' });
  assert.equal(calls[0][0], calls[1][0]);
  assert.notEqual(calls[0][0], calls[2][0]);
  assert.deepEqual(calls.map((item) => item[1]), ['claude-sonnet-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-6']);
  assert.deepEqual(new Set(calls.map((item) => item[0])), new Set([first.id, second.id]));
});

test('account affinity is shared by parent and child conversations without sharing upstream session IDs', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  const calls = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async (_normalized, _model, options) => {
        calls.push({ accountId: record.id, sessionId: options.sessionId });
        return { text: record.email, toolCalls: [], usage: {} };
      },
      generateImage: async () => ({ data: Buffer.from('image').toString('base64'), mimeType: 'image/jpeg', usage: {} }),
      listModels: async () => ['gemini-3.8-flash-high'],
      modelInfo: () => null
    })
  });
  const parent = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'parent-session', routingKey: 'family-affinity' });
  const child = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'child-session', routingKey: 'family-affinity' });
  const image = await pool.generateImage({ prompt: 'draw it' }, {
    sessionId: 'child-session', routingKey: 'family-affinity', accountId: parent.accountId
  });
  assert.equal(parent.accountId, child.accountId);
  assert.equal(parent.accountId, image.accountId);
  assert.deepEqual(calls.map((call) => call.sessionId), ['parent-session', 'child-session']);
});

test('an auxiliary image fallback does not migrate the parent text conversation', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  let primaryAccount = '';
  const textAccounts = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        textAccounts.push(record.id);
        return { text: record.email, toolCalls: [], usage: {} };
      },
      generateImage: async () => {
        if (record.id === primaryAccount) {
          const error = new Error('image quota exhausted');
          error.status = 429;
          throw error;
        }
        return { data: Buffer.from('image').toString('base64'), mimeType: 'image/jpeg', usage: {} };
      },
      listModels: async () => ['gemini-3.8-flash-high'],
      modelInfo: () => null
    })
  });
  const first = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'parent', routingKey: 'family' });
  primaryAccount = first.accountId;
  const image = await pool.generateImage({ prompt: 'draw it' }, {
    sessionId: 'parent', routingKey: 'family', accountId: primaryAccount, bindRouting: false
  });
  assert.notEqual(image.accountId, primaryAccount);
  await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'parent', routingKey: 'family' });
  assert.deepEqual(textAccounts, [primaryAccount, primaryAccount]);
});

test('account pool reports the actual account selected for each upstream attempt', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  const selected = [];
  let attempts = 0;
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('quota exhausted');
          error.status = 429;
          throw error;
        }
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  const result = await pool.send({}, 'gemini-3.8-flash-high', {
    onAccountSelected: (value) => selected.push(value)
  });
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((value) => value.attempt), [1, 2]);
  assert.notEqual(selected[0].email, selected[1].email);
  assert.deepEqual(new Set(selected.map((value) => value.email)), new Set(['one@example.com', 'two@example.com']));
  assert.equal(result.text, selected[1].email);
});

test('account pool reports the official local agy session when no managed account exists', async (t) => {
  const store = tempStore(t);
  const selected = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {
      send: async () => ({ text: 'ok', toolCalls: [], usage: {} })
    }
  });
  await pool.send({}, 'gemini-3.8-flash-high', { onAccountSelected: (value) => selected.push(value) });
  assert.deepEqual(selected, [{ accountId: 'local-agy-session', email: '', source: 'local-agy-session', attempt: 1 }]);
});

test('account pool fails over quota errors without changing the requested model', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  const models = [];
  let failed = false;
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async (_normalized, model) => {
        models.push(model);
        if (!failed) {
          failed = true;
          const error = new Error('Resource has been exhausted (quota)');
          error.status = 429;
          throw error;
        }
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [model],
      modelInfo: () => null
    })
  });
  const result = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'session' });
  assert.match(result.text, /@example\.com$/);
  assert.deepEqual(models, ['gemini-3.8-flash-high', 'gemini-3.8-flash-high']);
});

test('account pool does not hide request/schema errors by switching accounts', async (t) => {
  const store = tempStore(t);
  store.save(account('one@example.com'));
  store.save(account('two@example.com'));
  let attempts = 0;
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: () => ({
      send: async () => {
        attempts += 1;
        const error = new Error('invalid JSON schema');
        error.status = 400;
        throw error;
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  await assert.rejects(pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'session' }), /invalid JSON schema/);
  assert.equal(attempts, 1);
});

test('quota snapshots prioritize healthy accounts but never hard-block the last fallback', async (t) => {
  const store = tempStore(t);
  const first = store.save(account('empty@example.com'));
  const second = store.save(account('healthy@example.com'));
  const attempts = [];
  const pool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => {
        attempts.push(record.id);
        return { text: record.email, toolCalls: [], usage: {} };
      },
      listModels: async () => [], modelInfo: () => null
    })
  });
  pool.quotaManager = {
    get: (id) => ({ available: id === first.id ? false : true })
  };

  const preferred = await pool.send({}, 'gemini-3.8-flash-high', { sessionId: 'new-session' });
  assert.equal(preferred.text, second.email);
  assert.deepEqual(attempts, [second.id]);

  const fallbackPool = new AccountPool({
    store,
    fallbackProvider: {},
    providerFactory: (record) => ({
      send: async () => ({ text: record.email, toolCalls: [], usage: {} }),
      listModels: async () => [], modelInfo: () => null
    })
  });
  fallbackPool.quotaManager = { get: () => ({ available: false }) };
  const fallback = await fallbackPool.send({}, 'gemini-3.8-flash-high', { sessionId: 'all-empty' });
  assert.match(fallback.text, /@example\.com$/);
});

test('quota cooldown parser understands compound Google reset durations', () => {
  assert.equal(durationMs('114h17m51.141587561s'), 114 * 3_600_000 + 17 * 60_000 + 51.141587561 * 1000);
  assert.equal(retryDelay('{"quotaResetDelay":"5h1m2s"}'), 5 * 3_600_000 + 60_000 + 2000);
  assert.equal(retryDelay('retryDelay: 708.717057ms'), 1000);
});

// ── weekly-pressure 策略 ────────────────────────────────────────────────────

test('modelGroup maps model ids to quota groups and strips the models/ prefix', () => {
  assert.equal(modelGroup('gemini-3-flash'), 'gemini');
  assert.equal(modelGroup('models/gemini-3-flash'), 'gemini');
  assert.equal(modelGroup('claude-sonnet-4-6'), '3p');
  assert.equal(modelGroup('gpt-5.2'), '3p');
  assert.equal(modelGroup('tab_chat_x'), '');
  assert.equal(modelGroup(''), '');
});

test('classifyWeeklyBucket sorts exhausted/unknown/pressure and clamps tiny reset windows', () => {
  assert.deepEqual(classifyWeeklyBucket({ remainingFraction: 0, resetTime: new Date(FIXED_NOW + 3_600_000).toISOString() }, FIXED_NOW), { kind: 'exhausted' });
  assert.deepEqual(classifyWeeklyBucket({ remainingFraction: 0, resetTime: new Date(FIXED_NOW - 3_600_000).toISOString() }, FIXED_NOW), { kind: 'unknown' });
  assert.deepEqual(classifyWeeklyBucket({ remainingFraction: 0.5, resetTime: 'not-a-time' }, FIXED_NOW), { kind: 'unknown' });
  assert.deepEqual(classifyWeeklyBucket({ remainingFraction: 0.5, resetTime: new Date(FIXED_NOW - 1).toISOString() }, FIXED_NOW), { kind: 'unknown' });
  // resetTime 只剩 1 秒:hours 下限 1/60 兜底(按 1 分钟算,band=4),不产生 NaN/Infinity,
  // 也不是无下限的 floor(log2(0.5×3600))=10。
  const tiny = classifyWeeklyBucket({ remainingFraction: 0.5, resetTime: new Date(FIXED_NOW + 1000).toISOString() }, FIXED_NOW);
  assert.equal(tiny.kind, 'pressure');
  assert.ok(Number.isFinite(tiny.band) && Number.isFinite(tiny.pressure));
  assert.equal(tiny.band, Math.floor(Math.log2(0.5 / (1 / 60))));
  assert.deepEqual(classifyWeeklyBucket({ remainingFraction: 'oops', resetTime: new Date(FIXED_NOW + 3_600_000).toISOString() }, FIXED_NOW), { kind: 'unknown' });
});

test('weekly-pressure orders new sessions by descending pressure band', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save(account('a@example.com'));
  const b = store.save(account('b@example.com'));
  const c = store.save(account('c@example.com'));
  const pool = poolFromSnapshot(store, {
    [a.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) },
    [b.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -7 * 1.414) }) },
    [c.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -9 * 1.414) }) }
  });
  const order = pool.orderedCandidates('gemini-3-flash', 's1').map((entry) => entry.account.id);
  assert.deepEqual(order, [a.id, b.id, c.id]);
});

test('a weekly bucket at zero with a future resetTime is exhausted and ranked last, not first', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const empty = store.save(account('empty@example.com'));
  const healthy = store.save(account('healthy@example.com'));
  const pool = poolFromSnapshot(store, {
    // available=false 但 remainingFraction 尚未归零(上游两字段存在时间差的形态):
    // 若实现漏看桶级 available,该号会被高压力顶到第一——反向对照应红在这一格。
    [empty.id]: { peek: snapshot({ p3: { id: '3p-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: new Date(FIXED_NOW + 3_600_000).toISOString(), available: false } }) },
    [healthy.id]: { peek: snapshot({ p3: pressureBucket(2 ** -7 * 1.414) }) }
  });
  const order = pool.orderedCandidates('claude-sonnet-4-6', 's1').map((entry) => entry.account.id);
  assert.deepEqual(order, [healthy.id, empty.id]);
});

test('a weekly bucket whose resetTime already passed counts as unknown, not by stale pressure', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const stale = store.save(account('stale@example.com'));
  const fresh = store.save(account('fresh@example.com'));
  const pool = poolFromSnapshot(store, {
    [stale.id]: { peek: snapshot({ gemini: { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: new Date(FIXED_NOW - 1).toISOString(), available: true } }) },
    [fresh.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }) }
  });
  const order = pool.orderedCandidates('gemini-3-flash', 's1').map((entry) => entry.account.id);
  assert.deepEqual(order, [fresh.id, stale.id]);
});

test('the weekly bucket is taken from the quota group matching the requested model', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save(account('a@example.com'));
  const b = store.save(account('b@example.com'));
  const pool = poolFromSnapshot(store, {
    [a.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414), p3: pressureBucket(2 ** -8 * 1.414) }) },
    [b.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414), p3: pressureBucket(2 ** -5 * 1.414) }) }
  });
  assert.deepEqual(pool.orderedCandidates('gemini-3-flash', 'g1').map((e) => e.account.id), [a.id, b.id]);
  assert.deepEqual(pool.orderedCandidates('claude-sonnet-4-6', 'g2').map((e) => e.account.id), [b.id, a.id]);
});

test('models outside the prefix table degrade to rotation (unknown lane)', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  store.save(account('a@example.com'));
  store.save(account('b@example.com'));
  const pool = poolFromSnapshot(store, {
    'account-x': { peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) }
  });
  const first = pool.orderedCandidates('tab_chat_x', 'u1').map((e) => e.account.id);
  const second = pool.orderedCandidates('tab_chat_x', 'u2').map((e) => e.account.id);
  assert.notEqual(first[0], second[0]);
});

test('an unnamed quota group does not satisfy an unmapped model', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save(account('a@example.com'));
  const b = store.save(account('b@example.com'));
  // a 的快照里有一个无 id 的额度组(真实 usageQuotaSnapshot 总会兜底 group-N,
  // 这里防上游变化):未映射模型的 group='' 不得匹配到它,否则 a 被误当已知恒排前。
  const unnamed = {
    available: true,
    observedAt: new Date(FIXED_NOW).toISOString(),
    expiresAt: new Date(FIXED_NOW + 30 * 60_000).toISOString(),
    groups: [{ buckets: [{ id: 'x-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: new Date(FIXED_NOW + 3_600_000).toISOString(), available: true }] }]
  };
  const pool = poolFromSnapshot(store, { [a.id]: { peek: unnamed } });
  const picks = ['n1', 'n2', 'n3', 'n4'].map((session) => pool.orderedCandidates('tab_x', session)[0].account.id);
  assert.deepEqual(picks, [a.id, b.id, a.id, b.id]);
});

test('band boundary: a bit more than 2x pressure separates, within-band ties rotate', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const high = store.save(account('high@example.com'));
  const lowA = store.save(account('lowa@example.com'));
  const lowB = store.save(account('lowb@example.com'));
  const pool = poolFromSnapshot(store, {
    [high.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -7 * 2.1) }) },
    [lowA.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -7 * 1.414) }) },
    [lowB.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -7 * 1.2) }) }
  });
  // 高档恒在前;同档两号在跨调用间交替(weightedPick 轮询)。
  const orders = ['x1', 'x2', 'x3', 'x4'].map((session) => pool.orderedCandidates('gemini-3-flash', session).map((e) => e.account.id));
  for (const order of orders) assert.equal(order[0], high.id);
  assert.deepEqual(orders[0].slice(1), [lowA.id, lowB.id]);
  assert.deepEqual(orders[1].slice(1), [lowB.id, lowA.id]);
  assert.deepEqual(orders[2].slice(1), [lowA.id, lowB.id]);
});

test('session affinity still wins under weekly-pressure', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save(account('a@example.com'));
  const b = store.save(account('b@example.com'));
  const pool = poolFromSnapshot(store, {
    [a.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) },
    [b.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }) }
  });
  pool.sessions.set('s1', { accountId: b.id, at: FIXED_NOW });
  assert.equal(pool.orderedCandidates('gemini-3-flash', 's1')[0].account.id, b.id);
});

test('exhausted ranks after unknown', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const fresh = store.save(account('fresh@example.com'));
  const unknown = store.save(account('unknown@example.com'));
  const empty = store.save(account('empty@example.com'));
  const pool = poolFromSnapshot(store, {
    [fresh.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }) },
    [unknown.id]: {},
    [empty.id]: { peek: snapshot({ gemini: { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime: new Date(FIXED_NOW + 3_600_000).toISOString(), available: false } }) }
  });
  const order = pool.orderedCandidates('gemini-3-flash', 's1').map((e) => e.account.id);
  assert.deepEqual(order, [fresh.id, unknown.id, empty.id]);
});

test('account-level available=false still lands last regardless of pressure', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const off = store.save(account('off@example.com'));
  const on = store.save(account('on@example.com'));
  const pool = poolFromSnapshot(store, {
    [off.id]: { get: { available: false }, peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) },
    [on.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }) }
  });
  const order = pool.orderedCandidates('gemini-3-flash', 's1').map((e) => e.account.id);
  assert.deepEqual(order, [on.id, off.id]);
});

test('weekly-pressure reads expired snapshots via peek while get returns null', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save(account('a@example.com'));
  const b = store.save(account('b@example.com'));
  const pool = poolFromSnapshot(store, {
    [a.id]: { get: null, peek: { ...snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }), expiresAt: new Date(FIXED_NOW - 1).toISOString() } },
    [b.id]: { get: null, peek: { ...snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }), expiresAt: new Date(FIXED_NOW - 1).toISOString() } }
  });
  const order = pool.orderedCandidates('gemini-3-flash', 's1').map((e) => e.account.id);
  assert.deepEqual(order, [a.id, b.id]);
  // 第二次调用:若实现退回 get(null)则两号变 unknown 轮询,此处必反序——钉死 peek 是排序的数据源。
  const again = pool.orderedCandidates('gemini-3-flash', 's2').map((e) => e.account.id);
  assert.deepEqual(again, [a.id, b.id]);
});

test('an implementation without peek falls back to get for sorting', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save(account('a@example.com'));
  const b = store.save(account('b@example.com'));
  const pool = new AccountPool({ store, fallbackProvider: {}, strategy: 'weekly-pressure' });
  pool.quotaManager = {
    get: (id) => (id === a.id ? snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) : id === b.id ? snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }) : null)
  };
  const order = pool.orderedCandidates('gemini-3-flash', 's1').map((e) => e.account.id);
  assert.deepEqual(order, [a.id, b.id]);
});

test('weight decides inside a band but not across bands', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save({ ...account('a@example.com'), weight: 1 });
  const b = store.save({ ...account('b@example.com'), weight: 2 });
  const sameBand = poolFromSnapshot(store, {
    [a.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -7 * 1.414) }) },
    [b.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -7 * 1.4) }) }
  });
  // 同档:weightedPick 平滑轮询,首个名额偏向高权重账号。
  assert.equal(sameBand.orderedCandidates('gemini-3-flash', 'w1')[0].account.id, b.id);
  const across = poolFromSnapshot(store, {
    [a.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) },
    [b.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -7 * 1.414) }) }
  });
  // 跨档:weight 不参与,band 高者(a)在前。
  assert.deepEqual(across.orderedCandidates('gemini-3-flash', 'w2').map((e) => e.account.id), [a.id, b.id]);
});

test('missing or invalid strategy values behave exactly like round-robin', (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  store.save(account('a@example.com'));
  store.save(account('b@example.com'));
  const quota = {
    a: { peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }), get: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) },
    b: { peek: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }), get: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }) }
  };
  const byEmail = (pool, session) => pool.orderedCandidates('gemini-3-flash', session).map((e) => e.account.email);
  const defaultPool = poolFromSnapshot(store, quota, { strategy: 'round-robin' });
  const invalidPool = new AccountPool({ store, fallbackProvider: {}, strategy: 'weekly_pressure' });
  invalidPool.quotaManager = defaultPool.quotaManager;
  // 非法值与显式 round-robin 在同一权重状态下序列逐项一致,且不按压力排序(压力高的 a 不恒先)。
  assert.deepEqual(byEmail(invalidPool, 'r1'), byEmail(defaultPool, 'r1'));
  assert.deepEqual(byEmail(invalidPool, 'r2'), byEmail(defaultPool, 'r2'));
  assert.deepEqual(byEmail(invalidPool, 'r3'), byEmail(defaultPool, 'r3'));
  assert.deepEqual([...new Set(byEmail(defaultPool, 'r1'))].sort(), ['a@example.com', 'b@example.com']);
});

test('generateImage follows the weekly-pressure order of the gemini group', async (t) => {
  useFixedNow(t);
  const store = tempStore(t);
  const a = store.save(account('a@example.com'));
  const b = store.save(account('b@example.com'));
  const pool = poolFromSnapshot(store, {
    [a.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -5 * 1.414) }) },
    [b.id]: { peek: snapshot({ gemini: pressureBucket(2 ** -8 * 1.414) }) }
  });
  pool.providerFactory = undefined;
  const calls = [];
  for (const entry of pool.entries.values()) {
    entry.provider = {
      send: async () => ({ text: entry.account.email, toolCalls: [], usage: {} }),
      generateImage: async () => { calls.push(entry.account.id); return { data: 'aGk=', mimeType: 'image/png', usage: {} }; },
      listModels: async () => [], modelInfo: () => null
    };
  }
  await pool.generateImage({ prompt: 'draw' }, {});
  assert.deepEqual(calls, [a.id]);
});
