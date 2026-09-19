'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function accountId(record) {
  const stable = firstString(record?.id, record?.subjectId, record?.subject_id, record?.email, record?.refreshToken, record?.refresh_token, record?.projectId, record?.project_id);
  return record?.id || `account-${crypto.createHash('sha256').update(stable || crypto.randomUUID()).digest('hex').slice(0, 16)}`;
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const accessToken = firstString(raw.accessToken, raw.access_token);
  const refreshToken = firstString(raw.refreshToken, raw.refresh_token);
  if (!accessToken && !refreshToken) return null;
  const expirySource = raw.expiresAt ?? raw.expiry ?? raw.expires_at;
  const expiry = expirySource ? new Date(expirySource) : null;
  const expiresAt = expiry && !Number.isNaN(expiry.valueOf()) ? expiry.toISOString() : '';
  const now = new Date().toISOString();
  return {
    id: accountId(raw),
    subjectId: firstString(raw.subjectId, raw.subject_id),
    email: firstString(raw.email),
    accessToken,
    refreshToken,
    expiresAt,
    projectId: firstString(raw.projectId, raw.project_id),
    authMethod: firstString(raw.authMethod, raw.auth_method) || 'consumer',
    source: firstString(raw.source),
    enabled: raw.enabled !== false,
    weight: Math.max(1, Number(raw.weight) || 1),
    createdAt: firstString(raw.createdAt) || now,
    updatedAt: firstString(raw.updatedAt) || now,
    lastSuccessAt: firstString(raw.lastSuccessAt),
    lastFailureAt: firstString(raw.lastFailureAt),
    lastError: firstString(raw.lastError)
  };
}

function safeName(account) {
  const email = String(account.email || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${email || account.id}.json`;
}

class AccountStore {
  constructor({ configDir, fsImpl = fs } = {}) {
    if (!configDir) throw new Error('AccountStore requires configDir');
    this.fs = fsImpl;
    this.directory = path.join(configDir, 'accounts');
  }

  ensureDirectory() {
    // Deliberately use the operating system's normal user defaults. The
    // gateway is a local tool and does not install an encryption/ACL layer.
    this.fs.mkdirSync(this.directory, { recursive: true });
  }

  list() {
    this.ensureDirectory();
    const accounts = [];
    for (const name of this.fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const account = normalizeAccount(JSON.parse(this.fs.readFileSync(path.join(this.directory, name), 'utf8')));
        if (account) accounts.push(account);
      } catch {
        // One broken account file must not prevent other accounts from loading.
      }
    }
    return accounts.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  save(value) {
    const account = normalizeAccount({ ...value, updatedAt: new Date().toISOString() });
    if (!account) throw new Error('账号凭据缺少 access token 和 refresh token。');
    this.ensureDirectory();
    const target = path.join(this.directory, safeName(account));
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.fs.writeFileSync(temporary, `${JSON.stringify(account, null, 2)}\n`);
    this.fs.renameSync(temporary, target);
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

  update(id, updates) {
    const current = this.list().find((account) => account.id === id);
    if (!current) throw new Error(`找不到账号: ${id}`);
    return this.save({ ...current, ...updates, id: current.id, createdAt: current.createdAt });
  }
}

module.exports = { AccountStore, accountId, normalizeAccount };
