'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Public Antigravity OAuth client ID used by both Antigravity Desktop and Cockpit Tools.
// Client secrets are never hardcoded; token refresh resolves matching secrets from local binaries/env.
const COCKPIT_TOOLS_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const SECURE_KEY_FILE = 'secure-account-storage.key';
const LEGACY_TOKEN_KEY_FILE = 'account-token.key';

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function isoExpiryFromRecord(raw, token) {
  const numeric = Number(token?.expiry_timestamp ?? raw?.expiry_timestamp);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  const expiresIn = Number(token?.expires_in ?? raw?.expires_in);
  const createdAt = Number(raw?.created_at);
  if (Number.isFinite(expiresIn) && expiresIn > 0 && Number.isFinite(createdAt) && createdAt > 0) {
    const baseMs = createdAt < 10_000_000_000 ? createdAt * 1000 : createdAt;
    return new Date(baseMs + expiresIn * 1000).toISOString();
  }
  const iso = firstString(raw?.expiresAt, raw?.expires_at, token?.expires_at, token?.expiry);
  if (iso) {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return '';
}

function decryptAes256GcmEnvelope(envelope, keyBytes) {
  if (!envelope || typeof envelope !== 'object') throw new Error('加密信封格式无效。');
  if (Number(envelope.version) !== 1) throw new Error('加密信封版本不受支持。');
  if (envelope.algorithm && envelope.algorithm !== 'AES-256-GCM') throw new Error('加密算法不受支持。');
  const nonce = Buffer.from(String(envelope.nonce || '').trim(), 'base64');
  if (nonce.length !== 12) throw new Error('加密信封 nonce 长度无效。');
  const combined = Buffer.from(String(envelope.ciphertext || '').trim(), 'base64');
  if (combined.length < 16) throw new Error('加密信封密文长度无效。');
  const ciphertext = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

function readKeyBytes(keyPath, fsImpl, keyCache) {
  if (keyCache.has(keyPath)) return keyCache.get(keyPath);
  const stat = fsImpl.lstatSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`密钥路径无效: ${keyPath}`);
  const raw = fsImpl.readFileSync(keyPath, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`AES-256 密钥长度无效: ${path.basename(keyPath)}`);
  keyCache.set(keyPath, key);
  return key;
}

/**
 * Resolve existing Cockpit Tools data directories (or an explicit file/directory override).
 */
function cockpitToolsSources({ dataDir = '', homeDir = os.homedir(), env = process.env, fsImpl = fs } = {}) {
  const candidates = dataDir
    ? [String(dataDir).trim()]
    : [
        env.COCKPIT_TOOLS_DATA_DIR,
        path.join(homeDir, '.cockpit_tools'),
        path.join(homeDir, '.antigravity_cockpit')
      ].filter(Boolean);
  const seen = new Set();
  const resolved = [];
  for (const rawPath of candidates) {
    const candidate = path.resolve(rawPath);
    try {
      const stat = fsImpl.lstatSync(candidate);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory() && !(dataDir && stat.isFile())) continue;
      const canonical = fsImpl.realpathSync ? fsImpl.realpathSync(candidate) : candidate;
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ path: canonical, isFile: stat.isFile() });
    } catch { /* ignore absent candidates */ }
  }
  return resolved;
}

function decodeAccountPayload(content, baseDir, { fsImpl, keyCache }) {
  const normalized = String(content || '').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(normalized);
  if (parsed && typeof parsed.ciphertext === 'string' && typeof parsed.nonce === 'string') {
    const key = readKeyBytes(path.join(baseDir, SECURE_KEY_FILE), fsImpl, keyCache);
    return [decryptAes256GcmEnvelope(parsed, key)];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.accounts)) return parsed.accounts;
  if (parsed && typeof parsed === 'object') {
    if (!parsed.token && parsed.token_encrypted && typeof parsed.token_encrypted === 'object') {
      const key = readKeyBytes(path.join(baseDir, LEGACY_TOKEN_KEY_FILE), fsImpl, keyCache);
      parsed.token = decryptAes256GcmEnvelope(parsed.token_encrypted, key);
    }
    return [parsed];
  }
  return [];
}

function toGatewayAccount(raw) {
  if (!raw || typeof raw !== 'object') return { skipReason: 'invalid_record' };
  if (raw.disabled === true) return { skipReason: 'disabled' };
  if (raw.pending_oauth === true) return { skipReason: 'pending_oauth' };
  const token = raw.token && typeof raw.token === 'object' ? raw.token : raw;
  const email = firstString(raw.email, token.email);
  const accessToken = firstString(token.access_token, token.accessToken, raw.access_token, raw.accessToken);
  const refreshToken = firstString(token.refresh_token, token.refreshToken, raw.refresh_token, raw.refreshToken);
  if (!accessToken && !refreshToken) return { skipReason: 'missing_tokens' };
  if (!email) return { skipReason: 'missing_email' };
  const freshRank = Math.max(
    Number(raw.usage_updated_at) || 0,
    Number(raw.last_used) || 0,
    Number(raw.created_at) || 0,
    Number(token.expiry_timestamp) || 0
  );
  return {
    freshRank,
    account: {
      email,
      accessToken,
      refreshToken,
      expiresAt: isoExpiryFromRecord(raw, token),
      projectId: firstString(token.project_id, token.projectId, raw.project_id, raw.projectId),
      clientId: COCKPIT_TOOLS_OAUTH_CLIENT_ID,
      clientSecret: '',
      providerType: 'cloudcode',
      accountType: 'antigravity',
      authMethod: 'consumer',
      source: 'cockpit-tools',
      enabled: true
    }
  };
}

/**
 * Scan Cockpit Tools directories (supporting plaintext, legacy encrypted token, and AES-256-GCM envelopes).
 */
function scanCockpitToolsAccounts({ dataDir = '', homeDir = os.homedir(), env = process.env, fsImpl = fs } = {}) {
  const sources = cockpitToolsSources({ dataDir, homeDir, env, fsImpl });
  const keyCache = new Map();
  const byIdentity = new Map();
  const skipped = { disabled: 0, pendingOauth: 0, missingTokens: 0, missingEmail: 0, invalid: 0 };
  const errors = [];
  let scannedFiles = 0;

  for (const source of sources) {
    const files = [];
    const baseDir = source.isFile ? path.dirname(source.path) : source.path;
    if (source.isFile) {
      files.push(source.path);
    } else {
      const accountsDir = path.join(source.path, 'accounts');
      try {
        const dirStat = fsImpl.lstatSync(accountsDir);
        if (dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
          for (const entry of fsImpl.readdirSync(accountsDir)) {
            if (!entry.endsWith('.json') || entry.endsWith('.json.bak')) continue;
            files.push(path.join(accountsDir, entry));
          }
        }
      } catch { /* directory absent or unreadable */ }
    }

    for (const file of files) {
      scannedFiles += 1;
      try {
        const stat = fsImpl.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const records = decodeAccountPayload(fsImpl.readFileSync(file, 'utf8'), baseDir, { fsImpl, keyCache });
        for (const raw of records) {
          const mapped = toGatewayAccount(raw);
          if (mapped.skipReason) {
            if (mapped.skipReason === 'disabled') skipped.disabled += 1;
            else if (mapped.skipReason === 'pending_oauth') skipped.pendingOauth += 1;
            else if (mapped.skipReason === 'missing_tokens') skipped.missingTokens += 1;
            else if (mapped.skipReason === 'missing_email') skipped.missingEmail += 1;
            else skipped.invalid += 1;
            continue;
          }
          const identity = mapped.account.email.toLowerCase();
          const current = byIdentity.get(identity);
          if (!current || mapped.freshRank > current.freshRank) {
            byIdentity.set(identity, { ...mapped, sourceDir: source.path });
          }
        }
      } catch (error) {
        errors.push({ file: path.basename(file), message: error.message || '读取失败' });
      }
    }
  }

  return {
    scannedDirs: sources.map(item => item.path),
    scannedFiles,
    candidates: [...byIdentity.values()],
    skipped,
    errors
  };
}

function findExistingAccount(existingAccounts, candidate) {
  const email = String(candidate.email || '').toLowerCase();
  return existingAccounts.find(item => item.email && item.email.toLowerCase() === email) || null;
}

/**
 * Preview discovered Cockpit Tools accounts against the current gateway AccountStore without exposing tokens.
 */
function previewCockpitToolsImport({ store, dataDir = '', homeDir = os.homedir(), env = process.env, fsImpl = fs } = {}) {
  const scan = scanCockpitToolsAccounts({ dataDir, homeDir, env, fsImpl });
  const existing = store ? store.list() : [];
  let newCount = 0;
  let updateCount = 0;
  let unchangedCount = 0;
  const accounts = scan.candidates.map(({ account, sourceDir }) => {
    const match = findExistingAccount(existing, account);
    let status = 'new';
    if (match) {
      if (match.refreshToken && account.refreshToken && match.refreshToken === account.refreshToken) {
        status = 'unchanged';
        unchangedCount += 1;
      } else {
        status = 'updatable';
        updateCount += 1;
      }
    } else {
      newCount += 1;
    }
    return {
      email: account.email,
      projectId: account.projectId || '',
      hasRefreshToken: Boolean(account.refreshToken),
      hasAccessToken: Boolean(account.accessToken),
      expiresAt: account.expiresAt || '',
      sourceDir,
      status
    };
  });
  return {
    scannedDirs: scan.scannedDirs,
    scannedFiles: scan.scannedFiles,
    totalFound: accounts.length,
    newCount,
    updateCount,
    unchangedCount,
    skipped: scan.skipped,
    errors: scan.errors,
    accounts
  };
}

/**
 * Import discovered Cockpit Tools accounts into AccountStore and reload the active AccountPool.
 */
function importCockpitToolsAccounts({ store, pool, quotaManager, dataDir = '', overwrite = false, homeDir = os.homedir(), env = process.env, fsImpl = fs, onImported } = {}) {
  if (!store) throw new Error('AccountStore is required');
  const scan = scanCockpitToolsAccounts({ dataDir, homeDir, env, fsImpl });
  const existing = store.list();
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  const savedIds = [];
  const results = [];

  for (const { account } of scan.candidates) {
    const match = findExistingAccount(existing, account);
    if (match) {
      const sameRefresh = Boolean(match.refreshToken && account.refreshToken && match.refreshToken === account.refreshToken);
      if (!overwrite && (sameRefresh || !account.refreshToken)) {
        unchanged += 1;
        results.push({ email: account.email, status: 'unchanged' });
        continue;
      }
      const saved = store.save({
        ...account,
        id: match.id,
        weight: match.weight,
        enabled: match.enabled
      }, { newGrant: true });
      updated += 1;
      savedIds.push(saved.id);
      results.push({ email: saved.email, status: 'updated' });
      continue;
    }
    const saved = store.save(account, { newGrant: true });
    imported += 1;
    savedIds.push(saved.id);
    results.push({ email: saved.email, status: 'imported' });
  }

  if (imported > 0 || updated > 0) {
    if (pool?.reload) pool.reload();
    else if (quotaManager?.refreshAccount) {
      for (const accountId of savedIds) {
        void Promise.resolve().then(() => quotaManager.refreshAccount(accountId, { force: true, summaryOnly: false })).catch(() => {});
      }
    }
    onImported?.();
  }

  return {
    scannedDirs: scan.scannedDirs,
    scannedFiles: scan.scannedFiles,
    totalFound: scan.candidates.length,
    imported,
    updated,
    unchanged,
    skipped: scan.skipped,
    errors: scan.errors,
    accounts: results
  };
}

module.exports = {
  COCKPIT_TOOLS_OAUTH_CLIENT_ID,
  cockpitToolsSources,
  decryptAes256GcmEnvelope,
  importCockpitToolsAccounts,
  previewCockpitToolsImport,
  scanCockpitToolsAccounts,
  toGatewayAccount
};
