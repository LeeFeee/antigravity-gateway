'use strict';

const { capturedClaudeClient } = require('./agy-client-compaction');
const { capturedHermesClient } = require('./agy-hermes-profile');
const { clientRuntime } = require('./client-versions');

const CODEX_CLIENT_PROFILE = 'codex-exec-0.159.2';
const CODEX_167_CLIENT_PROFILE = 'codex-cli-0.167.2';
const CODEX_171_CLIENT_PROFILE = 'codex-cli-0.171.0';
const CLAUDE_304_CLIENT_PROFILE = 'claude-code-2.1.304';
const CLAUDE_284_CLIENT_PROFILE = 'claude-code-2.1.284';

function capturedClaude304Client(req, normalized) {
  if (normalized.protocol !== 'anthropic') return '';
  const ua = req?.headers?.['user-agent'] || '';
  if (!/^claude-cli\/2\.1\.304(?:\s|$)/.test(ua)) return '';
  const sid = req?.headers?.['x-claude-code-session-id'];
  if (typeof sid !== 'string' || !sid.trim()) return '';
  return CLAUDE_304_CLIENT_PROFILE;
}

function capturedClaude284Client(req, normalized) {
  if (normalized.protocol !== 'anthropic') return '';
  const ua = req?.headers?.['user-agent'] || '';
  if (!/^claude-cli\/2\.1\.284(?:\s|\(|$)/.test(ua)) return '';
  const sid = req?.headers?.['x-claude-code-session-id'];
  if (typeof sid !== 'string' || !sid.trim()) return '';
  return CLAUDE_284_CLIENT_PROFILE;
}

// This is a versioned capability profile, not authentication or permission.
// Unknown clients retain their submitted declarations and existing routing.
function capturedNativeClient(req, normalized) {
  const claude304 = capturedClaude304Client(req, normalized);
  if (claude304) return claude304;
  const claude284 = capturedClaude284Client(req, normalized);
  if (claude284) return claude284;
  const claude = capturedClaudeClient(req, normalized);
  if (claude) return claude;
  const hermes = capturedHermesClient(normalized);
  if (hermes) return hermes;
  const headers = req?.headers || {};
  if (normalized.protocol !== 'responses' || typeof headers['session-id'] !== 'string' || !headers['session-id'].trim()) return '';
  const runtime = clientRuntime(req);
  if (runtime?.client !== 'codex') return '';
  if (runtime.entrypoint === 'codex_exec' && runtime.version === '0.159.2') return CODEX_CLIENT_PROFILE;
  // The real CLI launched from Codex Desktop keeps the desktop originator
  // and reports its executable/version in the final UA tuple. Identity edits
  // still require the exact developer-template fingerprint downstream.
  if (runtime.version === '0.167.2') return CODEX_167_CLIENT_PROFILE;
  return runtime.version === '0.171.0' ? CODEX_171_CLIENT_PROFILE : '';
}

module.exports = { capturedNativeClient, CODEX_CLIENT_PROFILE, CODEX_167_CLIENT_PROFILE, CODEX_171_CLIENT_PROFILE, CLAUDE_304_CLIENT_PROFILE, CLAUDE_284_CLIENT_PROFILE };
