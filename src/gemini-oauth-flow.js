'use strict';

const crypto = require('node:crypto');
const { OAuthFlow, callbackInput } = require('./oauth-flow');
const { GEMINI_OAUTH_SCOPES, geminiOAuthClient } = require('./gemini-oauth-profile');

function failure(stage, code, status = 502) {
  return Object.assign(new Error('Gemini 授权未完成，请查看当前阶段后重试。'), { stage, code, status });
}

async function jsonResponse(response, signal, stage) {
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > 1024 * 1024) throw failure(stage, 'gemini_oauth_response_too_large');
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  if (!response.ok) throw failure(stage, 'gemini_oauth_request_failed', response.status);
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure(stage, 'gemini_oauth_response_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(stage, 'gemini_oauth_response_invalid');
  return value;
}

// Reuse only OAuthFlow's local callback listener and active-flow locking.
// Credential discovery, endpoints, scopes, token exchange and initialization
// are independent: no agy/Gemini installation or old account import is used.
class GeminiOAuthFlow extends OAuthFlow {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 5 * 60_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid Gemini OAuth timeout');
    super({ fetchImpl, timeoutMs });
  }

  async _start({ onReady, onCode, onStage, signal } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason || failure('authorization', 'gemini_oauth_cancelled', 499));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(failure('authorization', 'gemini_oauth_timeout', 408)), this.timeoutMs);
    timer.unref?.();
    let callback, active;
    try {
      const state = crypto.randomBytes(24).toString('hex');
      const verifier = crypto.randomBytes(48).toString('base64url');
      callback = await this._callbackServer(state, { requireState: true });
      if (signal?.aborted) abort();
      controller.signal.throwIfAborted();
      const redirectUri = `http://127.0.0.1:${callback.port}/oauth-callback`;
      const client = geminiOAuthClient();
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ access_type: 'offline', client_id: client.clientId,
        response_type: 'code', redirect_uri: redirectUri, scope: GEMINI_OAUTH_SCOPES.join(' '),
        state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', include_granted_scopes: 'false', prompt: 'consent select_account' }).toString();
      let submit;
      const manual = new Promise(resolve => { submit = value => resolve(callbackInput(value)); });
      active = { url: url.href, browserOpened: false, submit, close: callback.close };
      this.active = active;
      onReady?.({ url: url.href, browserOpened: false, submit });
      controller.signal.throwIfAborted();
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      let selected;
      try { selected = await Promise.race([callback.result, manual, aborted]); }
      finally { controller.signal.removeEventListener('abort', rejectAbort); }
      controller.signal.throwIfAborted();
      if (!selected || selected.state !== state) throw failure('authorization', 'gemini_oauth_state_invalid', 400);
      if (selected.error || !selected.code) throw failure('authorization', 'gemini_oauth_not_authorized', 400);
      onCode?.();
      return await this.exchange({ code: selected.code, verifier, redirectUri, client,
        signal: controller.signal, onStage });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback?.close();
      if (this.active === active) this.active = null;
    }
  }

  async exchange({ code, verifier, redirectUri, client, signal, onStage }) {
    await onStage?.({ stage: 'exchanging_code' });
    signal.throwIfAborted();
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret,
        code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    });
    const token = await jsonResponse(response, signal, 'exchanging_code');
    const expires = Number(token.expires_in);
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string'
      || !token.refresh_token || !Number.isFinite(expires) || expires <= 0 || expires > 31 * 86400) {
      throw failure('exchanging_code', 'gemini_oauth_grant_incomplete');
    }
    await onStage?.({ stage: 'verifying_identity' });
    signal.throwIfAborted();
    const identity = await this.fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo?alt=json', {
      signal, headers: { authorization: `Bearer ${token.access_token}` }
    });
    const user = await jsonResponse(identity, signal, 'verifying_identity');
    if (typeof user.id !== 'string' || !user.id || typeof user.email !== 'string' || !user.email
      || user.verified_email !== true) throw failure('verifying_identity', 'gemini_oauth_identity_unverified');
    return { providerType: 'gemini', accountType: 'gemini-app', authMethod: 'gemini-oauth', source: 'dashboard-oauth',
      subjectId: user.id, email: user.email, ...client,
      accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + expires * 1000).toISOString(), enabled: false,
      // OAuth alone never makes an account eligible for inference. Dashboard
      // initialization must verify terms/preferences/catalog and actual usage.
      providerMetadata: { oauthRequestedScopes: [...GEMINI_OAUTH_SCOPES],
        oauthGrantedScopes: typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [],
        authorizationCompletedAt: new Date().toISOString(), initialization: { stage: 'authorized', complete: false } } };
  }
}

module.exports = { GeminiOAuthFlow };
