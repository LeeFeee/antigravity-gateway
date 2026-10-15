'use strict';

const crypto = require('node:crypto');
const http2 = require('node:http2');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { RobinConversationStore } = require('./robin-conversations');
const { robinCredentialFingerprint } = require('./robin-auth');
const { robinQuotaSnapshot } = require('./robin-quota');
const { responseMetadata, conversationTurnFrames } = require('./robin-response');
const {
  GrpcFrameDecoder,
  boolField,
  bytesField,
  concatFields,
  decodeProtoStruct,
  decodeFields,
  firstField,
  grpcFrame,
  intField,
  messageField,
  protoStruct,
  stringField,
  stringValue
} = require('./robin-proto');

const ROBIN_ORIGIN = 'https://robinfrontend-pa.googleapis.com';
const ROBIN_UPLOAD_ORIGIN = 'https://push.clients6.google.com/upload/';
const ROBIN_UPLOAD_PUSH_ID = 'feeds/mcudyrk2a4khkz';
const PROCESS_QUERY_PATH = '/$rpc/assistant.mobile.robin.RobinService/ProcessQuery';
const PROCESS_FILE_PATH = '/$rpc/assistant.mobile.robin.RobinService/ProcessFile';
const GET_USER_STATUS_PATH = '/$rpc/assistant.mobile.robin.RobinService/GetUserStatus';
const GET_USAGE_INFO_PATH = '/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo';
const GET_CONVERSATION_TURN_PATH = '/$rpc/assistant.mobile.robin.RobinService/GetConversationTurn';
const EXECUTE_REMOTE_TOOLS_PATH = '/$rpc/assistant.mobile.robin.notify.GeminiNotifyService/ExecuteRemoteTools';
const REGISTER_DEVICE_PATH = '/assistant.mobile.robin.notify.GeminiNotifyService/RegisterDevice';
const ARGON_MODEL = 'gemini-4-argon';
const ARGON_MODE_VARIANT_ID = '95a4c0abcba24364';
const TASK_FEATURE_MODE = 41;
const ROBIN_CLIENT_VERSION = '1.128.14.1166';
const ROBIN_CLIENT_CAPABILITIES = Buffer.from(
  'ErQCAQpPaPYC9ATDBCRV2gKtA8cDCGGwAmTXAkT7BE6uAskD+wPoBecF8AX7BdgCYoMBY8ACTa8CYFzsAvICvQKbAsIDZcMDUbgCoQKHA4MDwQL1AtEDB5QCiQOLA7ADtAO9A7UDjAOWA6gDqwPuA5UEyASLBK4EwgShA7sDwAPqBO8EpgThAt4ClwPMA8gDiAO6AuQC5QLgApEEqwTPA6UD5gPgA5MEzwScBL0ExAS/AlBGAgUEBgOeBOcE9gSHBYIB1gX8BP0D/wPpBIABgQEC1QKiAvAD7gTRApMD6gLrAsIC4gLcBYQHhweRB7oFnwWMBesF8QWMBB/cBiEiHpQHhQX/BIYF5gavBvYGpQWxBsMGR8sFzgXPBe8FiQbpBokHjwXUBakG9Aa4BacGnAenB6MGiAY=',
  'base64'
);
const ROBIN_DEVICE_PROFILE = Buffer.from('+wLTA8MD+gOMBMUD', 'base64');
const ROBIN_TURN_TTL_MS = Math.max(60_000, Number(process.env.ANTIGRAVITY_ROBIN_TURN_TTL_SECONDS || 30 * 60) * 1000);
const ROBIN_MAX_ACTIVE_TURNS = Math.max(8, Number(process.env.ANTIGRAVITY_ROBIN_MAX_ACTIVE_TURNS || 512));
const ROBIN_UPLOAD_CACHE_TTL_MS = Math.max(60_000, Number(process.env.ANTIGRAVITY_ROBIN_UPLOAD_CACHE_TTL_SECONDS || 20 * 60 * 60) * 1000);
const ROBIN_MAX_UPLOAD_BYTES = Math.max(1024, Number(process.env.ANTIGRAVITY_ROBIN_MAX_UPLOAD_BYTES || 200 * 1024 * 1024));
const ROBIN_REGISTER_TIMEOUT_MS = 30_000;
const ROBIN_METADATA_TIMEOUT_MS = 30_000;
const ROBIN_REQUEST_TIMEOUT_MS = Number(process.env.ANTIGRAVITY_GATEWAY_TIMEOUT_MS || 300_000);
const ROBIN_RECOVERY_PHASE_TIMEOUT_MS = Number.isFinite(ROBIN_REQUEST_TIMEOUT_MS) && ROBIN_REQUEST_TIMEOUT_MS > 0
  ? ROBIN_REQUEST_TIMEOUT_MS : 300_000;
const ROBIN_RECOVERY_MAX_POLLS = Math.max(1, Math.ceil(ROBIN_RECOVERY_PHASE_TIMEOUT_MS / 2000));

class RobinProviderError extends Error {
  constructor(message, { code = 'robin_upstream_error', status = 502, details = '' } = {}) {
    super(message);
    this.name = 'RobinProviderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function waitForSharedOperation(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function grpcHeaders(token, extraHeaders = {}) {
  return {
    ':method': 'POST',
    authorization: `Bearer ${token}`,
    'content-type': 'application/grpc',
    te: 'trailers',
    'user-agent': 'grpc-c++/1.70.0',
    'x-ios-bundle-identifier': 'com.google.GeminiMacOS',
    'accept-language': 'zh_CN',
    ...extraHeaders
  };
}

function grpcStatusError(status, message, httpStatus = 0) {
  const grpc = Number(status);
  // gRPC errors normally arrive over HTTP 200. The envelope status must never
  // turn a failed RPC into a successful HTTP response to the connected agent.
  // https://grpc.io/docs/guides/status-codes/
  const mapping = {
    1: [499, 'request_aborted'],
    3: [400, 'robin_invalid_argument'],
    4: [504, 'robin_deadline_exceeded'],
    5: [404, 'robin_not_found'],
    6: [409, 'robin_already_exists'],
    7: [403, 'robin_permission_denied'],
    8: [429, 'robin_quota_error'],
    9: [412, 'robin_failed_precondition'],
    10: [409, 'robin_conflict'],
    11: [400, 'robin_out_of_range'],
    12: [501, 'robin_unimplemented'],
    14: [503, 'robin_unavailable'],
    16: [401, 'robin_auth_error']
  };
  const [mappedStatus, code] = mapping[grpc] || [httpStatus >= 400 ? httpStatus : 502, 'robin_upstream_error'];
  return new RobinProviderError(`Gemini Robin 请求失败：${message || `gRPC ${status}`}`, {
    code, status: mappedStatus, details: message || ''
  });
}

class RobinGrpcTransport {
  constructor({ origin = ROBIN_ORIGIN, connectImpl = http2.connect } = {}) {
    this.origin = origin;
    this.connectImpl = connectImpl;
  }

  request(path, token, { signal, onMessage, headers } = {}) {
    const client = this.connectImpl(this.origin);
    const request = client.request({ ...grpcHeaders(token, headers), ':path': path });
    const decoder = new GrpcFrameDecoder();
    let httpStatus = 0;
    let grpcStatus = '';
    let grpcMessage = '';
    const messages = [];
    let settled = false;
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const close = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (!error && grpcStatus && grpcStatus !== '0') error = grpcStatusError(grpcStatus, grpcMessage, httpStatus);
      if (!error && httpStatus && (httpStatus < 200 || httpStatus >= 300)) error = new RobinProviderError(
        `Gemini Robin HTTP 请求失败：${httpStatus}`,
        { code: httpStatus === 401 || httpStatus === 403 ? 'robin_auth_error' : 'robin_upstream_error', status: httpStatus }
      );
      if (!error) {
        try {
          decoder.finish();
          if (grpcStatus !== '0') throw new Error('missing gRPC completion status');
        } catch (cause) {
          error = new RobinProviderError(`Gemini Robin 响应不完整：${cause.message}`, { code: 'robin_protocol_error', status: 502 });
        }
      }
      if (error) { try { request.close(http2.constants.NGHTTP2_CANCEL); } catch { /* already closed */ } }
      try { client.close(); } catch { /* already closed */ }
      if (error) rejectDone(error);
      else resolveDone(messages);
    };
    const abort = () => {
      const error = signal?.reason || new RobinProviderError('Gemini Robin 请求已取消。', { code: 'request_aborted', status: 499 });
      try { request.close(http2.constants.NGHTTP2_CANCEL); } catch { /* best effort */ }
      close(error);
    };
    request.on('response', (headers) => {
      httpStatus = Number(headers[':status'] || 0);
      grpcStatus = String(headers['grpc-status'] ?? grpcStatus);
      grpcMessage = safeDecodeGrpcMessage(headers['grpc-message'] ?? grpcMessage);
    });
    request.on('trailers', (headers) => {
      grpcStatus = String(headers['grpc-status'] ?? grpcStatus);
      grpcMessage = safeDecodeGrpcMessage(headers['grpc-message'] ?? grpcMessage);
    });
    request.on('data', (chunk) => {
      if (settled) return;
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.compressed) throw new RobinProviderError('Robin 返回了暂不支持的压缩 gRPC 帧。');
          messages.push(frame.data);
          onMessage?.(frame.data);
        }
      } catch (error) {
        close(error instanceof RobinProviderError ? error : new RobinProviderError(`Gemini Robin 响应处理失败：${error.message}`, {
          code: 'robin_protocol_error', status: 502
        }));
      }
    });
    request.on('end', () => close());
    request.on('close', () => {
      if (!settled) close(new RobinProviderError('Gemini Robin 连接在响应完成前关闭。', { code: 'robin_network_error', status: 503 }));
    });
    request.on('error', (error) => close(new RobinProviderError(`Gemini Robin 网络请求失败：${error.message}`, {
      code: 'robin_network_error', status: 503, details: error.message
    })));
    client.on('error', (error) => close(new RobinProviderError(`Gemini Robin 连接失败：${error.message}`, {
      code: 'robin_network_error', status: 503, details: error.message
    })));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    return {
      write: (message) => request.write(grpcFrame(message)),
      end: (message) => {
        if (message) request.end(grpcFrame(message));
        else request.end();
      },
      close: abort,
      done
    };
  }

  async unary(path, token, message = Buffer.alloc(0), options = {}) {
    const stream = this.request(path, token, options);
    stream.end(message);
    const messages = await stream.done;
    return messages[0] || Buffer.alloc(0);
  }
}

function safeDecodeGrpcMessage(value) {
  const message = String(value ?? '');
  try { return decodeURIComponent(message); }
  catch { return message; }
}

function robinUploadError(status, stage) {
  const code = status === 401 || status === 403 ? 'robin_auth_error'
    : status === 429 ? 'robin_quota_error'
      : status >= 500 ? 'robin_unavailable'
        : 'robin_upload_error';
  return new RobinProviderError(`Gemini 文件${stage}失败：HTTP ${status || 0}`, {
    code,
    status: status === 401 || status === 403 ? status : status === 429 ? 429 : 502
  });
}

function robinTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

function clientEnvironment(deviceId) {
  const platform = concatFields([
    stringField(1, '15'),
    stringField(2, '15.7.0'),
    stringField(3, ROBIN_CLIENT_VERSION),
    stringField(4, 'CN'),
    stringField(7, 'com.google.GeminiMacOS'),
    stringField(8, 'prod')
  ]);
  return concatFields([
    stringField(1, ROBIN_CLIENT_VERSION),
    messageField(2, concatFields([
      intField(1, 12),
      messageField(13, platform)
    ])),
    intField(6, 0),
    stringField(9, 'prod'),
    stringField(17, deviceId)
  ]);
}

function requestMetadata({ deviceId, modeVariantId = ARGON_MODE_VARIANT_ID, timezone = robinTimezone() } = {}) {
  return concatFields([
    messageField(3, clientEnvironment(deviceId)),
    intField(4, 21), // MACOS
    intField(5, 1), // full-screen Gemini surface
    messageField(6, ROBIN_CLIENT_CAPABILITIES),
    stringField(7, 'zh-CN'),
    messageField(10, intField(1, 4)),
    stringField(16, modeVariantId),
    messageField(19, stringField(1, timezone)),
    intField(20, 2)
  ]);
}

function continuationMetadata(deviceId, timezone = robinTimezone()) {
  return concatFields([
    messageField(4, stringField(1, timezone)),
    stringField(12, `\n$${deviceId}`)
  ]);
}

function desktopDeviceInfo(deviceId, name = 'CONNECTED CLIENT', { workspacePaths = [], includeMode = true } = {}) {
  const fields = [stringField(1, name)];
  for (const workspacePath of workspacePaths) {
    if (workspacePath) fields.push(messageField(3, stringField(1, String(workspacePath))));
  }
  fields.push(
    stringField(6, deviceId),
    bytesField(7, ROBIN_DEVICE_PROFILE),
    intField(8, 0),
    messageField(9, includeMode
      ? concatFields([intField(1, 0), intField(2, 2)])
      : intField(1, 0))
  );
  return concatFields(fields);
}

function clientDevice(deviceId, name = 'CONNECTED CLIENT', workspacePaths = []) {
  return concatFields([
    stringField(1, deviceId),
    stringField(2, name),
    messageField(3, desktopDeviceInfo(deviceId, name, { workspacePaths })),
    intField(5, 1)
  ]);
}

function registerDeviceRequest({
  deviceId,
  name = 'CONNECTED CLIENT',
  modeVariantId = ARGON_MODE_VARIANT_ID,
  workspacePaths = []
} = {}) {
  return concatFields([
    messageField(1, requestMetadata({ deviceId, modeVariantId })),
    messageField(4, stringField(1, ROBIN_CLIENT_VERSION)),
    messageField(5, desktopDeviceInfo(deviceId, name, { workspacePaths, includeMode: false }))
  ]);
}

function compactJson(value) {
  try { return JSON.stringify(value); }
  catch { return 'null'; }
}

function robinTaskText(normalized) {
  const sections = [];
  if (normalized?.system) sections.push(`SYSTEM INSTRUCTIONS\n${normalized.system}`);
  const transcript = (normalized?.messages || []).map((message) => {
    const role = String(message?.role || 'user').toUpperCase();
    return `${role}\n${String(message?.text || '')}`;
  }).filter((value) => value.trim()).join('\n\n');
  if (transcript) sections.push(`CONVERSATION\n${transcript}`);

  const choice = normalized?.toolChoice;
  if (choice === 'none' || choice?.type === 'none') {
    sections.push('Do not request a connected client tool for this turn.');
  } else {
    if (normalized?.tools?.length) {
      sections.push('Connected client tools are available through the external_client MCP server. When a client tool is needed, use execute_mcp with server_name "external_client", the exact tool_name, and arguments matching its input schema. Do not substitute a similarly named local tool.');
    }
    if (['required', 'any'].includes(choice) || ['required', 'any'].includes(choice?.type)) {
      sections.push('Use at least one connected client tool before completing this turn.');
    }
    const requiredName = choice?.name || choice?.function?.name;
    if (requiredName) sections.push(`Use the connected client tool named ${JSON.stringify(requiredName)} through the external_client MCP server before completing this turn.`);
  }
  if (!normalized?.tools?.length) {
    sections.push('No connected client tools are available for this turn. Complete the request using only the supplied messages and attachments.');
  }
  if (normalized?.structuredSchema) {
    sections.push(`Return only one JSON value conforming to this schema, without Markdown fences or commentary:\n${compactJson(normalized.structuredSchema)}`);
  }
  if (normalized?.autoMode) {
    const root = normalized.autoModeFormat === 'severity' ? 'severity' : 'block';
    sections.push(`Follow the supplied XML decision contract exactly. Return XML only, beginning with <${root}>.`);
  }
  return sections.join('\n\n').trim();
}

function robinAttachment(part, index = 0) {
  if (part?.type !== 'media' || !part.robinBlobId) return null;
  const mimeType = String(part.mediaType || 'application/octet-stream');
  const name = String(part.filename || part.fileId || part.id || `attachment-${index + 1}`);
  const blob = concatFields([
    stringField(1, part.robinBlobId),
    intField(2, robinFileType(mimeType, name)),
    stringField(3, mimeType),
    intField(4, 1), // FILE_SOURCE_USER_UPLOADED
    stringField(5, part.robinCacheKey || '')
  ]);
  return concatFields([
    messageField(1, blob),
    stringField(2, name),
  ]);
}

function robinFileType(mimeType, filename = '') {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  if (mime.startsWith('image/')) return 1;
  if (mime.startsWith('video/')) return 2;
  if (mime.startsWith('audio/')) return 4;
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 11;
  if (mime.includes('json') || name.endsWith('.json')) return 5;
  if (mime.includes('spreadsheet') || mime.includes('excel') || /\.(?:xls|xlsx)$/.test(name)) return 7;
  if (mime.includes('wordprocessingml') || /\.(?:doc|docx)$/.test(name)) return 10;
  if (mime.includes('presentationml') || /\.(?:ppt|pptx)$/.test(name)) return 12;
  if (mime.startsWith('text/') || /\.(?:txt|md|csv|html?)$/.test(name)) return 3;
  return 0;
}

function robinUserQuery(normalized) {
  const fields = [stringField(1, robinTaskText(normalized))];
  let index = 0;
  for (const message of normalized?.messages || []) {
    for (const part of message?.parts || []) {
      const media = part?.type === 'tool_result' ? part.media || [] : [part];
      for (const item of media) {
        const attachment = robinAttachment(item, index);
        if (!attachment) continue;
        fields.push(messageField(3, attachment));
        index += 1;
      }
    }
  }
  return concatFields(fields);
}

function clientGenerateRequest(normalized, {
  deviceId = crypto.randomUUID().toUpperCase(),
  deviceName = 'CONNECTED CLIENT',
  workspacePaths = [],
  modeVariantId = ARGON_MODE_VARIANT_ID,
  requestIdentifiers,
  confirmationPrompt,
  timezone = robinTimezone()
} = {}) {
  const confirming = typeof confirmationPrompt === 'string';
  const query = messageField(1, confirming ? stringField(1, confirmationPrompt) : robinUserQuery(normalized));
  const identifiers = concatFields([
    bytesField(1, Buffer.from(requestIdentifiers?.conversationId || '')),
    bytesField(2, Buffer.from(requestIdentifiers?.parentRequestId || '')),
    bytesField(3, Buffer.from(requestIdentifiers?.parentResponseId || ''))
  ]);
  return concatFields([
    query,
    messageField(4, identifiers),
    boolField(5, true),
    messageField(6, intField(1, 1)),
    messageField(8, intField(1, 1)),
    messageField(16, bytesField(1004, continuationMetadata(deviceId, timezone))),
    intField(17, 2),
    intField(18, 1),
    intField(26, TASK_FEATURE_MODE),
    // Native card actions are control input, not a replay of user/system text.
    confirming ? messageField(30, intField(1, 5)) : Buffer.alloc(0), // PromptSource.ACTION_BLOCKS
    confirming ? boolField(45, true) : Buffer.alloc(0),
    intField(47, 8),
    boolField(49, true),
    messageField(51, clientDevice(deviceId, deviceName, workspacePaths)),
    intField(56, 0)
  ]);
}

function processQueryInitial(normalized, {
  deviceId = crypto.randomUUID().toUpperCase(),
  deviceName = 'CONNECTED CLIENT',
  workspacePaths = [],
  requestIdentifiers,
  confirmationPrompt
} = {}, modeVariantId) {
  const timezone = robinTimezone();
  const initial = concatFields([
    messageField(1, requestMetadata({ deviceId, modeVariantId, timezone })),
    stringField(2, `\n$${crypto.randomUUID().toUpperCase()}`),
    bytesField(1001, messageField(1, clientGenerateRequest(normalized, {
      deviceId, deviceName, workspacePaths, modeVariantId, timezone, requestIdentifiers, confirmationPrompt
    }))),
    bytesField(1004, Buffer.alloc(0)),
    bytesField(1007, Buffer.alloc(0)),
    bytesField(1013, Buffer.alloc(0))
  ]);
  return {
    deviceId,
    timezone,
    message: bytesField(1000, initial)
  };
}

function processQueryDeviceContext({ deviceId, timezone, workspacePaths = [] } = {}) {
  const deviceContextFields = [];
  for (const workspacePath of workspacePaths) {
    if (workspacePath) deviceContextFields.push(messageField(1, stringField(1, String(workspacePath))));
  }
  deviceContextFields.push(messageField(3, intField(1, 0)));
  const metadata = concatFields([
    bytesField(1004, continuationMetadata(deviceId, timezone)),
    bytesField(1033, concatFields(deviceContextFields))
  ]);
  return bytesField(1008, messageField(2, messageField(2, metadata)));
}

function processQueryPrefetch(normalized) {
  const textOnly = {
    ...normalized,
    messages: (normalized?.messages || []).map((message) => ({
      ...message,
      parts: (message?.parts || []).filter((part) => part?.type !== 'media')
        .map((part) => part?.type === 'tool_result' ? { ...part, media: [] } : part)
    }))
  };
  return bytesField(1007, robinUserQuery(textOnly));
}

function processQueryCommit() {
  return bytesField(1007, messageField(2, Buffer.alloc(0)));
}

function remoteToolConnect(sessionRoutingKey, { deviceId = '', routingToken } = {}) {
  const connect = concatFields([
    stringField(1, sessionRoutingKey),
    stringField(2, deviceId),
    routingToken?.length ? bytesField(3, routingToken) : Buffer.alloc(0)
  ]);
  return messageField(1, connect);
}

function continuationIdentifiers(input) {
  if (!input?.length) return null;
  try {
    // Native ProcessQueryResponse extension 1014 is the dedicated
    // ContinuationIdentifiersResponse, whose field 1 holds the identifiers.
    // Never search model text, attachments or ResponseIdentifiers recursively.
    for (const response of decodeFields(input).filter(field => field.number === 1014 && field.wireType === 2)) {
      const wrapper = decodeFields(response.value).find(field => field.number === 1 && field.wireType === 2);
      if (!wrapper) continue;
      const fields = decodeFields(wrapper.value);
      const conversation = fields.find(field => field.number === 1 && field.wireType === 2);
      const conversationId = conversation?.value.toString('utf8') || '';
      if (!/^c_[A-Za-z0-9_-]{8,}$/.test(conversationId)) continue;
      const token = fields.find(field => field.number === 2 && field.wireType === 2)?.value;
      return { conversationId, sessionRoutingKey: conversationId,
        routingToken: token?.length ? Buffer.from(token) : Buffer.alloc(0) };
    }
  } catch { /* Not a valid continuation response. */ }
  return null;
}

function clientFunctionResult(functionResponses) {
  const result = concatFields((functionResponses || []).map((response) => messageField(1, concatFields([
    stringField(1, response.name),
    stringField(2, response.id || ''),
    messageField(3, protoStruct(response.response && typeof response.response === 'object'
      ? response.response
      : { result: response.response ?? '' })),
    // Native FunctionResponse.attachments is repeated UserQueryAttachment.
    // Keep image/file bytes out of the JSON result: the model consumes these
    // as media, not a base64 string inside a text-only tool response.
    ...(response.attachments || []).map((part, index) => robinAttachment(part, index))
      .filter(Boolean).map((attachment) => messageField(4, attachment))
  ]))));
  return messageField(2, result);
}

function remoteToolFailure({ conversationId = '', id, message, code = 2 } = {}) {
  return messageField(3, concatFields([
    stringField(1, conversationId),
    stringField(2, id),
    stringField(3, message || 'Client tool execution failed.'),
    intField(4, code)
  ]));
}

function clientFunctionCalls(input) {
  const calls = [];
  for (const field of decodeFields(input)) {
    if (field.number !== 1 || field.wireType !== 2) continue;
    const values = decodeFields(field.value);
    const name = values.find((item) => item.number === 1 && item.wireType === 2)?.value.toString('utf8') || '';
    const second = values.find((item) => item.number === 2 && item.wireType === 2);
    const third = values.find((item) => item.number === 3 && item.wireType === 2);
    const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
    const secondText = second?.value.toString('utf8') || '';
    const thirdText = third?.value.toString('utf8') || '';
    let id = '';
    let argsField = null;
    if (name === 'list_mcp') {
      // Gemini's built-in list_mcp request carries an empty Struct in field 2
      // and normally has no call ID. Echoing an invented ID makes Robin reject
      // the catalog and ask for it again.
      argsField = second;
      id = identifierPattern.test(thirdText) ? thirdText : '';
    } else if (identifierPattern.test(secondText)) {
      id = secondText;
      argsField = third;
    } else if (identifierPattern.test(thirdText)) {
      id = thirdText;
      argsField = second;
    } else {
      id = '';
      argsField = third || second;
    }
    let args = {};
    if (argsField) {
      try { args = decodeProtoStruct(argsField.value); }
      catch { args = {}; }
    }
    if (name) calls.push({ id, name, arguments: args });
  }
  return calls;
}

function remoteToolEvent(input) {
  const fields = decodeFields(input);
  const conversation = fields.find(field => field.number === 5 && field.wireType === 2)?.value.toString('utf8');
  const connect = fields.find((field) => field.number === 1 && field.wireType === 2);
  if (connect) {
    const values = decodeFields(connect.value);
    return {
      type: 'connected',
      connected: values.find((field) => field.number === 1 && field.wireType === 0)?.value !== 0n,
      sessionId: values.find((field) => field.number === 2 && field.wireType === 2)?.value.toString('utf8') || ''
    };
  }
  const toolCall = fields.find((field) => field.number === 2 && field.wireType === 2);
  if (toolCall) return { type: 'tool_call', calls: clientFunctionCalls(toolCall.value), ...(conversation ? { conversationId: conversation } : {}) };
  if (fields.some((field) => field.number === 3)) return { type: 'session_complete', ...(conversation ? { conversationId: conversation } : {}) };
  return { type: 'unknown' };
}

function normalizedToolResults(normalized) {
  const results = [];
  for (const message of normalized?.messages || []) {
    for (const part of message.parts || []) {
      if (part?.type !== 'tool_result' || !part.id) continue;
      results.push({
        id: String(part.id),
        name: String(part.name || ''),
        response: part.isError ? { error: String(part.content || 'Tool execution failed.') } : { result: String(part.content || '') },
        ...(part.media?.length ? { attachments: part.media } : {}),
        isError: Boolean(part.isError)
      });
    }
  }
  return results;
}

function mcpCatalogResult(tools) {
  return {
    servers: [{
      name: 'external_client',
      description: '<critical_rule>Use client:execute_mcp with server `external_client` for every tool listed by this server. Preserve each tool name and pass arguments that match its input schema.</critical_rule>',
      tools: (tools || []).map((tool) => ({
        name: tool.name,
        description: `${tool.description || ''}${tool.schema ? `\nInput schema: ${compactJson(tool.schema)}` : ''}`.trim(),
        toolAnnotations: {
          destructiveHint: Boolean(tool.annotations?.destructiveHint || tool.destructiveHint)
        }
      }))
    }]
  };
}

function projectedClientCall(call, tools) {
  const names = new Set((tools || []).map((tool) => tool.name));
  if (/^(?:call|execute|run)_?mcp$/i.test(call.name)) {
    const server = call.arguments.server_name || call.arguments.serverName || call.arguments.ServerName;
    if (server && server !== 'external_client') return null;
    const name = call.arguments.tool_name || call.arguments.toolName || call.arguments.ToolName || call.arguments.name;
    const args = call.arguments.arguments || call.arguments.Arguments || call.arguments.args || call.arguments.input || {};
    if (names.has(name)) return {
      ...call,
      id: call.id || crypto.randomUUID(),
      name,
      arguments: args && typeof args === 'object' ? args : {}
    };
    if (name) return null;
  }
  if (names.has(call.name)) return { ...call, id: call.id || crypto.randomUUID() };
  return null;
}

class RobinTurn {
  constructor({
    provider,
    normalized,
    token,
    serverToken,
    authFingerprint,
    sessionId,
    deviceId,
    deviceName,
    workspacePaths,
    modeVariantId,
    requestIdentifiers,
    onAuthUsed,
    signal
  }) {
    this.provider = provider;
    this.normalized = normalized;
    this.token = token;
    this.serverToken = serverToken;
    this.authFingerprint = authFingerprint;
    this.onAuthUsed = onAuthUsed;
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.workspacePaths = workspacePaths;
    this.modeVariantId = modeVariantId;
    this.requestIdentifiers = requestIdentifiers;
    // An HTTP tool-call response ends before the upstream task does. The task
    // owns its streams; only the currently waiting request may cancel it.
    this.controller = new AbortController();
    this.events = [];
    this.waiters = [];
    this.messages = [];
    this.pendingCalls = new Map();
    this.closed = false;
    this.remote = null;
    this.process = null;
    this.remoteStarted = false;
    this.queryGeneration = 0;
    this.remotes = new Set();
    this.acknowledgedConfirmations = new Set();
    this.confirmationResponses = new Set();
    this.upstreamConversationId = '';
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.text = '';
    this.responseId = '';
    this.deliveredText = new Map();
    this.deliveredThinking = new Map();
    this.timer = null;
    this.recoveryWake = null;
    this.touch();
  }

  touch() {
    this.updatedAt = Date.now();
    clearTimeout(this.timer);
    if (!this.closed) {
      this.timer = setTimeout(() => this.destroy(), ROBIN_TURN_TTL_MS);
      this.timer.unref?.();
    }
  }

  emit(event) {
    this.touch();
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(event);
    else this.events.push(event);
  }

  next(signal) {
    if (signal?.aborted) {
      this.fail(signal.reason);
      return Promise.reject(signal.reason);
    }
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        const error = signal.reason || new RobinProviderError('Gemini Robin 请求已取消。', { code: 'request_aborted', status: 499 });
        this.fail(error);
        reject(error);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const originalResolve = waiter.resolve;
      waiter.resolve = (value) => {
        signal?.removeEventListener('abort', abort);
        originalResolve(value);
      };
    });
  }

  startRemote(identifiers) {
    if (this.remoteStarted || this.closed || !identifiers?.sessionRoutingKey) return;
    const conversationId = identifiers.conversationId || identifiers.sessionRoutingKey;
    if (this.upstreamConversationId && conversationId !== this.upstreamConversationId) {
      this.fail(new RobinProviderError('Argon 确认续接返回了不同的原生会话。', { code: 'robin_session_mismatch', status: 409 }));
      return;
    }
    this.remoteStarted = true;
    this.upstreamConversationId = conversationId;
    this.touch();
    const fingerprint = this.authFingerprint;
    const remote = this.provider.transport.request(EXECUTE_REMOTE_TOOLS_PATH, this.token, {
      signal: this.controller.signal,
      headers: { 'x-server-token': this.serverToken },
      onMessage: (message) => {
        if (this.remotes.has(remote)) this.onRemoteMessage(message, remote);
      }
    });
    this.remote = remote;
    this.remotes.add(remote);
    remote.write(remoteToolConnect(identifiers.sessionRoutingKey, { routingToken: identifiers.routingToken }));
    remote.done.then(() => this.remotes.delete(remote), error => {
      if (error && typeof error === 'object' && Object.isExtensible(error)) error.upstreamAuthFingerprint ||= fingerprint;
      this.fail(error);
    });
  }

  async resumeConfirmation(control) {
    const record = await this.provider.auth.get(this.controller.signal);
    if (this.closed) return;
    this.token = record.accessToken;
    this.serverToken = record.serverToken;
    this.authFingerprint = record.credentialFingerprint || robinCredentialFingerprint(this.provider.auth.account);
    this.onAuthUsed?.(this.authFingerprint);
    await this.provider.ensureDeviceRegistered(record, this.controller.signal);
    if (!this.closed) this.start(control);
  }

  async recoverRunningSnapshot(identifiers, generation) {
    let attempts = 0, deadline = Date.now() + ROBIN_RECOVERY_PHASE_TIMEOUT_MS;
    while (!this.closed && generation === this.queryGeneration) {
      if (this.pendingCalls.size) {
        // Client approvals/tools may take time. Do not poll their unfinished
        // task, replay a call, or use that waiting time as a recovery timeout.
        let wake;
        await new Promise(resolve => { wake = resolve; this.recoveryWake = resolve; });
        if (this.recoveryWake === wake) this.recoveryWake = null;
        attempts = 0; deadline = Date.now() + ROBIN_RECOVERY_PHASE_TIMEOUT_MS;
        continue;
      }
      if (++attempts > ROBIN_RECOVERY_MAX_POLLS || Date.now() >= deadline) {
        throw new RobinProviderError('Argon 原生任务仍未完成，读取恢复已达到上限。', {
          code: 'robin_incomplete_response', status: 502, details: JSON.stringify({ goalStatus: 4, attempts: attempts - 1 })
        });
      }
      let frames, record;
      try {
        const signal = AbortSignal.any([this.controller.signal,
          AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now())))]);
        record = await this.provider.auth.get(signal);
        if (this.closed || generation !== this.queryGeneration) return null;
        this.authFingerprint = record.credentialFingerprint || robinCredentialFingerprint(this.provider.auth.account);
        this.onAuthUsed?.(this.authFingerprint);
        const response = await this.provider.transport.unary(GET_CONVERSATION_TURN_PATH, record.accessToken,
          concatFields([stringField(1, identifiers.conversationId), stringField(2, identifiers.requestId),
            messageField(4, boolField(1, true))]), { signal, headers: { 'x-server-token': record.serverToken } });
        if (this.closed || generation !== this.queryGeneration) return null;
        frames = conversationTurnFrames(response, identifiers);
      } catch (error) {
        if (error && typeof error === 'object' && Object.isExtensible(error)) error.upstreamAuthFingerprint ||= this.authFingerprint;
        if (this.closed || generation !== this.queryGeneration) return null;
        const status = Number(error.status || error.statusCode);
        const retryable = status === 429 || status >= 500 && status !== 501 || error?.name === 'TimeoutError';
        if (error.code === 'robin_recovery_response_error' || !retryable) throw error;
        // A read API's rate limit is not evidence of exhausted model quota.
        // Retry only this read-only RPC. Never resubmit ProcessQuery or tools.
        await this.provider.pauseRecovery(this.controller.signal);
        continue;
      }
      if (this.pendingCalls.size) continue;
      const metadata = responseMetadata(frames);
      if ([1, 2, 3].includes(metadata.goalStatus)) return frames;
      await this.provider.pauseRecovery(this.controller.signal);
    }
    return null;
  }

  start(control) {
    const generation = ++this.queryGeneration;
    this.recoveryWake?.();
    this.remoteStarted = false;
    const fingerprint = this.authFingerprint;
    const received = new Set();
    const processStream = this.provider.transport.request(PROCESS_QUERY_PATH, this.token, {
      signal: this.controller.signal,
      headers: { 'x-server-token': this.serverToken },
      onMessage: (message) => {
        if (this.closed || generation !== this.queryGeneration) return;
        this.touch();
        received.add(message);
        this.messages.push(message);
        const messageMetadata = responseMetadata([message]);
        const reportedConversation = messageMetadata.responseIdentifiers?.conversationId;
        if (reportedConversation && this.upstreamConversationId && reportedConversation !== this.upstreamConversationId) {
          this.fail(new RobinProviderError('Argon 回答属于不同的原生会话。', { code: 'robin_session_mismatch', status: 409 }));
          return;
        }
        if (reportedConversation) this.upstreamConversationId ||= reportedConversation;
        for (const thought of messageMetadata.models) {
          if (thought.thinking) this.emit({ type: 'thinking', ...thought });
          if (thought.confirmations?.length) this.confirmationResponses.add(thought.responseId);
        }
        const snapshot = responseSnapshot([message]);
        const text = snapshot?.text || '';
        if (text && !this.confirmationResponses.has(snapshot.responseId)
            && (text !== this.text || snapshot.responseId !== this.responseId)) {
          this.text = text;
          this.responseId = snapshot.responseId;
          this.emit({ type: 'text', ...snapshot });
        }
        const identifiers = continuationIdentifiers(message);
        if (identifiers) this.startRemote(identifiers);
      }
    });
    this.process = processStream;
    const initial = processQueryInitial(this.normalized, {
      deviceId: this.deviceId, deviceName: this.deviceName, workspacePaths: this.workspacePaths,
      requestIdentifiers: control?.identifiers || this.requestIdentifiers,
      confirmationPrompt: control?.prompt
    }, this.modeVariantId);
    processStream.write(initial.message);
    processStream.write(processQueryDeviceContext({ ...initial, workspacePaths: this.workspacePaths }));
    processStream.write(control ? bytesField(1007, stringField(1, control.prompt)) : processQueryPrefetch(this.normalized));
    processStream.end(processQueryCommit());
    processStream.done.then(async (messages) => {
      if (this.closed || generation !== this.queryGeneration) return;
      const initialMetadata = responseMetadata(messages);
      if (initialMetadata.goalStatus === 4 && !initialMetadata.punt && initialMetadata.responseIdentifiers) {
        const ids = initialMetadata.responseIdentifiers;
        if (this.upstreamConversationId && ids.conversationId !== this.upstreamConversationId) {
          throw new RobinProviderError('Argon 未完成响应属于不同的原生会话。', { code: 'robin_session_mismatch', status: 409 });
        }
        this.upstreamConversationId ||= ids.conversationId;
        const recovered = await this.recoverRunningSnapshot(ids, generation);
        if (!recovered || this.closed || generation !== this.queryGeneration) return;
        messages = [...messages, ...recovered];
      }
      // Some transports deliver the final authoritative frame only at EOF.
      // Keep it in the cumulative native metadata, without duplicating live frames.
      for (const message of messages) if (!received.has(message)) this.messages.push(message);
      const snapshot = responseSnapshot(messages), text = snapshot?.text || '';
      const metadata = responseMetadata(messages);
      const reportedConversation = metadata.responseIdentifiers?.conversationId;
      if (reportedConversation && this.upstreamConversationId && reportedConversation !== this.upstreamConversationId) {
        this.fail(new RobinProviderError('Argon 最终响应属于不同的原生会话。', { code: 'robin_session_mismatch', status: 409 }));
        return;
      }
      if (reportedConversation) this.upstreamConversationId ||= reportedConversation;
      const cards = metadata.models.flatMap(model => (model.confirmations || []).map(card => ({ ...card, responseId: model.responseId })));
      if (cards.length) {
        const card = cards[0];
        const choice = this.normalized.toolChoice;
        const permitted = cards.length === 1 && card.confirmationType === 4 && card.allowPrompt
          && (this.normalized.tools || []).length && choice !== 'none' && choice?.type !== 'none'
          && metadata.goalStatus === 2 && metadata.responseIdentifiers;
        if (!permitted) {
          this.fail(new RobinProviderError(['Argon 原生任务需要尚未支持的确认操作。',
            card.header, card.body].filter(Boolean).join('\n'), {
            code: 'robin_confirmation_required', status: 409,
            details: JSON.stringify({ confirmationType: card.confirmationType, goalStatus: metadata.goalStatus })
          }));
          return;
        }
        const key = JSON.stringify([metadata.responseIdentifiers, card.responseId]);
        if (this.acknowledgedConfirmations.has(key) || this.acknowledgedConfirmations.size >= 256) {
          this.fail(new RobinProviderError('Argon 重复请求同一项原生确认。', { code: 'robin_confirmation_loop', status: 409 }));
          return;
        }
        this.acknowledgedConfirmations.add(key);
        const nextControl = { prompt: card.allowPrompt, identifiers: {
          conversationId: metadata.responseIdentifiers.conversationId,
          parentRequestId: metadata.responseIdentifiers.requestId, parentResponseId: card.responseId
        } };
        // A typed MCP confirmation only enables delivery of the real tool
        // request. Execution still goes through the client's normal approval
        // and schema checks. Never invent a function call from a card caption.
        if (this.pendingCalls.size) this.deferredConfirmation = nextControl;
        else this.resumeConfirmation(nextControl).catch(error => this.fail(error));
        return;
      }
      const finalModel = metadata.models.find(model => model.responseId === snapshot?.responseId);
      if ((metadata.goalStatus === 4 && !metadata.punt) || (text && (finalModel?.completeness === 1
          || (finalModel?.completeness !== 2 && metadata.messageTreeCompleted === false)))) {
        this.fail(new RobinProviderError('Argon 响应在任务完成前结束。', {
          code: 'robin_incomplete_response', status: 502,
          details: JSON.stringify({ messageCount: messages.length, goalStatus: metadata.goalStatus })
        }));
        return;
      }
      this.closed = true;
      clearTimeout(this.timer);
      this.emit(text ? { type: 'final', ...snapshot } : { type: 'error', error: new RobinProviderError(
        [metadata.punt?.headline, metadata.punt?.body].filter(Boolean).join('\n') || 'Argon 任务没有返回可识别的最终文本。', {
          code: 'robin_empty_response', status: 502,
          details: JSON.stringify({ messageCount: messages.length, modeCategory: metadata.modeCategory,
            goalStatus: metadata.goalStatus,
            puntCategory: metadata.punt?.category, puntType: metadata.punt?.type })
        }) });
      for (const remote of this.remotes) { try { remote.end(); } catch { /* best effort */ } }
    }, error => {
      if (error && typeof error === 'object' && Object.isExtensible(error)) error.upstreamAuthFingerprint ||= fingerprint;
      throw error;
    }).catch(error => {
      if (generation !== this.queryGeneration) return;
      this.fail(error);
    });
  }

  onRemoteMessage(message, source = this.remote) {
    if (this.closed) return;
    this.touch();
    let event;
    try { event = remoteToolEvent(message); }
    catch (error) { this.fail(new RobinProviderError(`Robin 工具消息无法解析：${error.message}`)); return; }
    const reportedConversation = event.type === 'connected' ? event.sessionId : event.conversationId;
    if (reportedConversation && reportedConversation !== this.upstreamConversationId) {
      this.fail(new RobinProviderError('Argon 工具消息属于不同的原生会话。', { code: 'robin_session_mismatch', status: 409 }));
      return;
    }
    if (event.type !== 'tool_call' || !event.calls.length) {
      if (event.type === 'session_complete') {
        try { source?.end(); } catch { /* best effort */ }
      }
      return;
    }
    const internal = [];
    const external = [];
    for (const call of event.calls) {
      if (call.name === 'list_mcp') internal.push(call);
      else {
        const projected = projectedClientCall(call, this.normalized.tools);
        if (projected) {
          this.pendingCalls.set(projected.id, { remoteId: call.id, remoteName: call.name, source });
          external.push(projected);
        } else internal.push({ ...call, unsupported: true });
      }
    }
    for (const call of internal) {
      if (call.name === 'list_mcp') source.write(clientFunctionResult([{
        id: call.id, name: call.name, response: mcpCatalogResult(this.normalized.tools)
      }]));
      else source.write(remoteToolFailure({
        conversationId: this.upstreamConversationId,
        id: call.id,
        message: `The connected client does not provide tool ${call.name}.`,
        code: 1
      }));
    }
    if (external.length) this.emit({ type: 'tool_call', calls: external });
  }

  submit(results) {
    this.touch();
    const successes = new Map();
    for (const result of results) {
      const pending = this.pendingCalls.get(result.id);
      if (!pending) continue;
      if (!this.remotes.has(pending.source)) {
        this.fail(new RobinProviderError('原 Argon 工具连接已结束，不能在其他连接重放结果。', {
          code: 'robin_tool_channel_closed', status: 409
        }));
        return;
      }
      this.pendingCalls.delete(result.id);
      if (result.isError) pending.source.write(remoteToolFailure({
        conversationId: this.upstreamConversationId,
        id: pending.remoteId,
        message: result.response.error,
        code: 2
      }));
      else {
        const batch = successes.get(pending.source) || [];
        batch.push({ id: pending.remoteId, name: pending.remoteName, response: result.response, attachments: result.attachments });
        successes.set(pending.source, batch);
      }
    }
    for (const [source, batch] of successes) source.write(clientFunctionResult(batch));
    if (!this.pendingCalls.size) this.recoveryWake?.();
    if (!this.pendingCalls.size && this.deferredConfirmation) {
      const control = this.deferredConfirmation;
      this.deferredConfirmation = null;
      this.resumeConfirmation(control).catch(error => this.fail(error));
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.recoveryWake?.();
    clearTimeout(this.timer);
    this.emit({ type: 'error', error });
    this.controller.abort(error);
    try { this.process?.close(); } catch { /* best effort */ }
    for (const remote of this.remotes) { try { remote.close(); } catch { /* best effort */ } }
  }

  destroy(reason = 'Robin task session expired.') {
    if (!this.closed) this.fail(new RobinProviderError(reason, { code: 'robin_turn_expired', status: 409 }));
    else {
      try { this.process?.close(); } catch { /* best effort */ }
      for (const remote of this.remotes) { try { remote.close(); } catch { /* best effort */ } }
    }
  }
}

function responseText(messages) {
  return responseSnapshot(messages)?.text || '';
}

function responseSnapshot(messages) {
  const structured = [];
  for (const message of messages) collectClientGenerateResponseText(message, structured);
  return structured.at(-1) || null;
}

function plainText(input) {
  const text = Buffer.from(input || '').toString('utf8');
  if (!text || text.includes('\uFFFD') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return '';
  return text;
}

function textResponseValue(input, depth = 0) {
  if (depth > 5 || !input?.length) return '';
  let fields;
  try { fields = decodeFields(input); }
  catch { return plainText(input); }
  for (const number of [1, 2, 3]) {
    for (const field of fields) {
      if (field.number !== number || field.wireType !== 2) continue;
      const nested = textResponseValue(field.value, depth + 1);
      if (nested) return nested;
    }
  }
  return plainText(input);
}

function collectClientGenerateResponseText(input, output) {
  let streamingFields;
  try { streamingFields = decodeFields(input); }
  catch { return; }
  // StreamingProcessQueryResponse.client_generate_response is field 1003.
  // Its field 1 wraps ClientGenerateResponse; only field 1 of that message is
  // model_responses. Staying on this exact path prevents status cards, icon
  // URLs and task activity labels from being mistaken for assistant text.
  for (const streaming of streamingFields.filter((field) => field.number === 1003 && field.wireType === 2)) {
    let wrappers;
    try { wrappers = decodeFields(streaming.value); }
    catch { continue; }
    for (const wrapper of wrappers.filter((field) => field.number === 1 && field.wireType === 2)) {
      let clientFields;
      try { clientFields = decodeFields(wrapper.value); }
      catch { continue; }
      for (const candidate of clientFields.filter((field) => field.number === 1 && field.wireType === 2)) {
        let modelFields;
        try { modelFields = decodeFields(candidate.value); }
        catch { continue; }
        const responseId = modelFields.find((field) => field.number === 1 && field.wireType === 2);
        const textResponse = modelFields.find((field) => field.number === 2 && field.wireType === 2);
        const id = responseId ? plainText(responseId.value) : '';
        const text = textResponse ? textResponseValue(textResponse.value) : '';
        if (/^r(?:c)?_[A-Za-z0-9_-]+$/.test(id) && text) output.push({ responseId: id, text });
      }
    }
  }
}

function robinUserStatus(statusMessage) {
  // GetUserStatus exposes mode definitions in field 17 and the account's
  // selectable mode IDs in field 18. A marketing label elsewhere in the
  // response is not evidence of access. Require both exact typed locations.
  try {
    const fields = decodeFields(statusMessage);
    const ids = (number) => fields.filter((field) => field.number === number && field.wireType === 2)
      .flatMap((field) => decodeFields(field.value))
      .filter((field) => field.number === 1 && field.wireType === 2)
      .map((field) => field.value.toString('utf8'));
    const entitled = ids(17).includes(ARGON_MODE_VARIANT_ID) && ids(18).includes(ARGON_MODE_VARIANT_ID);
    return { models: entitled ? [ARGON_MODEL] : [] };
  } catch {
    return { models: [] };
  }
}

function discoveredArgonModels(statusMessage) {
  return robinUserStatus(statusMessage).models;
}

class RobinProvider {
  constructor({ auth, fetchImpl = globalThis.fetch, transport, diagnosticReporter, metadataTimeoutMs = ROBIN_METADATA_TIMEOUT_MS } = {}) {
    if (!auth) throw new Error('RobinProvider requires auth');
    this.auth = auth;
    this.fetchImpl = fetchImpl;
    this.transport = transport || new RobinGrpcTransport();
    this.diagnosticReporter = typeof diagnosticReporter === 'function' ? diagnosticReporter : null;
    this.metadataTimeoutMs = Number.isFinite(metadataTimeoutMs) && metadataTimeoutMs > 0 ? metadataTimeoutMs : ROBIN_METADATA_TIMEOUT_MS;
    this.turns = new Map();
    this.activeRequests = new Set();
    this.requestControllers = new Set();
    this.uploadCache = new Map();
    this.registrationToken = '';
    this.registrationPending = new Map();
    this.conversations = this.conversationStore();
  }

  conversationStore() {
    return new RobinConversationStore({ account: this.auth.account,
      directory: this.auth.store?.directory ? path.join(path.dirname(this.auth.store.directory), 'state') : undefined });
  }

  forgetConversations() { this.conversations.forget(); }

  deviceIdentity() {
    const account = this.auth.account || {};
    const metadata = account.providerMetadata && typeof account.providerMetadata === 'object'
      ? account.providerMetadata
      : {};
    let deviceId = String(metadata.robinDeviceId || '');
    if (!deviceId) {
      deviceId = crypto.randomUUID().toUpperCase();
      if (account.id && this.auth.store?.update) {
        this.auth.account = this.auth.store.update(account.id, {
          providerMetadata: { ...metadata, robinDeviceId: deviceId }
        });
      }
    }
    const workspacePaths = Array.isArray(metadata.robinWorkspacePaths)
      ? metadata.robinWorkspacePaths.map(String).filter(Boolean)
      : [];
    return { deviceId, name: String(metadata.robinDeviceName || 'CONNECTED CLIENT'), workspacePaths };
  }

  async ensureDeviceRegistered(record, signal) {
    signal?.throwIfAborted();
    const tokenKey = crypto.createHash('sha256').update(record.accessToken).digest('hex');
    if (this.registrationToken === tokenKey) return this.deviceIdentity();
    let pending = this.registrationPending.get(tokenKey);
    if (!pending) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new RobinProviderError('Gemini 设备注册请求超时。', {
        code: 'robin_deadline_exceeded', status: 504
      })), ROBIN_REGISTER_TIMEOUT_MS);
      timer.unref?.();
      const promise = (async () => {
        const identity = this.deviceIdentity();
        await this.transport.unary(REGISTER_DEVICE_PATH, record.accessToken, registerDeviceRequest({
          ...identity,
          modeVariantId: this.auth.account?.modeVariantId || ARGON_MODE_VARIANT_ID
        }), { signal: controller.signal });
        controller.signal.throwIfAborted();
        this.registrationToken = tokenKey;
        return identity;
      })().finally(() => {
        clearTimeout(timer);
        if (this.registrationPending.get(tokenKey)?.promise === promise) this.registrationPending.delete(tokenKey);
      });
      pending = { promise, controller };
      this.registrationPending.set(tokenKey, pending);
    }
    // Device registration is shared per credential, but each client's wait
    // is independently cancellable. A token rotation starts its own RPC.
    return waitForSharedOperation(pending.promise, signal);
  }

  cleanupTurns(now = Date.now()) {
    for (const [key, turn] of this.turns) {
      if (now - turn.updatedAt >= ROBIN_TURN_TTL_MS) {
        turn.destroy();
        this.turns.delete(key);
      }
    }
    if (this.turns.size <= ROBIN_MAX_ACTIVE_TURNS) return;
    const oldest = [...this.turns.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (const [key, turn] of oldest.slice(0, this.turns.size - ROBIN_MAX_ACTIVE_TURNS)) {
      turn.destroy('Robin task session was evicted because the active-session limit was reached.');
      this.turns.delete(key);
    }
  }

  cleanupUploads(now = Date.now()) {
    for (const [key, entry] of this.uploadCache) {
      if (!entry?.blobId || entry.expiresAt <= now) this.uploadCache.delete(key);
    }
  }

  async uploadMedia(part, record, signal) {
    signal?.throwIfAborted();
    let contents;
    try { contents = Buffer.from(String(part?.data || ''), 'base64'); }
    catch { contents = Buffer.alloc(0); }
    if (!contents.length) {
      throw new RobinProviderError('Gemini 文件上传失败：附件内容为空。', {
        code: 'robin_upload_error', status: 400
      });
    }
    if (contents.length > ROBIN_MAX_UPLOAD_BYTES) {
      throw new RobinProviderError(`Gemini 文件上传失败：附件超过 ${ROBIN_MAX_UPLOAD_BYTES} 字节限制。`, {
        code: 'robin_upload_too_large', status: 413
      });
    }
    const mimeType = String(part.mediaType || 'application/octet-stream');
    // Some clients provide application/octet-stream and rely on the filename
    // for the native file type. A cache processed as PDF is not a text cache,
    // even if both requests happen to contain identical bytes.
    const fileType = robinFileType(mimeType, part.filename || part.fileId || part.id || '');
    const cacheKey = crypto.createHash('sha256')
      .update(mimeType)
      .update('\0')
      .update(String(fileType))
      .update('\0')
      .update(contents)
      .digest('hex');
    this.cleanupUploads();
    const cached = this.uploadCache.get(cacheKey);
    if (cached?.blobId && cached?.cacheKey) return cached;

    const authorization = `Bearer ${record.accessToken}`;
    const start = await this.fetchImpl(ROBIN_UPLOAD_ORIGIN, {
      method: 'POST',
      signal,
      headers: {
        authorization,
        'push-id': ROBIN_UPLOAD_PUSH_ID,
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': String(contents.length),
        'x-goog-upload-header-content-type': mimeType,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: new URLSearchParams({ data_content_type: mimeType }).toString()
    });
    if (!start.ok) throw robinUploadError(start.status, '初始化');
    const uploadUrl = String(start.headers.get('x-goog-upload-url') || '');
    let parsedUploadUrl;
    try { parsedUploadUrl = new URL(uploadUrl); }
    catch { parsedUploadUrl = null; }
    if (!parsedUploadUrl || parsedUploadUrl.protocol !== 'https:' || parsedUploadUrl.hostname !== 'push.clients6.google.com') {
      throw new RobinProviderError('Gemini 文件上传失败：上游没有返回有效的上传地址。', {
        code: 'robin_upload_error', status: 502
      });
    }

    const finalize = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      signal,
      headers: {
        authorization,
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'content-type': mimeType
      },
      body: contents
    });
    if (!finalize.ok) throw robinUploadError(finalize.status, '传输');
    const blobId = (await finalize.text()).trim();
    signal?.throwIfAborted();
    if (!/^\/contrib_service\/ttl_[A-Za-z0-9_-]+\/[A-Za-z0-9._~-]+$/.test(blobId)) {
      throw new RobinProviderError('Gemini 文件上传失败：上游没有返回有效的文件引用。', {
        code: 'robin_upload_error', status: 502
      });
    }
    const processed = await this.transport.unary(PROCESS_FILE_PATH, record.accessToken, messageField(1, robinAttachment({
      ...part,
      robinBlobId: blobId
    })), {
      signal,
      headers: { 'x-server-token': record.serverToken }
    });
    const processedFields = decodeFields(processed);
    signal?.throwIfAborted();
    const processingStatus = processedFields.find((field) => field.number === 2 && field.wireType === 0)?.value;
    const processedData = processedFields.find((field) => field.number === 3 && field.wireType === 2);
    const processedDataFields = processedData ? decodeFields(processedData.value) : [];
    const robinCacheKey = processedDataFields.find((field) => field.number === 1 && field.wireType === 2)?.value.toString('utf8') || '';
    if (processingStatus !== 1n || !robinCacheKey) {
      throw new RobinProviderError('Gemini 文件处理失败：上游没有返回可用的文件缓存标识。', {
        code: 'robin_file_processing_error', status: 502
      });
    }
    const uploaded = { blobId, cacheKey: robinCacheKey, expiresAt: Date.now() + ROBIN_UPLOAD_CACHE_TTL_MS };
    this.uploadCache.set(cacheKey, uploaded);
    return uploaded;
  }

  async prepareMediaParts(input, record, signal) {
    const parts = [];
    for (const part of input || []) {
      if (part?.type === 'media' && part.data) {
        const uploaded = await this.uploadMedia(part, record, signal);
        parts.push({
          ...part,
          robinBlobId: uploaded.blobId,
          robinCacheKey: uploaded.cacheKey
        });
      } else if (part?.type === 'tool_result' && part.media?.length) {
        parts.push({ ...part, media: await this.prepareMediaParts(part.media, record, signal) });
      } else parts.push(part);
    }
    return parts;
  }

  async prepareNormalized(normalized, record, signal) {
    const messages = [];
    for (const message of normalized?.messages || []) {
      const parts = await this.prepareMediaParts(message?.parts, record, signal);
      messages.push({ ...message, parts });
    }
    return { ...normalized, messages };
  }

  async metadataRpc(rpc, body, callerSignal) {
    callerSignal?.throwIfAborted();
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new RobinProviderError('Gemini 元数据请求超时。', {
      code: 'robin_deadline_exceeded', status: 504
    })), this.metadataTimeoutMs);
    timer.unref?.();
    this.requestControllers.add(controller);
    let fingerprint = robinCredentialFingerprint(this.auth.account);
    try {
      const record = await waitForSharedOperation(this.auth.get(signal), signal);
      fingerprint = record.credentialFingerprint || fingerprint;
      signal.throwIfAborted();
      const response = await waitForSharedOperation(this.transport.unary(rpc, record.accessToken,
        typeof body === 'function' ? body() : body, {
          signal, headers: { 'x-server-token': record.serverToken }
        }), signal);
      signal.throwIfAborted();
      return response;
    } catch (error) {
      if (error && typeof error === 'object' && Object.isExtensible(error)) error.upstreamAuthFingerprint ||= fingerprint;
      throw error;
    } finally {
      clearTimeout(timer);
      this.requestControllers.delete(controller);
    }
  }

  async getQuota(signal) {
    const response = await this.metadataRpc(GET_USAGE_INFO_PATH,
      () => messageField(1, requestMetadata({ deviceId: this.deviceIdentity().deviceId })), signal);
    return robinQuotaSnapshot(response);
  }

  pauseRecovery(signal) { return pause(2000, undefined, { signal }); }

  async getStatus(signal) {
    const status = await this.metadataRpc(GET_USER_STATUS_PATH, Buffer.alloc(0), signal);
    // An OAuth grant authenticates the user; it does not prove that the
    // subscription has Argon access. Never manufacture model entitlement.
    return robinUserStatus(status);
  }

  async listModels(signal) {
    const status = await this.getStatus(signal);
    return status.models;
  }

  async send(normalized, model, options = {}) {
    options.signal?.throwIfAborted();
    const key = String(options.sessionId || crypto.randomUUID());
    if (this.activeRequests.has(key)) throw new RobinProviderError('该 Argon 会话已有请求正在处理。', {
      code: 'robin_session_busy', status: 409
    });
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    this.requestControllers.add(controller);
    this.activeRequests.add(key);
    let fingerprint = robinCredentialFingerprint(this.auth.account);
    try {
      const result = await this.sendTurn(normalized, model, { ...options, signal, sessionId: key,
        onAuthUsed: value => { if (value) fingerprint = value; } });
      return { ...result, upstreamAuthFingerprint: fingerprint };
    }
    catch (error) {
      if (error && typeof error === 'object' && Object.isExtensible(error)) error.upstreamAuthFingerprint ||= fingerprint;
      if (error?.code !== 'robin_tool_result_missing') {
        this.turns.get(key)?.destroy();
        this.turns.delete(key);
      }
      throw error;
    }
    finally {
      this.activeRequests.delete(key);
      this.requestControllers.delete(controller);
    }
  }

  cancelTask(sessionId) {
    const key = String(sessionId || '');
    const turn = this.turns.get(key);
    if (!turn) return false;
    turn.destroy('Client tool response contract rejected.');
    this.turns.delete(key);
    return true;
  }

  stop() {
    const reason = new RobinProviderError('Gemini 账号任务已停止。', { code: 'request_aborted', status: 499 });
    for (const controller of this.requestControllers) controller.abort(reason);
    for (const { controller } of this.registrationPending.values()) controller.abort(reason);
    for (const turn of this.turns.values()) turn.destroy('Robin provider stopped.');
    this.turns.clear();
    this.uploadCache.clear();
  }

  async sendTurn(normalized, model, { signal, sessionId, onDelta, onThinkingDelta, onAuthUsed, requireExistingTurn = false, reuseConversation = true, repairInstruction = '' } = {}) {
    signal?.throwIfAborted();
    if (model !== ARGON_MODEL) {
      throw new RobinProviderError(`Robin Provider 不支持模型 ${model}。`, { code: 'robin_model_unavailable', status: 404 });
    }
    if (repairInstruction) normalized = { ...normalized,
      system: [normalized.system, String(repairInstruction)].filter(Boolean).join('\n\n') };
    this.cleanupTurns();
    const key = String(sessionId || crypto.randomUUID());
    let turn = this.turns.get(key);
    const results = normalizedToolResults(normalized);
    const latestResults = normalizedToolResults({ messages: normalized?.messages?.slice(-1) || [] });
    // A tool continuation cannot be replayed as a new task after process
    // restart, eviction or failure: client-side writes may already have run.
    if (!turn && (requireExistingTurn || latestResults.length)) {
      throw new RobinProviderError('原 Argon 工具任务已结束或丢失，无法继续回传结果；请发起新的任务。', {
        code: 'robin_task_not_found', status: 409
      });
    }
    if (turn && !turn.closed) {
      turn.onAuthUsed = onAuthUsed;
      onAuthUsed?.(turn.authFingerprint);
      const matched = results.filter((result) => turn.pendingCalls.has(result.id));
      if (!matched.length) throw new RobinProviderError('客户端尚未返回当前 Argon 任务的工具结果。', {
        code: 'robin_tool_result_missing', status: 409
      });
      // Only upload results for outstanding calls. Historical tool results
      // travel with client conversation history and must not be replayed.
      if (matched.some((result) => !result.isError && result.attachments?.length)) {
        const record = await this.auth.get(signal);
        onAuthUsed?.(record.credentialFingerprint || robinCredentialFingerprint(this.auth.account));
        for (const result of matched) {
          if (!result.isError && result.attachments?.length) {
            result.attachments = await this.prepareMediaParts(result.attachments, record, signal);
          }
        }
      }
      signal?.throwIfAborted();
      onAuthUsed?.(turn.authFingerprint);
      turn.submit(matched);
    } else if (!turn) {
      const record = await this.auth.get(signal);
      signal?.throwIfAborted();
      const authFingerprint = record.credentialFingerprint || robinCredentialFingerprint(this.auth.account);
      onAuthUsed?.(authFingerprint);
      const identity = await this.ensureDeviceRegistered(record, signal);
      const preparedNormalized = await this.prepareNormalized(normalized, record, signal);
      // Preparation may finish after disable/delete even if an adapter did
      // not honour abort. Never create a new task or write results afterward.
      signal?.throwIfAborted();
      if (!this.conversations.matches(this.auth.account)) this.conversations = this.conversationStore();
      turn = new RobinTurn({
        provider: this,
        normalized: preparedNormalized,
        token: record.accessToken,
        serverToken: record.serverToken,
        authFingerprint,
        sessionId: key,
        deviceId: identity.deviceId,
        deviceName: identity.name,
        workspacePaths: identity.workspacePaths,
        modeVariantId: this.auth.account?.modeVariantId || ARGON_MODE_VARIANT_ID,
        requestIdentifiers: reuseConversation ? this.conversations.get(key) : null,
        onAuthUsed,
        signal
      });
      this.turns.set(key, turn);
      turn.start();
    }

    let event;
    const deliveredBefore = new Map(turn.deliveredText);
    const thinkingBefore = new Map(turn.deliveredThinking);
    const thoughts = new Map();
    const texts = new Map();
    const deliver = (snapshot) => {
      const previous = turn.deliveredText.get(snapshot.responseId) || '';
      const baseline = deliveredBefore.get(snapshot.responseId) || '';
      if (!snapshot.text.startsWith(baseline) || (onDelta && !snapshot.text.startsWith(previous))) {
        throw new RobinProviderError('Argon 返回的正文快照改写了已交付内容，无法继续追加流式输出。', {
          code: 'robin_text_snapshot_conflict', status: 502
        });
      }
      const delta = snapshot.text.startsWith(previous) ? snapshot.text.slice(previous.length) : '';
      if (delta) onDelta?.(delta);
      texts.set(snapshot.responseId, snapshot.text.slice(baseline.length));
      turn.deliveredText.set(snapshot.responseId, snapshot.text);
    };
    const deliverThinking = (snapshot) => {
      const previous = turn.deliveredThinking.get(snapshot.responseId) || '';
      const baseline = thinkingBefore.get(snapshot.responseId) || '';
      const current = snapshot.thinking || '';
      if (!current.startsWith(baseline) || (onThinkingDelta && !current.startsWith(previous))) {
        throw new RobinProviderError('Argon 改写了已交付的思考摘要，无法继续追加输出。', {
          code: 'robin_thinking_snapshot_conflict', status: 502
        });
      }
      const delta = current.startsWith(previous) ? current.slice(previous.length) : '';
      if (delta) onThinkingDelta?.(delta);
      thoughts.set(snapshot.responseId, current.slice(baseline.length));
      turn.deliveredThinking.set(snapshot.responseId, current);
    };
    do {
      event = await turn.next(signal);
      if (event.type === 'text') deliver(event);
      if (event.type === 'thinking') deliverThinking(event);
    } while (event.type === 'text' || event.type === 'thinking');
    if (event.type === 'error') {
      this.turns.delete(key);
      throw event.error;
    }
    const metadata = responseMetadata(turn.messages);
    for (const thought of metadata.models) if (thought.thinking) deliverThinking(thought);
    const thinking = [...thoughts.values()].join('');
    if (event.type === 'tool_call') {
      return {
        text: [...texts.values()].join(''),
        thinking,
        toolCalls: event.calls,
        finishReason: 'tool_calls',
        usage: null,
        usageKnown: false,
        upstreamMetadata: metadata,
        upstreamConversationId: turn.upstreamConversationId || metadata.responseIdentifiers?.conversationId || ''
      };
    }
    this.turns.delete(key);
    deliver(event);
    if (reuseConversation && metadata.responseIdentifiers) this.conversations.set(key, {
      conversationId: metadata.responseIdentifiers.conversationId,
      parentRequestId: metadata.responseIdentifiers.requestId,
      parentResponseId: event.responseId
    });
    return {
      text: [...texts.values()].join(''),
      thinking,
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
      usageKnown: false,
      upstreamMetadata: metadata,
      upstreamConversationId: turn.upstreamConversationId || metadata.responseIdentifiers?.conversationId || ''
    };
  }
}

module.exports = {
  ARGON_MODEL,
  ARGON_MODE_VARIANT_ID,
  EXECUTE_REMOTE_TOOLS_PATH,
  GET_USER_STATUS_PATH,
  GET_USAGE_INFO_PATH,
  GET_CONVERSATION_TURN_PATH,
  PROCESS_QUERY_PATH,
  REGISTER_DEVICE_PATH,
  RobinGrpcTransport,
  RobinProvider,
  RobinProviderError,
  ROBIN_MAX_ACTIVE_TURNS,
  ROBIN_TURN_TTL_MS,
  clientGenerateRequest,
  continuationIdentifiers,
  clientFunctionCalls,
  clientFunctionResult,
  discoveredArgonModels,
  mcpCatalogResult,
  normalizedToolResults,
  processQueryPrefetch,
  processQueryInitial,
  registerDeviceRequest,
  projectedClientCall,
  remoteToolConnect,
  remoteToolEvent,
  remoteToolFailure,
  requestMetadata,
  robinAttachment,
  robinTaskText,
  robinUserStatus,
  robinUserQuery,
  responseText
};
