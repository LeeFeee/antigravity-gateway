'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const DEFAULT_MEDIA_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_MEDIA_LIMIT || 96 * 1024 * 1024);
const DEFAULT_TOTAL_MEDIA_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_TOTAL_MEDIA_LIMIT || 192 * 1024 * 1024);
const MEDIA_ID = /^file_[a-f0-9]{32}$/;
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
function imageFileExtension(mime) { return IMAGE_EXTENSIONS[normalizeMime(mime)] || 'bin'; }
const GENERATED_ORIGIN = 'gateway-generated-image-v1';

// MIME declarations alone must never make uploaded HTML/SVG into public,
// same-origin content. Only passive raster formats with matching signatures
// can receive the server-owned generated-image marker.
function safeRasterImage(buffer, mediaType) {
  if (!Buffer.isBuffer(buffer)) return false;
  switch (normalizeMime(mediaType)) {
    case 'image/png':
      return buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        && buffer.readUInt32BE(8) === 13 && buffer.toString('ascii', 12, 16) === 'IHDR'
        && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0
        && buffer.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
    case 'image/jpeg':
      return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
    case 'image/gif':
      return buffer.length >= 14 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))
        && buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0 && buffer[buffer.length - 1] === 0x3b;
    case 'image/webp':
      return buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF'
        && buffer.readUInt32LE(4) === buffer.length - 8 && buffer.toString('ascii', 8, 12) === 'WEBP'
        && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16));
    case 'image/avif': {
      if (buffer.length < 24 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
      const size = buffer.readUInt32BE(0);
      if (size < 24 || size > Math.min(buffer.length, 4096) || size % 4) return false;
      if (['avif', 'avis'].includes(buffer.toString('ascii', 8, 12))) return true;
      for (let at = 16; at < size; at += 4) if (['avif', 'avis'].includes(buffer.toString('ascii', at, at + 4))) return true;
      return false;
    }
    default: return false;
  }
}

function withinRoot(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function localMediaOptions({ env = process.env, configDir, homeDir = os.homedir() } = {}) {
  const allowLocalPaths = env.ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS === '1';
  let allowedLocalRoots = [];
  if (allowLocalPaths) {
    try { allowedLocalRoots = JSON.parse(env.ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS || '[]'); }
    catch { throw new Error('ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS 必须是绝对目录路径的 JSON 数组。'); }
    if (!Array.isArray(allowedLocalRoots) || !allowedLocalRoots.length
      || allowedLocalRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
      throw new Error('启用本地媒体路径时，ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS 必须指定至少一个绝对目录路径。');
    }
  }
  // These exclusions apply even when an operator allows a broad parent such
  // as their home directory. Other credential stores should remain outside the
  // explicitly allowed media roots as well.
  const blockedLocalRoots = [configDir, ...[
    '.antigravity-gateway', '.ssh', '.aws', '.config', '.antigravity', '.agy', '.gemini',
    '.claude', '.codex', '.hermes', '.pi', '.dsh', '.mirasim', '.local/share/agy',
    'Library/Application Support/Antigravity', 'Library/Keychains'
  ].map(name => path.join(homeDir, name))].filter(Boolean);
  return { allowLocalPaths, allowedLocalRoots, blockedLocalRoots };
}

const MIME_BY_EXTENSION = new Map(Object.entries({
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.webm': 'video/webm',
  '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json', '.md': 'text/markdown', '.pdf': 'application/pdf', '.txt': 'text/plain'
}));

class MultimediaError extends Error {
  constructor(message, { code = 'invalid_media', status = 400, details, cause } = {}) {
    super(message, { cause });
    this.name = 'MultimediaError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function mimeFromName(name, fallback = 'application/octet-stream') {
  return MIME_BY_EXTENSION.get(path.extname(String(name || '')).toLowerCase()) || fallback;
}

function normalizeMime(value, name = '') {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  if (mime === 'application/octet-stream') return mimeFromName(name, mime);
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime) ? mime : mimeFromName(name);
}

function usefulMime(value) {
  const mime = String(value || '').toLowerCase();
  return mime && mime !== 'application/octet-stream' && !mime.endsWith('/*') ? mime : '';
}

function dataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([a-z0-9+/=\r\n]+)$/i);
  return match ? { mimeType: normalizeMime(match[1]), data: match[2].replace(/\s+/g, '') } : null;
}

function canonicalMedia({ id, mediaType, data, url, fileId, filePath, filename, detail } = {}) {
  const source = firstString(url, filePath);
  const inline = firstString(data);
  const inlineData = dataUrl(inline);
  if (/^data:/i.test(inline) && !inlineData) {
    throw new MultimediaError('内联附件的 Data URL 必须包含有效的 Base64 数据。');
  }
  const resolvedData = inlineData || dataUrl(source);
  const encoded = inlineData?.data || firstString(data, resolvedData?.data);
  return {
    type: 'media',
    id: firstString(id) || `media_${crypto.randomUUID().replaceAll('-', '')}`,
    mediaType: normalizeMime(resolvedData?.mimeType || mediaType, filename || source),
    ...(encoded ? { data: encoded.replace(/\s+/g, '') } : {}),
    ...(fileId ? { fileId: String(fileId) } : {}),
    ...(url && !resolvedData ? { url: String(url) } : {}),
    ...(filePath ? { filePath: String(filePath) } : {}),
    ...(filename ? { filename: String(filename) } : {}),
    ...(detail ? { detail: String(detail) } : {})
  };
}

function mediaPartFromBlock(block, protocol = '') {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'media' && (block.data || block.url || block.fileId || block.filePath)) return canonicalMedia(block);

  const source = block.source && typeof block.source === 'object' ? block.source : null;
  if (source && ['image', 'document', 'audio', 'video'].includes(block.type)) {
    if (source.type === 'base64') return canonicalMedia({ mediaType: source.media_type || source.mime_type, data: source.data, filename: source.filename });
    if (source.type === 'url') return canonicalMedia({ mediaType: source.media_type || source.mime_type, url: source.url, filename: source.filename });
    if (source.type === 'file') return canonicalMedia({ mediaType: source.media_type || source.mime_type, fileId: source.file_id, filePath: source.path || source.file_path, filename: source.filename });
  }

  const imageUrl = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
  const videoUrl = typeof block.video_url === 'string' ? block.video_url : block.video_url?.url;
  const audio = block.input_audio || block.audio;
  const fileData = block.file_data || block.fileData;
  const inlineData = block.inline_data || block.inlineData;

  if (imageUrl || ['image_url', 'input_image'].includes(block.type)) {
    return canonicalMedia({
      mediaType: block.media_type || block.mime_type || 'image/*',
      url: imageUrl || block.url,
      fileId: block.file_id,
      filePath: block.file_path || block.path,
      detail: block.detail || block.image_url?.detail
    });
  }
  if (videoUrl || ['video_url', 'input_video', 'video'].includes(block.type)) {
    return canonicalMedia({ mediaType: block.media_type || block.mime_type || 'video/*', url: videoUrl || block.url, fileId: block.file_id, filePath: block.file_path || block.path });
  }
  if (['input_audio', 'audio'].includes(block.type) && audio) {
    return canonicalMedia({ mediaType: block.media_type || block.mime_type || (audio.format ? `audio/${audio.format}` : 'audio/*'), data: audio.data, url: audio.url, fileId: block.file_id, filePath: block.file_path || block.path });
  }
  if (['file', 'input_file'].includes(block.type)) {
    // Chat Completions wraps these fields in `file`; Responses and legacy
    // clients use flat fields. Both reach the same canonical media path.
    const file = block.type === 'file' && block.file && typeof block.file === 'object' && !Array.isArray(block.file)
      ? block.file : block;
    return canonicalMedia({
      mediaType: file.media_type || file.mime_type,
      data: file.file_data && !String(file.file_data).startsWith('http') ? file.file_data : '',
      url: file.file_url || (String(file.file_data || '').startsWith('http') ? file.file_data : ''),
      fileId: file.file_id,
      filePath: file.file_path || file.path,
      filename: file.filename
    });
  }
  if (inlineData?.data) return canonicalMedia({ mediaType: inlineData.mimeType || inlineData.mime_type, data: inlineData.data, filename: block.filename });
  if (fileData?.fileUri || fileData?.file_uri) return canonicalMedia({ mediaType: fileData.mimeType || fileData.mime_type, url: fileData.fileUri || fileData.file_uri, filename: block.filename });
  if (protocol === 'responses' && block.type === 'computer_screenshot' && block.image_url) return canonicalMedia({ mediaType: 'image/png', url: block.image_url });
  return null;
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const parts = value.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || parts[0] >= 224;
  }
  if (net.isIPv6(value)) return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:') || value.startsWith('::ffff:127.');
  return true;
}

async function assertPublicUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new MultimediaError('多媒体 URL 无效。', { code: 'invalid_media_url' }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new MultimediaError('远程多媒体只支持 HTTP/HTTPS URL。', { code: 'invalid_media_url' });
  const records = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new MultimediaError('远程多媒体 URL 指向不可访问的私有地址。', { code: 'media_url_not_allowed' });
  }
  return url;
}

async function responseBuffer(response, limit) {
  if (!response.ok) throw new MultimediaError(`下载多媒体失败：HTTP ${response.status}`, { code: 'media_download_failed', status: 400 });
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new MultimediaError('多媒体文件超过单文件传输上限。', { code: 'media_too_large', status: 413 });
  const chunks = [];
  let size = 0;
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new MultimediaError('多媒体文件超过单文件传输上限。', { code: 'media_too_large', status: 413 });
    return buffer;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new MultimediaError('多媒体文件超过单文件传输上限。', { code: 'media_too_large', status: 413 });
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

class MediaStore {
  constructor({ directory, fsImpl = fs, fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MEDIA_LIMIT, maxTotalBytes = DEFAULT_TOTAL_MEDIA_LIMIT,
    allowLocalPaths = false, allowedLocalRoots = [], blockedLocalRoots = [] } = {}) {
    if (!directory) throw new Error('MediaStore requires directory');
    this.directory = directory;
    this.fs = fsImpl;
    this.fetchImpl = fetchImpl;
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MEDIA_LIMIT);
    this.maxTotalBytes = Math.max(this.maxBytes, Number(maxTotalBytes) || DEFAULT_TOTAL_MEDIA_LIMIT);
    this.allowLocalPaths = allowLocalPaths === true;
    this.allowedLocalRoots = Array.isArray(allowedLocalRoots) ? allowedLocalRoots.map(root => path.resolve(root)) : [];
    this.blockedLocalRoots = [path.resolve(directory), ...blockedLocalRoots.map(root => path.resolve(root))];
  }

  ensureDirectory() { this.fs.mkdirSync(this.directory, { recursive: true }); }
  metadataPath(id) { return path.join(this.directory, `${id}.json`); }
  contentPath(id, metadata) {
    if (!metadata) { try { metadata = JSON.parse(this.fs.readFileSync(this.metadataPath(id), 'utf8')); } catch { /* legacy files use .bin */ } }
    const extension = metadata?.purpose === 'generated' ? imageFileExtension(metadata.mediaType) : 'bin';
    const typed = path.join(this.directory, `${id}.${extension}`);
    // Older generated files remain readable/deletable without migration.
    return extension !== 'bin' && this.fs.existsSync(typed) ? typed : path.join(this.directory, `${id}.bin`);
  }

  save(buffer, options = {}) {
    if (String(options.purpose || '').trim().toLowerCase() === 'generated') {
      throw new MultimediaError('generated 是网关内部保留的文件用途，不能用于上传。', { code: 'reserved_file_purpose' });
    }
    return this.#persist(buffer, options);
  }

  saveGeneratedImage(buffer, options = {}) {
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const mediaType = normalizeMime(options.mediaType, options.filename);
    if (!safeRasterImage(content, mediaType)) {
      throw new MultimediaError('生成结果不是与声明类型匹配的受支持图片。', { code: 'invalid_generated_image', status: 502 });
    }
    return this.#persist(content, { ...options, mediaType, purpose: 'generated' }, {
      origin: GENERATED_ORIGIN, visibility: 'public', sha256: crypto.createHash('sha256').update(content).digest('hex')
    });
  }

  #persist(buffer, { mediaType, filename = '', purpose = 'assistants', scope = '' } = {}, generated = null) {
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (!content.length) throw new MultimediaError('上传的多媒体文件为空。', { code: 'empty_media' });
    if (content.length > this.maxBytes) throw new MultimediaError('多媒体文件超过单文件传输上限。', { code: 'media_too_large', status: 413 });
    this.ensureDirectory();
    const id = `file_${crypto.randomBytes(16).toString('hex')}`;
    const metadata = {
      id, object: 'file', bytes: content.length, created_at: Math.floor(Date.now() / 1000),
      filename: filename || `${id}.bin`, purpose, mediaType: normalizeMime(mediaType, filename), scope,
      origin: generated?.origin || 'client-upload', visibility: generated?.visibility || 'private',
      ...(generated ? { sha256: generated.sha256 } : {})
    };
    const extension = purpose === 'generated' ? imageFileExtension(metadata.mediaType) : 'bin';
    this.fs.writeFileSync(path.join(this.directory, `${id}.${extension}`), content);
    this.fs.writeFileSync(this.metadataPath(id), `${JSON.stringify(metadata)}\n`);
    return metadata;
  }

  get(id, { scope = '', allowPublic = false } = {}) {
    if (!MEDIA_ID.test(String(id || ''))) return null;
    try {
      const metadata = JSON.parse(this.fs.readFileSync(this.metadataPath(id), 'utf8'));
      // Legacy purpose=generated is not proof of origin: older HTTP uploads
      // could set it. Keep those files readable by their owner, never public.
      const publicCandidate = metadata.origin === GENERATED_ORIGIN && metadata.visibility === 'public'
        && metadata.purpose === 'generated' && /^[a-f0-9]{64}$/.test(metadata.sha256 || '');
      const scopeMatches = !metadata.scope || metadata.scope === scope;
      if (!scopeMatches && !(allowPublic && publicCandidate)) return null;
      const buffer = this.fs.readFileSync(this.contentPath(id, metadata));
      const publicOutput = publicCandidate && safeRasterImage(buffer, metadata.mediaType)
        && crypto.createHash('sha256').update(buffer).digest('hex') === metadata.sha256;
      if (!scopeMatches && !(allowPublic && publicOutput)) return null;
      return { metadata, buffer, publicOutput };
    } catch { return null; }
  }

  delete(id, { scope = '' } = {}) {
    const item = this.get(id, { scope });
    if (!item) return false;
    this.fs.unlinkSync(this.contentPath(id));
    this.fs.unlinkSync(this.metadataPath(id));
    return true;
  }

  async resolve(part, { scope = '', signal } = {}) {
    if (part.data) {
      const buffer = Buffer.from(String(part.data), 'base64');
      if (!buffer.length || buffer.length > this.maxBytes) throw new MultimediaError('Base64 多媒体为空或超过单文件传输上限。', { code: 'media_too_large', status: 413 });
      return { ...part, data: buffer.toString('base64'), bytes: buffer.length };
    }
    if (part.fileId) {
      const item = this.get(part.fileId, { scope });
      if (!item) throw new MultimediaError(`找不到多媒体文件: ${part.fileId}`, { code: 'media_file_not_found', status: 404 });
      return { ...part, mediaType: normalizeMime(usefulMime(part.mediaType) || item.metadata.mediaType, item.metadata.filename), data: item.buffer.toString('base64'), bytes: item.buffer.length, filename: part.filename || item.metadata.filename };
    }
    if (part.filePath || /^file:/i.test(String(part.url || ''))) {
      return this.resolveLocalFile(part);
    }
    if (part.url) {
      try {
        const linked = new URL(part.url);
        const storedId = linked.pathname.match(/^\/v1\/files\/(file_[a-f0-9]{32})\/content$/)?.[1];
        if (storedId) {
          const item = this.get(storedId, { scope });
          if (!item) throw new MultimediaError(`找不到多媒体文件: ${storedId}`, { code: 'media_file_not_found', status: 404 });
          return { ...part, fileId: storedId, mediaType: normalizeMime(usefulMime(part.mediaType) || item.metadata.mediaType, item.metadata.filename), data: item.buffer.toString('base64'), bytes: item.buffer.length, filename: part.filename || item.metadata.filename };
        }
      } catch (error) {
        if (error instanceof MultimediaError) throw error;
      }
      let url = await assertPublicUrl(part.url);
      let response;
      try {
        for (let redirect = 0; redirect < 5; redirect += 1) {
          response = await this.fetchImpl(url, { signal, redirect: 'manual', headers: { accept: 'image/*,video/*,audio/*,application/pdf,text/plain,*/*;q=0.1' } });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          if (!location) break;
          url = await assertPublicUrl(new URL(location, url).toString());
        }
      } catch (error) { throw new MultimediaError('远程多媒体下载失败。', { code: 'media_download_failed', details: error.message, cause: error }); }
      const buffer = await responseBuffer(response, this.maxBytes);
      return { ...part, mediaType: normalizeMime(response.headers.get('content-type') || part.mediaType, url.pathname), data: buffer.toString('base64'), bytes: buffer.length, filename: part.filename || path.basename(url.pathname) };
    }
    throw new MultimediaError('多媒体内容缺少 data、URL、file_id 或本地路径。');
  }

  resolveLocalFile(part) {
    const denied = () => new MultimediaError('网关不允许读取此本地路径；请上传文件并使用 file_id。', { code: 'media_local_path_not_allowed', status: 403 });
    if (!this.allowLocalPaths || !this.allowedLocalRoots.length) throw denied();
    let target;
    try { target = path.resolve(part.filePath || fileURLToPath(part.url)); }
    catch { throw new MultimediaError('本地媒体路径无效。', { code: 'invalid_media_url' }); }
    const realOrResolved = candidate => {
      try { return this.fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
    };
    const blocked = candidate => this.blockedLocalRoots.some(root => withinRoot(candidate, root) || withinRoot(candidate, realOrResolved(root)))
      || /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc)$/i.test(path.basename(candidate));
    if (blocked(target) || !this.allowedLocalRoots.some(root => withinRoot(target, root) || withinRoot(target, realOrResolved(root)))) throw denied();
    let canonical;
    try { canonical = this.fs.realpathSync(target); }
    catch { throw new MultimediaError('找不到本地多媒体文件。', { code: 'media_file_not_found', status: 404 }); }
    if (blocked(canonical) || !this.allowedLocalRoots.some(root => {
      try { return withinRoot(canonical, this.fs.realpathSync(root)); } catch { return false; }
    })) throw denied();
    let fd;
    try {
      const before = this.fs.statSync(canonical);
      if (!before.isFile() || before.size > this.maxBytes) throw new MultimediaError('本地多媒体不是文件或超过单文件传输上限。', { code: 'media_too_large', status: 413 });
      fd = this.fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened = this.fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || this.fs.realpathSync(target) !== canonical || this.fs.realpathSync(canonical) !== canonical) throw denied();
      const buffer = this.fs.readFileSync(fd);
      if (buffer.length > this.maxBytes) throw new MultimediaError('本地多媒体超过单文件传输上限。', { code: 'media_too_large', status: 413 });
      return { ...part, mediaType: normalizeMime(usefulMime(part.mediaType), canonical), data: buffer.toString('base64'), bytes: buffer.length, filename: part.filename || path.basename(canonical) };
    } catch (error) {
      if (error instanceof MultimediaError) throw error;
      throw denied();
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
  }

  async resolveNormalized(normalized, options = {}) {
    let total = 0;
    const messages = [];
    for (const message of normalized.messages || []) {
      const parts = [];
      for (const part of message.parts || []) {
        if (part?.type === 'tool_result' && Array.isArray(part.media)) {
          const media = [];
          for (const item of part.media) {
            const resolved = await this.resolve(item, options);
            total += resolved.bytes || 0;
            if (total > this.maxTotalBytes) throw new MultimediaError('本次请求的多媒体总量超过传输上限。', { code: 'media_total_too_large', status: 413 });
            media.push(resolved);
          }
          parts.push({ ...part, media });
          continue;
        }
        if (part?.type !== 'media') { parts.push(part); continue; }
        const resolved = await this.resolve(part, options);
        total += resolved.bytes || 0;
        if (total > this.maxTotalBytes) throw new MultimediaError('本次请求的多媒体总量超过传输上限。', { code: 'media_total_too_large', status: 413 });
        parts.push(resolved);
      }
      messages.push({ ...message, parts });
    }
    return { ...normalized, messages };
  }
}

function mediaParts(normalized, predicate = () => true) {
  return (normalized.messages || []).flatMap((message) => message.parts || [])
    .filter((part) => part?.type === 'media' && predicate(part));
}

module.exports = {
  DEFAULT_MEDIA_LIMIT,
  MEDIA_ID,
  MediaStore,
  MultimediaError,
  canonicalMedia,
  imageFileExtension,
  localMediaOptions,
  safeRasterImage,
  dataUrl,
  mediaPartFromBlock,
  mediaParts,
  mimeFromName,
  normalizeMime
};
