'use strict';

const { capturedClaudeClient } = require('./agy-client-compaction');
const { capturedHermesClient } = require('./agy-hermes-profile');

const CODEX_CLIENT_PROFILE = 'codex-exec-0.159.2';

// This is a versioned capability profile, not authentication or permission.
// Unknown clients retain their submitted declarations and existing routing.
function capturedNativeClient(req, normalized) {
  const claude = capturedClaudeClient(req, normalized);
  if (claude) return claude;
  const hermes = capturedHermesClient(normalized);
  if (hermes) return hermes;
  const headers = req?.headers || {};
  return normalized.protocol === 'responses'
    && /^codex_exec\/0\.159\.2(?:\s|$)/.test(headers['user-agent'] || '')
    && headers.originator === 'codex_exec'
    && typeof headers['session-id'] === 'string' && headers['session-id'].trim()
    ? CODEX_CLIENT_PROFILE : '';
}

module.exports = { capturedNativeClient, CODEX_CLIENT_PROFILE };
