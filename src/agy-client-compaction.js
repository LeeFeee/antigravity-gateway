'use strict';

const crypto = require('node:crypto');

const CLAUDE_COMPACTION_PROFILE = 'claude-code-2.1.285';
// Captured from the installed CLI's actual automatic-compaction request.
// Match the complete instruction, not words such as "summarize" in user text.
// Unknown versions/customized instructions retain the existing agent route.
const CAPTURED_PROMPT_SHA256 = '63e2bfb4ded280d5057a66d8a034ef352a73960d97d955b990e78f04f0db1fb0';
const SUMMARY_PREFIX = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n';
const SUMMARY_FOOTER = 'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';

function capturedClaudeClient(req, normalized) {
  if (normalized.protocol !== 'anthropic') return '';
  if (!/^claude-cli\/2\.1\.285(?:\s|$)/.test(req?.headers?.['user-agent'] || '')) return '';
  if (typeof req?.headers?.['x-claude-code-session-id'] !== 'string'
      || !req.headers['x-claude-code-session-id'].trim()) return '';
  return CLAUDE_COMPACTION_PROFILE;
}

function detectNativeCompaction(req, normalized, promptHash = CAPTURED_PROMPT_SHA256) {
  if (!capturedClaudeClient(req, normalized)) return '';
  const last = normalized.messages?.at(-1);
  if (last?.role !== 'user') return '';
  const parts = last.parts || [];
  if (parts.at(-1)?.type !== 'text' || parts.filter(p => p.type === 'text').length !== 1
      || parts.some(p => !['text', 'tool_result'].includes(p.type))) return '';
  const text = parts.at(-1).text;
  if (typeof text !== 'string') return '';
  return crypto.createHash('sha256').update(text).digest('hex') === promptHash ? CLAUDE_COMPACTION_PROFILE : '';
}

function capturedSummaryReplacement(content, pending) {
  if (pending?.profile !== CLAUDE_COMPACTION_PROFILE || content.role !== 'user'
      || content.parts?.length !== 1 || typeof content.parts[0].text !== 'string') return false;
  // Preserve the client's complete summary, transcript reference and resume
  // instructions. Do not parse/reconstruct its generated summary body.
  const text = content.parts[0].text;
  return ['Summary:\n', '- Summary:\n'].some(label => text.startsWith(SUMMARY_PREFIX + label)) && text.endsWith(SUMMARY_FOOTER)
    && text.includes('\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ');
}

module.exports = { CLAUDE_COMPACTION_PROFILE, capturedClaudeClient, detectNativeCompaction, capturedSummaryReplacement };
