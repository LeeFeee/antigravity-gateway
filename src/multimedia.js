'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_MEDIA_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_MEDIA_LIMIT || 96 * 1024 * 1024);
const DEFAULT_TOTAL_MEDIA_LIMIT = Number(process.env.ANTIGRAVITY_GATEWAY_TOTAL_MEDIA_LIMIT || 192 * 1024 * 1024);
const MEDIA_ID = /^file_[a-f0-9]{32}$/;

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
  const resolvedData = dataUrl(source);
  return {
    type: 'media',
    id: firstString(id) || `media_${crypto.randomUUID().replaceAll('-', '')}`,
    mediaType: normalizeMime(resolvedData?.mimeType || mediaType, filename || source),
    ...(firstString(data, resolvedData?.data) ? { data: firstString(data, resolvedData?.data).replace(/\s+/g, '') } : {}),
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
    return canonicalMedia({
      mediaType: block.media_type || block.mime_type,
      data: block.file_data && !String(block.file_data).startsWith('http') ? block.file_data : '',
      url: block.file_url || (String(block.file_data || '').startsWith('http') ? block.file_data : ''),
      fileId: block.file_id,
      filePath: block.file_path || block.path,
      filename: block.filename
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
  constructor({ directory, fsImpl = fs, fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MEDIA_LIMIT, maxTotalBytes = DEFAULT_TOTAL_MEDIA_LIMIT } = {}) {
    if (!directory) throw new Error('MediaStore requires directory');
    this.directory = directory;
    this.fs = fsImpl;
    this.fetchImpl = fetchImpl;
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MEDIA_LIMIT);
    this.maxTotalBytes = Math.max(this.maxBytes, Number(maxTotalBytes) || DEFAULT_TOTAL_MEDIA_LIMIT);
  }

  ensureDirectory() { this.fs.mkdirSync(this.directory, { recursive: true }); }
  metadataPath(id) { return path.join(this.directory, `${id}.json`); }
  contentPath(id) { return path.join(this.directory, `${id}.bin`); }

  save(buffer, { mediaType, filename = '', purpose = 'assistants', scope = '' } = {}) {
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (!content.length) throw new MultimediaError('上传的多媒体文件为空。', { code: 'empty_media' });
    if (content.length > this.maxBytes) throw new MultimediaError('多媒体文件超过单文件传输上限。', { code: 'media_too_large', status: 413 });
    this.ensureDirectory();
    const id = `file_${crypto.randomBytes(16).toString('hex')}`;
    const metadata = {
      id, object: 'file', bytes: content.length, created_at: Math.floor(Date.now() / 1000),
      filename: filename || `${id}.bin`, purpose, mediaType: normalizeMime(mediaType, filename), scope
    };
    this.fs.writeFileSync(this.contentPath(id), content);
    this.fs.writeFileSync(this.metadataPath(id), `${JSON.stringify(metadata)}\n`);
    return metadata;
  }

  get(id, { scope = '', allowPublic = false } = {}) {
    if (!MEDIA_ID.test(String(id || ''))) return null;
    try {
      const metadata = JSON.parse(this.fs.readFileSync(this.metadataPath(id), 'utf8'));
      if (!allowPublic && metadata.scope && metadata.scope !== scope) return null;
      const buffer = this.fs.readFileSync(this.contentPath(id));
      return { metadata, buffer };
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
    if (part.filePath || String(part.url || '').startsWith('file://')) {
      const target = path.resolve(part.filePath || decodeURIComponent(new URL(part.url).pathname));
      let stat;
      try { stat = this.fs.statSync(target); } catch { throw new MultimediaError(`找不到本地多媒体文件: ${target}`, { code: 'media_file_not_found', status: 404 }); }
      if (!stat.isFile() || stat.size > this.maxBytes) throw new MultimediaError('本地多媒体不是文件或超过单文件传输上限。', { code: 'media_too_large', status: 413 });
      const buffer = this.fs.readFileSync(target);
      return { ...part, mediaType: normalizeMime(usefulMime(part.mediaType), target), data: buffer.toString('base64'), bytes: buffer.length, filename: part.filename || path.basename(target) };
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
  dataUrl,
  mediaPartFromBlock,
  mediaParts,
  mimeFromName,
  normalizeMime
};
