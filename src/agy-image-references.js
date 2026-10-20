'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const UPLOAD = /^uploaded_media_(?:\d+_)?\d+\.[a-z0-9]+$/;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/svg+xml': 'svg' };
// Object identity carries local aliases without adding enumerable fields to
// normalized API messages, the history fingerprint or the upstream JSON.
const sources = new WeakMap(), aliases = new WeakMap();
function registerImagePart(wirePart, source) { sources.set(wirePart, source); return wirePart; }
function imageReferencePaths(source) { return [...(aliases.get(source) || [])]; }
function saveImageReference(wirePart, store, options) {
  const source = sources.get(wirePart);
  if (!source || !store) return '';
  const file = store.save(wirePart.inlineData, options);
  const paths = aliases.get(source) || new Set(); paths.add(file); aliases.set(source, paths);
  return file;
}

class AgyImageStore {
  constructor({ directory, now = () => Date.now(), ttlMs = 24 * 60 * 60 * 1000,
    maxBytes = 256 * 1024 * 1024, maxFiles = 1024 } = {}) {
    if (!directory) throw new Error('AgyImageStore requires directory');
    this.directory = path.resolve(directory);
    this.now = now; this.ttlMs = ttlMs; this.maxBytes = maxBytes; this.maxFiles = maxFiles;
  }

  ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('原生图片缓存目录不是普通目录。');
  }

  save(inline, { cascadeId, uploadedAt, index, count }) {
    if (!UUID.test(cascadeId) || !Number.isSafeInteger(uploadedAt) || uploadedAt < 0
      || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(count) || index >= count) {
      throw new Error('原生图片引用状态无效。');
    }
    const cascade = path.join(this.directory, cascadeId), directory = path.join(cascade, '.user_uploaded');
    for (const dir of [this.directory, cascade, directory]) this.ensureDirectory(dir);
    // Names and single/multiple-image numbering match the captured agy layout.
    // The root is the gateway's real private cache, never a fictitious CLI path.
    const file = path.join(directory, `uploaded_media_${count > 1 ? `${index}_` : ''}${uploadedAt}.${extensions[inline.mimeType] || 'bin'}`);
    const bytes = Buffer.from(inline.data, 'base64');
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length || !fs.readFileSync(file).equals(bytes)) {
        throw new Error('原生图片引用与缓存内容不一致。');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = `${file}.tmp-${crypto.randomUUID()}`;
      try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
      finally { try { fs.unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } }
    }
    const now = new Date(this.now()); fs.utimesSync(file, now, now);
    return file;
  }

  cleanup(protectedFiles = new Set()) {
    // Only this dedicated cache is eligible. Never traverse symlinks or touch
    // Files API uploads/generated artifacts beside the session state directory.
    let roots;
    try { if (fs.lstatSync(this.directory).isSymbolicLink()) return; roots = fs.readdirSync(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const files = [], directories = [], now = this.now();
    for (const id of roots.filter(name => UUID.test(name))) {
      const cascade = path.join(this.directory, id), directory = path.join(cascade, '.user_uploaded');
      try {
        if (!fs.lstatSync(cascade).isDirectory() || fs.lstatSync(cascade).isSymbolicLink()) continue;
        const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        directories.push([directory, cascade]);
        for (const name of fs.readdirSync(directory)) {
          const temporary = /\.tmp-[a-f0-9-]{36}$/.test(name), base = name.replace(/\.tmp-[a-f0-9-]{36}$/, '');
          if (!UPLOAD.test(base)) continue;
          const file = path.join(directory, name), entry = fs.lstatSync(file);
          if (entry.isFile() && !entry.isSymbolicLink()) files.push({ file, bytes: entry.size, at: entry.mtimeMs, temporary });
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let bytes = files.reduce((n, f) => n + f.bytes, 0), count = files.length;
    for (const entry of files.sort((a, b) => a.at - b.at)) {
      if (protectedFiles.has(entry.file)) continue;
      // Do not reap another process's in-flight atomic write for size pressure.
      if (entry.temporary && now - entry.at < this.ttlMs) continue;
      if (now - entry.at < this.ttlMs && bytes <= this.maxBytes && count <= this.maxFiles) continue;
      try { fs.unlinkSync(entry.file); bytes -= entry.bytes; count--; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const pair of directories) for (const dir of pair) {
      try { fs.rmdirSync(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
}

module.exports = { AgyImageStore, registerImagePart, saveImageReference, imageReferencePaths };
