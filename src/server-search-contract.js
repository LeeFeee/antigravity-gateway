'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// This module owns a gateway protocol, not Anthropic's private encryption.
// No network request, tool execution, model selection or turn budget lives here.
const TOOL_FIELDS = new Set(['type', 'name', 'max_uses', 'allowed_domains', 'blocked_domains',
  'allowed_callers', 'cache_control', 'defer_loading', 'strict', 'user_location']);
const CALLERS = new Set(['direct', 'code_execution_20250825', 'code_execution_20260120', 'code_execution_20260521']);
const COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY '
  + 'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ '
  + 'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ '
  + 'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const SOURCE_FIELDS = new Set(['id', 'url', 'finalUrl', 'title', 'page_age', 'provenance']);
const PROVENANCE_FIELDS = new Set(['kind', 'verifiedFinalUrl', 'contentKind', 'evidenceId', 'chunkIndex']);
const RESULT_FIELDS = new Set(['type', 'url', 'title', 'page_age', 'encrypted_content']);
const KEY_FILE = 'receipt-key-v1.bin';
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

class ServerSearchContractError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ServerSearchContractError';
    this.code = code;
    this.status = status;
    this.type = status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}
function fail(code, message, status) { throw new ServerSearchContractError(code, message, status); }
function fields(value, allowed, label, code = 'invalid_server_search_tool') {
  if (!object(value)) fail(code, `${label} 必须是对象。`);
  if (Object.keys(value).some(key => !allowed.has(key))) fail(code, `${label} 包含不支持的字段。`);
}
function string(value, label, { empty = false, max = 16384, code = 'invalid_server_search_tool' } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    fail(code, `${label} 必须是${empty ? '' : '非空'}字符串，且不能包含非法控制字符或超出长度限制。`);
  }
  return value;
}
function jsonCopy(value, code = 'invalid_server_search_receipt') {
  const seen = new Set();
  function copy(item, depth) {
    if (depth > 32) fail(code, 'JSON 数据超出支持的嵌套深度。');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!Array.isArray(item) && !object(item)) fail(code, '只能保存有效的 JSON 值，数值必须有限。');
    if (seen.has(item)) fail(code, '不能保存包含循环引用的数据。');
    seen.add(item);
    const result = Array.isArray(item) ? item.map(child => copy(child, depth + 1))
      : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, copy(child, depth + 1)]));
    seen.delete(item);
    return result;
  }
  return copy(value, 0);
}

function parseDomainRule(value) {
  string(value, '域名过滤条件');
  if (!/^[\x21-\x7e]+$/.test(value) || /[?#@:\\]/.test(value)) {
    fail('invalid_server_search_tool', '域名过滤条件必须使用 ASCII 域名，可附带路径，不能包含协议或端口。');
  }
  const slash = value.indexOf('/');
  const host = (slash < 0 ? value : value.slice(0, slash)).toLowerCase();
  const pathname = slash < 0 ? '' : value.slice(slash);
  if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail('invalid_server_search_tool', '域名过滤条件包含无效域名或域名通配符。');
  }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { fail('invalid_server_search_tool', '域名过滤路径包含无效的百分号编码。'); }
  if (/[\\\u0000-\u0020?#]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) {
    fail('invalid_server_search_tool', '域名过滤路径包含有歧义的路径片段。');
  }

}

function validateServerSearchTool(tool) {
  fields(tool, TOOL_FIELDS, '服务器搜索工具');
  if (tool.type !== 'web_search_20250305' || tool.name !== 'web_search') {
    fail('unsupported_server_search_tool', '仅支持名称为 web_search 的 web_search_20250305 工具。');
  }
  if (tool.max_uses != null && (!Number.isSafeInteger(tool.max_uses) || tool.max_uses < 0)) {
    fail('invalid_server_search_tool', 'max_uses 必须是非负安全整数或 null。');
  }
  if (tool.allowed_domains != null && tool.blocked_domains != null) {
    fail('invalid_server_search_tool', 'allowed_domains 和 blocked_domains 不能同时提供。');
  }
  for (const key of ['allowed_domains', 'blocked_domains']) {
    if (tool[key] == null) continue;
    if (!Array.isArray(tool[key])) fail('invalid_server_search_tool', `${key} 必须是数组或 null。`);
    tool[key].forEach(parseDomainRule);
  }
  for (const key of ['strict', 'defer_loading']) {
    if (own(tool, key) && typeof tool[key] !== 'boolean') fail('invalid_server_search_tool', `${key} 必须是布尔值。`);
  }
  if (own(tool, 'allowed_callers')) {
    if (!Array.isArray(tool.allowed_callers) || !tool.allowed_callers.length
      || tool.allowed_callers.some(caller => !CALLERS.has(caller))
      || new Set(tool.allowed_callers).size !== tool.allowed_callers.length) {
      fail('invalid_server_search_tool', 'allowed_callers 必须包含 SDK 定义的调用者类型，且不能重复。');
    }
    // Syntax validation is not execution authorization. The orchestrator must
    // reject caller types it cannot execute (for example code_execution).
  }
  if (tool.cache_control != null) {
    fields(tool.cache_control, new Set(['type', 'ttl']), 'cache_control');
    if (tool.cache_control.type !== 'ephemeral' || (own(tool.cache_control, 'ttl') && !['5m', '1h'].includes(tool.cache_control.ttl))) {
      fail('invalid_server_search_tool', '服务器搜索的 cache_control 配置不受支持。');
    }
  }
  if (tool.user_location != null) {
    const loc = tool.user_location;
    fields(loc, new Set(['type', 'city', 'region', 'country', 'timezone']), 'user_location');
    if (loc.type !== 'approximate') fail('invalid_server_search_tool', 'user_location.type 必须是 approximate。');
    const present = ['city', 'region', 'country', 'timezone'].filter(key => loc[key] != null);
    if (!present.length) fail('invalid_server_search_tool', 'user_location 至少需要一个位置字段。');
    for (const key of present) string(loc[key], `user_location.${key}`, { max: 512 });
    if (loc.country != null && !COUNTRIES.has(loc.country)) fail('invalid_server_search_tool', 'user_location.country 必须是 ISO 3166-1 alpha-2 国家代码。');
    if (loc.timezone != null) {
      try { new Intl.DateTimeFormat('en', { timeZone: loc.timezone }).format(0); }
      catch { fail('invalid_server_search_tool', 'user_location.timezone 必须是有效的 IANA 时区。'); }
    }
  }
  return jsonCopy(tool, 'invalid_server_search_tool');
}

function sourceUrl(value) {
  string(value, '来源 URL', { code: 'invalid_server_search_source' });
  let url;
  try { url = new URL(value); } catch { fail('invalid_server_search_source', '来源 URL 无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname
    || /[\\\u0000-\u0020]/.test(value)) fail('invalid_server_search_source', '来源 URL 必须是绝对 HTTP(S) 地址，且不能包含凭据。');
  // Preserve the upstream reference verbatim; this module never resolves it.
  return value;
}

function validateSource(source) {
  const code = 'invalid_server_search_source';
  fields(source, SOURCE_FIELDS, '搜索来源', code);
  const initial = sourceUrl(source.url), final = sourceUrl(source.finalUrl);
  string(source.title, '来源标题', { empty: true, code });
  if (source.id !== undefined) string(source.id, '来源 ID', { code });
  if (source.page_age != null) string(source.page_age, '来源 page_age', { code });
  const proof = source.provenance;
  fields(proof, PROVENANCE_FIELDS, '来源证明', code);
  if (proof.kind !== 'google_search_result' || proof.verifiedFinalUrl !== false
    || proof.contentKind !== 'metadata_only' || initial !== final) {
    fail(code, '搜索来源只能保留 Google 原始链接元数据，不能声明已解析目标或网页正文。');
  }
  string(proof.evidenceId, '来源证据 ID', { code });
  if (proof.chunkIndex !== undefined && (!Number.isSafeInteger(proof.chunkIndex) || proof.chunkIndex < 0)) fail(code, '来源 chunkIndex 必须是非负整数。');
  return jsonCopy(source, code);
}

function receiptBinding(scope, callId) {
  string(scope, 'API 客户端作用域', { max: 4096, code: 'invalid_server_search_receipt' });
  string(callId, '服务器工具调用 ID', { max: 512, code: 'invalid_server_search_receipt' });
  return `${digest(scope)}:${digest(callId)}`;
}
function loadKey(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    fail('server_search_key_error', '搜索凭据目录必须由网关运行用户拥有，且不能是符号链接。', 500);
  }
  fs.chmodSync(directory, 0o700);
  const keyPath = path.join(directory, KEY_FILE), pending = path.join(directory, `.key-${crypto.randomUUID()}.tmp`);
  // Publish a complete key atomically. Another process either wins the link or
  // reads the exact same existing key; neither can observe a half-written key.
  if (!fs.existsSync(keyPath)) {
    let fd;
    try {
      fd = fs.openSync(pending, 'wx', 0o600);
      fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      try { fs.linkSync(pending, keyPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(pending, { force: true });
    }
  }
  let fd;
  try {
    fd = fs.openSync(keyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const info = fs.fstatSync(fd);
    // The winning publisher briefly has two links before it removes its temp
    // name. A concurrent reader must not reject that valid completed key.
    if (!info.isFile() || info.size !== 32 || (process.getuid && info.uid !== process.getuid())) {
      fail('server_search_key_error', '持久化搜索密钥无效，已拒绝覆盖原密钥。', 500);
    }
    fs.fchmodSync(fd, 0o600);
    return { key: fs.readFileSync(fd), keyPath };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

class ServerSearchReceipts {
  #key;
  constructor({ directory, now = Date.now } = {}) {
    if (typeof directory !== 'string' || !directory || typeof now !== 'function') fail('server_search_key_error', '必须提供私有搜索凭据目录和有效时钟。', 500);
    try {
      const loaded = loadKey(path.resolve(directory)); this.#key = loaded.key; this.keyPath = loaded.keyPath;
    } catch (error) {
      if (error instanceof ServerSearchContractError) throw error;
      fail('server_search_key_error', '无法加载持久化搜索凭据密钥。', 500);
    }
    this.now = now;
  }
  #issuedAt() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) fail('server_search_key_error', '搜索凭据时钟返回了无效时间戳。', 500);
    return value;
  }
  #seal(kind, binding, payload) {
    const bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.length > MAX_PAYLOAD_BYTES) fail('invalid_server_search_receipt', '搜索凭据超出支持的大小。');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(`agyws1:${kind}:${binding}`));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return ['agyws1', kind, iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }
  #open(kind, binding, token) {
    try {
      if (typeof token !== 'string' || token.length > MAX_PAYLOAD_BYTES * 2) throw new Error('size');
      const pieces = token.split('.');
      if (pieces.length !== 5 || pieces[0] !== 'agyws1' || pieces[1] !== kind
        || pieces.slice(2).some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error('format');
      const [iv, ciphertext, tag] = pieces.slice(2).map(value => Buffer.from(value, 'base64url'));
      if ([iv, ciphertext, tag].some((value, i) => value.toString('base64url') !== pieces[i + 2])
        || iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PAYLOAD_BYTES) throw new Error('encoding');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(Buffer.from(`agyws1:${kind}:${binding}`)); decipher.setAuthTag(tag);
      const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
      if (payload.version !== 1 || payload.kind !== kind || !Number.isFinite(payload.issuedAt)) throw new Error('payload');
      return payload;
    } catch { fail('invalid_server_search_receipt', '搜索凭据无效，或属于其他 API 客户端作用域、调用或结果。'); }
  }
  issueResult({ scope, callId, source, metadata = {} }) {
    const binding = receiptBinding(scope, callId), verified = validateSource(source);
    if (!object(metadata)) fail('invalid_server_search_receipt', '搜索凭据元数据必须是对象。');
    const payload = { version: 1, kind: 'r', issuedAt: this.#issuedAt(), resultId: crypto.randomUUID(),
      source: verified, metadata: jsonCopy(metadata) };
    return { type: 'web_search_result', url: verified.finalUrl, title: verified.title,
      page_age: verified.page_age ?? null, encrypted_content: this.#seal('r', binding, payload) };
  }
  restoreResult({ scope, callId, result }) {
    fields(result, RESULT_FIELDS, '搜索结果', 'invalid_server_search_receipt');
    const payload = this.#open('r', receiptBinding(scope, callId), result.encrypted_content);
    const source = validateSource(payload.source);
    if (result.type !== 'web_search_result' || result.url !== source.finalUrl || result.title !== source.title
      || (result.page_age ?? null) !== (source.page_age ?? null)) {
      fail('invalid_server_search_receipt', '搜索结果的可见字段与认证凭据不匹配。');
    }
    return { source, metadata: payload.metadata, resultId: payload.resultId, issuedAt: payload.issuedAt };
  }
}

module.exports = { ServerSearchContractError, validateServerSearchTool, ServerSearchReceipts };
