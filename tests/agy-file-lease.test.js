'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { FileLease, acquireFileLease, cleanupPendingLeases, reap, canonicalDirectoryPort, acquireDirectoryGuard, PROCESS_INSTANCE_ID, ACTIVE_LOCAL_LEASES } = require('../src/agy-file-lease');
const { AgySessionStore } = require('../src/agy-session-state');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-file-lease-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function child(source) {
  const proc = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(proc, 'exit');
  assert.equal(code, 0, stderr);
  return proc.pid;
}

test('a published lease is nonempty; a cancelled contender leaves the owner and no candidate behind', async t => {
  const dir = directory(t), target = path.join(dir, 'state.lock');
  const first = new FileLease(target);
  assert.equal(first.tryAcquire(), true);
  assert.deepEqual(fs.readdirSync(target), [first.entry]);
  await assert.rejects(acquireFileLease(target, AbortSignal.timeout(60)), { name: 'AbortError' });
  assert.deepEqual(fs.readdirSync(dir), ['state.lock']);
  assert.deepEqual(fs.readdirSync(target), [first.entry]);
  first.release(); first.dispose();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a late release cannot delete a successor lease at the same pathname', t => {
  const target = path.join(directory(t), 'state.lock'), first = new FileLease(target);
  assert.equal(first.tryAcquire(), true);
  fs.unlinkSync(path.join(target, first.entry)); fs.rmdirSync(target);
  const next = new FileLease(target);
  assert.equal(next.tryAcquire(), true);
  first.release(); first.dispose();
  assert.deepEqual(fs.readdirSync(target), [next.entry]);
  next.release(); next.dispose();
});

test('an exited legacy file-lock owner can be migrated without deleting live leases', async t => {
  const target = path.join(directory(t), 'state.lock');
  await child(`require('node:fs').writeFileSync(${JSON.stringify(target)}, JSON.stringify({pid:process.pid,lease:'legacy'}));`);
  const release = await acquireFileLease(target, AbortSignal.timeout(2000));
  assert.equal(fs.statSync(target).isDirectory(), true);
  release(); assert.equal(fs.existsSync(target), false);
});

test('pending candidate collection removes only recognized directories of exited processes', async t => {
  const dir = directory(t), target = path.join(dir, `${'a'.repeat(64)}.json.lock`);
  await child(`const {FileLease}=require(${JSON.stringify(require.resolve('../src/agy-file-lease'))}); new FileLease(${JSON.stringify(target)});`);
  const live = new FileLease(target), unrelated = path.join(dir, 'keep-me');
  fs.mkdirSync(unrelated);
  assert.equal(fs.readdirSync(dir).length, 3);
  cleanupPendingLeases(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(live.pending), 'keep-me'].sort());
  live.dispose();
});

test('unknown lease contents and symlink targets are not reclaimed', async t => {
  const dir = directory(t), target = path.join(dir, 'state.lock');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'unknown'), 'keep');
  await assert.rejects(acquireFileLease(target, AbortSignal.timeout(1000)), /未知归属/);
  const link = path.join(dir, 'linked.lock');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(acquireFileLease(link, AbortSignal.timeout(1000)), /符号链接/);
  assert.equal(fs.readFileSync(path.join(target, 'unknown'), 'utf8'), 'keep');
});

test('state collection does not evict a session while its directory lease is held', async t => {
  const dir = directory(t), store = new AgySessionStore({ directory: dir });
  await store.transact('A', 'S', null, (state, save) => save());
  const file = path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.json')));
  const release = await acquireFileLease(`${file}.lock`);
  const collector = new AgySessionStore({ directory: dir, now: () => Date.now() + 48 * 60 * 60 * 1000 });
  collector.cleanup(); assert.equal(fs.existsSync(file), true);
  release(); collector.lastCleanup = 0; collector.cleanup();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('eight real processes recover abandoned leases without overlapping or losing updates', { timeout: 20000 }, async t => {
  const dir = directory(t), modulePath = require.resolve('../src/agy-session-state');
  for (let round = 0; round < 8; round++) {
    await child(`const {AgySessionStore}=require(${JSON.stringify(modulePath)});
      new AgySessionStore({directory:${JSON.stringify(dir)}}).transact('A','S',null,(state,save)=>{save();process.exit(0);});`);
    await Promise.all(Array.from({ length: 8 }, () => child(`
      const fs=require('node:fs'),path=require('node:path');
      const {AgySessionStore}=require(${JSON.stringify(modulePath)}),dir=${JSON.stringify(dir)};
      new AgySessionStore({directory:dir}).transact('A','S',AbortSignal.timeout(5000),async(state,save)=>{
        const marker=path.join(dir,'critical.guard');
        const fd=fs.openSync(marker,'wx');fs.closeSync(fd);
        await new Promise(resolve=>setTimeout(resolve,15));
        state.requestIndex++;save();fs.unlinkSync(marker);
      }).catch(error=>{console.error(error);process.exitCode=1;});
    `)));
    await new AgySessionStore({ directory: dir }).transact('A', 'S', null, state => assert.equal(state.requestIndex, (round + 1) * 8));
  }
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('.lock')).length, 0);
});

test('canonicalDirectoryPort computes identical port for realpath and symlinks based on dev:ino', (t) => {
  const dir = directory(t);
  const realDir = path.join(dir, 'real-config');
  const symlinkDir = path.join(dir, 'symlink-config');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, symlinkDir, 'dir');

  const port1 = canonicalDirectoryPort(realDir);
  const port2 = canonicalDirectoryPort(symlinkDir);
  assert.equal(port1, port2, '软链接与真实物理目录端口必须完全相等');
  assert.ok(port1 >= 49152 && port1 <= 65152);
});

test('acquireDirectoryGuard ensures single instance exclusivity and allows clean handoff', async (t) => {
  const dir = directory(t);
  const guard1 = await acquireDirectoryGuard(dir);
  assert.ok(guard1.port >= 49152);

  // 尝试在同一数据目录启动第二个守护实例，必定被拒绝
  await assert.rejects(
    async () => { await acquireDirectoryGuard(dir); },
    /数据目录已被正在运行的网关进程独占/
  );

  // 释放第一个守护后，第二个实例可立即成功获取
  guard1.close();
  const guard2 = await acquireDirectoryGuard(dir);
  assert.equal(guard2.port, guard1.port);
  guard2.close();
});

test('managed reap reclaims orphan lease of different instance even with identical PID (container PID 1 scenario)', async (t) => {
  const dir = directory(t);
  const guard = await acquireDirectoryGuard(dir);
  t.after(() => guard.close());
  const crypto = require('node:crypto');
  const target = path.join(dir, 'state', 'agy-sessions', 'session.json.lock');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const foreignInstanceId = crypto.randomUUID();
  const foreignLeaseId = crypto.randomUUID();
  const orphanEntry = `${process.pid}-${foreignInstanceId}-${foreignLeaseId}.lease`;

  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, orphanEntry), '');

  // 非托管模式下，同 PID 存活进程不清理
  reap(target, Date.now(), {});
  assert.ok(fs.existsSync(target), '非托管模式下存活 PID 不应被清理');

  // 跨目录错误 guard 测试：目录 B 的 guard 绝不能清理目录 A 的锁
  const otherDir = directory(t);
  const otherGuard = await acquireDirectoryGuard(otherDir);
  t.after(() => otherGuard.close());
  reap(target, Date.now(), { directoryGuard: otherGuard });
  assert.ok(fs.existsSync(target), '跨目录 guard 绝不能误清理目标锁！');

  // 托管模式下，确认非当前实例且属于同 PID 的旧容器遗留锁，立即清理
  reap(target, Date.now(), { directoryGuard: guard });
  assert.equal(fs.existsSync(target), false, '托管模式下异实例同 PID 遗留锁应被安全回收');
});

test('managed reap reclaims legacy 2-part format lock of same PID', async (t) => {
  const dir = directory(t);
  const guard = await acquireDirectoryGuard(dir);
  t.after(() => guard.close());
  const crypto = require('node:crypto');
  const target = path.join(dir, 'state', 'agy-sessions', 'legacy-session.json.lock');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const legacyEntry = `${process.pid}-${crypto.randomUUID()}.lease`;

  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, legacyEntry), '');

  // 跨目录 guard 绝不误清理
  const otherDir = directory(t);
  const otherGuard = await acquireDirectoryGuard(otherDir);
  t.after(() => otherGuard.close());
  reap(target, Date.now(), { directoryGuard: otherGuard });
  assert.ok(fs.existsSync(target), '跨目录 guard 绝不清理 legacy 锁');

  // 托管模式下同 PID 2段式旧锁立即被识别为前代遗留并清理
  reap(target, Date.now(), { directoryGuard: guard });
  assert.equal(fs.existsSync(target), false, '同 PID 旧格式锁在托管模式下应被安全回收');
});

test('acquireFileLease maintains active lease registration across finally.dispose without premature reaping', async (t) => {
  const dir = directory(t);
  const guard = await acquireDirectoryGuard(dir);
  t.after(() => guard.close());
  const target = path.join(dir, 'state', 'agy-sessions', 'active-session.json.lock');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const release = await acquireFileLease(target, AbortSignal.timeout(2000), Date.now, { directoryGuard: guard });

  assert.ok(fs.existsSync(target), '锁目录物理存在');
  assert.equal(ACTIVE_LOCAL_LEASES.size, 1, '活跃租约表保持登记');

  // 并发请求在托管模式下调用 reap，绝不误删自己正在持有的活跃锁
  reap(target, Date.now(), { directoryGuard: guard });
  assert.ok(fs.existsSync(target), '活跃持锁者的锁目录绝不能被 reap 误删');

  release();
  assert.equal(fs.existsSync(target), false, '释放后锁目录被安全清理');
  assert.equal(ACTIVE_LOCAL_LEASES.size, 0, '活跃租约表注销');
});

