'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { compileSchema, compileSchemaAsync } = require('./schema-contract');
const { runSync, runAsync } = require('./schema-steps');
const { trustedModelServiceDefinition } = require('./agy-model-service-tools');

const VERSION = 1;
const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
const SUMMARY = "Brief 2-5 word noun phrase describing the specific task. Capitalize like a sentence. Some examples: 'Directory analysis', 'Web search', 'Git status check', 'Test execution', 'Code search'.";
const VERSIONS = { claude: '2.1.318', hermes: '0.21.7+11153.g2bd378e', pi: '1.5.0', dsh: '0.2.1-rc.2' };
// Full declaration fingerprints, not name-only rules. Evidence lives in
// tests/fixtures/agent-requests-20261107. No runtime dependency on test files.
const PROFILES = {
  claude: {
    // Full and compact harness descriptions were captured independently.
    Read: ['read', 'file_path', '0d92ae8d2aa76ebf1a83ec99c0a4e71265500d1cb49383d46a5e7401557adfd7', 'bad69a47943e39e7750bf2fd714b16bd24eafae0659faa93dc72efd73d6e3f0c'],
    Write: ['write', 'file_path', '244e38a49a4c484cdeef86675fdf19515e0a22fbd7fd34e4302efab8a469a4fc', '772c5ab16d3aef644186d87abd9c1b0778837aadac079266e99812fab8b18be7'],
    Edit: ['edit', 'file_path', '2d3c585898eeec5ce15864a2230f2b07d5a7951ee1496039e0ecc274884dd545', '55815321a75f3c2d1bc6b4409709bf37fbc297927310821f06f836e5ae0b4dfe']
  },
  pi: {
    read: ['read', 'path', 'f82441250b72f20563bc799334e4379b8aa381094a300c71dbde1ccfff127701'],
    write: ['write', 'path', '8cde0b1ae0d91dcff471c93cee5b1fa9f931f250003b6faead97564631363b5e']
  },
  hermes: {
    read_file: ['read', 'path', 'ebc892b5a7213b0ff701da2dd694ac51fdc75717b18a7ca0085d4cdb2be5b8a7'],
    write_file: ['write', 'path', '4a253157dca5b1f0f9accc158ec3f8ac226cfc03ba91067cf9a1fd59fd50f859']
  },
  dsh: {
    read: ['read', 'file_path', 'da2b0daec987c583fd81fdce3fe929b5c8bff27e76e34de7d18790c4ff90e92d'],
    write: ['write', 'file_path', '63b01617d79ae5bcccd2c54c090823be793cfec2c53ebf5a1a080de4a44127f6'],
    edit: ['edit', 'file_path', 'ba3a448f27d8c5bd30308e2b0c84ca6eafac57b77f1eb0364b6b4a82c7b16b9a']
  }
};

const APPLY_PATCH_GRAMMAR = 'start: begin_patch hunk+ end_patch\nbegin_patch: "*** Begin Patch" LF\nend_patch: "*** End Patch" LF?\n\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: "*** Add File: " filename LF add_line+\ndelete_hunk: "*** Delete File: " filename LF\nupdate_hunk: "*** Update File: " filename LF change_move? change?\n\nfilename: /(.+)/\nadd_line: "+" /(.*)/ LF -> line\n\nchange_move: "*** Move to: " filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: ("@@" | "@@ " /(.+)/) LF\nchange_line: ("+" | "-" | " ") /(.*)/ LF\neof_line: "*** End of File" LF\n\n%import common.LF\n';

class ToolContractError extends Error {
  constructor(message, { code = 'invalid_tool_arguments', status = 502, details } = {}) {
    super(message); this.name = 'ToolContractError'; this.code = code; this.status = status;
    if (details !== undefined) this.details = details;
  }
}
const fail = (message, options) => { throw new ToolContractError(message, options); };
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const fingerprint = tool => digest({ name: tool.name, description: tool.description || '', schema: tool.schema === undefined ? { type: 'object' } : tool.schema, kind: tool.kind || 'function' });

function parseJSON(value, status = 502) {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value) > MAX_ARGUMENT_BYTES) fail('工具参数超过 4 MiB。', { status });
  try { return JSON.parse(value); }
  catch { return fail('工具参数不是有效 JSON。', { status }); }
}
function serialize(value, status = 400) {
  function check(item, depth = 0) {
    if (depth > 64) fail('工具参数嵌套超过支持深度。', { status });
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) { if (!own(item, index)) fail('稀疏数组不能无损转换为 JSON。', { status }); check(item[index], depth + 1); }
      return;
    }
    if (object(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item)) && !Object.getOwnPropertySymbols(item).length) {
      for (const child of Object.values(item)) check(child, depth + 1);
      return;
    }
    fail('工具参数不是可无损往返的 JSON 值。', { status });
  }
  check(value);
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { return fail('工具参数无法序列化。', { status }); }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_ARGUMENT_BYTES) fail('工具参数为空或超过 4 MiB。', { status });
  // JSON.stringify silently changes NaN, Infinity, undefined, sparse arrays,
  // and custom objects. Do not call such a lossy operation a round trip.
  if (stable(JSON.parse(encoded)) !== stable(value)) fail('工具参数不是可无损往返的 JSON 值。', { status });
  return encoded;
}
function* validate(value, validator, status = 502) {
  if (!(yield validator(value))) fail('工具参数不符合原始客户端契约。', { status, details: clone(validator.errors || []) });
}

// Direct MCP declarations use only vocabulary observed in the official MCP
// probes. additionalProperties:false is a LOCAL guard, never sent as an
// unsupported protobuf field. Open objects retain a separate JSON view.
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'default', 'examples', 'readOnly', 'writeOnly', 'deprecated']);
const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'additionalProperties']);
function projectSimple(schema) {
  if (!object(schema) || !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(schema.type)) return null;
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key) && !ANNOTATIONS.has(key)) return null;
  if (own(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') return null;
  if (own(schema, 'enum') && (schema.type !== 'string' || !Array.isArray(schema.enum) || schema.enum.some(value => typeof value !== 'string'))) return null;
  const local = {}, wire = { type: schema.type.toUpperCase() };
  for (const key of ['type', 'description', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) {
    if (!own(schema, key)) continue;
    local[key] = clone(schema[key]);
    if (key !== 'type') wire[key] = ['minLength', 'maxLength', 'minItems', 'maxItems'].includes(key) ? String(schema[key]) : clone(schema[key]);
  }
  let complete = true;
  if (schema.type === 'object') {
    if (schema.properties !== undefined && !object(schema.properties)) return null;
    if (schema.required?.some(name => !own(schema.properties || {}, name))) return null;
    local.properties = {}; wire.properties = {};
    for (const [name, child] of Object.entries(schema.properties || {})) {
      const projected = projectSimple(child); if (!projected) return null;
      Object.defineProperty(local.properties, name, { value: projected.local, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(wire.properties, name, { value: projected.wire, enumerable: true, writable: true, configurable: true });
      complete &&= projected.complete;
    }
    if (schema.required !== undefined) { local.required = clone(schema.required); wire.required = clone(schema.required); }
    local.additionalProperties = false;
    complete &&= schema.additionalProperties === false;
  }
  if (schema.type === 'array') {
    const items = projectSimple(schema.items); if (!items) return null;
    local.items = items.local; wire.items = items.wire; complete &&= items.complete;
  }
  return { local, wire, complete };
}

function validPatch(text) {
  if (typeof text !== 'string' || !text.startsWith('*** Begin Patch\n')) return false;
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines.at(-1) !== '*** End Patch') return false;
  const end = lines.length - 1; let index = 1, hunks = 0;
  while (index < end) {
    const line = lines[index++];
    if (/^\*\*\* Add File: .+$/.test(line)) {
      let count = 0; while (index < end && lines[index].startsWith('+')) { index++; count++; }
      if (!count) return false;
    } else if (/^\*\*\* Delete File: .+$/.test(line)) {
      // The header is the entire delete hunk.
    } else if (/^\*\*\* Update File: .+$/.test(line)) {
      if (index < end && /^\*\*\* Move to: .+$/.test(lines[index])) index++;
      let changes = 0;
      while (index < end && (lines[index] === '@@' || /^@@ .+$/.test(lines[index]) || /^[+ -]/.test(lines[index]))) { index++; changes++; }
      if (index < end && lines[index] === '*** End of File') { if (!changes) return false; index++; }
    } else return false;
    hunks++;
  }
  return hunks > 0;
}

function customValidator(tool, options) {
  if (tool.kind !== 'custom') return null;
  const supplied = options.customToolValidators && own(options.customToolValidators, tool.name) ? options.customToolValidators[tool.name] : undefined;
  if (supplied !== undefined && typeof supplied !== 'function') fail('自定义工具校验器必须是函数。', { code: 'invalid_tool_validator', status: 400 });
  if (supplied) return supplied;
  const format = tool.format;
  if (!format || format.type === 'text') return value => typeof value === 'string';
  if ((tool.clientName ?? tool.name) === 'apply_patch' && format.type === 'grammar' && format.syntax === 'lark' && format.definition === APPLY_PATCH_GRAMMAR) return validPatch;
  fail('此自定义工具 grammar 尚无已验证的本地校验器。', { code: 'unsupported_tool_grammar', status: 400, details: { name: tool.name, syntax: format.syntax || null } });
}

function recognizedRule(tool, normalized, options) {
  const profile = options.clientIdentity;
  if (options.checkpoint || normalized.autoMode || !profile || !own(VERSIONS, profile.client)
    || VERSIONS[profile.client] !== profile.templateVersion) return null;
  if (options.clientVersion && options.clientVersion !== VERSIONS[profile.client]) return null;
  const rules = own(PROFILES, profile.client) ? PROFILES[profile.client] : null;
  const rule = rules && own(rules, tool.name) ? rules[tool.name] : null;
  return rule && rule.slice(2).includes(fingerprint(tool)) ? { operation: rule[0], pathField: rule[1], client: profile.client } : null;
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.py', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.java', '.kt', '.sh', '.bash', '.zsh', '.sql', '.csv', '.log', '.ini', '.conf', '.env', '.svg']);
const absolutePath = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
const textPath = value => absolutePath(value) && (TEXT_EXTENSIONS.has(path.posix.extname(value).toLowerCase()) || /^(?:README|LICENSE|Dockerfile|Makefile|\.gitignore|\.env)$/i.test(path.posix.basename(value)));

function nativeView(rule, tool, compatibilityName) {
  const string = { type: 'string' }, properties = { Path: { type: 'string', minLength: 1 } };
  let required, description;
  if (rule.operation === 'read') {
    Object.assign(properties, { StartLine: { type: 'integer', minimum: 1 }, EndLine: { type: 'integer', minimum: 1 } });
    required = ['Path', 'StartLine', 'EndLine'];
    description = `Read an explicit inclusive 1-indexed text range of at most 800 lines. Use absolute paths to ordinary text/source files. Images, PDF/document extraction, byte offsets, unrestricted/default reads and large-read switches use ${compatibilityName}. This is a parameter view of the client's file reader: its byte limits, output formatting, permissions and observation rules remain in force; it does not implement the official executor's 46080-byte truncation.`;
  } else if (rule.operation === 'write') {
    Object.assign(properties, { Content: string, Overwrite: { type: 'boolean', description: 'Must be true: this view creates or completely replaces the file.' } });
    required = ['Path', 'Content', 'Overwrite'];
    description = `Create or completely replace a file. Overwrite must be true. Append and artifact metadata are not supported by this view. The client retains all read-before-write, permission, changed-file detection and syntax-check rules; use ${compatibilityName} for additional client parameters.`;
  } else {
    Object.assign(properties, { Target: { type: 'string', minLength: 1 }, Replacement: string });
    required = ['Path', 'Target', 'Replacement'];
    description = `Replace every exact occurrence of Target with Replacement in an existing file. The client's replace_all=true operation executes this call, preserving its permissions and read-before-edit rules. Unique-only replacement or permission options use ${compatibilityName}.`;
  }
  description += '\nUnderlying client execution constraints (all remain applicable):\n' + (tool.description || '');
  const schema = { type: 'object', properties, required, additionalProperties: false };
  return { name: `${rule.operation}_file`, description, schema, nativeSchema: projectSimple(schema).wire, kind: 'function' };
}

function toNative(input, rule) {
  if (!object(input) || !absolutePath(input[rule.pathField])) return null;
  const keys = rule.operation === 'read' ? [rule.pathField, 'offset', 'limit'] : rule.operation === 'write' ? [rule.pathField, 'content'] : [rule.pathField, 'old_string', 'new_string', 'replace_all'];
  if (Object.keys(input).some(key => !keys.includes(key))) return null;
  if (rule.operation === 'read') {
    if (!textPath(input[rule.pathField]) || !Number.isSafeInteger(input.offset) || input.offset < 1 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 800) return null;
    const end = input.offset + input.limit - 1; if (!Number.isSafeInteger(end)) return null;
    return { Path: input[rule.pathField], StartLine: input.offset, EndLine: end };
  }
  if (rule.operation === 'write') return { Path: input[rule.pathField], Content: input.content, Overwrite: true };
  if (input.replace_all !== true || typeof input.old_string !== 'string' || !input.old_string || input.old_string === input.new_string) return null;
  return { Path: input[rule.pathField], Target: input.old_string, Replacement: input.new_string };
}

function fromNative(args, rule) {
  if (!absolutePath(args.Path)) fail('官方参数视图要求绝对文件路径。');
  if (rule.operation === 'read') {
    const limit = args.EndLine - args.StartLine + 1;
    if (!textPath(args.Path) || !Number.isSafeInteger(args.StartLine) || !Number.isSafeInteger(args.EndLine) || args.StartLine < 1 || limit < 1 || limit > 800) fail('读取范围不属于已验证的文本能力视图，请使用完整兼容工具。');
    return { [rule.pathField]: args.Path, offset: args.StartLine, limit };
  }
  if (rule.operation === 'write') {
    if (args.Overwrite !== true) fail('该客户端只能通过此视图创建或完整覆盖文件，Overwrite 必须为 true。');
    return { [rule.pathField]: args.Path, content: args.Content };
  }
  if (!args.Target || args.Target === args.Replacement) fail('精确替换必须提供非空且发生改变的目标。');
  return { [rule.pathField]: args.Path, old_string: args.Target, new_string: args.Replacement, replace_all: true };
}

function replaceCall(call, name, args, source) {
  const result = { ...call, name, arguments: args };
  if (own(call, 'args')) result.args = args;
  if (source.kind === 'custom') { result.kind = 'custom'; result.input = args.input; }
  else {
    if (own(call, 'kind')) result.kind = 'function';
    if (own(call, 'input')) result.input = args;
  }
  return result;
}

function* prepareAntigravityToolsSteps(normalized, options = {}) {
  const compiler = options.schemaCompiler || compileSchema;
  const run = options.runSteps || runSync;
  const tools = normalized.tools || [], sourceTools = options.sourceTools || tools;
  const sources = new Map(), clients = new Map(), providers = new Map(), prepared = [], records = [], serviceInstructions = [];
  for (const source of sourceTools) {
    if (!source || typeof source.name !== 'string' || !source.name || sources.has(source.name)) fail('工具名称为空或重复。', { code: 'invalid_tool_declaration', status: 400 });
    // Bound and validate schemas before full fingerprint traversal as well as
    // before declaration projection (including recognized-profile requests).
    yield compiler(source.schema);
    sources.set(source.name, source);
  }
  const reserved = new Set();
  function allocate(clientName, suffix = '') {
    const hash = digest(clientName + '\0' + suffix);
    for (let length = 16; length <= hash.length; length += 8) {
      const name = `mcp_gateway_tool_${hash.slice(0, length)}${suffix ? '_' + suffix : ''}`;
      if (!reserved.has(name)) { reserved.add(name); return name; }
    }
    return fail('无法为工具分配无冲突名称。', { code: 'tool_name_collision', status: 400 });
  }
  const rules = new Map(), nativeCounts = new Map();
  for (const tool of tools) {
    const source = sources.get(tool.name); if (!source) fail('缺少工具原始契约。', { code: 'missing_tool_contract', status: 400 });
    const rule = recognizedRule(source, normalized, options);
    if (rule) { rules.set(tool.name, rule); nativeCounts.set(rule.operation, (nativeCounts.get(rule.operation) || 0) + 1); }
  }

  for (const tool of tools) {
    if (clients.has(tool.name)) fail('工具名称重复。', { code: 'invalid_tool_declaration', status: 400 });
    const modelService = trustedModelServiceDefinition(sources.get(tool.name), tool);
    const source = clone(sources.get(tool.name));
    source.schema = source.schema === undefined ? { type: 'object' } : source.schema;
    source.kind ||= 'function';
    if (!['function', 'custom'].includes(source.kind)) fail('不支持此工具种类。', { code: 'unsupported_tool_type', status: 400 });
    const validator = yield compiler(source.schema);
    const checkCustom = customValidator(source, options);
    const executionOwner = modelService ? 'Gateway model-service tool' : 'Client-executed tool';
    const contract = { source, validator, checkCustom, views: [], rule: rules.get(tool.name) };
    const projected = !modelService && object(source.schema) && source.schema.type === 'object' && !own(source.schema.properties || {}, 'toolSummary') ? projectSimple(source.schema) : null;
    const needsJSON = !modelService && (!projected || !projected.complete);
    const jsonName = needsJSON ? allocate(tool.name, 'json') : null;
    const directName = projected ? allocate(tool.name) : null;
    contract.fullName = modelService?.declaration.name || jsonName || directName;
    function* register(declaration, mode) {
      const view = { declaration, mode, contract, validator: yield compiler(declaration.schema) };
      if (providers.has(declaration.name)) fail('上游工具名称冲突。', { code: 'tool_name_collision', status: 400 });
      providers.set(declaration.name, view); contract.views.push(view); prepared.push(declaration);
    }
    if (modelService) {
      const declaration = modelService.declaration;
      reserved.add(declaration.name);
      yield* register({ name: declaration.name, description: declaration.description, kind: 'function',
        schema: modelService.schema, nativeSchema: declaration.parameters }, 'native-service');
      serviceInstructions.push(`Gateway model service ${declaration.name}:\n${modelService.instructions}`);
    }
    if (projected) {
      const schema = clone(projected.local), nativeSchema = clone(projected.wire);
      schema.properties.toolSummary = { type: 'string', description: SUMMARY };
      nativeSchema.properties.toolSummary = { type: 'STRING', description: SUMMARY };
      schema.required = [...(schema.required || []), 'toolSummary']; nativeSchema.required = [...(nativeSchema.required || []), 'toolSummary'];
      const extra = needsJSON ? ` Undeclared extra business fields use ${jsonName}; toolSummary is transport metadata only in this view.` : ' toolSummary is transport metadata only in this view.';
      yield* register({ name: directName, kind: 'function', description: `${executionOwner} in the gateway MCP compatibility namespace.${extra}\n${tool.description || ''}`, schema, nativeSchema }, 'mcp-direct');
    }
    if (needsJSON) {
      const schema = { type: 'object', properties: { argumentsJson: { type: 'string', description: 'One complete JSON value conforming to the original client schema below. Preserve all business fields, including any field named toolSummary.' }, toolSummary: { type: 'string', description: SUMMARY } }, required: ['argumentsJson', 'toolSummary'], additionalProperties: false };
      yield* register({ name: jsonName, kind: 'function', description: `${executionOwner} in the gateway MCP compatibility namespace. Decode argumentsJson once; no business fields are removed.\n${tool.description || ''}\nComplete original JSON Schema (validated locally before execution):\n${JSON.stringify(source.schema)}`, schema, nativeSchema: projectSimple(schema).wire }, 'mcp-json');
    }
    if (contract.rule && nativeCounts.get(contract.rule.operation) === 1) {
      const declaration = nativeView(contract.rule, tool, contract.fullName);
      reserved.add(declaration.name); yield* register(declaration, 'native');
    }
    clients.set(tool.name, contract);
    records.push({ clientName: tool.name, clientKind: source.kind, fingerprint: fingerprint(source), clientSchema: clone(source.schema),
      ...(source.clientName != null ? { clientWireName: source.clientName } : {}),
      ...(source.namespace != null ? { clientNamespace: source.namespace } : {}),
      ...(source.format ? { clientFormat: clone(source.format) } : {}), compatibilityName: contract.fullName,
      profile: contract.rule ? { client: contract.rule.client, templateVersion: VERSIONS[contract.rule.client] } : null,
      views: contract.views.map(view => ({ name: view.declaration.name, mode: view.mode })),
      ...(contract.rule && nativeCounts.get(contract.rule.operation) > 1 ? { nativeOmitted: 'ambiguous-native-name' } : {}) });
  }

  function getClient(name) {
    const contract = clients.get(name); if (!contract) fail(`客户端没有声明工具：${name}`, { code: 'unknown_client_tool', status: 400 });
    return contract;
  }
  function getProvider(name) {
    const view = providers.get(name); if (!view) fail(`上游调用了未声明的工具：${name}`, { code: 'invalid_tool_call' });
    return view;
  }
  function* validateSource(args, contract, status) {
    yield* validate(args, contract.validator, status);
    if (contract.checkCustom && (typeof args?.input !== 'string' || !contract.checkCustom(args.input))) fail('自定义工具字符串不符合已验证的格式约束。', { status });
    if (contract.source.name === 'DeferredToolPlaceholder' && contract.source.description === 'Reserved placeholder that keeps deferred tool loading active; never call this tool.') fail('客户端延迟工具占位项不可执行。', { code: 'non_executable_tool', status });
  }
  function* toClient(call) {
    const view = getProvider(call.name), contract = view.contract;
    const args = parseJSON(own(call, 'arguments') ? call.arguments : call.args);
    yield* validate(args, view.validator);
    let decoded;
    if (view.mode === 'native-service') decoded = args;
    else if (view.mode === 'native') decoded = fromNative(args, contract.rule);
    else if (view.mode === 'mcp-json') decoded = parseJSON(args.argumentsJson);
    else decoded = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'toolSummary'));
    serialize(decoded, 502); yield* validateSource(decoded, contract, 502);
    return replaceCall(call, contract.source.name, decoded, contract.source);
  }
  function* toProvider(call) {
    const contract = getClient(call.name);
    let args = own(call, 'arguments') ? call.arguments : own(call, 'args') ? call.args : call.input;
    if (contract.source.kind === 'custom' && typeof call.input === 'string') args = { input: call.input };
    else if (contract.source.kind === 'custom' && typeof args === 'string') args = { input: args };
    // Normalized arguments can themselves be a JSON string value. Prefer
    // that valid client value; only parse a serialized function envelope when
    // a string is not admitted by the original schema.
    else if (typeof args === 'string' && !(yield contract.validator(args))) args = parseJSON(args, 400);
    serialize(args, 400); yield* validateSource(args, contract, 400);
    const service = contract.views.find(view => view.mode === 'native-service');
    if (service) return replaceCall(call, service.declaration.name, args, { kind: 'function' });
    const native = contract.views.find(view => view.mode === 'native');
    const candidate = native && toNative(args, contract.rule);
    if (candidate) return replaceCall(call, native.declaration.name, candidate, { kind: 'function' });
    const direct = contract.views.find(view => view.mode === 'mcp-direct');
    if (direct && object(args) && !own(args, 'toolSummary')) {
      const input = { ...args, toolSummary: 'Client tool request' };
      if (yield direct.validator(input)) return replaceCall(call, direct.declaration.name, input, { kind: 'function' });
    }
    const wrapped = contract.views.find(view => view.mode === 'mcp-json');
    if (!wrapped) fail('工具参数不属于任何已声明的可逆能力视图。', { status: 400 });
    return replaceCall(call, wrapped.declaration.name, { argumentsJson: serialize(args), toolSummary: 'Client tool request' }, { kind: 'function' });
  }

  const toProviderNames = name => getClient(name).views.map(view => view.declaration.name);
  const toClientName = name => getProvider(name).contract.source.name;
  const toProviderName = name => getClient(name).fullName;
  function references(items, direction) {
    if (!Array.isArray(items)) fail('工具引用必须为数组。', { code: 'invalid_tool_reference', status: 400 });
    const mapped = items.flatMap(item => {
      const name = typeof item === 'string' ? item : item?.tool_name ?? item?.name;
      if (typeof name !== 'string') fail('工具引用缺少名称。', { code: 'invalid_tool_reference', status: 400 });
      const names = direction === 'provider' ? toProviderNames(name) : [toClientName(name)];
      return names.map(mapped => typeof item === 'string' ? mapped : { ...item, [own(item, 'tool_name') ? 'tool_name' : 'name']: mapped });
    });
    return direction === 'client' ? [...new Map(mapped.map(item => [stable(item), item])).values()] : mapped;
  }
  function toProviderResult(result, issuedCall) {
    const issuedName = typeof issuedCall === 'string' ? issuedCall : issuedCall?.name;
    let view;
    if (issuedName) view = getProvider(issuedName);
    else if (result.name) {
      const contract = getClient(result.name);
      if (contract.views.length !== 1) fail('此工具有多个上游视图；结果必须关联当时发出的上游调用。', { code: 'missing_provider_tool_identity', status: 400 });
      view = contract.views[0];
    } else fail('工具结果缺少关联调用。', { code: 'missing_provider_tool_identity', status: 400 });
    if (result.name && result.name !== view.contract.source.name) fail('工具结果与关联调用的名称不一致。', { code: 'tool_result_mismatch', status: 400 });
    if (typeof issuedCall === 'object' && result.id && issuedCall.id && result.id !== issuedCall.id) fail('工具结果与关联调用的 ID 不一致。', { code: 'tool_result_mismatch', status: 400 });
    return { ...result, name: view.declaration.name, ...(result.references ? { references: references(result.references, 'provider') } : {}) };
  }
  function toClientResult(result) {
    const source = getProvider(result.name).contract.source;
    return { ...result, name: source.name, ...(result.references ? { references: references(result.references, 'client') } : {}) };
  }
  let toolChoice = normalized.toolChoice;
  const choiceName = toolChoice?.name || toolChoice?.function?.name;
  if (choiceName) {
    const mapped = toProviderName(choiceName);
    toolChoice = { ...toolChoice, ...(toolChoice.name ? { name: mapped } : {}), ...(toolChoice.function ? { function: { ...toolChoice.function, name: mapped } } : {}) };
  }
  const guide = records.length ? 'Tool reference index (names mentioned by the client refer to these declared functions; execute tools only through their declarations):\n'
    + records.map(record => `${record.clientNamespace != null ? JSON.stringify({ namespace: record.clientNamespace, name: record.clientWireName }) : JSON.stringify(record.clientWireName ?? record.clientName)}: ${record.views.map(view => `${view.name} (${view.mode})`).join(', ')}`).join('\n') : '';
  return { version: VERSION, normalized: tools.length ? { ...normalized, tools: prepared, toolChoice } : normalized,
    adapted: tools.length > 0, records, instructions: [guide, ...serviceInstructions].filter(Boolean).join('\n\n'),
    declarations: prepared.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.nativeSchema })),
    toClient: call => run(toClient(call)), toProvider: call => run(toProvider(call)), toProviderName, toProviderNames, toClientName,
    toProviderReferences: items => references(items, 'provider'), toClientReferences: items => references(items, 'client'),
    toProviderResult, toClientResult,
    resultContract: name => ({ clientName: getProvider(name).contract.source.name, clientKind: getProvider(name).contract.source.kind,
      successField: 'output', errorField: 'error', timestamps: 'not-generated', media: 'preserve' }) };
}

function prepareAntigravityTools(normalized, options = {}) { return runSync(prepareAntigravityToolsSteps(normalized, options)); }
function prepareAntigravityToolsAsync(normalized, options = {}) {
  return runAsync(prepareAntigravityToolsSteps(normalized, { ...options, runSteps: runAsync,
    schemaCompiler: schema => compileSchemaAsync(schema, options.schemaOptions || { signal: options.signal }) }));
}

module.exports = { prepareAntigravityTools, prepareAntigravityToolsAsync, ToolContractError, projectSimple, fingerprint, validPatch, APPLY_PATCH_GRAMMAR, VERSION };
