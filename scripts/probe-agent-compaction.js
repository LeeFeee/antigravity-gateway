#!/usr/bin/env node
'use strict';
// Actual installed clients -> loopback synthetic provider only. Never Google.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {setTimeout:delay}=require('node:timers/promises');
const helpers=require('./verify-client-gateway');
const {clientSandbox,privateWrite,scrub}=require('./verify-real-client-gateway');
const HOME=os.homedir(), MODEL='claude-sonnet-4-6', KEY='local-compaction-fake-key';
const SUMMARY='COMPACTION_SYNTHETIC_CHECKPOINT: Controlled local test; one fixture was read. Continue without tools.';
const LONG='CONTROLLED_LONG_HISTORY\n'+Array.from({length:600},(_,i)=>`Fixture fact ${i}: ${require('node:crypto').createHash('sha256').update('controlled-fact-'+i).digest('hex')}`).join('\n');
let replyText='LOCAL_COMPACTION_OK', replyIndex=0;
function responsesReply(body, call) {
  const serial=++replyIndex;
  const calls = Array.isArray(call) ? call : call ? [call] : [];
  const output = calls.length ? calls.map((item, index) => ({ type: 'function_call', id: `fc_probe_${serial}_${index + 1}`, call_id: `call_probe_${index + 1}`, name: item.name,
    arguments: JSON.stringify(item.arguments), status: 'completed' })) : [{ type: 'message', id: `msg_probe_${serial}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: replyText, annotations: [] }] }];
  return { id: `resp_probe_${serial}`, object: 'response', created_at: 1794000000, status: 'completed', model: body.model,
    output, error: null, incomplete_details: null,
    usage: { input_tokens: 128, output_tokens: 12, total_tokens: 140, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}

function sendResponses(res, body, call) {
  const reply = responsesReply(body, call);
  if (!body.stream) return res.end(JSON.stringify(reply));
  let sequence = 0;
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  event('response.created', { response: { ...reply, status: 'in_progress', output: [], usage: null } });
  event('response.in_progress', { response: { ...reply, status: 'in_progress', output: [], usage: null } });
  for (const [index, item] of reply.output.entries()) {
    event('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(call ? { arguments: '' } : { content: [] }) } });
    if (call) {
      for (const delta of item.arguments.match(/.{1,19}/gs) || []) event('response.function_call_arguments.delta', { output_index: index, item_id: item.id, delta });
      event('response.function_call_arguments.done', { output_index: index, item_id: item.id, arguments: item.arguments });
    } else {
      event('response.content_part.added', { output_index: index, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (const delta of [replyText]) event('response.output_text.delta', { output_index: index, item_id: item.id, content_index: 0, delta });
      event('response.output_text.done', { output_index: index, item_id: item.id, content_index: 0, text: replyText });
      event('response.content_part.done', { output_index: index, item_id: item.id, content_index: 0, part: item.content[0] });
    }
    event('response.output_item.done', { output_index: index, item });
  }
  event('response.completed', { response: reply });
  res.end();
}

function sendMessages(res, body, call) {
  const calls = Array.isArray(call) ? call : call ? [call] : [];
  const content = calls.length ? calls.map((item, index) => ({ type: 'tool_use', id: `toolu_probe_${index + 1}`, name: item.name, input: item.arguments }))
    : [{ type: 'text', text: replyText }];
  const reply = { id: `msg_probe_${++replyIndex}`, type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 128, output_tokens: 12 } };
  if (!body.stream) return res.end(JSON.stringify(reply));
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...reply, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 1 } } });
  for (const [index, block] of content.entries()) {
    event('content_block_start', { index, content_block: call ? { ...block, input: {} } : { type: 'text', text: '' } });
    for (const chunk of (call ? JSON.stringify(block.input).match(/.{1,19}/gs) : [replyText]) || []) {
      event('content_block_delta', { index, delta: call ? { type: 'input_json_delta', partial_json: chunk } : { type: 'text_delta', text: chunk } });
    }
    event('content_block_stop', { index });
  }
  event('message_delta', { delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: 12 } });
  event('message_stop', {});
  res.end();
}

function launchOpen(command,args,options){const child=require('node:child_process').spawn(command,args,{...options,stdio:['pipe','pipe','pipe'],detached:true});const state={child,stdout:'',stderr:'',closed:false};child.stdout.on('data',x=>state.stdout+=x);child.stderr.on('data',x=>state.stderr+=x);child.stdin.on('error',error=>{state.stderr+=error.message;});state.done=new Promise(resolve=>{child.once('error',error=>{state.closed=true;resolve({error:error.message});});child.once('close',(code,signal)=>{state.closed=true;resolve({code,signal});});});return state;}
function sendChat(res,body){const message={role:'assistant',content:replyText};if(!body.stream)return res.end(JSON.stringify({id:'chatcmpl_probe',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:'stop'}],usage:{prompt_tokens:128,completion_tokens:12,total_tokens:140}}));res.write(`data: ${JSON.stringify({id:'chatcmpl_probe',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:message,finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'chatcmpl_probe',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);res.end();}
function readCall(agent,body,work){const names={claude:'Read',pi:'read',hermes:'read_file',dsh:'read'};const name=names[agent],t=(body.tools||[]).find(t=>(t.name||t.function?.name)===name);if(!t)return null;const schema=t.input_schema||t.parameters||t.function?.parameters||{},properties=schema.properties||{};const key=['file_path','path','Path'].find(k=>properties[k]);if(!key)return null;return{name,arguments:{[key]:path.join(work,'probe-input.txt'),offset:1,limit:2}};}
function sessionId(stdout,agent){const rows=stdout.split('\n').flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}});const row=agent==='hermes'?rows.find(r=>typeof r.session_id==='string'&&r.session_id.length>0):agent==='claude'?rows.find(r=>r.type==='system'&&r.subtype==='init'):rows.find(r=>r.type==='session');return row&&(row.session_id||row.sessionId||row.id);}
async function invoke(settings,args,runs,phase,stdin){const child=launchOpen('/usr/bin/sandbox-exec',['-f',settings.sandbox,settings.command,...args],{cwd:settings.work,env:settings.env});if(stdin)child.child.stdin.end(stdin);else child.child.stdin.end();let timer;const result=await Promise.race([child.done,new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),90000);})]);clearTimeout(timer);await helpers.stop(child);runs.push({phase,args,result,stdout:child.stdout,stderr:child.stderr});if(result.timedOut||result.code!==0)throw Error(`Client failed at ${phase}`);return child.stdout;}
async function probe(agent,output){const root=fs.mkdtempSync('/private/tmp/agy-compact-');let phase='seed1',settings,called=false;const captures=[],runs=[],actions=[];let error,compactOutcome;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw);}catch{body=raw;}captures.push({phase,method:req.method,path:req.url,headers:req.headers,body});res.setHeader('content-type','application/json');
 if(req.method==='GET'){res.end(JSON.stringify({object:'list',data:[{id:MODEL,object:'model',context_length:200000}]}));return;}
 if(!/messages|responses|chat\/completions/.test(req.url)){res.statusCode=404;res.end('{}');return;}
 const serialized=JSON.stringify(body),isCompact=phase==='compact'||/You are now acting as a compaction engine|summarizing conversations|Create a structured summary of the conversation|conversation summarization assistant/.test(serialized);
 let call;if(!called&&phase==='seed1'){call=readCall(agent,body,settings.work);if(call)called=true;}
 replyText=isCompact?SUMMARY:phase==='after'?'LOCAL_COMPACTION_FOLLOWUP_OK':(body.tools?.length?LONG:'LOCAL_AUXILIARY_OK');
 if(body.stream)res.setHeader('content-type','text/event-stream');
 if(req.url.includes('/messages'))sendMessages(res,body,call);else if(req.url.includes('/chat/completions'))sendChat(res,body);else sendResponses(res,body,call);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 try{settings=helpers.configure(agent,root,`http://127.0.0.1:${port}`,{model:MODEL,prompt:'Read the two lines of probe-input.txt using only the file-reading tool, then acknowledge this local test.',apiKey:KEY,scenario:'read'});
 const internal=[];
 if(agent==='claude')settings.args.push('--tools','Read');
 if(agent==='pi'){settings.args.push('--tools','read');privateWrite(path.join(settings.env.PI_CODING_AGENT_DIR,'settings.json'),{compaction:{enabled:false,keepRecentTokens:128,reserveTokens:1024}});}
 if(agent==='hermes'){settings.args.push('--toolsets','file');const p=await helpers.unusedPort();internal.push(p);const config=path.join(settings.env.HERMES_HOME,'config.yaml');privateWrite(config,fs.readFileSync(config,'utf8')+`webapp:\n  enabled: true\n  host: 127.0.0.1\n  port: ${p}\ncompression:\n  enabled: false\n  protect_first_n: 0\n  protect_last_n: 3\n  tail_mode: legacy\n  target_ratio: 0.01\n`);}
 if(agent==='dsh'){const patch=settings.args[settings.args.indexOf('--patch')+1];privateWrite(patch,fs.readFileSync(patch,'utf8')+'- id: compaction-basic\n  config:\n    auto: false\n    retainTokens: 128\n    headroomTokens: 1024\n    maxTokens: 512\n');}
 privateWrite(settings.sandbox,clientSandbox(settings,root,path.join(HOME,'.antigravity-gateway'),port,internal));
 if(agent==='pi'){
 const args=settings.args.filter(a=>a!== '-p'&&a!==settings.args[1]);args[args.indexOf('--mode')+1]='rpc';
 const child=launchOpen('/usr/bin/sandbox-exec',['-f',settings.sandbox,settings.command,...args],{cwd:settings.work,env:settings.env});
 let cursor=0;async function rpc(command,wait){actions.push({phase,command});const start=child.stdout.length;child.child.stdin.write(JSON.stringify(command)+'\n');for(let i=0;i<900;i++){const text=child.stdout.slice(start);if(text.includes(wait)){runs.push({phase,result:{code:0},stdout:text});return;}if(child.closed)throw Error('Pi RPC exited');await delay(100);}throw Error('Pi RPC timeout');}
 try{for(let i=1;i<=3;i++){phase=`seed${i}`;await rpc({id:phase,type:'prompt',message:i===1?settings.args[1]:`Controlled followup ${i}. Keep previous fixture details.`},'"type":"agent_settled"');}phase='compact';await rpc({id:'compact',type:'compact',customInstructions:'Preserve controlled fixture facts.'},'"command":"compact"');phase='after';await rpc({id:'after',type:'prompt',message:'Continue the local test from the checkpoint. Use no tools.'},'"type":"agent_settled"');compactOutcome='rpc-completed';}finally{await helpers.stop(child);runs.push({phase:'rpc-process',stdout:child.stdout,stderr:child.stderr});}
 }else{
 const originalPrompt=settings.args[agent==='claude'?1:agent==='hermes'?2:settings.args.length-1];
 const argsFor=(prompt,id)=>{const args=settings.args.map(arg=>arg===originalPrompt?prompt:arg);if(id)args.push(agent==='dsh'?'--session-id':'--resume',id);return args;};
 let sid;
 for(let i=1;i<=3;i++){phase=`seed${i}`;const stdout=await invoke(settings,argsFor(i===1?originalPrompt:`Controlled followup ${i}. Keep previous fixture facts.`,sid),runs,phase);sid=sessionId(stdout,agent)||sid;if(!sid)throw Error('Missing session ID');}
 phase='compact';
 if(agent==='hermes'){
 const facts=JSON.parse(fs.readFileSync(settings.env.__HERMES_ACTIVATED));const python=path.join(facts.packages.venv.environment,'bin/python');const program=path.join(root,'compact.py');privateWrite(program,`import asyncio,json\nfrom hermes_cli.gateway_client import connect_gateway\nfrom hermes_cli.gateway_mutations import PreparedMutations\nasync def run():\n async with connect_gateway() as c:\n  r=await PreparedMutations().apply(c,${JSON.stringify(sid)},'compress',{})\n  print(json.dumps(r))\nasyncio.run(run())\n`);actions.push({phase,api:'Hermes installed gateway_client.connect_gateway -> session.mutate compress'});const apiSettings={...settings,command:python,env:{...settings.env,PYTHONPATH:path.join(HOME,'.hermes/hermes-agent')}};const stdout=await invoke(apiSettings,[program],runs,phase);compactOutcome=stdout;try{sid=JSON.parse(stdout).branched_session_id||sid;}catch{}
 }else if(agent==='dsh'){
 const patch=settings.args[settings.args.indexOf('--patch')+1];privateWrite(patch,fs.readFileSync(patch,'utf8').replace('auto: false','auto: true').replace('retainTokens: 128','thresholdRatio: 0.04\n    retainTokens: 128'));compactOutcome=await invoke(settings,argsFor('Continue this long local conversation. No tools.',sid),runs,phase);
 }else compactOutcome=await invoke(settings,argsFor('/compact Preserve controlled fixture facts.',sid),runs,phase);
 phase='after';await invoke(settings,argsFor('Continue the local test from the checkpoint. Use no tools.',sid),runs,phase);
 }
 }catch(e){error=e.message;}finally{if(agent==='hermes'&&settings){helpers.cleanupHermes(settings);await delay(1500);}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 const record=scrub({agent,...helpers.version(agent),recordedAt:new Date().toISOString(),evidence:'actual-client-loopback-compaction-capture',trigger:({claude:'CLI /compact --resume',pi:'CLI RPC compact',hermes:'Installed PreparedMutations compress API used by CLI /compress',dsh:'Configured compaction-basic automatic threshold'})[agent],upstream:'synthetic-local-only',realModelValidated:false,root,syntheticProvider:{uniqueMessageIds:true,textBytes:Buffer.byteLength(LONG),reportedUsageIsSynthetic:true,summary:SUMMARY},actions,runs,compactOutcome,error,captures},[KEY],root);
 privateWrite(path.join(output,`${agent}-compact.json`),record);fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});console.log(JSON.stringify({agent,error,captures:captures.length,phases:Object.fromEntries([...new Set(captures.map(x=>x.phase))].map(p=>[p,captures.filter(x=>x.phase===p).length]))}));return record;
}
async function main(){process.umask(0o077);if(process.platform!=='darwin')throw Error('Requires macOS Seatbelt');const argv=process.argv.slice(2),get=(key,fallback)=>{const i=argv.indexOf(key);return i<0?fallback:argv[i+1];};const output=path.resolve(get('--out','tests/fixtures/agent-compaction-20261107'));for(const agent of get('--agents','claude,pi,hermes,dsh').split(',')){if(!['claude','pi','hermes','dsh'].includes(agent))throw Error('Unknown agent');const record=await probe(agent,output);if(record.error)process.exitCode=1;}}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={sessionId};
