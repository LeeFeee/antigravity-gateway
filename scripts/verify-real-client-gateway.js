#!/usr/bin/env node
'use strict';

// Real CLI -> isolated real gateway -> unchanged native TLS -> Google.
// This script never changes the production service, configuration, accounts,
// quota protection or client profiles. Use --run to perform billed inference;
// the default only validates and snapshots the isolated scaffolding.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const helpers = require('./verify-client-gateway');
const ROOT = path.resolve(__dirname, '..');
const SOURCE_HOME = os.homedir();
const STATE_FILES = ['state/account-pool.json', 'state/quota.json'];
const SECRET_FIELD = /^(?:authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|cookie|set-cookie)$/i;
const PRIVATE_FIELD = /^(?:email|subject[-_]?id|project[-_]?id|project|client[-_]?id|account[-_]?id)$/i;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function regularBytes(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Snapshot accepts only regular files, never credential symlinks.');
  return fs.readFileSync(file);
}
function accountSnapshot(configDir) {
  const directory = path.join(configDir, 'accounts');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed accounts must be an ordinary directory.');
  const names = fs.readdirSync(directory).sort();
  const digest = crypto.createHash('sha256'); let count = 0;
  for (const name of names) {
    const file = path.join(directory, name), info = fs.lstatSync(file);
    if (info.isDirectory()) throw new Error('Unexpected nested managed account directory; no recursive credential discovery is allowed.');
    const bytes = regularBytes(file);
    digest.update(name + '\0' + sha(bytes) + '\0');
    if (name.endsWith('.json')) count++;
  }
  return { fileCount: names.length, jsonCount: count, digest: digest.digest('hex') };
}
function copyManagedState(source, target) {
  const observedAt = new Date().toISOString();
  const before = accountSnapshot(source);
  if (!before.jsonCount) throw new Error('The existing agy accounts directory is empty.');
  const secrets = [], copiedAccounts = [], copiedState = {};
  const summary = { accounts: before.jsonCount, stateFiles: [], disabledAccounts: 0, observedAt,
    evidence: 'copied-disk-state-only; no live health or quota probe; accountUpdatedAt is record update time, not proof of credential refresh' };
  for (const name of fs.readdirSync(path.join(source, 'accounts')).filter(name => name.endsWith('.json')).sort()) {
    const bytes = regularBytes(path.join(source, 'accounts', name)), value = JSON.parse(bytes);
    privateWrite(path.join(target, 'accounts', name), bytes);
    copiedAccounts.push(value);
    if (value.enabled === false) summary.disabledAccounts++;
    for (const key of ['id', 'email', 'subjectId', 'subject_id', 'projectId', 'project_id', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'clientId', 'client_id', 'clientSecret', 'client_secret']) {
      if (typeof value[key] === 'string' && value[key].length >= 4) secrets.push(value[key]);
    }
  }
  for (const name of STATE_FILES) {
    const sourceFile = path.join(source, name);
    if (!fs.existsSync(sourceFile)) continue;
    const bytes = regularBytes(sourceFile);
    copiedState[name] = JSON.parse(bytes); // Invalid protection state must not be silently reset.
    privateWrite(path.join(target, name), bytes);
    summary.stateFiles.push({ path: name, sha256: sha(bytes), byteExact: true });
  }
  const after = accountSnapshot(source);
  if (after.digest !== before.digest) throw new Error('Production accounts changed during snapshot; do not claim an atomic copy.');
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const boolean = value => typeof value === 'boolean' ? value : null;
  const fraction = value => value !== null && value !== undefined && typeof value !== 'boolean'
    && String(value).trim() && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1 ? Number(value) : null;
  const protection = value => value && typeof value === 'object' ? {
    protected: boolean(value.protected), fastRefresh: boolean(value.fastRefresh),
    remainingFraction: fraction(value.remainingFraction), resetTime: timestamp(value.resetTime), observedAt: timestamp(value.observedAt)
  } : null;
  const health = copiedState['state/account-pool.json']?.health || {};
  const quota = copiedState['state/quota.json'] || {};
  summary.persistedHealthRecordCount = Object.keys(health).length;
  summary.accountStates = copiedAccounts.map((raw, index) => {
    // Reuse the storage parser only to locate persisted records; do not run a
    // pool, compare credential fingerprints, clear health or infer availability.
    const account = require('../src/account-store').normalizeAccount(raw);
    const record = account && health[account.id], savedQuota = account && quota[account.id];
    const savedProtection = savedQuota?.geminiQuotaProtection;
    return {
      anonymousAccount: `account-${index + 1}`, accountRecordParsed: Boolean(account), enabled: raw.enabled !== false,
      accountUpdatedAt: timestamp(raw.updatedAt), credentialExpiresAt: timestamp(raw.expiresAt ?? raw.expiry ?? raw.expires_at),
      persistedHealthState: record ? (['verification_required', 'authentication_error', 'access_denied'].includes(record.state) ? record.state : 'unrecognized') : 'none',
      persistedHealthSince: timestamp(record?.since), persistedHealthFingerprintPresent: typeof record?.accountFingerprint === 'string' && record.accountFingerprint.length > 0,
      quotaObservedAt: timestamp(savedQuota?.observedAt), quotaGroupsObservedAt: timestamp(savedQuota?.groupsObservedAt),
      quotaModelsExpiresAt: timestamp(savedQuota?.modelsExpiresAt ?? savedQuota?.expiresAt),
      imageQuotaEvidence: 'persisted-model-name-match; not a fresh model-service measurement',
      imageQuota: Object.entries(savedQuota?.models || {}).filter(([model]) => /image|imagen/i.test(model)).map(([model, value]) => ({
        model, remainingFraction: fraction(value?.remainingFraction), available: boolean(value?.available), resetTime: timestamp(value?.resetTime)
      })),
      persistedGeminiProtection: savedProtection ? { ...protection(savedProtection),
        fiveHour: protection(savedProtection.fiveHour), weekly: protection(savedProtection.weekly) } : null
    };
  });
  const resolvedSource = path.resolve(source), isDefault = resolvedSource === path.join(SOURCE_HOME, '.antigravity-gateway');
  summary.sourceConfig = { defaultManagedDirectory: isDefault, pathSha256: sha(resolvedSource),
    location: scrub(resolvedSource, isDefault ? secrets : [...secrets, resolvedSource], target) };
  summary.copyCompletedAt = new Date().toISOString();
  return { before, summary, secrets: [...new Set(secrets)].sort((a, b) => b.length - a.length) };
}
function scrub(value, secrets, root, key = '') {
  if (SECRET_FIELD.test(key)) return '<REDACTED_CREDENTIAL>';
  if (PRIVATE_FIELD.test(key)) return '<REDACTED_ACCOUNT_METADATA>';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) text = text.split(secret).join('<REDACTED_VALUE>');
    return text.split(root).join('/tmp/real-client-gateway').split(SOURCE_HOME).join('/home/probe')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<REDACTED_EMAIL>')
      .replace(/\bya29\.[A-Za-z0-9._~-]+/g, '<REDACTED_TOKEN>')
      .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <REDACTED_CREDENTIAL>')
      .replace(/("(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key)"\s*:\s*")[^"\r\n]*(")/gi, '$1<REDACTED_CREDENTIAL>$2');
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, secrets, root, name)]));
  return value;
}
function sourceSnapshot() {
  const files = ['antigravity-gateway.js', 'package.json', 'package-lock.json'];
  for (const name of fs.readdirSync(path.join(ROOT, 'src')).filter(name => name.endsWith('.js'))) files.push(`src/${name}`);
  for (const name of fs.readdirSync(path.join(ROOT, 'native/bin'))) files.push(`native/bin/${name}`);
  return { sha256: sha(files.sort().map(name => name + '\0' + sha(regularBytes(path.join(ROOT, name)))).join('\n')), files: files.length };
}
function observerSource(traceFile, configDir, tempRoot, apiKey) {
  // Observe the actual AgyNativeTransport.fetch method, retaining its original
  // implementation and Go subprocess. Never substitute Node fetch for models.
  return `'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const configDir=${JSON.stringify(configDir)},root=${JSON.stringify(tempRoot)};
const secrets=[${JSON.stringify(apiKey)}];
for(const name of fs.readdirSync(path.join(configDir,'accounts'))){if(!name.endsWith('.json'))continue;const a=JSON.parse(fs.readFileSync(path.join(configDir,'accounts',name),'utf8'));for(const key of ['id','email','subjectId','subject_id','projectId','project_id','accessToken','access_token','refreshToken','refresh_token','clientId','client_id','clientSecret','client_secret'])if(typeof a[key]==='string'&&a[key].length>=4)secrets.push(a[key]);}
secrets.sort((a,b)=>b.length-a.length);
const scrub=${scrub.toString()};
const SECRET_FIELD=${SECRET_FIELD.toString()},PRIVATE_FIELD=${PRIVATE_FIELD.toString()},SOURCE_HOME=${JSON.stringify(SOURCE_HOME)};
function record(value){fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(scrub(value,secrets,root))+'\\n',{mode:0o600});}
const transport=require(${JSON.stringify(path.join(ROOT, 'src/agy-native-transport.js'))});
const nativeFetch=transport.AgyNativeTransport.prototype.fetch;
transport.AgyNativeTransport.prototype.fetch=async function(url,options={}){
  const parsed=new URL(url),modelOrigin=/^(daily-)?cloudcode-pa\\.googleapis\\.com$/.test(parsed.hostname),authOrigin=(parsed.hostname==='oauth2.googleapis.com'&&parsed.pathname==='/token')||(parsed.hostname==='www.googleapis.com'&&parsed.pathname==='/oauth2/v2/userinfo');
  if(parsed.protocol!=='https:'||parsed.port||(!modelOrigin&&!authOrigin))throw new Error('Verification native transport origin denied');
  const id=require('node:crypto').randomUUID();let body=options.body;
  if(new Headers(options.headers).get('content-type')?.includes('application/x-www-form-urlencoded')||body instanceof URLSearchParams)body=Object.fromEntries(new URLSearchParams(body));else try{body=JSON.parse(body);}catch{}
  record({type:'native-request',id,url:String(url),method:options.method||'GET',headers:Object.fromEntries(new Headers(options.headers)),body,transport:'original-AgyNativeTransport.fetch'});
  try{const response=await nativeFetch.call(this,url,options);record({type:'native-response',id,status:response.status,headers:Object.fromEntries(response.headers),binary:this.child?.spawnfile||null});
    void response.clone().text().then(body=>record({type:'native-body',id,body})).catch(error=>record({type:'native-body-error',id,message:error.message}));return response;
  }catch(error){record({type:'native-error',id,code:error.code,message:error.message});throw error;}
};
const createServer=http.createServer;
http.createServer=function(handler){return createServer.call(this,(req,res)=>{
  const input=[],output=[];let recorded=false;const emit=req.emit;
  req.emit=function(event,...args){if(event==='data')input.push(Buffer.from(args[0]));return emit.call(this,event,...args);};
  const write=res.write,end=res.end;res.write=function(chunk,...args){if(chunk)output.push(Buffer.from(chunk));return write.call(this,chunk,...args);};res.end=function(chunk,...args){if(chunk)output.push(Buffer.from(chunk));return end.call(this,chunk,...args);};
  function finished(){if(recorded)return;recorded=true;let body=Buffer.concat(input).toString('utf8');try{body=JSON.parse(body);}catch{}record({type:'client-http',method:req.method,path:req.url,headers:req.headers,body,status:res.statusCode,responseHeaders:res.getHeaders(),responseBody:Buffer.concat(output).toString('utf8')});}
  res.on('finish',finished);res.on('close',finished);return handler(req,res);
});};
record({type:'observer-ready',transportReplaced:false});
`;
}
function gatewaySandbox(root, sourceConfig) {
  return `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(sourceConfig)}))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))(allow network-outbound)(allow network-inbound (local ip "localhost:*"))(allow network-bind (local ip "localhost:*"))`;
}
function clientSandbox(settings, root, sourceConfig, gatewayPort, internalPorts = []) {
  // Source program files remain readable for Node/Python launch. Credential
  // copies are outside each client's private root and explicitly unreadable.
  const original = fs.readFileSync(settings.sandbox, 'utf8');
  const ports = [gatewayPort, ...internalPorts];
  if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Client network ports must be explicit valid port numbers.');
  const restricted = original.replace('(allow network-outbound (remote ip "localhost:*"))', `(allow network-outbound ${ports.map(port => `(remote ip "localhost:${port}")`).join(' ')})`);
  const installRoots = [path.resolve(path.dirname(process.execPath), '..'), path.join(SOURCE_HOME, '.hermes/hermes-agent'), path.join(SOURCE_HOME, '.hermes/installs'), path.join(SOURCE_HOME, '.hermes/tools'), path.join(SOURCE_HOME, '.local/share/uv'), path.join(SOURCE_HOME, '.local/share/hermes')];
  return restricted + `(deny file-read* (subpath ${JSON.stringify(SOURCE_HOME)}))(allow file-read-metadata (subpath ${JSON.stringify(SOURCE_HOME)}))(allow file-read* ${installRoots.map(item => `(subpath ${JSON.stringify(item)})`).join(' ')} (literal ${JSON.stringify(path.join(SOURCE_HOME, '.local/bin/hermes'))}))(deny file-read* (subpath ${JSON.stringify(sourceConfig)}) (subpath ${JSON.stringify(path.join(root, 'gateway-data'))}))(deny file-write* (subpath ${JSON.stringify(settings.work)}))`;
}
function readTrace(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function assess(agent, scenario, trace, outcome, marker) {
  const client = trace.filter(item => item.type === 'client-http' && /^\/v1\/(messages|responses)(?:\?|$)/.test(item.path));
  const generations = trace.filter(item => item.type === 'native-request' && item.url.includes(':streamGenerateContent'));
  const generationIds = new Set(generations.map(item => item.id));
  const responses = trace.filter(item => item.type === 'native-response' && generationIds.has(item.id));
  const answers = client.map(item => item.responseBody || '').join('\n');
  const visibleText = client.map(item => {
    try {
      const body = JSON.parse(item.responseBody);
      return [...(body.content || []), ...(body.output || []).flatMap(output => output.type === 'message' ? output.content || [] : [])]
        .filter(part => ['text', 'output_text'].includes(part.type)).map(part => part.text || '').join('');
    } catch {}
    return (item.responseBody || '').split('\n').flatMap(line => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return [];
    try { const event = JSON.parse(line.slice(6)); return [event.delta?.text || (event.type === 'response.output_text.delta' ? event.delta : '') || '']; }
    catch { return []; }
  }).join(''); }).join('\n');
  const upstreamResults = generations.flatMap(item => (item.body?.request?.contents || []).flatMap(content => content.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse));
  const checks = {
    clientSucceeded: outcome.code === 0 && !outcome.timedOut && !outcome.error && !outcome.clientReportedError,
    gatewayHTTP: client.length > 0 && client.every(item => item.status === 200),
    realNativeTLS: generations.length > 0 && responses.some(item => item.status === 200 && /agy-transport-/.test(item.binary || '')),
    finalMarkerDelivered: visibleText.includes(marker),
    officialUA: generations.every(item => /^antigravity\/cli\/1\.5\.2 /.test(item.headers?.['user-agent'] || ''))
  };
  if (scenario === 'read') {
    checks.actualFixtureResult = upstreamResults.some(item => JSON.stringify(item).includes(marker));
    checks.followupGeneration = generations.length >= 2;
    const expected = { claude: 'Read', hermes: 'read_file', pi: 'read', dsh: 'read' }[agent];
    checks.originalClientToolName = new RegExp('"name"\\s*:\\s*"' + expected + '"').test(answers);
    checks.noUnexpectedToolCall = [...answers.matchAll(/"name"\s*:\s*"([^"\\]+)"/g)].every(match => [expected, 'ToolSearch'].includes(match[1]));
  }
  return { passed: Object.values(checks).every(Boolean), checks, generationCount: generations.length, clientRequests: client.length,
    nativeResultNames: [...new Set(upstreamResults.map(item => item.name))] };
}

async function runScenario(agent, scenario, runtime, options) {
  const clientRoot = path.join(runtime.root, `${agent}-${scenario}`), port = runtime.port;
  const fixtureFile = path.join(clientRoot, 'work/probe-input.txt');
  const marker = scenario === 'text' ? 'REAL_GATEWAY_TEXT_OK' : 'REAL_GATEWAY_READ_' + crypto.randomBytes(8).toString('hex');
  const prompt = scenario === 'text' ? `This is an isolated connectivity test. Use no tools. Reply with exactly ${marker}.`
    : `This is an isolated file-reading test. Use your file-reading tool to read lines 1 through 2 of ${fixtureFile} (offset 1, limit 2). Return only the exact second line. Do not use shell commands, write tools, other files, web, or subagents.`;
  const settings = helpers.configure(agent, clientRoot, `http://127.0.0.1:${port}`, { model: options.model, prompt, apiKey: runtime.apiKey, scenario });
  privateWrite(fixtureFile, 'CONTROLLED_READ_FIXTURE\n' + marker + '\n');
  if (agent === 'pi') settings.args.push('--tools', 'read');
  if (agent === 'claude') settings.args.push('--tools', 'Read');
  const internalPorts = [];
  if (agent === 'hermes') {
    settings.args.push('--toolsets', 'file');
    // Hermes 0.21.7 CLI discovers a local WS listener through its Unix control
    // socket. The documented webapp config makes that otherwise ephemeral
    // listener predictable so Seatbelt can allow exactly this owned port.
    const localPort = await helpers.unusedPort(); internalPorts.push(localPort);
    const config = path.join(settings.env.HERMES_HOME, 'config.yaml');
    privateWrite(config, fs.readFileSync(config, 'utf8') + `webapp:\n  enabled: true\n  host: 127.0.0.1\n  port: ${localPort}\n`);
  }
  if (agent === 'dsh') {
    settings.env.DSH_PERMISSION_MODE = 'read-only';
    const patch = settings.args[settings.args.indexOf('--patch') + 1];
    const disabled = ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-plugin-manager', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'tool-web', 'tool-goal', 'tool-todo', 'tool-skill', 'tool-working-directory'];
    privateWrite(patch, fs.readFileSync(patch, 'utf8') + disabled.map(id => `- id: ${id}\n  disabled: true\n`).join(''));
  }
  privateWrite(settings.sandbox, clientSandbox(settings, runtime.root, options.source, port, internalPorts));
  const startTrace = readTrace(runtime.traceFile).length;
  let client, outcome = {};
  try {
    client = helpers.launch('/usr/bin/sandbox-exec', ['-f', settings.sandbox, settings.command, ...settings.args], { cwd: settings.work, env: settings.env });
    let timeout, monitor;
    try { outcome = await Promise.race([client.done,
      new Promise(resolve => { timeout = setTimeout(() => resolve({ code: null, timedOut: true }), options.timeoutMs); }),
      new Promise(resolve => { monitor = setInterval(() => {
        const failure = readTrace(runtime.traceFile).slice(startTrace).find(item => item.type === 'client-http' && item.body?.model === options.model && /account_pool_unavailable|account_quota_protected/.test(item.responseBody || ''));
        if (failure) resolve({ code: null, blockedCode: /account_quota_protected/.test(failure.responseBody) ? 'account_quota_protected' : 'account_pool_unavailable', stoppedClientRetries: true });
      }, 100); })]); }
    finally { clearTimeout(timeout); clearInterval(monitor); }
    if (outcome.timedOut || outcome.blockedCode) await helpers.stop(client);
    outcome.clientReportedError = /"stopReason":"error"|"is_error":true|"type":"error"|OpenAI Responses stream ended before/.test(client.stdout);
  } catch (error) { outcome.error = error.message; }
  finally { await helpers.stop(client); if (agent === 'hermes') await cleanupHermesAndWait(settings); }
  await delay(100);
  const trace = readTrace(runtime.traceFile).slice(startTrace), assessment = assess(agent, scenario, trace, outcome, marker);
  const record = scrub({ agent, ...helpers.version(agent), scenario, recordedAt: new Date().toISOString(), model: options.model,
    evidence: 'actual-cli-real-gateway-real-google-native-tls', realModelValidated: assessment.passed, tlsValidated: assessment.checks.realNativeTLS,
    isolation: 'fresh client HOME/workdir; separate copied agy account pool with original quota and health; CLI loopback only; original native Go TLS transport retained',
    source: runtime.source, accountSnapshot: runtime.snapshot.summary, command: [settings.command, ...settings.args], marker,
    ...(agent === 'hermes' ? { hermesDiagnostics: hermesDiagnostics(settings.env.HERMES_HOME) } : {}),
    assessment, outcome, trace, stdout: client?.stdout || '', stderr: client?.stderr || '' }, runtime.snapshot.secrets.concat(runtime.apiKey), runtime.root);
  privateWrite(path.join(options.output, `${agent}-${scenario}.json`), record);
  console.log(JSON.stringify({ agent, scenario, ...assessment, outcome: record.outcome }));
  return record;
}

async function main() {
  process.umask(0o077);
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('macOS Seatbelt is required.');
  const argv = process.argv.slice(2), option = (name, fallback) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1]; };
  const options = { source: path.resolve(option('--source-config', path.join(SOURCE_HOME, '.antigravity-gateway'))),
    output: path.resolve(option('--out', 'tests/fixtures/real-client-gateway-20261107')),
    model: option('--model', 'gemini-3.8-flash-high'), timeoutMs: Number(option('--timeout', '150')) * 1000 };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000) throw new Error('Timeout must be 1–300 seconds.');
  const agents = option('--agents', 'claude,hermes,pi,dsh').split(','), scenarios = option('--scenarios', 'text,read').split(',');
  if (agents.some(agent => !['claude', 'hermes', 'pi', 'dsh'].includes(agent)) || scenarios.some(scenario => !['text', 'read'].includes(scenario))) throw new Error('Unsupported scenario or agent.');
  const root = fs.mkdtempSync('/private/tmp/agy-real-'); fs.chmodSync(root, 0o700);
  const configDir = path.join(root, 'gateway-data'), traceFile = path.join(root, 'sanitized-trace.jsonl');
  const apiKey = 'local-real-verifier-' + crypto.randomBytes(24).toString('hex');
  let gateway, snapshot, source = sourceSnapshot(), results = [], startup = {}, runError;
  try {
    snapshot = copyManagedState(options.source, configDir);
    console.log(JSON.stringify({ stage: 'prepared', source, snapshot: snapshot.summary, productionAccountsBefore: snapshot.before, willRun: argv.includes('--run') }));
    if (!argv.includes('--run')) return;
    const port = await helpers.unusedPort(), preload = path.join(root, 'observe-native.js'), sandbox = path.join(root, 'gateway.sb');
    privateWrite(preload, observerSource(traceFile, configDir, root, apiKey));
    privateWrite(sandbox, gatewaySandbox(root, options.source));
    const home = path.join(root, 'gateway-home'), tmp = path.join(root, 'tmp'); fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(tmp);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, USER: 'probe', LOGNAME: 'probe', TERM: 'dumb', NO_COLOR: '1',
      ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir, ANTIGRAVITY_GATEWAY_PORT: String(port), ANTIGRAVITY_GATEWAY_HOST: '127.0.0.1',
      ANTIGRAVITY_GATEWAY_API_KEY: apiKey, ANTIGRAVITY_GATEWAY_TIMEOUT_MS: String(options.timeoutMs), ANTIGRAVITY_DEFAULT_MODEL: options.model };
    gateway = helpers.launch('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, '--require', preload, path.join(ROOT, 'antigravity-gateway.js')], { cwd: home, env });
    let ready = false;
    for (let index = 0; index < 240 && !gateway.closed; index++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1000) });
        const body = await response.json(); startup = { status: response.status, modelPresent: body.data?.some(item => item.id === options.model), modelCount: body.data?.length || 0 };
        if (startup.modelPresent) { ready = true; break; }
      } catch {}
      await delay(250);
    }
    if (!ready) throw new Error('Isolated gateway could not advertise the requested model under the preserved account/quota/health rules.');
    const runtime = { root, port, apiKey, traceFile, snapshot, source };
    scenariosLoop: for (const agent of agents) for (const scenario of scenarios) {
      const result = await runScenario(agent, scenario, runtime, options); results.push(result);
      if (result.outcome.blockedCode) break scenariosLoop;
    }
  } catch (error) { runError = error.message; process.exitCode = 1; }
  finally {
    try {
    await helpers.stop(gateway);
    const after = accountSnapshot(options.source), sourceAfter = sourceSnapshot();
    const summary = scrub({ recordedAt: new Date().toISOString(), evidence: 'actual-cli-real-gateway-real-google-native-tls', ran: argv.includes('--run'),
      productionAccountsBefore: snapshot?.before, productionAccountsAfter: after, productionAccountsUnchanged: snapshot?.before.digest === after.digest,
      sourceBefore: source, sourceAfter, sourceUnchanged: source.sha256 === sourceAfter.sha256, snapshot: snapshot?.summary, startup, runError,
      results: results.map(({ agent, version, scenario, assessment, outcome }) => ({ agent, version, scenario, assessment, outcome })),
      gatewayStdout: gateway?.stdout || '', gatewayStderr: gateway?.stderr || '', startupTrace: readTrace(traceFile).filter(item => item.type !== 'client-http' || !/^\/v1\/(messages|responses)/.test(item.path))
    }, (snapshot?.secrets || []).concat(apiKey), root);
    privateWrite(path.join(options.output, argv.includes('--run') ? 'summary.json' : 'preflight.json'), summary);
    if (argv.includes('--run') && (runError || !summary.productionAccountsUnchanged || !summary.sourceUnchanged || results.some(result => !result.assessment.passed))) process.exitCode = 1;
    console.log(JSON.stringify({ stage: 'finished', ran: summary.ran, productionAccountsUnchanged: summary.productionAccountsUnchanged, sourceUnchanged: summary.sourceUnchanged, passed: results.filter(result => result.assessment.passed).length, total: results.length, error: summary.runError }));
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  }
}
async function cleanupHermesAndWait(settings) {
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(settings.env.HERMES_HOME, 'gateway.pid'), 'utf8')); } catch {}
  helpers.cleanupHermes(settings);
  if (record?.hermes_home !== settings.env.HERMES_HOME || record.kind !== 'hermes-gateway' || !Number.isInteger(record.pid) || record.pid < 2) return;
  // The helper verifies the owned process command before SIGTERM. Wait for its
  // state writer to stop before removing the directory that contains credentials.
  for (let i = 0; i < 50; i++) {
    try { process.kill(record.pid, 0); } catch { return; }
    await delay(100);
  }
  // Kill only if the same private pid record still identifies the same owner.
  try {
    const current = JSON.parse(fs.readFileSync(path.join(settings.env.HERMES_HOME, 'gateway.pid'), 'utf8'));
    if (current.pid === record.pid && current.hermes_home === record.hermes_home && current.kind === record.kind) {
      const command = require('node:child_process').execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (command.includes('hermes') && command.includes('gateway')) process.kill(record.pid, 'SIGKILL');
    }
  } catch {}
  await delay(200);
}
function hermesDiagnostics(home) {
  const output = [];
  function visit(directory, depth = 0) {
    if (depth > 3 || !fs.existsSync(directory) || output.length >= 20) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory() && !['installs', 'environments'].includes(item.name)) visit(file, depth + 1);
      else if (item.isFile() && /(?:\.log|\.pid)$/.test(item.name)) {
        const size = fs.statSync(file).size;
        if (size < 256 * 1024) output.push({ path: path.relative(home, file), text: fs.readFileSync(file, 'utf8') });
      }
    }
  }
  visit(home); return output;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { accountSnapshot, copyManagedState, scrub, observerSource, assess, sourceSnapshot, gatewaySandbox, clientSandbox, STATE_FILES, runScenario, privateWrite };
