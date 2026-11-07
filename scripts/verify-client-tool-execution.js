#!/usr/bin/env node
'use strict';
// Actual clients execute only predetermined tools in a private fixture directory.
// Actual Gateway conversion/session/HTTP is retained; Google is loopback synthetic.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const helpers = require('./verify-client-gateway');
const { sourceSnapshot, clientSandbox, privateWrite } = require('./verify-real-client-gateway');
const { normalizeAnthropic, normalizeResponses } = require('../src/protocol');
const { sanitizeClientIdentity } = require('../src/client-identity');
const { prepareAntigravityTools } = require('../src/antigravity-tool-contract');
const ROOT = path.resolve(__dirname, '..'), HOME = require('node:os').homedir();
const MODEL = 'gemini-3.8-flash-high', KEY = 'sk-gateway-local-fixture-not-a-real-key';
const MARKER = 'CLIENT_EXECUTION_VERIFIED', PRINT = 'AGW_FIXED_TERMINAL_MARKER';
const BASE = 'ALPHA = old\nBETA = old\n';
function trace(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; }
function plan(agent, scenario, file, work) {
  const names = { claude: ['Read','Write','Edit','Bash'], pi: ['read','write','edit','bash'], hermes: ['read_file','write_file','patch','terminal'], dsh: ['read','write','edit','bash'] }[agent];
  const pathKey = ['claude','dsh'].includes(agent) ? 'file_path' : 'path';
  if (scenario === 'write') return [{ name: names[1], arguments: { [pathKey]: file, content: `WRITE_${agent}_VERIFIED\n` } }];
  if (scenario === 'terminal') return [{ name: names[3], arguments: { command: `printf '%s\\n' '${PRINT}'`, ...(['claude','dsh'].includes(agent) ? { description: 'Print the fixed local verification marker' } : {}), ...(agent === 'hermes' ? { workdir: work, timeout: 5, background: false } : agent === 'dsh' ? { workdir: work, timeoutMs: 5000, run_in_background: false } : { timeout: agent === 'claude' ? 5000 : 5 }) } }];
  const read = { name: names[0], arguments: { [pathKey]: file, offset: 1, limit: 2 } };
  const edit = agent === 'pi' ? { name: names[2], arguments: { path: file, edits: [{ oldText: 'ALPHA = old', newText: 'ALPHA = pi-one' }, { oldText: 'BETA = old', newText: 'BETA = pi-two' }] } }
    : { name: names[2], arguments: { [pathKey]: file, old_string: agent === 'hermes' ? 'ALPHA = old' : 'old', new_string: agent === 'hermes' ? 'ALPHA = hermes-new' : 'new', replace_all: agent !== 'hermes' } };
  return [read, edit];
}
function expectedFile(agent, scenario) { return scenario === 'write' ? `WRITE_${agent}_VERIFIED\n` : scenario === 'edit' ? agent === 'pi' ? 'ALPHA = pi-one\nBETA = pi-two\n' : agent === 'hermes' ? 'ALPHA = hermes-new\nBETA = old\n' : 'ALPHA = new\nBETA = new\n' : BASE; }
function adapterFrom(body, isMessages) { const normalized = isMessages ? normalizeAnthropic(body) : normalizeResponses(body); const identity = sanitizeClientIdentity(normalized); return prepareAntigravityTools(identity.normalized, { sourceTools: normalized.tools, clientIdentity: identity.metadata.profile }); }
function requestRecorder(upstreamPort, file) {
  return helpers.preloadSource(upstreamPort, file).replace("if (event === 'data') input.push(Buffer.from(args[0])); return emit.call(this, event, ...args);", `if (event === 'data') input.push(Buffer.from(args[0])); if (event === 'end') { let body=Buffer.concat(input).toString('utf8');try{body=JSON.parse(body)}catch{};fs.appendFileSync(${JSON.stringify(file)},JSON.stringify({type:'request-start',path:req.url,body})+'\\n'); } return emit.call(this, event, ...args);`);
}
function callsFromClient(rows) {
  const calls=[];
  for (const row of rows) {
    const blocks=new Map();
    for (const line of (row.responseBody||'').split('\n')) {
      if (!line.startsWith('data: ') || line==='data: [DONE]') continue;
      let event;try{event=JSON.parse(line.slice(6));}catch{continue;}
      if(event.type==='content_block_start'&&event.content_block?.type==='tool_use')blocks.set(event.index,{id:event.content_block.id,name:event.content_block.name,input:event.content_block.input||{},json:''});
      if(event.type==='content_block_delta'&&event.delta?.type==='input_json_delta'&&blocks.has(event.index))blocks.get(event.index).json+=event.delta.partial_json||'';
      if(event.type==='content_block_stop'&&blocks.has(event.index)){const block=blocks.get(event.index);calls.push({id:block.id,name:block.name,arguments:block.json?JSON.parse(block.json):block.input});blocks.delete(event.index);}
      if(event.type==='response.output_item.done'&&event.item?.type==='function_call')calls.push({id:event.item.call_id,name:event.item.name,arguments:JSON.parse(event.item.arguments)});
    }
  }
  return calls;
}
async function run(agent, scenario, output) {
  const root = fs.mkdtempSync('/private/tmp/agy-tool-exec-'), sourceBefore = sourceSnapshot(), captures = [], errors = [], issued = [];
  let settings, gateway, client, outcome = {}, adapter, pointer = 0;
  const traceFile = path.join(root, 'trace.jsonl'), work = path.join(root, 'work'), file = path.join(work, scenario === 'write' ? 'created.txt' : 'edit.txt');
  const steps = plan(agent, scenario, file, work);
  const google = http.createServer(async (req, res) => {
    try {
      let raw=''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw || '{}');
      const capture = { path:req.url, headers:req.headers, body }; captures.push(capture); res.setHeader('content-type','application/json');
      if (req.url.endsWith(':fetchAvailableModels')) return res.end(JSON.stringify({ models:{[MODEL]:{ displayName:'Synthetic Flash High',maxTokens:1048576,maxOutputTokens:65536,supportsThinking:true,thinkingLevel:3 }} }));
      if (req.url.endsWith(':loadCodeAssist')) return res.end(JSON.stringify({cloudaicompanionProject:'synthetic-project',currentTier:{id:'synthetic'}}));
      if (req.url.endsWith(':retrieveUserQuotaSummary')) return res.end('{"groups":[]}');
      if (!req.url.includes(':streamGenerateContent')) throw Error('Unexpected RPC');
      if(captures.filter(c=>c.path.includes(':streamGenerateContent')).length>10)throw Error('Exceeded synthetic request bound');
      const declarations = helpers.declarations(body), receipts = helpers.functionResults(body);
      if (declarations.length && pointer < steps.length) {
        if (pointer > 0 && !receipts.some(r => r.id === issued.at(-1).id)) throw Error('Client did not return prior executed tool result');
        if (!adapter) {
          const request = trace(traceFile).find(r => r.type === 'request-start' && r.body?.tools?.length);
          if (!request) throw Error('Missing original client declaration');
          adapter = adapterFrom(request.body, request.path.includes('/messages'));
        }
        const step = steps[pointer], converted = adapter.toProvider({ ...step, id: `controlled_${agent}_${scenario}_${pointer}` });
        if (!declarations.some(d => d.name === converted.name)) throw Error('Planned native call was not actually declared');
        if (scenario === 'write' && converted.name !== 'write_file') throw Error('Expected official equivalent write view');
        if (scenario === 'edit' && pointer === 1 && ['claude','dsh'].includes(agent) && converted.name !== 'edit_file') throw Error('Expected official equivalent edit view');
        if (scenario === 'edit' && pointer === 1 && ['pi','hermes'].includes(agent) && !converted.name.startsWith('mcp_')) throw Error('Batch/fuzzy edit must preserve full MCP contract');
        const call = { id:converted.id, name:converted.name, args:converted.arguments }; issued.push(call); pointer++; capture.issuedToolCall=call;
        res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify(helpers.googleEvent([{functionCall:call,thoughtSignature:`synthetic_${call.id}`}],true))+'\n\n');return;
      }
      if (declarations.length && pointer === steps.length && !receipts.some(r=>r.id===issued.at(-1)?.id)) throw Error('Final client tool receipt missing');
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify(helpers.googleEvent([{text:MARKER}],true))+'\n\n');
    } catch(error){errors.push(error.message);if(!res.headersSent){res.statusCode=400;res.setHeader('content-type','application/json');}res.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(resolve=>google.listen(0,'127.0.0.1',resolve));const upstreamPort=google.address().port,gatewayPort=await helpers.unusedPort();
  try {
    settings=helpers.configure(agent,root,`http://127.0.0.1:${gatewayPort}`,{model:MODEL,apiKey:KEY,scenario:'text',prompt:`Controlled local ${scenario} test. Follow only the supplied tool calls for ${file}. The terminal test only prints ${PRINT}. End by reporting ${MARKER}.`});
    if(scenario!=='write')privateWrite(file,BASE);
    const internal=[];
    if(agent==='claude'){settings.env.CLAUDE_CODE_TMPDIR=path.join(root,'tmp');const names=scenario==='write'?'Write':scenario==='edit'?'Read,Edit':'Bash';settings.args[settings.args.indexOf('--allowedTools')+1]=names;settings.args.push('--tools',names);settings.args[settings.args.indexOf('--max-turns')+1]='6';}
    if(agent==='dsh' && scenario==='terminal')settings.env.DSH_PERMISSION_MODE='danger-full-access';
    if(agent==='pi')settings.args.push('--tools',scenario==='write'?'write':scenario==='edit'?'read,edit':'bash');
    if(agent==='hermes'){settings.args.push('--toolsets',scenario==='terminal'?'terminal':'file');settings.args[settings.args.indexOf('--max-turns')+1]='6';const p=await helpers.unusedPort();internal.push(p);const config=path.join(settings.env.HERMES_HOME,'config.yaml');privateWrite(config,fs.readFileSync(config,'utf8')+`webapp:\n  enabled: true\n  host: 127.0.0.1\n  port: ${p}\n`);}
    const originalPolicy=fs.readFileSync(settings.sandbox,'utf8');
    const clientPolicy=clientSandbox(settings,root,path.join(HOME,'.antigravity-gateway'),gatewayPort,internal).replace(`(deny file-write* (subpath ${JSON.stringify(work)}))`,'');
    privateWrite(settings.sandbox,clientPolicy);
    const gatewayPolicy=path.join(root,'gateway.sb');privateWrite(gatewayPolicy,originalPolicy+`(deny file-write* (subpath ${JSON.stringify(work)}))`);
    const config=path.join(root,'gateway-data');privateWrite(path.join(config,'accounts/synthetic.json'),{id:'synthetic-tool-account',email:'synthetic@example.invalid',subjectId:'synthetic-tool-identity',accessToken:'gateway-local-fixture-access-token',expiresAt:new Date(Date.now()+86400000).toISOString(),projectId:'synthetic-project',providerType:'cloudcode',accountType:'antigravity',enabled:true,capabilities:[MODEL],authMethod:'oauth'});
    const preload=path.join(root,'observe.js');privateWrite(preload,requestRecorder(upstreamPort,traceFile));
    const env={...settings.env,ANTIGRAVITY_GATEWAY_CONFIG_DIR:config,ANTIGRAVITY_GATEWAY_PORT:String(gatewayPort),ANTIGRAVITY_GATEWAY_API_KEY:KEY,ANTIGRAVITY_DIRECT_BASE_URL:`http://127.0.0.1:${upstreamPort}`,ANTIGRAVITY_DIRECT_MAX_RETRIES:'0',ANTIGRAVITY_GATEWAY_TIMEOUT_MS:'45000',ANTIGRAVITY_CLI_PATH:path.join(root,'no-agy')};
    gateway=helpers.launch('/usr/bin/sandbox-exec',['-f',gatewayPolicy,process.execPath,'--require',preload,path.join(ROOT,'antigravity-gateway.js')],{cwd:root,env});
    let ready=false;for(let i=0;i<200&&!gateway.closed;i++){try{const r=await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`,{headers:{authorization:`Bearer ${KEY}`},signal:AbortSignal.timeout(500)});if((await r.json()).data?.some(m=>m.id===MODEL)){ready=true;break;}}catch{}await delay(50);}if(!ready)throw Error('Gateway did not become ready');
    client=helpers.launch('/usr/bin/sandbox-exec',['-f',settings.sandbox,settings.command,...settings.args],{cwd:work,env:settings.env});let timeout;try{outcome=await Promise.race([client.done,new Promise(resolve=>{timeout=setTimeout(()=>resolve({timedOut:true}),90000);})]);}finally{clearTimeout(timeout);}if(outcome.timedOut)await helpers.stop(client);
  }catch(error){outcome.error=error.message;}finally{await helpers.stop(client);if(agent==='hermes'){helpers.cleanupHermes(settings);await delay(1500);}await helpers.stop(gateway);google.closeAllConnections();await new Promise(resolve=>google.close(resolve));}
  const clientHTTP=trace(traceFile).filter(x=>x.type!=='request-start'),requests=clientHTTP.filter(x=>/^\/v1\/(messages|responses)/.test(x.path));
  const disk=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,expected=expectedFile(agent,scenario),results=captures.flatMap(c=>helpers.functionResults(c.body));
  const calls=callsFromClient(requests);
  const checks={clientCallArgumentsRestored:calls.length===steps.length&&calls.every((call,i)=>call.name===steps[i].name&&require('node:util').isDeepStrictEqual(call.arguments,steps[i].arguments)),clientSucceeded:outcome.code===0&&!outcome.error&&!outcome.timedOut,gatewayHTTP:requests.length>0&&requests.every(x=>x.status===200),allPlannedToolsIssued:issued.length===steps.length,allClientReceiptsReturned:issued.every(c=>results.some(r=>r.id===c.id&&r.name===c.name)),exactDiskContents:disk===expected,finalAnswer:requests.some(x=>x.responseBody?.includes(MARKER)),noUpstreamError:errors.length===0};
  if(scenario==='terminal')checks.actualTerminalOutput=results.some(r=>JSON.stringify(r).includes(PRINT));
  const sourceAfter=sourceSnapshot();checks.sourceStable=sourceBefore.sha256===sourceAfter.sha256;
  const record=helpers.sanitize({agent,...helpers.version(agent),scenario,recordedAt:new Date().toISOString(),evidence:'actual-cli-real-gateway-synthetic-google-tool-execution',realModelValidated:false,tlsValidated:false,sourceBefore,sourceAfter,
    isolation:'fresh HOME; fake account; CLI explicit loopback ports; writes only private root; gateway forbidden to write client work directory',command:[settings?.command,...(settings?.args||[])],plan:steps,issued,clientCalls:calls,outcome,checks,passed:Object.values(checks).every(Boolean),disk:{file,before:scenario==='write'?null:BASE,expected,actual:disk},errors,clientHTTP,upstream:captures,stdout:client?.stdout||'',stderr:client?.stderr||'',gatewayStderr:gateway?.stderr||''},root,[[gatewayPort,'GATEWAY_PORT'],[upstreamPort,'UPSTREAM_PORT']]);
  privateWrite(path.join(output,`${agent}-${scenario}.json`),record);fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});console.log(JSON.stringify({agent,scenario,passed:record.passed,checks,outcome,errors,native:issued.map(c=>c.name)}));return record;
}
async function main(){process.umask(0o077);if(process.platform!=='darwin')throw Error('Requires macOS Seatbelt');const argv=process.argv.slice(2),option=(k,f)=>{const i=argv.indexOf(k);return i<0?f:argv[i+1];};const agents=option('--agents','claude,pi,hermes,dsh').split(','),scenarios=option('--scenarios','write,edit,terminal').split(',');if(agents.some(a=>!['claude','pi','hermes','dsh'].includes(a))||scenarios.some(s=>!['write','edit','terminal'].includes(s)))throw Error('Unknown agent/scenario');const out=path.resolve(option('--out','tests/fixtures/client-tool-execution-20261107'));const results=[];for(const a of agents)for(const s of scenarios)results.push(await run(a,s,out));privateWrite(path.join(out,'summary.json'),results.map(({agent,version,scenario,passed,checks})=>({agent,version,scenario,passed,checks})));if(results.some(r=>!r.passed))process.exitCode=1;}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={plan,expectedFile,adapterFrom,requestRecorder,callsFromClient};
