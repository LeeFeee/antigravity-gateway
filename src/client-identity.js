'use strict';

const crypto = require('node:crypto');
const { CODEX_164_CLIENT_PROFILE } = require('./agy-client-profile');

// Evidence: tests/fixtures/agent-requests-20261107; these are template matches, not client authentication.
const VERSIONS = Object.freeze({ claude: '2.1.318', hermes: '0.21.7+11153.g2bd378e', pi: '1.5.0', dsh: '0.2.1-rc.2', codex: '0.164.0' });
// Captured independently with and without the gateway model catalog. Header
// version/profile alone is insufficient: require the exact first developer
// template and its intact normalized instruction projection as well.
const CODEX_FALLBACK_LENGTH = 16979;
const CODEX_FALLBACK_HASH = '3b08633fa672906666659d764864dfda1d7af5b5111ea5817c8f46e5de4e1a8d';
const CODEX_IDENTITY = 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. ';
const CODEX_IDENTITY_NOTE = 'Within this context, Codex refers to the open-source agentic coding interface (not the old Codex language model built by OpenAI).\n\n';
const CODEX_NEUTRAL_CATALOG = 'Follow the client instructions and use only client-provided tools when needed.';
const CLAUDE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_TUI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
// Interactive 2.1.318 uses a different entrypoint and identity from `-p`.
// The first 2111 characters of its following framework block were captured
// independently of user rules. Memory, environment and session-specific
// instructions begin after that exact prefix and are never part of this edit.
const CLAUDE_TUI_CORE_LENGTH = 2111;
const CLAUDE_TUI_CORE_HASH = '2fb163696951183b1ef28b34885a5475bc968591c78c24ccb2a85b9de7a27bcd';
const CLAUDE_CLI_BILLING = /^x-anthropic-billing-header: cc_version=2\.1\.318(?:\.[a-z0-9]+)?; cc_entrypoint=cli;$/;
// The same classifier policies were captured from interactive and print mode.
// Keep this broader entrypoint match scoped to classifier source evidence;
// the independent interactive search helper still requires its own CLI match.
const CLAUDE_CLASSIFIER_BILLING = /^x-anthropic-billing-header: cc_version=2\.1\.318(?:\.[a-z0-9]+)?; cc_entrypoint=(?:cli|sdk-cli);$/;
// Exact independent classifier captures; keep private policy text out of fixtures.
// These fingerprints authorize removing only the separate first billing block.
const CLAUDE_CLASSIFIER_POLICIES = Object.freeze({
  severity: Object.freeze({ length: 140015, sha256: '6b3d8f64bbbc091f82dbd59891ed562e9d76fccdc5c7951e1638eb1d488ea6d6' }),
  block: Object.freeze({ length: 140239, sha256: '6013166619a307df2fd9a0c62dfc78fae80611155a9b41d7823d97410712117c' })
});
const LEGACY_CLAUDE_IDENTITY = 'You are an AI coding agent operating behind a protocol-compatible client.';
const CLAUDE_CORE = 'You are an agent working with the user toward their goals, using your own judgment along the way. Use the instructions below and the tools available to you to assist the user.';
const CLAUDE_COMPACT_CORE = 'You are an agent working with the user toward their goals, using your own judgment along the way.';
// Full three-block auxiliary template captured in claude-web-search.json.
// This is not a general replacement for user text mentioning Claude/search.
const CLAUDE_SEARCH_CORE = 'You run a web search for another Claude model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results.';
const NEUTRAL_SEARCH_CORE = 'You run a web search for another model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results.';
const HERMES_IDENTITY = 'You are Hermes Agent, built by Nous Research. ';
const HERMES_INTRO_HASH = '36c1f5a2e92cd1d018311eaf4c8f1e8886672eae78212e033c681d0e3d5d506f';
const HERMES_DOCS = "For help with Hermes Agent itself — configuring, setting up, using, extending, or troubleshooting it — or to understand your own features, tools, or capabilities, the documentation at https://hermes-agent.nousresearch.com/docs is your authoritative reference and always holds the latest, most up-to-date information. The `hermes-agent` skill has the actual commands and proven workflows — load it with skill_view(name='hermes-agent') before configuring, modifying, or troubleshooting Hermes so you don't guess or invent workarounds.";
const HERMES_DOCS_NO_SKILLS = 'For help with Hermes Agent itself — configuring, setting up, using, extending, or troubleshooting it — or to understand your own features, tools, or capabilities, the documentation at https://hermes-agent.nousresearch.com/docs is the authoritative reference and always holds the latest, most up-to-date information. Point the user there (or read it yourself if you have a way to fetch web content).';
const PI_PREAMBLE = 'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.';
const DSH_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.';
const ATTRIBUTION = "Attribution for git commits and pull requests you create from here on (this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder; the user's own instructions about these lines, such as a CLAUDE.md or memory rule, take precedence over this reminder, but do not add attribution lines this reminder leaves out):";
const DEFAULT_ATTRIBUTION = `<system-reminder>\n${ATTRIBUTION}\n- End git commit messages with:\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>\n- End pull request descriptions with:\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n</system-reminder>`;
const COMPACT_ATTRIBUTION = DEFAULT_ATTRIBUTION.replace('Co-Authored-By: Claude Sonnet 4.6', 'Co-Authored-By: Claude Code');
const DEFAULT_MODEL_NOTICE = '<system-reminder>\nYou are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6. Assistant knowledge cutoff is August 2025.\n</system-reminder>';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function quotedAt(text, offset) {
  let fence = '', depth = 0;
  for (const line of text.slice(0, offset).split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = ''; }
    if (!fence) for (const tag of line.matchAll(/<(\/?)(?:quote|quoted_text|user_instructions|soul|agents)(?:\s[^>]*)?>/gi)) {
      depth = Math.max(0, depth + (tag[1] ? -1 : 1));
    }
  }
  return Boolean(fence || depth);
}

function claudeTuiPrefix(text) {
  const leading = text.length - text.trimStart().length;
  const rest = text.slice(leading);
  const billing = rest.match(/^x-anthropic-billing-header: cc_version=2\.1\.318(?:\.[a-z0-9]+)?; cc_entrypoint=cli;\n/);
  if (!billing || !rest.startsWith(CLAUDE_TUI_IDENTITY + '\n', billing[0].length)) return null;
  const end = leading + billing[0].length + CLAUDE_TUI_IDENTITY.length + 1;
  const framework = text.slice(end);
  if (hash(framework.slice(0, CLAUDE_TUI_CORE_LENGTH)) !== CLAUDE_TUI_CORE_HASH
    || !framework.slice(CLAUDE_TUI_CORE_LENGTH).startsWith('\n# Session-specific guidance\n')) return null;
  return { end, billing: true, tui: true };
}

function claudePrefix(text) {
  const tui = claudeTuiPrefix(text);
  if (tui) return tui;
  let rest = text.trimStart();
  const billing = rest.match(/^x-anthropic-billing-header: cc_version=2\.1\.318(?:\.[a-z0-9]+)?; cc_entrypoint=sdk-cli;\s*/);
  if (billing) rest = rest.slice(billing[0].length);
  const identity = [CLAUDE_IDENTITY, LEGACY_CLAUDE_IDENTITY].find(value => rest.startsWith(value));
  if (!identity) return null;
  rest = rest.slice(identity.length).trimStart();
  if (billing && identity === CLAUDE_IDENTITY && rest.startsWith(CLAUDE_SEARCH_CORE)
    && (rest.length === CLAUDE_SEARCH_CORE.length || rest[CLAUDE_SEARCH_CORE.length] === '\n')) {
    return { end: text.length - rest.length, billing: true, searchHelper: true };
  }
  // The same installed 2.1.318 CLI selects this shorter template for a
  // non-Claude model. Verified by actual-cli-real-gateway-synthetic-google-upstream.
  if (billing && rest.startsWith(CLAUDE_COMPACT_CORE + '\n\n')
    && rest.includes('\n# Harness\n - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.')
    && rest.includes('\n - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don\'t retry verbatim.')
    && (rest.includes('\n# Session-specific guidance\n')
      || (rest.includes('\n# Memory\n') && rest.includes('\n# Environment\n')
        && rest.includes('When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue')))
    && rest.includes('\n# Context management\n')) {
    return { end: text.length - rest.length, billing: true, compact: true };
  }
  if (!rest.startsWith(CLAUDE_CORE)
    || !rest.includes('\n# System\n') || !rest.includes('\n# Using your tools\n')
    || !rest.includes('Tools are executed in a user-selected permission mode.')) return null;
  return { end: text.length - rest.length, billing: Boolean(billing) };
}

function detectTemplate(text) {
  if (typeof text !== 'string') return null;
  const claude = claudePrefix(text);
  if (claude) return { client: 'claude', evidence: claude.tui ? 'claude-tui-system-template' : claude.searchHelper ? 'claude-sdk-search-helper-template'
    : claude.compact ? 'claude-sdk-compact-system-template' : 'claude-sdk-system-template' };
  const paragraphs = text.trimStart().split(/\n\s*\n/);
  const hermesDocs = [HERMES_DOCS, HERMES_DOCS_NO_SKILLS].find(value => paragraphs[1] === value);
  const docsAt = hermesDocs ? text.indexOf(hermesDocs) : -1;
  // Hermes adds its enforcement paragraph only for selected model families.
  // The captured Sonnet/file-only template instead has these exact two
  // behavioral paragraphs plus the bounded runtime environment section.
  const hermesWithoutEnforcement = hash(paragraphs[2] || '') === '3baa51af2f4d627c2b1b2cffee38919540472a1215558c88e8616443efb7da1c'
    && hash(paragraphs[3] || '') === 'f47069f4d7c2b7fb68365437cab3225e11ab3fbdf2f6bf42d1f8109d8b61dd30'
    && text.includes('\n# Hermes runtime environment\n') && text.includes('\n<!-- End Hermes runtime environment -->');
  if (docsAt >= 0 && !quotedAt(text, docsAt)
    && paragraphs[2]?.startsWith('# Finishing the job\n')
    && text.includes('\n# Parallel tool calls\n')
    && (text.includes('\n# Tool-use enforcement\n') || hermesWithoutEnforcement)) {
    return { client: 'hermes', evidence: hermesDocs === HERMES_DOCS_NO_SKILLS
      ? 'hermes-instructions-no-skills-template' : 'hermes-instructions-template' };
  }
  if (text.trimStart().startsWith(PI_PREAMBLE + '\n\n<tools>\n')
    && text.includes('\n</tools>\n\n<rules>\n') && text.includes('\n</rules>\n\n<docs>\nPi documentation (')
    && text.includes('\n</docs>\n\n<cwd>\n')) return { client: 'pi', evidence: 'pi-developer-template' };
  if (text.trimStart().startsWith(DSH_IDENTITY + '\n\n')
    && /^You are a coding agent powered by the [A-Za-z0-9._:/\[\]-]{1,160} model\.$/.test(paragraphs[1] || '')
    && paragraphs[2] === 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'
    && paragraphs[3] === 'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.') {
    return { client: 'dsh', evidence: 'dsh-developer-template' };
  }
  return null;
}

function instructionSources(normalized) {
  const sources = [{ location: 'system', text: normalized?.system }];
  for (const [index, message] of (normalized?.messages || []).entries()) {
    if (message?.role === 'system' || message?.role === 'developer') {
      sources.push({ location: `messages.${index}`, text: message.text });
    }
  }
  return sources;
}

function codexTemplate(normalized, { clientProfile } = {}) {
  if (clientProfile !== CODEX_164_CLIENT_PROFILE || normalized?.protocol !== 'responses' || normalized.instructions) return null;
  const first = normalized.instructionMessages?.[0];
  if (first?.role !== 'developer' || typeof first.text !== 'string') return null;
  const projected = normalized.instructionMessages.map(item => item.text).filter(Boolean).join('\n\n');
  if (normalized.system !== projected) return null;
  if (first.text === CODEX_NEUTRAL_CATALOG) return 'codex-neutral-catalog-template';
  if (first.text.length >= CODEX_FALLBACK_LENGTH && hash(first.text.slice(0, CODEX_FALLBACK_LENGTH)) === CODEX_FALLBACK_HASH) {
    return 'codex-cli-fallback-template';
  }
  return null;
}

function anthropicSystemBlockEvidence(blocks) {
  if (!Array.isArray(blocks) || blocks.length !== 3
    || blocks.some(block => block?.type !== 'text' || typeof block.text !== 'string' || !block.text.length)
    || !CLAUDE_CLASSIFIER_BILLING.test(blocks[0].text)) return null;
  // Retain source boundaries without copying any policy or user context. The
  // normalizer creates this field itself; similarly named API input is ignored.
  return Object.freeze({ kind: 'anthropic-system-blocks', blocks: Object.freeze(blocks.map(block => Object.freeze({
    type: 'text', length: block.text.length, sha256: hash(block.text)
  }))) });
}

function anthropicSystemBlocks(normalized) {
  const evidence = normalized.clientSystemProvenance;
  if (evidence?.kind !== 'anthropic-system-blocks' || !Array.isArray(evidence.blocks)
    || evidence.blocks.length !== 3 || typeof normalized.system !== 'string') return null;
  const source = normalized.system, blocks = [];
  let offset = 0;
  for (const [index, block] of evidence.blocks.entries()) {
    if (block?.type !== 'text' || !Number.isSafeInteger(block.length) || block.length <= 0) return null;
    const text = source.slice(offset, offset + block.length);
    if (text.length !== block.length || hash(text) !== block.sha256) return null;
    blocks.push(text); offset += block.length;
    // Anthropic text blocks join with one newline; separate system-role
    // messages, if present, join after that original source with two newlines.
    if (index < 2 && source[offset++] !== '\n') return null;
  }
  if (source.length > offset && !source.startsWith('\n\n', offset)) return null;
  return { blocks, end: offset };
}

function classifierBillingPrefix(normalized) {
  if (normalized?.protocol !== 'anthropic' || !normalized.autoMode || normalized.tools?.length
    || normalized.structuredSchema != null) return null;
  const policy = Object.hasOwn(CLAUDE_CLASSIFIER_POLICIES, normalized.autoModeFormat)
    ? CLAUDE_CLASSIFIER_POLICIES[normalized.autoModeFormat] : null;
  const source = policy && anthropicSystemBlocks(normalized);
  if (!source) return null;
  const { blocks } = source;
  if (!CLAUDE_CLASSIFIER_BILLING.test(blocks[0]) || blocks[1].length !== policy.length
    || hash(blocks[1]) !== policy.sha256) return null;
  return { end: blocks[0].length + 1 };
}

function tuiSearchHelperPrefix(normalized) {
  if (normalized?.protocol !== 'anthropic' || normalized.autoMode || normalized.tools?.length
    || normalized.structuredSchema != null) return null;
  const source = anthropicSystemBlocks(normalized);
  if (!source || !CLAUDE_CLI_BILLING.test(source.blocks[0])
    || source.blocks[1] !== CLAUDE_TUI_IDENTITY || source.blocks[2] !== CLAUDE_SEARCH_CORE) return null;
  return source;
}

function tuiSearchHelperProfile() {
  return { client: 'claude', templateVersion: VERSIONS.claude, evidence: ['claude-tui-search-helper-template'] };
}

function classifierProfile() {
  return { client: 'claude', templateVersion: VERSIONS.claude, evidence: ['claude-auto-mode-system-template'] };
}

function inferClientProfile(normalized, options = {}) {
  if (classifierBillingPrefix(normalized)) return classifierProfile();
  if (tuiSearchHelperPrefix(normalized)) return tuiSearchHelperProfile();
  const found = instructionSources(normalized).map(source => detectTemplate(source.text)).filter(Boolean);
  const codex = codexTemplate(normalized, options);
  if (codex) found.push({ client: 'codex', evidence: codex });
  if (!found.length || new Set(found.map(item => item.client)).size !== 1) return null;
  const client = found[0].client;
  return { client, templateVersion: VERSIONS[client], evidence: [...new Set(found.map(item => item.evidence))] };
}

function cleanInstruction(text, client, record) {
  const template = detectTemplate(text);
  if (template?.client !== client) return text;
  if (client === 'claude') {
    const prefix = claudePrefix(text);
    if (prefix.billing) record('claude-billing-marker');
    record(prefix.tui ? 'claude-tui-identity' : 'claude-sdk-identity');
    const cleaned = text.slice(prefix.end);
    if (prefix.tui) return cleaned;
    if (prefix.searchHelper) {
      record('claude-search-helper-model-identity');
      return NEUTRAL_SEARCH_CORE + cleaned.slice(CLAUDE_SEARCH_CORE.length);
    }
    // Current compact CLI also emits a separate system-role environment block.
    // Match its exact bounded layout; keep every environment and execution rule.
    return cleaned.replace(/(# Environment\nYou have been invoked in the following environment: ?\n(?: - [^\n]+\n)+)(\nYou are powered by the model [A-Za-z0-9._:/-]{1,160}\.\n)(\nToday's date is \d{4}-\d{2}-\d{2}\.\s*)$/, (_match, environment, _identity, date) => {
      record('claude-environment-model-identity');
      return environment + date;
    });
  }
  if (client === 'hermes') {
    const start = text.length - text.trimStart().length;
    const paragraph = text.slice(start).split(/\n\s*\n/, 1)[0];
    if (hash(paragraph) !== HERMES_INTRO_HASH) return text;
    record('hermes-default-identity');
    return text.slice(0, start) + text.slice(start + HERMES_IDENTITY.length);
  }
  if (client === 'pi') {
    record('pi-harness-identity');
    return text.replace(PI_PREAMBLE, 'Help users inspect files, run commands, and modify code.');
  }
  if (client === 'dsh') {
    record('dsh-harness-and-model-identity');
    return text.replace(/^\s*You are an AI agent powered by DeepSeek Harness\.\n\nYou are a coding agent powered by the [A-Za-z0-9._:/\[\]-]{1,160} model\.\n\n/, '');
  }
  return text;
}

const TOOL_RULES = [
  { client: 'claude', name: 'Read', digest: '2f6648f651a01c3853c7bccad2c0b96e86f0e8e47d5218b657154c7fa68756a0', rule: 'claude-read-description',
    edits: [[ '- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.',
      '- This tool allows the assistant to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually.' ]] },
  { client: 'claude', name: 'ListAgents', digest: '398d4802fc2327352ff22bdb927adf533cb667a3a553b152c5efd19b661f7c20', rule: 'claude-list-agents-description',
    edits: [['other local Claude sessions', 'other local client sessions'], ['your Claude sessions', 'your client sessions']] },
  { client: 'hermes', name: 'execute_code', digest: 'dfd068e41bd66a3d5f964ed807857c39b60b76fc4b57acb0714dd1c0fc634943', rule: 'hermes-execute-code-description',
    edits: [['Run Python that calls Hermes tools programmatically.', "Run Python that calls the client's tools programmatically."],
      ["otherwise Hermes's own python (the common case — stdlib plus Hermes's deps;", "otherwise the client's own python (the common case — stdlib plus the client's deps;"]] }
];

function sanitizeToolDescription(tool, profile, record = () => {}) {
  if (typeof tool?.description !== 'string') return tool;
  const rule = TOOL_RULES.find(item => item.client === profile?.client && item.name === tool.name && hash(tool.description) === item.digest);
  if (!rule) return tool;
  let description = tool.description;
  for (const [from, to] of rule.edits) description = description.replace(from, to);
  record(rule.rule);
  return { ...tool, description };
}

function frameworkReminderBundle(message, profile, index) {
  const parts = message.parts;
  // In the captured compact template, the default attribution is the sole
  // leading framework block. Restrict this rule to that exact first-turn layout.
  if (profile?.evidence.includes('claude-sdk-compact-system-template') && index === 0
    && message.role === 'user' && Array.isArray(parts) && parts.length === 2
    && parts[0]?.type === 'text' && parts[0].text?.trim() === COMPACT_ATTRIBUTION
    && parts[1]?.type === 'text' && !parts[1].text.trim().startsWith('<system-reminder>')) return true;
  if (message.role !== 'user' || !Array.isArray(parts) || parts.length < 4) return false;
  const text = parts.filter(part => part?.type === 'text').map(part => part.text);
  return text[0]?.startsWith('<system-reminder>\n# Environment\nYou have been invoked in the following environment:')
    && text.some(value => value.startsWith('<system-reminder>\nThe following deferred tools are now available via ToolSearch.'))
    && text.some(value => value.startsWith('<system-reminder>\nAvailable agent types for the Agent tool:'))
    && text.some(value => value.startsWith('<system-reminder>\nThe following skills are available for use with the Skill tool:'));
}

function transformParts(message, transform) {
  if (!Array.isArray(message.parts)) return message;
  let cursor = 0;
  const edits = [], parts = [];
  for (const [index, part] of message.parts.entries()) {
    if (part?.type !== 'text' || typeof part.text !== 'string') { parts.push(part); continue; }
    const replacement = transform(part.text, index);
    const at = typeof message.text === 'string' ? message.text.indexOf(part.text, cursor) : -1;
    if (at >= 0) cursor = at + part.text.length;
    if (replacement === part.text) { parts.push(part); continue; }
    // A stale/mismatched dual text projection has no reliable replacement boundary.
    if (typeof message.text === 'string' && at < 0) return message;
    if (at >= 0) edits.push({ at, end: at + part.text.length, replacement });
    if (replacement) parts.push({ ...part, text: replacement });
  }
  let text = message.text;
  for (const edit of edits.reverse()) text = text.slice(0, edit.at) + edit.replacement + text.slice(edit.end);
  return { ...message, ...(typeof text === 'string' ? { text } : {}), parts };
}

function transformInstruction(message, client, record) {
  const pending = [], text = cleanInstruction(message.text, client, rule => pending.push(rule));
  if (text === message.text) return message;
  if (!message.parts?.length) { pending.forEach(record); return { ...message, text }; }
  let ranges;
  const prefix = client === 'claude' ? claudePrefix(message.text) : null;
  if (prefix?.searchHelper) {
    const brand = prefix.end + CLAUDE_SEARCH_CORE.indexOf('Claude ');
    ranges = [[0, prefix.end], [brand, brand + 'Claude '.length]];
  } else {
    let start = 0, end = message.text.length, outputEnd = text.length;
    while (start < text.length && message.text[start] === text[start]) start++;
    while (end > start && outputEnd > start && message.text[end - 1] === text[outputEnd - 1]) { end--; outputEnd--; }
    if (outputEnd !== start) return message;
    ranges = [[start, end]];
  }
  let cursor = 0;
  const parts = [];
  for (const part of message.parts) {
    if (part?.type !== 'text') { parts.push(part); continue; }
    const at = message.text.indexOf(part.text, cursor);
    if (at < 0) return message;
    cursor = at + part.text.length;
    let remaining = part.text;
    for (const [start, end] of [...ranges].reverse()) {
      const from = Math.max(start, at), to = Math.min(end, cursor);
      if (from < to) remaining = remaining.slice(0, from - at) + remaining.slice(to - at);
    }
    if (remaining === part.text) parts.push(part);
    else if (remaining) parts.push({ ...part, text: remaining });
  }
  pending.forEach(record);
  return { ...message, text, parts };
}

function sanitizeClientIdentity(normalized, options = {}) {
  const classifier = classifierBillingPrefix(normalized);
  if (classifier) return {
    normalized: { ...normalized, system: normalized.system.slice(classifier.end) },
    metadata: { profile: classifierProfile(), rules: ['claude-classifier-billing-marker'] }
  };
  const searchHelper = tuiSearchHelperPrefix(normalized);
  if (searchHelper) return {
    // Only the three verified source blocks belong to this dedicated helper.
    // Keep additional instructions and every message untouched, including any
    // user-authored copies of the billing/identity phrases.
    normalized: { ...normalized, system: NEUTRAL_SEARCH_CORE + normalized.system.slice(searchHelper.end) },
    metadata: { profile: tuiSearchHelperProfile(),
      rules: ['claude-billing-marker', 'claude-tui-identity', 'claude-search-helper-model-identity'] }
  };
  const profile = inferClientProfile(normalized, options), rules = [];
  const record = rule => { if (!rules.includes(rule)) rules.push(rule); };
  const result = { ...normalized };
  if (profile?.client === 'codex') {
    if (profile.evidence.includes('codex-cli-fallback-template')) {
      const first = normalized.instructionMessages[0];
      const template = first.text.slice(0, CODEX_FALLBACK_LENGTH);
      const text = template.slice(CODEX_IDENTITY.length).replace(CODEX_IDENTITY_NOTE, '') + first.text.slice(CODEX_FALLBACK_LENGTH);
      result.instructionMessages = [{ ...first, text }, ...normalized.instructionMessages.slice(1)];
      result.system = result.instructionMessages.map(item => item.text).filter(Boolean).join('\n\n');
      record('codex-cli-framework-identity');
      record('codex-cli-model-identity-note');
    }
    return { normalized: result, metadata: { profile, rules } };
  }
  if (profile) {
    result.system = cleanInstruction(normalized.system, profile.client, record);
    result.messages = (normalized.messages || []).map((message, index) => {
      if (message.role === 'system' || message.role === 'developer') {
        return transformInstruction(message, profile.client, record);
      }
      if (profile.client !== 'claude' || !frameworkReminderBundle(message, profile, index)) return message;
      // Only the leading framework bundle is eligible; later user quotes stay untouched.
      const counts = new Map(), pending = [];
      for (const part of message.parts) {
        if (part.type !== 'text' || !part.text.trim().startsWith('<system-reminder>')) break;
        counts.set(part.text.trim(), (counts.get(part.text.trim()) || 0) + 1);
      }
      let framework = true;
      const transformed = transformParts(message, text => {
        if (!framework || !text.trim().startsWith('<system-reminder>')) { framework = false; return text; }
        if (counts.get(text.trim()) !== 1) return text;
        if (text.trim() === DEFAULT_MODEL_NOTICE) { pending.push('claude-model-reminder'); return ''; }
        if (text.trim() === DEFAULT_ATTRIBUTION) { pending.push('claude-default-attribution'); return ''; }
        if (text.trim() === COMPACT_ATTRIBUTION && profile.evidence.includes('claude-sdk-compact-system-template')) {
          pending.push('claude-compact-default-attribution'); return '';
        }
        return text;
      });
      if (transformed !== message) pending.forEach(record);
      return transformed;
    });
    if (Array.isArray(normalized.tools)) result.tools = normalized.tools.map(tool => sanitizeToolDescription(tool, profile, record));
  }
  return { normalized: result, metadata: { profile, rules } };
}

module.exports = { inferClientProfile, sanitizeClientIdentity, sanitizeToolDescription, anthropicSystemBlockEvidence };
