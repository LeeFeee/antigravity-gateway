'use strict';

const { bytesField: bytes, stringField: str, messageField: msg, intField: int, concatFields: fields,
  decodeFields, firstField, stringValue } = require('./robin-proto');

const WINDOWS_ARGON_VARIANT = '95a4c0abcba24364';
const WINDOWS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Gemini/1.15.0 Chrome/152.0.7977.130 Safari/537.36 GeminiWindowsApp/1.15.0 (prod)';

// Gemini Windows 1.15.0 uses the web ProcessSession protobuf protocol, not
// Robin ProcessQuery. In particular, there is no guessed Windows surface ID.
function windowsMetadata({ requestId, instanceId, build, locale = 'zh-CN' }) {
  const encode = value => value.toString('base64');
  return {
    'x-goog-ext-525001261-bin': encode(fields([
      int(1, 1), str(5, WINDOWS_ARGON_VARIANT), int(8, 0),
      bytes(9, Buffer.from([4, 5, 6, 8, 16, 19, 20])), int(12, 2), int(15, 8),
      str(17, instanceId), msg(18, str(1, build))
    ])),
    'x-goog-ext-525005358-bin': encode(fields([str(1, requestId), int(2, 1)])),
    'x-goog-ext-73010989-bin': encode(int(1, 0)),
    'x-goog-ext-73010990-bin': encode(fields([int(1, 0), int(2, 0), int(3, 0)]))
  };
}

function windowsInitialize({ requestId, locale = 'zh-CN' }) {
  return msg(1, fields([
    msg(1, fields([int(1, 1), str(2, WINDOWS_ARGON_VARIANT), str(3, locale), str(4, requestId)])),
    int(2, 0),
    msg(8, msg(5, fields([
      msg(1, fields([
        msg(1, fields([bytes(1, Buffer.alloc(0)), int(2, 0), int(7, 0)])),
        msg(2, str(1, locale)), int(8, 1), int(11, 1), int(28, 1),
        msg(42, int(1, 1)), str(60, requestId), int(80, 8), int(81, 1), int(99, 1)
      ])), int(4, 1)
    ])))
  ]));
}

function windowsInput(text) { return msg(2, fields([int(1, 1), msg(9, str(1, text))])); }
function windowsFinish() { return msg(4, int(1, 1)); }

// WebChannel length prefixes count JavaScript UTF-16 code units. TextDecoder
// preserves UTF-8 characters split across network chunks; slicing below then
// follows the same framing as the official JavaScript client.
class WebChannelDecoder {
  constructor({ maxFrameChars = 16 * 1024 * 1024 } = {}) {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.buffer = ''; this.maxFrameChars = maxFrameChars;
  }
  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const output = [];
    while (this.buffer.length) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) {
        if (this.buffer.length > 12) throw new Error('无效的 Windows WebChannel 长度。');
        break;
      }
      const prefix = this.buffer.slice(0, end);
      if (!/^\d{1,10}$/.test(prefix)) throw new Error('无效的 Windows WebChannel 帧头。');
      const length = Number(prefix);
      if (length > this.maxFrameChars) throw new Error('Windows WebChannel 响应超过限制。');
      if (this.buffer.length < end + 1 + length) break;
      const frame = JSON.parse(this.buffer.slice(end + 1, end + 1 + length));
      if (!Array.isArray(frame)) throw new Error('无效的 Windows WebChannel 响应。');
      output.push(...frame);
      this.buffer = this.buffer.slice(end + 1 + length);
    }
    return output;
  }
  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer.length) throw new Error('Windows WebChannel 响应被截断。');
  }
}

function at(input, path) {
  let data = input;
  for (const number of path) {
    const value = firstField(decodeFields(data), number, 2);
    if (!value) return null;
    data = value.value;
  }
  return data;
}

function windowsResponse(input) {
  const root = decodeFields(input);
  if (firstField(root, 4, 2)) return { closed: true };
  const envelope = at(input, [2, 7, 1]);
  if (!envelope) return {};
  const body = at(envelope, [4, 4]);
  if (!body) return {};
  const response = decodeFields(body);
  const models = response.filter(f => f.number === 5 && f.wireType === 2);
  const candidate = models[0]?.value;
  const content = candidate && at(candidate, [2]);
  const variant = stringValue(firstField(response, 40, 2));
  const output = { done: firstField(response, 15, 0)?.value === 1n };
  if (content) output.text = stringValue(firstField(decodeFields(content), 1, 2));
  if (variant) output.modeVariantId = variant;
  // Do not manufacture token usage: the native web response does not supply it.
  return output;
}

module.exports = { WINDOWS_ARGON_VARIANT, WINDOWS_USER_AGENT, WebChannelDecoder,
  windowsMetadata, windowsInitialize, windowsInput, windowsFinish, windowsResponse };
