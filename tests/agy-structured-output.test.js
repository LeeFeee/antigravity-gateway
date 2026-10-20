'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildDirectRequest,DirectAntigravityProvider}=require('../src/direct-provider');
const {normalizeChat,normalizeAnthropic,normalizeResponses,finalizeModelResult}=require('../src/protocol');
const {prepareStructuredOutput,finishResult}=require('../src/agy-structured-output');
const {AgySessionStore}=require('../src/agy-session-state');
const fixture=require('./fixtures/agy-finish-tool.json');
const model='gemini-3.8-flash-high',schema={type:'object',properties:{code:{type:'string'},count:{type:'integer'}},required:['code','count'],additionalProperties:false};
const user={role:'user',content:'Report code and count.'};
const normalize=messages=>normalizeChat({model,messages,response_format:{type:'json_schema',json_schema:{schema}}});

test('captured finish declaration is exact; schema is present on the first Cloud Code request',()=>{
 const normalized=normalize([user]),original=structuredClone(normalized),native={};
 const body=buildDirectRequest(normalized,model,'p','s','',null,native);
 assert.deepEqual(body.request.tools,[{functionDeclarations:[fixture]}]);
 assert.deepEqual(normalized,original);assert.deepEqual(native.structuredSchema,schema);
 assert.equal(body.request.generationConfig.responseSchema,undefined);assert.equal(body.request.generationConfig.responseMimeType,undefined);
 assert.equal(body.request.systemInstruction,undefined);assert.equal(body.request.toolConfig,undefined);
});

test('three public structured-output formats use the same captured terminal tool without mutating normalization',()=>{
 const cases=[normalize([user]),normalizeAnthropic({messages:[user],output_config:{format:{type:'json_schema',schema}}}),normalizeResponses({input:[user],text:{format:{type:'json_schema',schema}}})];
 for(const n of cases){const before=structuredClone(n),b=buildDirectRequest(n,model,'p','s');assert.deepEqual(b.request.tools,[{functionDeclarations:[fixture]}]);assert.deepEqual(n,before);}
});

test('client tools remain available; none excludes client actions without prohibiting JSON completion',()=>{
 const n=normalize([user]);n.tools=[{name:'read',schema:{type:'object'}}];
 assert.deepEqual(prepareStructuredOutput(n).normalized.tools.map(t=>t.name),['read','finish']);
 n.toolChoice='none';const prepared=prepareStructuredOutput(n);assert.deepEqual(prepared.normalized.tools.map(t=>t.name),['finish']);
 assert.equal(prepared.normalized.toolChoice,'auto');assert.equal(n.toolChoice,'none');
});

test('required/named tools, collisions, auto-mode, checkpoint and unobserved root shapes preserve compatibility',()=>{
 const original=normalize([user]);
 const cases=[{toolChoice:'required'},{toolChoice:{type:'tool',name:'read'}},{tools:[{name:'finish'}]},
  {structuredSchema:{...schema,properties:{toolAction:{type:'string'}}}},
  {structuredSchema:{...schema,properties:{toolSummary:{type:'string'}}}},
  {structuredSchema:{type:'object',required:['toolSummary']}},
  {structuredSchema:{...schema,enum:[{code:'x',count:1}]}},
  {structuredSchema:{...schema,const:{code:'x',count:1}}},
  {structuredSchema:{type:'array',items:{type:'string'}}},{structuredSchema:{...schema,allOf:[]}}, {autoMode:true}];
 for(const extra of cases){const n={...original,...extra};assert.equal(prepareStructuredOutput(n).schema,null);assert.equal(prepareStructuredOutput(n).normalized,n);}
 assert.equal(prepareStructuredOutput(original,{checkpoint:true}).schema,null);
 assert.equal(prepareStructuredOutput({...original,structuredSchema:undefined}).schema,null);
});

test('finish arguments return only validated client JSON; malformed/mixed calls fail without discarding work',()=>{
 const call={id:'native-finish',name:'finish',arguments:{code:'marigold-9372',count:5,toolAction:'Reporting facts',toolSummary:'Facts report'}};
 assert.deepEqual(JSON.parse(finishResult(schema,[call]).text),{code:'marigold-9372',count:5});
 assert.equal(finishResult(schema,[{name:'read',arguments:{}}]),null);
 for(const calls of [[call,{name:'read'}],[{...call,arguments:'bad json'}],[{...call,arguments:[]}],[{...call,arguments:{code:'x'}}],[{...call,arguments:{code:'x',count:1,extra:'no'}}]]){
  assert.throws(()=>finishResult(schema,calls),{code:'invalid_structured_output'});
 }
 assert.equal(finishResult(null,[call]),null);
});

test('strict JSON echo restores signed finish and native result across disk restart; edited prefixes never recover them',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agy-schema-state-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const seen=[],chunks=[],call={id:'call_native',name:'finish',args:{code:'marigold-9372',count:5,toolAction:'Reporting facts',toolSummary:'Facts report'}};
 async function send(messages,session='one'){
  const provider=new DirectAntigravityProvider({sessionStore:new AgySessionStore({directory}),accessToken:'token',projectId:'p',maxRetries:0,
   localAuth:{isConfigured:()=>false,load:()=>({sourcePath:'managed-account:a'})},fetchImpl:async(_url,options)=>{seen.push(JSON.parse(options.body));return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'Do not stream this prose.'},{functionCall:call,thoughtSignature:'actual-native-signature'}]}}]}),{headers:{'content-type':'application/json'}});}});
  return finalizeModelResult(normalize(messages),await provider.send(normalize(messages),model,{sessionId:session,onDelta:text=>chunks.push(text)}));
 }
 const first=await send([user]);assert.equal(first.toolCalls.length,0);assert.deepEqual(JSON.parse(first.text),{code:'marigold-9372',count:5});assert.deepEqual(chunks,[]);
 const history=[user,{role:'assistant',content:first.text},{role:'user',content:'Recall.'}];await send(history);
 const contents=seen[1].request.contents;
 assert.equal(contents[1].parts[1].functionCall.name,'finish');assert.equal(contents[1].parts[1].thoughtSignature,'actual-native-signature');
 assert.deepEqual(contents[1].parts[1].functionCall,call);
 assert.equal(contents[2].role,'model');assert.equal(contents[2].parts[0].functionResponse.id,call.id);
 assert.match(contents[2].parts[0].functionResponse.response.output,/^Created At: .*\nCompleted At: .*\nTask is complete\. Summarize what you did and do not call any more tools\.$/);
 assert.match(seen[1].requestId,/\/4$/);assert.ok(seen[1].request.labels.last_execution_id);
 await send([{...user,content:'Changed prefix'},...history.slice(1)]);
 assert.equal(seen[2].request.contents.some(c=>c.parts.some(p=>p.functionCall?.name==='finish')),false);
 await send(history,'other');assert.equal(seen[3].request.contents.some(c=>c.parts.some(p=>p.functionCall?.name==='finish')),false);
});

test('ordinary tool calls in a structured turn remain client calls, not terminal output',async()=>{
 const n=normalize([user]);n.tools=[{name:'read',schema:{type:'object',properties:{file:{type:'string'}}}}];
 const call={id:'read-id',name:'read',args:{file:'memory.txt'}};
 const provider=new DirectAntigravityProvider({sessionStore:new AgySessionStore({directory:''}),accessToken:'token',projectId:'p',maxRetries:0,localAuth:{isConfigured:()=>false,load:()=>({})},fetchImpl:async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{functionCall:call}]}}]}),{headers:{'content-type':'application/json'}})});
 const result=finalizeModelResult(n,await provider.send(n,model,{sessionId:'tool'}));assert.equal(result.toolCalls[0].name,'read');assert.deepEqual(result.toolCalls[0].arguments,{file:'memory.txt'});
});
