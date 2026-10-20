'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const ID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const OWNER = new RegExp(`^([1-9][0-9]*)-(${ID})\\.lease$`);
const PENDING = new RegExp(`^[a-f0-9]{64}\\.json\\.lock\\.pending-([1-9][0-9]*)-(${ID})$`);
const benignRemoval = error => ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code);

function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  return false;
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

function reap(target, now = Date.now()) {
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
  const match = entries.length === 1 && OWNER.exec(entries[0]);
  if (!match) throw new Error('会话锁包含未知归属文件。');
  if (dead(Number(match[1]))) removeOwned(target, entries[0]);
}

class FileLease {
  constructor(target) {
    this.target = target;
    const identity = `${process.pid}-${crypto.randomUUID()}`;
    this.entry = `${identity}.lease`;
    this.pending = `${target}.pending-${identity}`;
    this.acquired = false;
    fs.mkdirSync(this.pending, { mode: 0o700 });
    try { fs.writeFileSync(path.join(this.pending, this.entry), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { this.dispose(); throw error; }
  }

  tryAcquire() {
    // Publishing an ALREADY NONEMPTY directory is atomic. Publishing over an
    // existing nonempty directory fails; there is no empty-owner window.
    try { fs.renameSync(this.pending, this.target); this.acquired = true; return true; }
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
    removeOwned(this.target, this.entry);
  }

  dispose() { removeOwned(this.pending, this.entry); }
}

async function acquireFileLease(target, signal, now = () => Date.now()) {
  signal?.throwIfAborted();
  const lease = new FileLease(target);
  try {
    while (true) {
      signal?.throwIfAborted();
      if (lease.tryAcquire()) return () => lease.release();
      reap(target, now());
      await delay(50, undefined, { signal });
    }
  } finally { lease.dispose(); }
}

function cleanupPendingLeases(directory) {
  for (const name of fs.readdirSync(directory)) {
    const match = PENDING.exec(name);
    if (!match || !dead(Number(match[1]))) continue;
    const target = path.join(directory, name), entry = `${match[1]}-${match[2]}.lease`;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const contents = fs.readdirSync(target);
      if (contents.length > 1 || (contents.length === 1 && contents[0] !== entry)) continue;
      removeOwned(target, entry);
    } catch { /* Another collector may already have removed this candidate. */ }
  }
}

module.exports = { FileLease, acquireFileLease, cleanupPendingLeases };
