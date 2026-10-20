'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {nativeClientToolResponse,NATIVE_ERROR_PREFIX}=require('../src/agy-tool-results');
const {normalizeAnthropic,normalizeChat,normalizeResponses}=require('../src/protocol');
const {buildDirectRequest,DirectAntigravityProvider}=require('../src/direct-provider');
const {AgySessionStore}=require('../src/agy-session-state');
const model='gemini-3.8-flash-high',call={id:'read-one',name:'view_file',args:{AbsolutePath:'/owned/missing.txt'}};
const initial={role:'user',content:'Read the file.'},assistant={role:'assistant',content:[{type:'tool_use',id:call.id,name:call.name,input:call.args}]};
function normalized(error,content){return normalizeAnthropic({messages:[initial,assistant,{role:'user',content:[{type:'tool_result',tool_use_id:call.id,is_error:error,content}]}]});}

test('explicit error flag becomes the captured native output phrase, not a new upstream field',()=>{
 const n=normalized(true,'user declined'),original=structuredClone(n),body=buildDirectRequest(n,model,'p','s');
 assert.deepEqual(body.request.contents.at(-1),{role:'model',parts:[{functionResponse:{id:call.id,name:call.name,response:{output:NATIVE_ERROR_PREFIX+'user declined'}}}]});
 assert.deepEqual(n,original);assert.equal(n.messages.at(-1).parts[0].isError,true);
 assert.doesNotMatch(JSON.stringify(body),/"isError"|"is_error"|"error"|Created At:|Completed At:/);
});

test('failed JSON-looking output retains exact client spelling and whitespace',()=>{
 for(const content of ['false','null','0',' { "code": 7, "why": "denied" }\n','\n spaced error\r\n','']){
  const part=normalized(true,content).messages.at(-1).parts[0];
  const b=buildDirectRequest(normalized(true,content),model,'p','s');assert.equal(b.request.contents.at(-1).parts[0].functionResponse.response.output,NATIVE_ERROR_PREFIX+content);
  assert.equal(part.content,content);
 }
});

test('already native failure envelopes are not duplicated or stripped',()=>{
 const simple=NATIVE_ERROR_PREFIX+'actual failure',timed='Created At: 2026-10-19T19:03:44+08:00\nCompleted At: 2026-10-19T19:03:44+08:00\n'+simple;
 for(const text of [simple,timed,timed.replaceAll('\n','\r\n')])assert.deepEqual(nativeClientToolResponse({isError:true,content:text},text),{output:text});
 const response={output:timed};assert.equal(nativeClientToolResponse({isError:true,content:'unused local text',response},null),response);
});

test('success values and error-looking user payloads are not reclassified',()=>{
 for(const value of [{error:'ordinary data'},{artifact:{gateway_path:'/client/path'}},false,null,0,['error']]){
  const b=buildDirectRequest(normalized(false,JSON.stringify(value)),model,'p','s');assert.deepEqual(b.request.contents.at(-1).parts[0].functionResponse.response,{output:value});
 }
 const text='Encountered error in tool execution: literal user output';
 assert.deepEqual(nativeClientToolResponse({content:text},text),{output:text});
});

test('Anthropic/Chat explicit error flags survive locally; Responses without a failure flag stays unchanged',()=>{
 const a=normalized(true,'denied');
 const c=normalizeChat({messages:[initial,{role:'assistant',content:null,tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]},{role:'tool',tool_call_id:call.id,is_error:true,content:'denied'}]});
 for(const n of [a,c]){const before=structuredClone(n),b=buildDirectRequest(n,model,'p','s');assert.deepEqual(b.request.contents.at(-1).parts[0].functionResponse.response,{output:NATIVE_ERROR_PREFIX+'denied'});assert.deepEqual(n,before);}
 const r=normalizeResponses({input:[{type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.args)},{type:'function_call_output',call_id:call.id,output:'{"error":"client data"}'}]});
 assert.deepEqual(buildDirectRequest(r,model,'p','s').request.contents.at(-1).parts[0].functionResponse.response,{output:{error:'client data'}});
});

test('error result keeps attached binary data and issued parallel result ordering',()=>{
 const n={messages:[{role:'assistant',parts:[{type:'tool_call',id:'one',name:'first',arguments:{}},{type:'tool_call',id:'two',name:'second',arguments:{}}]},
  {role:'tool',parts:[{type:'tool_result',id:'two',isError:true,content:'denied',media:[{mediaType:'image/png',data:'YWJj'}]}]},
  {role:'tool',parts:[{type:'tool_result',id:'one',content:'done'}]}]};
 const parts=buildDirectRequest(n,model,'p','s').request.contents.at(-1).parts;
 assert.deepEqual(parts.map(p=>p.functionResponse.id),['one','two']);assert.equal(parts[1].functionResponse.response.output,NATIVE_ERROR_PREFIX+'denied');
 assert.deepEqual(parts[1].functionResponse.parts,[{inlineData:{mimeType:'image/png',data:'YWJj'}}]);
});

test('native error history, call signature, answer signature and steps survive actual state-file restarts',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agy-tool-error-state-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const seen=[],replies=[[{functionCall:call,thoughtSignature:'actual-call-signature'}],[{text:'FAILED',thoughtSignature:'actual-answer-signature'}],[{text:'FAILED'}]];
 async function send(n){const provider=new DirectAntigravityProvider({sessionStore:new AgySessionStore({directory}),accessToken:'token',projectId:'p',maxRetries:0,localAuth:{isConfigured:()=>false,load:()=>({sourcePath:'managed-account:one'})},fetchImpl:async(_url,o)=>{seen.push(JSON.parse(o.body));return new Response(JSON.stringify({candidates:[{content:{parts:replies.shift()}}]}),{headers:{'content-type':'application/json'}});}});return provider.send(n,model,{sessionId:'same'});}
 await send(normalizeAnthropic({messages:[initial]}));const n=normalized(true,'false');await send(n);
 n.messages.push({role:'assistant',text:'FAILED'},{role:'user',text:'Recall.'});await send(n);
 assert.deepEqual(seen.map(b=>Number(b.requestId.split('/').at(-1))),[1,3,5]);
 assert.deepEqual(seen[2].request.contents[2],seen[1].request.contents[2]);assert.equal(seen[2].request.contents[2].parts[0].functionResponse.response.output,NATIVE_ERROR_PREFIX+'false');
 assert.equal(seen[2].request.contents[1].parts[0].thoughtSignature,'actual-call-signature');assert.equal(seen[2].request.contents[3].parts[0].thoughtSignature,'actual-answer-signature');
});
