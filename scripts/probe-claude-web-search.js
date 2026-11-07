#!/usr/bin/env node
'use strict';

// Actual Claude WebSearch execution against one synthetic loopback endpoint.
// No browser, search provider, real credential or production gateway is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const helpers = require('./verify-client-gateway');
const { clientSandbox } = require('./verify-real-client-gateway');
const { normalizeAnthropic } = require('../src/protocol');
const ROOT = path.resolve(__dirname, '..');
const PROMPT = 'Synthetic local protocol audit. Use WebSearch for ANTIGRAVITY_LOCAL_WEBSEARCH_PROBE_20261107 on example.com once, then report its result. Do not use any other tools.';
const KEY = 'sk-gateway-local-fixture-not-a-real-key';

function reply(res, body, content, stopReason) {
  const message = { id: `msg_probe_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
    content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 128, output_tokens: 16 } };
  if (!body.stream) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(message)); }
  res.setHeader('content-type', 'text/event-stream');
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  for (const [index, block] of content.entries()) {
    const call = block.type === 'tool_use' || block.type === 'server_tool_use';
    event('content_block_start', { index, content_block: call ? { ...block, input: {} } : block.type === 'text' ? { type: 'text', text: '', ...(block.citations ? { citations: [] } : {}) } : block });
    if (call || block.type === 'text') event('content_block_delta', { index, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    for (const citation of block.citations || []) event('content_block_delta', { index, delta: { type: 'citations_delta', citation } });
    event('content_block_stop', { index });
  }
  event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 16 } });
  event('message_stop', {}); res.end();
}

async function run(outFile, { replyMode = 'reject' } = {}) {
  if (!['reject', 'synthetic-search-result'].includes(replyMode)) throw new Error('Unknown reply mode');
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('macOS Seatbelt is required');
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'agw-websearch-')));
  fs.chmodSync(root, 0o700);
  const captures = []; let client, settings, discoveryIssued = false, searchIssued = false, result, timer;
  const protocolHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/protocol.js'))).digest('hex');
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'); let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    const capture = { method: req.method, path: req.url, headers: req.headers, body }; captures.push(capture);
    if (req.url.includes('/count_tokens')) { res.setHeader('content-type', 'application/json'); return res.end('{"input_tokens":128}'); }
    if (!req.url.includes('/messages')) { res.statusCode = 404; return res.end('{"error":{"type":"not_found_error","message":"Synthetic Messages endpoint only"}}'); }
    const serverTools = (body.tools || []).filter(tool => tool.type && tool.type !== 'function' && tool.type !== 'custom');
    if (serverTools.length) {
      capture.kind = 'secondary-server-tool-request';
      try { normalizeAnthropic(body); capture.currentNormalizer = { accepted: true }; }
      catch (error) { capture.currentNormalizer = { accepted: false, status: error.statusCode || error.status, code: error.code, message: error.message }; }
      if (replyMode === 'synthetic-search-result') {
        // Pure test data, not a network search or genuine indexed page.
        const query = 'ANTIGRAVITY_LOCAL_WEBSEARCH_PROBE_20261107', url = 'https://example.com/synthetic-search-fixture';
        capture.syntheticResponse = [
          { type: 'server_tool_use', id: 'srvtoolu_probe_search', name: 'web_search', input: { query } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_probe_search', content: [{ type: 'web_search_result', url, title: 'Synthetic local search fixture', encrypted_content: 'SYNTHETIC_ENCRYPTED_CONTENT', page_age: 'November 7, 2026' }] },
          { type: 'text', text: 'SYNTHETIC_SEARCH_SUMMARY: local fixture only.', citations: [{ type: 'web_search_result_location', url, title: 'Synthetic local search fixture', cited_text: 'SYNTHETIC_SEARCH_EXCERPT', encrypted_index: 'SYNTHETIC_ENCRYPTED_INDEX' }] }
        ];
        capture.syntheticStatus = 200;
        return reply(res, body, capture.syntheticResponse, 'end_turn');
      }
      res.statusCode = 400; res.setHeader('content-type', 'application/json');
      capture.syntheticStatus = 400;
      capture.syntheticResponse = { type: 'error', error: { type: 'invalid_request_error', message: capture.currentNormalizer.message || 'Synthetic probe does not execute server tools' } };
      return res.end(JSON.stringify(capture.syntheticResponse));
    }
    capture.kind = 'main-agent-request';
    const names = (body.tools || []).map(tool => tool.name);
    let call;
    if (!searchIssued && names.includes('WebSearch')) {
      searchIssued = true;
      call = { type: 'tool_use', id: 'toolu_probe_websearch', name: 'WebSearch', input: { query: 'ANTIGRAVITY_LOCAL_WEBSEARCH_PROBE_20261107', allowed_domains: ['example.com'] } };
    } else if (!searchIssued && !discoveryIssued && names.includes('ToolSearch')) {
      discoveryIssued = true;
      call = { type: 'tool_use', id: 'toolu_probe_discover', name: 'ToolSearch', input: { query: 'select:WebSearch', max_results: 1 } };
    }
    capture.syntheticResponse = call || { type: 'text', text: 'LOCAL_WEBSEARCH_AUDIT_COMPLETE' };
    return reply(res, body, [capture.syntheticResponse], call ? 'tool_use' : 'end_turn');
  });
  let port;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
    settings = helpers.configure('claude', root, `http://127.0.0.1:${port}`, { model: 'claude-sonnet-4-6', prompt: PROMPT, apiKey: KEY });
    settings.args[settings.args.indexOf('--allowedTools') + 1] = 'WebSearch,ToolSearch';
    settings.args[settings.args.indexOf('--max-turns') + 1] = '5';
    settings.args.push('--tools', 'WebSearch,ToolSearch');
    settings.env.CLAUDE_CODE_TMPDIR = path.join(root, 'tmp');
    helpers.write(settings.sandbox, clientSandbox(settings, root, path.join(os.homedir(), '.antigravity-gateway'), port));
    client = helpers.launch('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...settings.args], { cwd: settings.work, env: settings.env });
    result = await Promise.race([client.done, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 60000); })]);
  } catch (error) { result = { error: error.message }; }
  finally {
    clearTimeout(timer); await helpers.stop(client);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  const secondary = captures.filter(capture => capture.kind === 'secondary-server-tool-request');
  const evidence = helpers.sanitize({ agent: 'claude', ...helpers.version('claude'), recordedAt: new Date().toISOString(),
    evidence: 'actual-cli-websearch-loopback-capture', realSearchValidated: false, realModelValidated: false,
    isolation: 'fresh temporary HOME; Seatbelt restricts outbound network to one loopback capture port; real HOME denied except installation code; work directory read-only',
    protocolHash, replyMode, command: settings && [settings.command, ...settings.args], outcome: result,
    searchIssued, secondaryRequestCount: secondary.length, temporaryDirectoryRemoved: !fs.existsSync(root),
    captures, stdout: client?.stdout || '', stderr: client?.stderr || '' }, root, [[port, 'PROBE_PORT']]);
  helpers.write(outFile, evidence);
  console.log(JSON.stringify({ file: outFile, outcome: result, searchIssued, secondaryRequestCount: secondary.length, temporaryDirectoryRemoved: evidence.temporaryDirectoryRemoved }));
  return evidence;
}
if (require.main === module) {
  const args = process.argv.slice(2), i = args.indexOf('--out'), m = args.indexOf('--reply-mode');
  const replyMode = m < 0 ? 'reject' : args[m + 1];
  const defaultName = replyMode === 'reject' ? 'claude-web-search.json' : 'claude-web-search-synthetic-result.json';
  run(path.resolve(i < 0 ? `tests/fixtures/client-web-tools-20261107/${defaultName}` : args[i + 1]), { replyMode })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run };
