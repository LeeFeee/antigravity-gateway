'use strict';

const { GatewayError, validateSchema } = require('./protocol');
const { isDeepStrictEqual } = require('node:util');
const { CLAUDE_COMPACTION_PROFILE } = require('./agy-client-compaction');
const { CODEX_CLIENT_PROFILE } = require('./agy-client-profile');
const { FINISH_METADATA } = require('./agy-structured-output');
const { HERMES_CLIENT_PROFILE, capturedHermesTool, hermesSystemText, toolReferences } = require('./agy-hermes-profile');

// Native names and metadata come from captured agy declarations. Only the
// capabilities the actual client declares are exposed; this is not an agy
// executor, task planner, or substitute permission system.
const claudeRules = {
  Read: { name: 'view_file', description: 'Reads a file from the local filesystem.', fields: { file_path: 'string', offset: 'integer', limit: 'integer', pages: 'string' }, required: ['file_path'] },
  Write: { name: 'write_to_file', description: 'Writes a file to the local filesystem, overwriting if one exists.', fields: { file_path: 'string', content: 'string' }, required: ['file_path', 'content'] },
  Edit: {
    name: 'replace_file_content', description: 'Performs exact string replacement in a file.',
    fields: { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean' }, required: ['file_path', 'old_string', 'new_string'],
    parameters: { file_path: 'TargetFile', old_string: 'TargetContent', new_string: 'ReplacementContent', replace_all: 'AllowMultiple' }
  },
  Bash: {
    name: 'run_command', description: 'Executes a bash command and returns its output.',
    fields: { command: 'string', timeout: 'number', description: 'string', run_in_background: 'boolean', dangerouslyDisableSandbox: 'boolean' }, required: ['command'],
    // Timeout is an execution limit, not WaitMsBeforeAsync. Background work
    // is not an indefinite IsDaemon task. Preserve both actual capabilities.
    parameters: { command: 'CommandLine', timeout: 'TimeoutMs', description: 'Description', run_in_background: 'RunInBackground', dangerouslyDisableSandbox: 'BypassSandbox' }
  }
};

const codexRules = {
  exec_command: {
    name: 'run_command', description: 'Runs a command in a PTY, returning output or a session ID for ongoing interaction.',
    fields: { cmd: 'string', justification: 'string', login: 'boolean', max_output_tokens: 'number', prefix_rule: 'array', sandbox_permissions: 'string', shell: 'string', tty: 'boolean', workdir: 'string', yield_time_ms: 'number' }, required: ['cmd'],
    parameters: { cmd: 'CommandLine', justification: 'Justification', login: 'Login', max_output_tokens: 'MaxOutputTokens', prefix_rule: 'ApprovalPrefix', sandbox_permissions: 'BypassSandbox', shell: 'Shell', tty: 'Tty', workdir: 'Cwd', yield_time_ms: 'WaitMsBeforeAsync' }
  },
  write_stdin: {
    name: 'manage_task', description: 'Writes characters to an existing unified exec session and returns recent output.',
    fields: { chars: 'string', max_output_tokens: 'number', session_id: 'number', yield_time_ms: 'number' }, required: ['session_id'],
    parameters: { chars: 'Input', max_output_tokens: 'MaxOutputTokens', session_id: 'TaskId', yield_time_ms: 'WaitMs' }, session: true
  },
  view_image: {
    name: 'view_file', description: 'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.',
    fields: { detail: 'string', path: 'string' }, required: ['path'],
    parameters: { detail: 'ImageDetail', path: 'AbsolutePath' }
  }
};

const hermesRules = {
  read_file: { name: 'view_file', hermes: true, lineRange: true, parameters: { path: 'AbsolutePath', offset: 'StartLine', limit: 'EndLine' } },
  write_file: { name: 'write_to_file', hermes: true, parameters: { path: 'TargetFile', content: 'CodeContent' } },
  patch: { name: 'replace_file_content', hermes: true, parameters: { path: 'TargetFile', old_string: 'TargetContent', new_string: 'ReplacementContent', replace_all: 'AllowMultiple' } },
  terminal: { name: 'run_command', hermes: true, parameters: { command: 'CommandLine', background: 'RunInBackground', timeout: 'ExecutionTimeoutSeconds', workdir: 'Cwd', pty: 'Tty', notify: 'Notify', heartbeat: 'HeartbeatSeconds', persist_on_release: 'PersistOnRelease' } }
};

const profiles = {
  [CLAUDE_COMPACTION_PROFILE]: { protocol: 'anthropic', rules: claudeRules },
  [CODEX_CLIENT_PROFILE]: { protocol: 'responses', rules: codexRules },
  [HERMES_CLIENT_PROFILE]: { protocol: 'chat', rules: hermesRules }
};

function supported(tool, rule) {
  if (rule.hermes) return capturedHermesTool(tool);
  const s = tool.schema;
  return !tool.internal && (!tool.kind || tool.kind === 'function') && s?.type === 'object'
    && String(tool.description || '').split('\n')[0] === rule.description
    && s.additionalProperties === false && s.properties && !['allOf', 'anyOf', 'oneOf', '$ref', 'not', 'enum', 'const', 'if', 'then', 'else'].some(k => k in s)
    && Object.keys(s.properties).every(k => rule.fields[k] && s.properties[k]?.type === rule.fields[k])
    && rule.required.every(k => s.properties[k] && s.required?.includes(k))
    && (s.required || []).every(k => rule.required.includes(k))
    && (tool.name !== 'Read' || Boolean(s.properties.offset) === Boolean(s.properties.limit))
    && (!rule.session || Boolean(s.properties.chars))
    && (tool.name !== 'exec_command' || !s.properties.sandbox_permissions
      || (Object.keys(s.properties.sandbox_permissions).every(k => ['type', 'enum', 'description'].includes(k))
        && s.properties.sandbox_permissions.enum?.length === 2
        && ['use_default', 'require_escalated'].every(v => s.properties.sandbox_permissions.enum.includes(v))));
}

function systemText(text, target) {
  return String(text || '').replace(/^You are an AI coding agent operating behind a protocol-compatible client\.[ \t]*$/gm,
    target === 'robin' ? '' : 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.');
  // System text also contains user/project instructions and literal examples.
  // A generic replacement of `Read` would change those instructions. Only
  // this captured framework identity line is translated, not arbitrary prose.
}

function parameterReferences(text, parameters) {
  // Translate field references in the recognized declaration, never in the
  // command, replacement text, user messages or other executable arguments.
  return String(text || '').replace(/`([A-Za-z_][A-Za-z_0-9]*)`/g, (whole, name) => parameters[name] ? '`' + parameters[name] + '`' : whole)
    .replace(/\b(old_string|new_string|replace_all)\b/g, name => parameters[name] || name);
}

function declaration(tool, rule, mappings, target) {
  const p = tool.schema.properties;
  let properties = { AbsolutePath: p.file_path }, required = ['AbsolutePath'];
  let description = 'View the contents of a file from the local filesystem. Paths must be absolute. Text lines are 1-indexed; EndLine is inclusive. Reads up to 2000 lines by default. Images and Jupyter notebooks are supported. Do not re-read a file just edited merely to verify it; the executing tool tracks file state.';
  if (tool.name === 'Read') {
    if (p.offset) {
      properties.StartLine = { ...p.offset, description: 'Optional starting line number, 1-indexed.' };
      properties.EndLine = { type: 'integer', description: 'Optional inclusive ending line. Must be greater than or equal to StartLine (or 1 when omitted).' };
    }
    if (p.pages) {
      // There is no line-range equivalent for a PDF page selection. Preserve
      // this necessary client capability rather than falsely advertising the
      // native byte-offset feature, which this client cannot execute.
      properties.Pages = p.pages;
      description += ' PDFs use Pages (for example "1-5", at most 20 pages; required for documents over 10 pages).';
    }
  } else if (tool.name === 'Write') {
    delete properties.AbsolutePath;properties.TargetFile = p.file_path;properties.CodeContent = p.content;
    required.splice(0, 1, 'TargetFile', 'CodeContent');
    description = 'Write a file to the local filesystem, creating it or overwriting an existing file. Existing files must have been read first; otherwise execution will fail. Use this for new files or complete replacement; use an available editing tool for partial changes. This tool does not offer append or no-overwrite modes.';
  } else {
    properties = Object.fromEntries(Object.entries(p).map(([name, schema]) => [rule.parameters[name], {
      ...schema, ...(schema.description === undefined ? {} : { description: parameterReferences(schema.description, rule.parameters) })
    }]));
    required = tool.schema.required.map(name => rule.parameters[name]);
    description = parameterReferences(tool.description, rule.parameters);
    if (rule.hermes) {
      description = toolReferences(description, mappings);
      // Field assignments/quoted field names in this captured description must
      // match its declaration; ordinary prose and returned next_offset do not.
      const references = text => text.replace(/\b([A-Za-z_][A-Za-z_0-9]*)\b(?=\s*=)/g, (whole, name) => rule.parameters[name] || whole)
        .replace(/(['"])([A-Za-z_][A-Za-z_0-9]*)\1/g, (whole, quote, name) => rule.parameters[name] ? quote + rule.parameters[name] + quote : whole);
      description = references(description);
      for (const property of Object.values(properties)) if (property.description) property.description = references(toolReferences(property.description, mappings));
    }
    if (rule.lineRange) {
      properties.EndLine = { type: 'integer', description: 'Optional inclusive ending line. StartLine defaults to 1; at most 2000 lines may be requested. Omit to read up to 2000 lines. The text budget and next_offset continuation still apply.' };
      description = description.replace('Use offset and limit for large files.', 'Use StartLine and inclusive EndLine for large files.')
        .replace('continue with offset to read the rest.', 'continue with StartLine to read the rest.');
    }
    if (tool.name === 'Edit' && mappings.has('Read')) {
      description = description.replace('You must Read the file in this conversation', 'You must use view_file to read the file in this conversation')
        .replace('Strip the Read line prefix', 'Strip the view_file line prefix');
    }
    if (tool.name === 'exec_command' && p.sandbox_permissions) {
      properties.BypassSandbox = { type: 'boolean', description: 'False uses the default sandbox. True requests unsandboxed execution through existing approval controls. Omit for the default.' };
      if (p.justification) properties.Justification = { ...properties.Justification, description: 'User-facing approval question when BypassSandbox is true; omit otherwise.' };
      if (p.prefix_rule) properties.ApprovalPrefix = { ...properties.ApprovalPrefix, description: 'Reusable approval prefix for CommandLine, only when BypassSandbox is true; for example ["git", "pull"].' };
    }
    if (rule.session) {
      properties.Action = { type: 'string', enum: ['status', 'send_input'], description: 'status polls recent output without writing; send_input writes Input to the running task.' };
      required.push('Action');
      description = 'Interact with an existing command session and return recent output. TaskId is the numeric session ID returned by the command tool. Only status and send_input are supported; this tool does not list or kill tasks. WaitMs controls how long to wait for output, not the execution lifetime.';
    }
  }
  // Robin advertises these aliases as external MCP tools, not agy built-ins.
  // Its protocol neither requires nor consumes agy's action/summary fields.
  if (target !== 'robin') {
    Object.assign(properties, structuredClone(FINISH_METADATA));required.push('toolSummary', 'toolAction');
  }
  return { ...tool, name: rule.name, description, schema: { type: 'object', properties, required, additionalProperties: false } };
}

function clientCall(call, tool, rule, target) {
  let args = call.arguments;
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { args = null; }
  const fail = () => { throw new GatewayError('上游工具参数无法无损转换为客户端工具参数。', { code: 'invalid_tool_arguments', status: 502 }); };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail();
  const allowed = rule.parameters ? Object.keys(tool.schema.properties).map(name => rule.parameters[name])
    : tool.name === 'Read' ? ['AbsolutePath', 'StartLine', 'EndLine', 'Pages'] : ['TargetFile', 'CodeContent'];
  if (rule.session) allowed.push('Action');
  if (Object.keys(args).some(k => !allowed.includes(k) && (target === 'robin' || !Object.hasOwn(FINISH_METADATA, k)))) return fail();
  const input = rule.parameters
    ? Object.fromEntries(Object.entries(rule.parameters).filter(([, name]) => Object.hasOwn(args, name)).map(([name, alias]) => [name, args[alias]]))
    : tool.name === 'Read' ? { file_path: args.AbsolutePath } : { file_path: args.TargetFile, content: args.CodeContent };
  if (rule.lineRange) {
    if (args.StartLine !== undefined && (!Number.isSafeInteger(args.StartLine) || args.StartLine < 1)) return fail();
    if (args.EndLine !== undefined) {
      const limit = args.EndLine - (args.StartLine ?? 1) + 1;
      if (!Number.isSafeInteger(args.EndLine) || limit < 1 || limit > 2000) return fail();
      input.limit = limit;
    }
  }
  if (rule.hermes && tool.name === 'terminal'
      && ((input.timeout !== undefined && input.timeout < 1) || (input.heartbeat !== undefined && input.heartbeat < 0))) return fail();
  if (tool.name === 'exec_command' && Object.hasOwn(input, 'sandbox_permissions')) {
    if (typeof input.sandbox_permissions !== 'boolean') return fail();
    input.sandbox_permissions = input.sandbox_permissions ? 'require_escalated' : 'use_default';
  }
  if (rule.session) {
    if (!['status', 'send_input'].includes(args.Action)) return fail();
    if (args.Action === 'status' && args.Input !== undefined && args.Input !== '') return fail();
    if (args.Action === 'send_input' && typeof args.Input !== 'string') return fail();
  }
  if (tool.name === 'Read') {
    if (args.StartLine !== undefined) {
      if (!Number.isSafeInteger(args.StartLine) || args.StartLine < 1) return fail();
      input.offset = args.StartLine;
    }
    if (args.EndLine !== undefined) {
      if (!Number.isSafeInteger(args.EndLine) || args.EndLine < (args.StartLine ?? 1)) return fail();
      input.limit = args.EndLine - (args.StartLine ?? 1) + 1;
    }
    if (args.Pages !== undefined) input.pages = args.Pages;
  }
  if (!validateSchema(input, tool.schema)) return fail();
  return { ...call, name: tool.name, arguments: input };
}

function providerCall(call, tool, rule, target) {
  let input = call.arguments;
  try { if (typeof input === 'string') input = JSON.parse(input); } catch { return call; }
  // Historical calls with changed/unknown capabilities stay as submitted.
  // Never manufacture missing values to make them fit the current profile.
  if (!input || typeof input !== 'object' || Array.isArray(input) || !validateSchema(input, tool.schema)) return call;
  const parameters = rule.parameters || (tool.name === 'Read'
    ? { file_path: 'AbsolutePath', offset: 'StartLine', limit: 'EndLine', pages: 'Pages' }
    : { file_path: 'TargetFile', content: 'CodeContent' });
  const args = Object.fromEntries(Object.entries(input).map(([name, value]) => [parameters[name], value]));
  if (rule.lineRange || tool.name === 'Read') {
    if (Object.hasOwn(input, 'limit')) args.EndLine = (input.offset ?? 1) + input.limit - 1;
  }
  if (tool.name === 'exec_command' && Object.hasOwn(input, 'sandbox_permissions')) args.BypassSandbox = input.sandbox_permissions === 'require_escalated';
  if (rule.session) args.Action = input.chars ? 'send_input' : 'status';
  const mapped = { ...call, name: rule.name, arguments: args };
  try { if (!isDeepStrictEqual(clientCall(mapped, tool, rule, target).arguments, input)) return call; }
  catch { return call; }
  return mapped;
}

function prepareToolAdapter(normalized, { clientProfile = '', checkpoint = false, target = 'cloudcode' } = {}) {
  const mappings = new Map(), source = new Map(), names = new Set((normalized.tools || []).map(t => t.name));
  const profile = profiles[clientProfile];
  const recognized = !checkpoint && !normalized.autoMode && profile && normalized.protocol === profile.protocol;
  if (recognized) {
    for (const tool of normalized.tools || []) {
      const rule = profile.rules[tool.name];
      if (rule && !names.has(rule.name) && supported(tool, rule)) { mappings.set(tool.name, rule);source.set(rule.name, tool); }
    }
  }
  const byNative = new Map([...mappings].map(([name, rule]) => [rule.name, rule]));
  let toolChoice = normalized.toolChoice;
  const choiceName = toolChoice?.name || toolChoice?.function?.name, translated = mappings.get(choiceName);
  if (translated) toolChoice = { ...toolChoice, ...(toolChoice.name ? { name: translated.name } : {}),
    ...(toolChoice.function ? { function: { ...toolChoice.function, name: translated.name } } : {}) };
  const system = recognized ? clientProfile === HERMES_CLIENT_PROFILE
    ? hermesSystemText(String(normalized.system || ''), mappings, target === 'robin' ? { identity: '' } : {})
    : systemText(normalized.system, target) : normalized.system;
  return {
    normalized: mappings.size || system !== normalized.system ? { ...normalized, system, toolChoice,
      tools: (normalized.tools || []).map(t => mappings.has(t.name) ? declaration(t, mappings.get(t.name), mappings, target) : t) } : normalized,
    toClient: call => byNative.has(call.name) ? clientCall(call, source.get(call.name), byNative.get(call.name), target) : call,
    toProvider: call => mappings.has(call.name) ? providerCall(call, source.get(mappings.get(call.name).name), mappings.get(call.name), target) : call,
    adapted: mappings.size > 0
  };
}

module.exports = { prepareToolAdapter };
