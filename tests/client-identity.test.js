'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { inferClientProfile, sanitizeClientIdentity, sanitizeToolDescription } = require('../src/client-identity');

const fixtures = path.join(__dirname, 'fixtures/agent-requests-20261107');
const interactiveClaude = require('./fixtures/claude-tui-2.1.318-framework.json');

function interactiveClaudeSystem() {
  return [interactiveClaude.billingTemplate, interactiveClaude.identity,
    interactiveClaude.corePrefix + '\n# Session-specific guidance\n - Keep every client permission rule.\n'
      + '\n# Memory\nUser-authored SOUL: keep my chosen Claude persona.\n'
      + '\n# Environment\n - Working directory: /synthetic/project\n'
      + '\n# Context management\nKeep the actual client context-management instructions.'];
}

test('actual interactive Claude template removes only its separate billing and CLI identity blocks', () => {
  const blocks = interactiveClaudeSystem();
  const hookContext = 'SessionStart hook additional context: User-owned plugin rules must remain byte-for-byte.';
  const normalized = normalizeAnthropic({ model: 'gemini-3.8-flash-high',
    system: blocks.map(text => ({ type: 'text', text })),
    tools: [{ name: 'owned_tool', description: 'User-defined Claude Code business tool.', input_schema: { type: 'object' } }],
    messages: [{ role: 'system', content: hookContext },
      { role: 'user', content: 'User rule: preserve my SOUL and project instructions.' }] });
  const original = structuredClone(normalized);
  const cleaned = sanitizeClientIdentity(freeze(normalized));
  assert.deepEqual(cleaned.metadata.profile, { client: 'claude', templateVersion: '2.1.318', evidence: ['claude-tui-system-template'] });
  assert.deepEqual(cleaned.metadata.rules, ['claude-billing-marker', 'claude-tui-identity']);
  assert.equal(cleaned.normalized.system, blocks[2] + '\n\n' + hookContext);
  assert.deepEqual(cleaned.normalized.messages, original.messages);
  assert.deepEqual(cleaned.normalized.tools, original.tools);
  assert.deepEqual(normalized, original);
  assert.deepEqual(sanitizeClientIdentity(cleaned.normalized).normalized, cleaned.normalized);
});

test('interactive cleanup preserves all user rules, literal quotations, arguments and tool results', () => {
  const blocks = interactiveClaudeSystem(), template = blocks.join('\n');
  const userTail = '\n\n# SOUL.md\n' + interactiveClaude.identity + '\n# AGENTS.md\nAsk before execution.\n<quote>\n' + template + '\n</quote>';
  const userMessage = { role: 'user', text: template, parts: [{ type: 'text', text: template }] };
  const source = { protocol: 'anthropic', system: template + userTail, tools: [], messages: [userMessage,
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'owned-call', name: 'owned', arguments: { text: template } }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'owned-call', name: 'owned', content: template }] }] };
  const cleaned = sanitizeClientIdentity(freeze(source));
  assert.equal(cleaned.normalized.system, blocks[2] + userTail);
  assert.deepEqual(cleaned.normalized.messages, source.messages);
  assert.equal(cleaned.normalized.system.split(interactiveClaude.identity).length - 1, 2);
});

test('unknown interactive versions, edited framework prefixes and quoted identities remain untouched', () => {
  const blocks = interactiveClaudeSystem(), template = blocks.join('\n');
  for (const system of [template.replace('2.1.318', '2.1.319'), template.replace('cc_entrypoint=cli;', 'cc_entrypoint=sdk-cli;'),
    template.replace(interactiveClaude.identity, interactiveClaude.identity + ' User custom identity.'),
    template.replace('using your own judgment', 'using my custom judgment'),
    template.replace('\n# Session-specific guidance\n', '\n# User-defined guidance\n'),
    blocks.slice(1).join('\n'), blocks.slice(0, 2).join('\n'),
    '# SOUL.md\n' + template, '<quote>\n' + template + '\n</quote>', '```text\n' + template + '\n```']) {
    const source = { protocol: 'anthropic', system, messages: [], tools: [] };
    assert.equal(inferClientProfile(source), null);
    assert.deepEqual(sanitizeClientIdentity(source).normalized, source);
  }
});
function fixture(name, { rawClaudeSystem = false } = {}) {
  const record = JSON.parse(fs.readFileSync(path.join(fixtures, name + '.json'), 'utf8'));
  const capture = record.captures.find(item => /^\/v1\/(?:messages|responses)(?:\?|$)/.test(item.path)
    && item.body && typeof item.body === 'object');
  assert.ok(capture, name);
  const normalized = capture.path.startsWith('/v1/messages') ? normalizeAnthropic(capture.body) : normalizeResponses(capture.body);
  if (rawClaudeSystem && Array.isArray(capture.body.system)) normalized.system = capture.body.system.map(part => part.text).join('\n');
  return { record, capture, normalized };
}
function instructionText(normalized) {
  return [normalized.system, ...normalized.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => message.text)].join('\n');
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

const capturedFiles = fs.readdirSync(fixtures).filter(name => name.endsWith('.json')).filter(name => {
  const record = JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
  return record.captures.some(item => /^\/v1\/(?:messages|responses)(?:\?|$)/.test(item.path)
    && item.body && typeof item.body === 'object');
});
for (const file of capturedFiles) {
  test(`captured ${file}: framework identity is removed without mutating caller contracts`, () => {
    const { normalized, record } = fixture(file.slice(0, -5), { rawClaudeSystem: true });
    const original = JSON.stringify(normalized), input = freeze(normalized);
    const { normalized: clean, metadata } = sanitizeClientIdentity(input);
    assert.notEqual(clean, input);
    assert.equal(metadata.profile.client, record.agent);
    assert.equal(JSON.stringify(input), original);
    assert.equal(Object.hasOwn(clean, 'metadata'), false);
    assert.equal(Object.hasOwn(clean, 'clientIdentity'), false);
    assert.deepEqual(clean.tools.map(({ description, ...tool }) => tool), input.tools.map(({ description, ...tool }) => tool));
    const instructions = instructionText(clean);
    assert.doesNotMatch(instructions, /You are a Claude agent, built on Anthropic's Claude Agent SDK\.|x-anthropic-billing-header:/);
    assert.doesNotMatch(instructions, /You are Hermes Agent, built by Nous Research\.|You are a coding assistant running inside pi, a coding agent harness\.|You are an AI agent powered by DeepSeek Harness\./);
    assert.doesNotMatch(instructions, /You are (?:Google|Antigravity)/);
    if (record.agent === 'hermes' && record.scenario !== 'identity') {
      assert.match(instructions, /PROBE_USER_SOUL: You are a fixture assistant\. Preserve this user-authored identity\./);
    }
    if (record.agent === 'claude') {
      assert.match(instructions, /Tools are executed in a user-selected permission mode\./);
      assert.match(instructions, /If the user denies a tool you call, do not re-attempt the exact same tool call\./);
      const user = clean.messages.find(message => message.role === 'user');
      assert.doesNotMatch(user.text, /Co-Authored-By: Claude Sonnet|Generated with \[Claude Code\]|You are powered by the model named Sonnet/);
      assert.ok(metadata.rules.includes('claude-default-attribution'));
      for (const part of input.messages[0].parts) {
        if (part.type === 'text' && !/^(?:<system-reminder>\nAttribution|<system-reminder>\nYou are powered by)/.test(part.text)) {
          assert.ok(user.parts.some(candidate => candidate.text === part.text), 'nonidentity framework and user content retained');
        }
      }
    }
    assert.deepEqual(sanitizeClientIdentity(clean).normalized, clean, 'sanitization is idempotent');
  });
}

test('Hermes identity removal keeps the entire behavioral remainder in its mixed opening paragraph', () => {
  const { normalized } = fixture('hermes-identity');
  const clean = sanitizeClientIdentity(normalized).normalized;
  assert.equal(clean.system, normalized.system.replace('You are Hermes Agent, built by Nous Research. ', ''));
  assert.match(clean.system, /Be direct: match the length/);
  assert.match(clean.system, /Do not modify another profile's skills\/plugins\/cron\/memories unless the user explicitly directs you to\./);
});

test('captured Hermes no-skills template preserves SOUL and does not invent skill_view guidance', () => {
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/agent-compaction-20261107/verified/hermes-compact.json'), 'utf8'));
  const capture = record.captures.find(item => item.path === '/v1/responses' && item.body?.tools?.length);
  const normalized = normalizeResponses(capture.body), original = structuredClone(normalized);
  const cleaned = sanitizeClientIdentity(normalized);
  assert.equal(cleaned.metadata.profile.client, 'hermes');
  assert.ok(cleaned.metadata.profile.evidence.includes('hermes-instructions-no-skills-template'));
  assert.match(cleaned.normalized.system, /^PROBE_USER_SOUL:/);
  assert.deepEqual(normalized, original);
  assert.deepEqual(cleaned.normalized.tools.map(tool => tool.name), original.tools.map(tool => tool.name));
  assert.doesNotMatch(cleaned.normalized.system, /load it with skill_view/);
  const defaultIntro = fixture('hermes-identity').normalized.system.split(/\n\s*\n/, 1)[0];
  const withDefault = { ...normalized, system: defaultIntro + normalized.system.slice(normalized.system.indexOf('\n\n')) };
  assert.equal(sanitizeClientIdentity(withDefault).normalized.system,
    withDefault.system.replace('You are Hermes Agent, built by Nous Research. ', ''));
  const changed = { ...withDefault, system: withDefault.system.replace('Point the user there', 'Use my custom documentation') };
  assert.equal(inferClientProfile(changed), null);
  assert.equal(sanitizeClientIdentity(changed).normalized.system, changed.system);
});

for (const [agent, scenario] of [['claude', 'write'], ['claude', 'edit'], ['pi', 'write']]) {
  test(`真实受限工具模板 ${agent}/${scenario} 保留执行约束并清理框架身份`, () => {
    const record = JSON.parse(fs.readFileSync(path.join(__dirname, `fixtures/client-tool-execution-20261107/initial/${agent}-${scenario}.json`), 'utf8'));
    const body = record.clientHTTP.find(item => item.body?.tools?.length).body;
    const normalized = agent === 'claude' ? normalizeAnthropic(body) : normalizeResponses(body);
    const before = structuredClone(normalized), cleaned = sanitizeClientIdentity(normalized);
    assert.equal(cleaned.metadata.profile.client, agent);
    assert.deepEqual(normalized, before);
    assert.deepEqual(cleaned.normalized.tools.map(tool => tool.name), before.tools.map(tool => tool.name));
    assert.deepEqual(cleaned.normalized.messages, before.messages);
    if (agent === 'claude') {
      assert.doesNotMatch(cleaned.normalized.system, /x-anthropic-billing-header|You are a Claude agent|You are powered by the model gemini/);
      assert.match(cleaned.normalized.system, /Tools run behind a user-selected permission mode/);
      assert.match(cleaned.normalized.system, /Run any Python that reads them with `-I`/);
      assert.match(cleaned.normalized.system, /Today's date is/);
    } else {
      assert.doesNotMatch(cleaned.normalized.system, /running inside pi, a coding agent harness/);
      assert.match(cleaned.normalized.system, /Use write only for new files or complete rewrites/);
    }
  });
}

test('Pi and dsh keep exact tool guidance, environment paths and execution constraints', () => {
  for (const client of ['pi', 'dsh']) {
    const { normalized } = fixture(client + '-first');
    const clean = sanitizeClientIdentity(normalized).normalized;
    const before = instructionText(normalized), after = instructionText(clean);
    if (client === 'pi') {
      assert.equal(after, before.replace('You are a coding assistant running inside pi, a coding agent harness. ', ''));
      assert.match(after, /PI_\*/);
      assert.match(after, /@earendil-works\/pi-coding-agent/);
      assert.match(after, /Each edits\[\]\.oldText must exactly and uniquely match/);
    } else {
      assert.equal(after, before.replace('You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the gemini-3.8-flash-high model.\n\n', ''));
      assert.match(after, /default fs-observation-policy requires it/);
      assert.match(after, /Use the workflow tool ONLY when the user explicitly asks/);
    }
  }
});

test('user identities, project instructions, arguments and tool results are not global replacement targets', () => {
  const { normalized } = fixture('hermes-first');
  const text = "# SOUL.md\nYou are Hermes Agent, built by Nous Research. This is my chosen persona.\n# AGENTS.md\nAsk before pushing. Analyze Claude Code, Pi and DeepSeek Harness.";
  normalized.system = text + normalized.system.slice(normalized.system.indexOf('\n\n'));
  const messages = [
    { role: 'user', text, parts: [{ type: 'text', text }] },
    { role: 'assistant', text, parts: [{ type: 'tool_call', name: 'terminal', arguments: { command: 'echo "Hermes"' }, id: 'a' }] },
    { role: 'user', text, parts: [{ type: 'tool_result', id: 'a', content: text }] }
  ];
  normalized.messages.push(...messages);
  const clean = sanitizeClientIdentity(normalized).normalized;
  assert.equal(clean.system, normalized.system);
  assert.deepEqual(clean.messages.slice(-3), messages);
});

test('unknown, quoted and template-mismatched identity text is preserved even when it names a known agent', () => {
  const { normalized: pi } = fixture('pi-first');
  const piText = instructionText(pi).trim();
  for (const system of [
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.\nCustom user policy.",
    'Review this example:\n```text\n' + piText + '\n```',
    '<quote>\n' + piText + '\n</quote>',
    piText.replace('<rules>', '<custom_rules>'),
    'You are an AI agent powered by DeepSeek Harness.\n\nUser-defined instructions.'
  ]) {
    const input = { system, messages: [], tools: [] };
    assert.equal(inferClientProfile(input), null);
    assert.deepEqual(sanitizeClientIdentity(input).normalized, input);
  }
});

test('Claude attribution is cleaned only inside the captured leading framework bundle', () => {
  const { normalized } = fixture('claude-first', { rawClaudeSystem: true });
  const attribution = normalized.messages[0].parts.find(part => part.text?.includes('Attribution for git commits')).text;
  const ordinary = { role: 'user', text: attribution, parts: [{ type: 'text', text: attribution }] };
  normalized.messages.push(ordinary, { role: 'user', text: 'Quote this:\n' + attribution, parts: [{ type: 'text', text: 'Quote this:\n' + attribution }] });
  const userQuote = { type: 'text', text: attribution };
  normalized.messages[0].parts.push(userQuote);
  normalized.messages[0].text += '\n' + attribution;
  const { normalized: clean } = sanitizeClientIdentity(normalized);
  assert.equal(clean.messages[0].parts.at(-1), userQuote, 'same literal quote after the user prompt is untouched');
  assert.deepEqual(clean.messages.slice(-2), normalized.messages.slice(-2));
  assert.equal(clean.messages[0].text.split(attribution).length - 1, 1, 'only the actual framework copy is removed');
});

test('user-configured attribution and a modified framework notice are preserved', () => {
  for (const replacement of ['Co-Authored-By: User Name <user@example.com>', 'Co-Authored-By: Claude Sonnet 4.6 <custom@example.com>']) {
    const { normalized } = fixture('claude-first', { rawClaudeSystem: true });
    const message = normalized.messages[0], part = message.parts.find(value => value.text?.includes('Attribution for git commits'));
    const before = part.text;
    part.text = before.replace('Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>', replacement);
    message.text = message.text.replace(before, part.text);
    const clean = sanitizeClientIdentity(normalized).normalized;
    assert.ok(clean.messages[0].parts.some(value => value.text === part.text));
    assert.ok(clean.messages[0].text.includes(replacement));
  }
});

test('known description edits preserve schema, callable identifiers, imports and permissions; modified tools remain intact', () => {
  const claude = fixture('claude-first', { rawClaudeSystem: true }).normalized;
  const profile = inferClientProfile(claude), read = claude.tools.find(tool => tool.name === 'Read');
  const clean = sanitizeToolDescription(read, profile);
  assert.doesNotMatch(clean.description, /Claude Code/);
  assert.match(clean.description, /contents are presented visually/);
  assert.match(clean.description, /file_path parameter must be an absolute path/);
  assert.equal(clean.schema, read.schema);
  for (const custom of [{ ...read, description: read.description + '\nUser-specific policy.' }, { ...read, name: 'user_Read' }]) {
    assert.equal(sanitizeToolDescription(custom, profile), custom);
  }
  const hermes = fixture('hermes-first').normalized, original = hermes.tools.find(tool => tool.name === 'execute_code');
  const code = sanitizeToolDescription(original, inferClientProfile(hermes));
  assert.match(code.description, /from hermes_tools import/);
  assert.match(code.description, /VIRTUAL_ENV\/CONDA_PREFIX/);
  assert.doesNotMatch(code.description, /Run Python that calls Hermes tools|Hermes's own python/);
  assert.equal(code.schema, original.schema);
});

test('legacy normalized Claude identity is recognized without rewriting its behavioral system text', () => {
  const { normalized } = fixture('claude-first');
  assert.equal(inferClientProfile(normalized).client, 'claude');
  const clean = sanitizeClientIdentity(normalized).normalized;
  assert.doesNotMatch(clean.system, /You are an AI coding agent operating behind a protocol-compatible client/);
  assert.match(clean.system, /# Executing actions with care/);
});

test('separate developer text blocks preserve boundaries while removing the verified preamble', () => {
  const { normalized } = fixture('pi-first');
  const message = { role: 'developer', text: normalized.system };
  normalized.system = '';
  normalized.messages.unshift(message);
  const split = message.text.indexOf('\n\n');
  message.parts = [{ type: 'text', text: message.text.slice(0, split) }, { type: 'text', text: message.text.slice(split + 2) }];
  const remainder = message.parts[1];
  const clean = sanitizeClientIdentity(normalized).normalized.messages.find(item => item.role === 'developer');
  assert.equal(clean.parts[0].text, 'Help users inspect files, run commands, and modify code.');
  assert.equal(clean.parts[1], remainder);
  assert.ok(clean.text.startsWith(clean.parts[0].text));
});

test('ambiguous duplicate reminders and mismatched text projections are not destructively rewritten', () => {
  const { normalized } = fixture('claude-first', { rawClaudeSystem: true });
  const message = normalized.messages[0], reminder = message.parts.find(part => part.text?.includes('Attribution for git commits'));
  message.parts.splice(7, 0, { ...reminder });
  message.text = message.parts.map(part => part.text).join('\n');
  const first = sanitizeClientIdentity(normalized);
  assert.equal(first.normalized.messages[0].parts.filter(part => part.text === reminder.text).length, 2);
  assert.ok(!first.metadata.rules.includes('claude-default-attribution'));
  const broken = fixture('pi-first').normalized;
  broken.messages.unshift({ role: 'developer', text: broken.system,
    parts: [{ type: 'text', text: 'Independent user-authored projection.' }] });
  broken.system = '';
  const second = sanitizeClientIdentity(broken);
  assert.equal(second.normalized.messages[0], broken.messages[0]);
  assert.ok(!second.metadata.rules.includes('pi-harness-identity'));
});

function compactClaudeFixture() {
  const captured = JSON.parse(fs.readFileSync(path.join(__dirname,
    'fixtures/client-gateway-20261107/failures/claude-read-compact-template.json'), 'utf8'));
  const body = captured.clientHTTP.find(item => item.path.startsWith('/v1/messages')).body;
  return normalizeAnthropic(body);
}

test('actual Claude compact template for Gemini preserves harness rules while removing its SDK identity and default attribution', () => {
  const original = compactClaudeFixture();
  const { normalized, metadata } = sanitizeClientIdentity(freeze(original));
  assert.equal(metadata.profile.client, 'claude');
  assert.equal(metadata.profile.templateVersion, '2.1.318');
  assert.deepEqual(metadata.profile.evidence, ['claude-sdk-compact-system-template']);
  assert.match(normalized.system, /Tools run behind a user-selected permission mode/);
  assert.match(normalized.system, /For actions that are hard to reverse or outward-facing, confirm first unless durably authorized/);
  assert.match(normalized.system, /IMPORTANT: Assist with authorized security testing/);
  assert.equal(normalized.system, original.system.slice(original.system.indexOf('You are an agent working with the user')));
  assert.doesNotMatch(normalized.messages[0].text, /Co-Authored-By: Claude Code|Generated with \[Claude Code\]/);
  assert.equal(normalized.messages[0].parts[0], original.messages[0].parts[1]);
  assert.ok(metadata.rules.includes('claude-compact-default-attribution'));
  assert.deepEqual(sanitizeClientIdentity(normalized).normalized, normalized);
});

test('compact Claude attribution requires the proven first-turn layout and exact default, never a user quotation', () => {
  const original = compactClaudeFixture(), attribution = original.messages[0].parts[0].text;
  original.messages.push({ role: 'user', text: attribution, parts: [{ type: 'text', text: attribution }] });
  const result = sanitizeClientIdentity(original);
  assert.equal(result.normalized.messages.at(-1), original.messages.at(-1));
  const custom = compactClaudeFixture(), before = custom.messages[0].parts[0].text;
  custom.messages[0].parts[0].text = before.replace('noreply@anthropic.com', 'chosen@example.invalid');
  custom.messages[0].text = custom.messages[0].text.replace(before, custom.messages[0].parts[0].text);
  assert.equal(sanitizeClientIdentity(custom).normalized.messages[0], custom.messages[0]);
  const unknown = compactClaudeFixture();
  unknown.system = unknown.system.replace('# Harness', '# User-provided example');
  assert.equal(inferClientProfile(unknown), null);
  assert.deepEqual(sanitizeClientIdentity(unknown).normalized, unknown);
});

function claudeSearchFixtures() {
  const captured = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/client-web-tools-20261107/claude-web-search.json'), 'utf8'));
  return captured.captures.filter(item => Array.isArray(item.body?.system)
    && item.body.system.some(part => part.text?.startsWith('You run a web search for another Claude model,')));
}

test('both actual Claude search helper requests preserve search behavior while clearing their exact three-block identity', () => {
  const captures = claudeSearchFixtures(); assert.equal(captures.length, 2);
  for (const capture of captures) {
    const source = { system: capture.body.system.map(part => part.text).join('\n'),
      messages: structuredClone(capture.body.messages), tools: structuredClone(capture.body.tools) };
    const original = structuredClone(source), { normalized, metadata } = sanitizeClientIdentity(freeze(source));
    assert.deepEqual(metadata.profile, { client: 'claude', templateVersion: '2.1.318', evidence: ['claude-sdk-search-helper-template'] });
    assert.equal(normalized.system, capture.body.system[2].text.replace('another Claude model', 'another model'));
    assert.match(normalized.system, /which is waiting on the result and can search again\. Search once, then reply with a brief summary of the results\./);
    assert.doesNotMatch(normalized.system, /billing-header|Anthropic|Claude|Google|Antigravity/);
    assert.deepEqual(normalized.messages, original.messages); assert.deepEqual(normalized.tools, original.tools);
    assert.deepEqual(source, original);
    assert.deepEqual(metadata.rules, ['claude-billing-marker', 'claude-sdk-identity', 'claude-search-helper-model-identity']);
    assert.deepEqual(sanitizeClientIdentity(normalized).normalized, normalized);
  }
});

test('search helper cleanup preserves SOUL, project suffixes, quoted copies and tool arguments byte-for-byte', () => {
  const capture = claudeSearchFixtures()[0], template = capture.body.system.map(part => part.text).join('\n');
  const suffix = '\n\n# SOUL.md\nMy chosen name is Claude.\n# AGENTS.md\nAsk before executing tools.\n<quote>\n' + template + '\n</quote>';
  const messages = [{ role: 'user', text: template, parts: [{ type: 'text', text: template }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'owned', name: 'web_search', arguments: { query: template } }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'owned', name: 'web_search', content: template }] }];
  const source = { system: template + suffix, messages, tools: [] }, clean = sanitizeClientIdentity(source).normalized;
  assert.equal(clean.system, capture.body.system[2].text.replace('another Claude model', 'another model') + suffix);
  assert.deepEqual(clean.messages, messages);
  assert.equal(clean.system.split('You run a web search for another Claude model').length - 1, 1, 'quoted tail remains untouched');
});

test('near matches and user quotations of the Claude search template are not treated as framework instructions', () => {
  const capture = claudeSearchFixtures()[0], blocks = capture.body.system.map(part => part.text), template = blocks.join('\n');
  for (const system of [blocks[2], blocks.slice(1).join('\n'), [blocks[0], blocks[2]].join('\n'),
    template.replace('2.1.318', '2.1.319'), template.replace('Search once,', 'Search twice,'),
    template + ' This is my custom paragraph.', '# SOUL.md\n' + template,
    'Review this example:\n```text\n' + template + '\n```', '<quote>\n' + template + '\n</quote>']) {
    const source = { system, messages: [], tools: [] };
    assert.equal(inferClientProfile(source), null);
    assert.deepEqual(sanitizeClientIdentity(source).normalized, source);
  }
});

test('separate developer blocks keep aligned projections when removing the search prefix and its bounded brand word', () => {
  const capture = claudeSearchFixtures()[0], parts = capture.body.system.map(part => ({ ...part }));
  const tail = { type: 'text', text: '# AGENTS.md\nKeep the user-provided Claude persona.' };
  parts.push(tail);
  const message = { role: 'developer', text: parts.map(part => part.text).join('\n'), parts };
  const source = { system: '', messages: [message], tools: [] }, clean = sanitizeClientIdentity(source);
  assert.equal(clean.normalized.messages[0].parts.length, 2);
  assert.equal(clean.normalized.messages[0].parts[0].text, capture.body.system[2].text.replace('another Claude model', 'another model'));
  assert.equal(clean.normalized.messages[0].parts[1], tail);
  assert.equal(clean.normalized.messages[0].text, clean.normalized.messages[0].parts.map(part => part.text).join('\n'));
  const mismatched = { ...source, messages: [{ ...message, parts: [{ type: 'text', text: 'Unrelated user projection.' }] }] };
  const conservative = sanitizeClientIdentity(mismatched);
  assert.equal(conservative.normalized.messages[0], mismatched.messages[0]);
  assert.deepEqual(conservative.metadata.rules, []);
});
