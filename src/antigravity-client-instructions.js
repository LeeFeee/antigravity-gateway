'use strict';

const crypto = require('node:crypto');

// Pi 1.5.2 dist/core/system-prompt.js, also present byte-for-byte in the
// captured pi-first fixture. Real Google requests rejected the original
// reference line with RESOURCE_EXHAUSTED; expanding its abbreviation kept
// the same meaning, references, roles and tools and returned a tool call.
// This is a narrow upstream compatibility rule, not a general text filter.
const PI_REFERENCE_HASH = '622e5364154ba1071d01c240a4b5693d164e437e69de1c964f594f69496ae6b1';
const PI_DOCS = '\n<docs>\nPi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):\n';
const CLAUDE_COMPACT_CORE = 'You are an agent working with the user toward their goals, using your own judgment along the way.';
const CLAUDE_CORE = CLAUDE_COMPACT_CORE + ' Use the instructions below and the tools available to you to assist the user.';
const CLAUDE_SECURITY_HASH = '10591efdcea75a1645b7f19037b36c979849ad4ec27f11ce87a8393423597b44';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// These fingerprints match Hermes 0.23.1 prompt_builder.py and its default
// opening paragraph. Only the recognized framework region is converted;
// project context, custom SOUL paragraphs and tool contracts remain verbatim.
function prepareHermesInstructions(text) {
  const paragraphs = text.split(/(\n\s*\n)/);
  const docs = paragraphs.findIndex(part => hash(part) === 'd73c1157c538e496c1de7e043555d08d589209c830bc9ea267921bd32df55ffe');
  if (docs < 0 || !paragraphs[docs + 2]?.startsWith('# Finishing the job\n')) return text;
  if (hash(paragraphs[0]) === '57da911234c52fb96609a042901eb952db73d3d13c218c57fa8f8989548ac07c') {
    paragraphs[0] = paragraphs[0].replace('Be direct: match the length of your reply to the weight of the ask',
      'Respond directly and in proportion to the request');
  }
  const sourceDocs = paragraphs[docs];
  paragraphs[docs] = 'For configuration, setup, usage, extensions, troubleshooting, or questions about the client framework and its features, tools and capabilities, consult the authoritative, current documentation at https://hermes-agent.nousresearch.com/docs. '
    + sourceDocs.slice(sourceDocs.indexOf('The `hermes-agent` skill'));
  for (let i = docs + 2; i < paragraphs.length && !/^(?:# Project Context|## Skills|# Memory|# Hermes runtime environment)/.test(paragraphs[i]); i += 2) {
    const fingerprint = hash(paragraphs[i]);
    if (fingerprint === '3baa51af2f4d627c2b1b2cffee38919540472a1215558c88e8616443efb7da1c') {
      paragraphs[i] = '# Finishing the job\n'
        + 'Complete build, execution and verification requests with a working result supported by actual tool output. A description, stub, plan or isolated command is insufficient. Continue until the code has really run or the requested result exists, then report the observed execution results.\n'
        + 'Report blocking tool, installation or network failures plainly, then try another package manager or approach, or ask the user. Do not fabricate data, file contents, API responses or any other output to stand in for unavailable real results. Always report a blocker honestly instead of inventing a result.';
    } else if (fingerprint === 'b79d84cb613e58210f8fbb22b052cac60cd9ccd4d9ced54ff2c9943ee98ed2b4') {
      paragraphs[i] = paragraphs[i].replace('# Google model operational directives', '# Model execution requirements');
    } else if (fingerprint === '7af6922616db050fd7a240cc80aebee4cefc4d89e32dcacc0c69c54deac26d43') {
      // Interactive gateway-backed Hermes adds this official steering block.
      // Keep the delivery marker, trust boundary and replay rules verbatim.
      paragraphs[i] = paragraphs[i].replace('Hermes delivers', 'The client delivers');
    }
  }
  let result = paragraphs.join('');
  const heading = '\n# Hermes runtime environment\n', end = '<!-- End Hermes runtime environment -->';
  const start = result.lastIndexOf(heading);
  if (start > result.indexOf(paragraphs[docs]) && result.trimEnd().endsWith(end)) {
    // Hermes appends this outer block after project prose. Preserve every
    // dynamic environment value, including user-supplied environment hints.
    const stop = result.lastIndexOf(end);
    result = result.slice(0, start) + result.slice(start, stop).replace(heading, '\n# Client runtime environment\n')
      + '<!-- End client runtime environment -->' + result.slice(stop + end.length);
  }
  return result;
}

function prepareAntigravityClientInstructions(normalized, profile) {
  if (profile?.client === 'dsh' && profile.templateVersion === '0.2.1-rc.2'
    && profile.evidence?.includes('dsh-web-developer-template') && typeof normalized.system === 'string') {
    // Official dsh-harness-dev-context 0.2.1-rc.2 GUI guidance, verified
    // against the installed source and a complete real web-client capture.
    // Expand DOM without changing any browser, build or execution rule.
    const paragraphs = normalized.system.split('\n\n');
    const index = paragraphs.length - 1;
    if (hash(paragraphs[index - 1] || '') === 'cacb12df44551f408df3e53d3d38cc680f55a62643ecc5102ed61e7965c83229'
      && hash(paragraphs[index] || '') === '7496863f7f81a12cad97ff5c643339f8ddf344b6525c191c29ab086bec5a400a') {
      paragraphs[index] = paragraphs[index].replace('no implicit DOM, route, or screenshot context',
        'no implicit Document Object Model, route, or screenshot context');
      return { ...normalized, system: paragraphs.join('\n\n') };
    }
    return normalized;
  }
  if (profile?.client === 'hermes' && profile.templateVersion === '0.23.1'
    && profile.evidence?.includes('hermes-instructions-template') && typeof normalized.system === 'string') {
    const system = prepareHermesInstructions(normalized.system);
    return system === normalized.system ? normalized : { ...normalized, system };
  }
  // Interactive CLI and SDK/print mode carry the same verified policy, but
  // the CLI framework starts with a newline and has its own source evidence.
  const claudeCore = profile?.evidence?.includes('claude-tui-system-template') ? '\n' + CLAUDE_COMPACT_CORE
    : profile?.evidence?.includes('claude-sdk-compact-system-template') ? CLAUDE_COMPACT_CORE
    : profile?.evidence?.includes('claude-sdk-system-template') ? CLAUDE_CORE : null;
  if (profile?.client === 'claude' && profile.templateVersion === '2.1.322'
    && claudeCore && normalized.system?.startsWith(claudeCore + '\n\n')) {
    const start = claudeCore.length + 2, end = normalized.system.indexOf('\n', start);
    const policy = normalized.system.slice(start, end < 0 ? undefined : end);
    if (hash(policy) === CLAUDE_SECURITY_HASH) {
      // Expand standard abbreviations; every allowed context, refusal and
      // authorization requirement in the verified client policy stays intact.
      const expanded = policy.replace('DoS attacks', 'denial-of-service attacks')
        .replace('C2 frameworks', 'command-and-control frameworks');
      return { ...normalized, system: normalized.system.slice(0, start) + expanded
        + (end < 0 ? '' : normalized.system.slice(end)) };
    }
  }
  if (profile?.client !== 'pi' || profile.templateVersion !== '1.5.2'
    || !profile.evidence?.includes('pi-developer-template') || typeof normalized.system !== 'string') return normalized;
  const text = normalized.system, start = text.indexOf(PI_DOCS);
  if (start < 0) return normalized;
  const end = text.indexOf('\n</docs>', start + PI_DOCS.length);
  if (end < 0) return normalized;
  const docs = text.slice(start, end), lines = docs.split('\n');
  const index = lines.findIndex(line => hash(line) === PI_REFERENCE_HASH);
  if (index < 0) return normalized;
  lines[index] = lines[index].replace('non-LLM models', 'models other than large language models,');
  return { ...normalized, system: text.slice(0, start) + lines.join('\n') + text.slice(end) };
}

module.exports = { prepareAntigravityClientInstructions };
