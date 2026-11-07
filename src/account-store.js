'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AccountStoragePermissions } = require('./account-storage-permissions');

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function accountId(record) {
  const stable = firstString(record?.id, record?.subjectId, record?.subject_id, record?.email, record?.refreshToken, record?.refresh_token, record?.projectId, record?.project_id);
  const providerType = firstString(record?.providerType, record?.provider_type);
  // Older imported JSON could contain arbitrary type labels which were
  // previously ignored. Only the new, known Robin provider gets a namespace;
  // legacy Antigravity account IDs and their persisted affinity stay stable.
  const namespace = providerType === 'robin'
    ? (record.authMethod === 'gemini-windows-session' ? 'gemini-win:' : 'robin:') : '';
  return record?.id || `account-${crypto.createHash('sha256').update(`${namespace}${stable || crypto.randomUUID()}`).digest('hex').slice(0, 16)}`;
}

function accountGrantGeneration(account = {}) {
  if (account.grantGeneration) return String(account.grantGeneration);
  // Legacy records get a deterministic identity until their next atomic save.
  return `legacy:${crypto.createHash('sha256').update(JSON.stringify([
    account.id, account.subjectId, account.email, account.refreshToken || account.accessToken,
    account.clientId, account.clientSecret, account.projectId, account.authMethod
  ])).digest('hex')}`;
}

function credentialFingerprint(account = {}) {
  return JSON.stringify(['subjectId', 'email', 'accessToken', 'refreshToken', 'clientId',
    'clientSecret', 'projectId', 'authMethod'].map(key => account[key] || ''));
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const accessToken = firstString(raw.accessToken, raw.access_token);
  const refreshToken = firstString(raw.refreshToken, raw.refresh_token);
  const windowsSession = raw.providerType === 'robin' && raw.accountType === 'gemini-app'
    && raw.authMethod === 'gemini-windows-session' && Array.isArray(raw.providerMetadata?.geminiWindows?.cookies)
    && raw.providerMetadata.geminiWindows.cookies.length > 0 && raw.subjectId && raw.email;
  if (!accessToken && !refreshToken && !windowsSession) return null;
  const expirySource = raw.expiresAt ?? raw.expiry ?? raw.expires_at;
  const expiry = expirySource ? new Date(expirySource) : null;
  const expiresAt = expiry && !Number.isNaN(expiry.valueOf()) ? expiry.toISOString() : '';
  const now = new Date().toISOString();
  return {
    id: accountId(raw),
    grantGeneration: firstString(raw.grantGeneration),
    providerType: firstString(raw.providerType, raw.provider_type) || 'cloudcode',
    accountType: firstString(raw.accountType, raw.account_type) || 'antigravity',
    subjectId: firstString(raw.subjectId, raw.subject_id),
    email: firstString(raw.email),
    accessToken,
    refreshToken,
    expiresAt,
    projectId: firstString(raw.projectId, raw.project_id),
    clientId: firstString(raw.clientId, raw.client_id),
    clientSecret: firstString(raw.clientSecret, raw.client_secret),
    authMethod: firstString(raw.authMethod, raw.auth_method) || 'consumer',
    source: firstString(raw.source),
    enabled: raw.enabled !== false,
    weight: Math.max(1, Number(raw.weight) || 1),
    createdAt: firstString(raw.createdAt) || now,
    updatedAt: firstString(raw.updatedAt) || now,
    lastSuccessAt: firstString(raw.lastSuccessAt),
    lastFailureAt: firstString(raw.lastFailureAt),
    lastError: firstString(raw.lastError),
    planName: firstString(raw.planName, raw.plan_name),
    modeVariantId: firstString(raw.modeVariantId, raw.mode_variant_id),
    routingVariantId: firstString(raw.routingVariantId, raw.routing_variant_id),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String).filter(Boolean) : [],
    providerMetadata: raw.providerMetadata && typeof raw.providerMetadata === 'object'
      ? raw.providerMetadata
      : {}
  };
}

function safeName(account) {
  const email = String(account.email || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${email || account.id}.json`;
}

class AccountStore {
  constructor({ configDir, fsImpl = fs, directoryName = 'accounts', platform = process.platform, permissions } = {}) {
    if (!configDir) throw new Error('AccountStore requires configDir');
    this.fs = fsImpl;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(directoryName)) throw new Error('AccountStore directoryName is invalid');
    this.directory = path.join(configDir, directoryName);
    this.permissions = permissions || new AccountStoragePermissions({ fsImpl, platform });
  }

  ensureDirectory() {
    this.fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.permissions.directory(this.directory);
  }

  list() {
    this.ensureDirectory();
    const accounts = [];
    for (const name of this.fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.directory, name);
      // Permission failures must be visible instead of silently accepting a
      // credential file whose privacy cannot be established.
      this.permissions.file(file);
      try {
        const account = normalizeAccount(JSON.parse(this.fs.readFileSync(file, 'utf8')));
        if (account) accounts.push(account);
      } catch {
        // One broken account file must not prevent other accounts from loading.
      }
    }
    return accounts.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  save(value, { newGrant = false, expectedGrant = '' } = {}) {
    let account = normalizeAccount({ ...value, updatedAt: new Date().toISOString() });
    if (!account) throw new Error('账号凭据缺少 access token 和 refresh token。');
    const existing = this.list().find(current => current.id === account.id
      || (account.subjectId && current.subjectId === account.subjectId)
      || (account.email && current.email.toLowerCase() === account.email.toLowerCase()));
    if (expectedGrant && (!existing || accountGrantGeneration(existing) !== expectedGrant)) return null;
    const sameCredentials = existing && credentialFingerprint(existing) === credentialFingerprint(account);
    // Normal refresh uses the CAS path. Any other credential replacement,
    // including an explicit reauthorization returning identical tokens, starts
    // a fresh generation that old asynchronous work cannot modify.
    account.grantGeneration = existing && !newGrant && (expectedGrant || sameCredentials)
      ? accountGrantGeneration(existing) : crypto.randomUUID();
    if (existing) { account.id = existing.id; account.createdAt = existing.createdAt; }
    const target = path.join(this.directory, safeName(account));
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      this.fs.writeFileSync(temporary, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      this.permissions.file(temporary);
      this.fs.renameSync(temporary, target);
      this.permissions.file(target);
    } finally {
      try { this.fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // If the account email became known after the first save, remove a stale
    // ID-named duplicate while leaving unrelated files untouched.
    for (const name of this.fs.readdirSync(this.directory)) {
      const file = path.join(this.directory, name);
      if (file === target || !name.endsWith('.json')) continue;
      try {
        const other = normalizeAccount(JSON.parse(this.fs.readFileSync(file, 'utf8')));
        const sameSubject = account.subjectId && other?.subjectId === account.subjectId;
        const sameEmail = account.email && other?.email && other.email.toLowerCase() === account.email.toLowerCase();
        if (other?.id === account.id || sameSubject || sameEmail) this.fs.unlinkSync(file);
      } catch { /* preserve unreadable user files */ }
    }
    return account;
  }

  updateCredentials(expected, updates) {
    const generation = accountGrantGeneration(expected);
    const current = this.list().find(account => account.id === expected.id);
    if (!current || accountGrantGeneration(current) !== generation) return null;
    const tokens = {};
    for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'projectId', 'authMethod']) {
      if (Object.hasOwn(updates, key)) tokens[key] = updates[key];
    }
    // No await between compare and atomic replace: concurrent operations in the
    // gateway cannot replace a newer grant or revert enabled/weight metadata.
    return this.save({ ...current, ...tokens }, { expectedGrant: generation });
  }

  update(id, updates) {
    const current = this.list().find((account) => account.id === id);
    if (!current) throw new Error(`找不到账号: ${id}`);
    return this.save({ ...current, ...updates, id: current.id, createdAt: current.createdAt });
  }

  delete(id) {
    this.ensureDirectory();
    let removed = null;
    for (const name of this.fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.directory, name);
      let account;
      try {
        account = normalizeAccount(JSON.parse(this.fs.readFileSync(file, 'utf8')));
      } catch {
        // Never delete an unreadable or unrelated user file based only on its
        // filename. Account deletion is matched against the stored account ID.
        continue;
      }
      if (account?.id !== id) continue;
      this.fs.unlinkSync(file);
      removed ||= account;
    }
    return removed;
  }
}

module.exports = { AccountStore, accountId, normalizeAccount, accountGrantGeneration };
