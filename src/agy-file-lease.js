'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const PROCESS_INSTANCE_ID = crypto.randomUUID();
const ACTIVE_LOCAL_LEASES = new Set();
const PREPARING_PENDINGS = new Set();

const ID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const NEW_OWNER = new RegExp(`^([1-9][0-9]*)-(${ID})-(${ID})\\.lease$`);
const LEGACY_OWNER = new RegExp(`^([1-9][0-9]*)-(${ID})\\.lease$`);
const NEW_PENDING = new RegExp(`^[a-f0-9]{64}\\.json\\.lock\\.pending-([1-9][0-9]*)-(${ID})-(${ID})$`);
const LEGACY_PENDING = new RegExp(`^[a-f0-9]{64}\\.json\\.lock\\.pending-([1-9][0-9]*)-(${ID})$`);
const benignRemoval = error => ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code);

function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  return false;
}

class DirectoryGuard {
  constructor(configDir, server, port, stat) {
    this.configDir = configDir;
    this.server = server;
    this.port = port;
    this.dev = stat.dev;
    this.ino = stat.ino;
    this.identity = `${stat.dev}:${stat.ino}`;
    this.active = true;
  }

  isActive() {
    return this.active && Boolean(this.server?.listening);
  }

  coversDirectory(targetPath) {
    if (!this.isActive()) return false;
    try {
      let curr = fs.realpathSync(targetPath);
      while (curr && curr !== path.dirname(curr)) {
        const s = fs.statSync(curr);
        if (s.dev === this.dev && s.ino === this.ino) return true;
        curr = path.dirname(curr);
      }
      return false;
    } catch {
      return false;
    }
  }

  close() {
    if (!this.active) return;
    this.active = false;
    try { this.server.close(); } catch {}
  }
}

function canonicalDirectoryPort(configDir) {
  const realDir = fs.realpathSync(configDir);
  const stat = fs.statSync(realDir);
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.dev === 0 || stat.ino === 0) {
    throw new Error('当前文件系统不支持稳定的设备与 Inode 物理标识，拒绝赋予托管独占资格。');
  }
  const identity = `${stat.dev}:${stat.ino}`;
  const hash = crypto.createHash('sha256').update(identity).digest().readUInt32BE(0);
  return 49152 + (hash % 16000);
}

async function acquireDirectoryGuard(configDir) {
  const port = canonicalDirectoryPort(configDir);
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`数据目录已被正在运行的网关进程独占（守护端口 ${port} 冲突）。`));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  const realDir = fs.realpathSync(configDir);
  const stat = fs.statSync(realDir);
  return new DirectoryGuard(configDir, server, port, stat);
}

function removeOwned(directory, entry) {
  // Never remove a directory recursively: a new owner at this pathname has
  // a DIFFERENT marker. Neither unlink(oldMarker) nor rmdir(nonempty) can
  // remove its lease, even if several processes reap the old one together.
  try { fs.unlinkSync(path.join(directory, entry)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.rmdirSync(directory); }
  catch (error) { if (!benignRemoval(error)) throw error; }
}

function reap(target, now = Date.now(), { directoryGuard = null } = {}) {
  const isManaged = Boolean(directoryGuard?.coversDirectory?.(target));
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) throw new Error('会话锁不能是符号链接。');
  if (stat.isFile()) {
    // Migrate an abandoned lock from the earlier file-based implementation.
    // New leases are directories, so unlink cannot remove a new lease that
    // appeared between this check and removal. Live legacy owners are left.
    if (stat.size > 1024) throw new Error('旧会话锁无效。');
    let owner;
    try { owner = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError) && !['ENOENT', 'EISDIR'].includes(error.code)) throw error; }
    if (!(dead(owner?.pid) || (!Number.isInteger(owner?.pid) && now - stat.mtimeMs > 30_000))) return;
    try {
      const current = fs.lstatSync(target);
      if (current.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino) fs.unlinkSync(target);
    } catch (error) { if (!['ENOENT', 'EISDIR', 'EPERM'].includes(error.code)) throw error; }
    return;
  }
  if (!stat.isDirectory()) throw new Error('会话锁不是有效目录。');
  let entries;
  try { entries = fs.readdirSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entries.length) {
    try { fs.rmdirSync(target); } catch (error) { if (!benignRemoval(error)) throw error; }
    return;
  }
  if (entries.length !== 1) throw new Error('会话锁包含未知归属文件。');
  const entry = entries[0];
  const newMatch = NEW_OWNER.exec(entry);
  if (newMatch) {
    const pid = Number(newMatch[1]);
    const instanceId = newMatch[2];
    if (instanceId === PROCESS_INSTANCE_ID) {
      if (!ACTIVE_LOCAL_LEASES.has(entry)) {
        removeOwned(target, entry);
      }
      return;
    }
    if (isManaged) {
      removeOwned(target, entry);
      return;
    }
    if (dead(pid)) {
      removeOwned(target, entry);
    }
    return;
  }
  const legacyMatch = LEGACY_OWNER.exec(entry);
  if (legacyMatch) {
    const pid = Number(legacyMatch[1]);
    if (isManaged && pid === process.pid) {
      removeOwned(target, entry);
      return;
    }
    if (dead(pid)) {
      removeOwned(target, entry);
    }
    return;
  }
  throw new Error('会话锁包含未知归属文件。');
}

class FileLease {
  constructor(target) {
    this.target = target;
    const leaseId = crypto.randomUUID();
    const identity = `${process.pid}-${PROCESS_INSTANCE_ID}-${leaseId}`;
    this.entry = `${identity}.lease`;
    this.pending = `${target}.pending-${identity}`;
    this.acquired = false;
    PREPARING_PENDINGS.add(this.pending);
    fs.mkdirSync(this.pending, { mode: 0o700 });
    try { fs.writeFileSync(path.join(this.pending, this.entry), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { this.dispose(); throw error; }
  }

  tryAcquire() {
    // Publishing an ALREADY NONEMPTY directory is atomic. Publishing over an
    // existing nonempty directory fails; there is no empty-owner window.
    try {
      fs.renameSync(this.pending, this.target);
      this.acquired = true;
      PREPARING_PENDINGS.delete(this.pending);
      ACTIVE_LOCAL_LEASES.add(this.entry);
      return true;
    }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error.code)) return false;
      // Windows may report access denied for an existing target directory.
      if (['EACCES', 'EPERM'].includes(error.code) && fs.existsSync(this.target)) return false;
      throw error;
    }
  }

  release() {
    if (!this.acquired) return;
    this.acquired = false;
    ACTIVE_LOCAL_LEASES.delete(this.entry);
    removeOwned(this.target, this.entry);
  }

  dispose() {
    PREPARING_PENDINGS.delete(this.pending);
    removeOwned(this.pending, this.entry);
  }
}

async function acquireFileLease(target, signal, now = () => Date.now(), { directoryGuard = null, onWaiting, onAcquired } = {}) {
  signal?.throwIfAborted();
  const lease = new FileLease(target);
  let waited = false;
  const begin = now();
  try {
    while (true) {
      signal?.throwIfAborted();
      if (lease.tryAcquire()) {
        if (waited) onAcquired?.({ target, elapsedMs: now() - begin });
        return () => lease.release();
      }
      if (!waited) {
        waited = true;
        onWaiting?.({ target, phase: 'waiting' });
      }
      reap(target, now(), { directoryGuard });
      await delay(50, undefined, { signal });
    }
  } finally { lease.dispose(); }
}

function cleanupPendingLeases(directory, { directoryGuard = null } = {}) {
  const isManaged = Boolean(directoryGuard?.coversDirectory?.(directory));
  for (const name of fs.readdirSync(directory)) {
    const newMatch = NEW_PENDING.exec(name);
    if (newMatch) {
      const target = path.join(directory, name);
      if (PREPARING_PENDINGS.has(target)) continue;
      const pid = Number(newMatch[1]);
      const instanceId = newMatch[2];
      const entry = `${newMatch[1]}-${newMatch[2]}-${newMatch[3]}.lease`;
      if ((isManaged && instanceId !== PROCESS_INSTANCE_ID) || dead(pid)) {
        try {
          const stat = fs.lstatSync(target);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          const contents = fs.readdirSync(target);
          if (contents.length > 1 || (contents.length === 1 && contents[0] !== entry)) continue;
          removeOwned(target, entry);
        } catch { /* Another collector may already have removed this candidate. */ }
      }
      continue;
    }
    const legacyMatch = LEGACY_PENDING.exec(name);
    if (legacyMatch) {
      const target = path.join(directory, name);
      if (PREPARING_PENDINGS.has(target)) continue;
      const pid = Number(legacyMatch[1]);
      const entry = `${legacyMatch[1]}-${legacyMatch[2]}.lease`;
      if ((isManaged && pid === process.pid) || dead(pid)) {
        try {
          const stat = fs.lstatSync(target);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          const contents = fs.readdirSync(target);
          if (contents.length > 1 || (contents.length === 1 && contents[0] !== entry)) continue;
          removeOwned(target, entry);
        } catch { /* Another collector may already have removed this candidate. */ }
      }
    }
  }
}

module.exports = {
  FileLease,
  acquireFileLease,
  cleanupPendingLeases,
  reap,
  canonicalDirectoryPort,
  acquireDirectoryGuard,
  DirectoryGuard,
  PROCESS_INSTANCE_ID,
  ACTIVE_LOCAL_LEASES,
  PREPARING_PENDINGS
};
