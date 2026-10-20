'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeChat,normalizeAnthropic,normalizeResponses}=require('../src/protocol');
const {buildDirectRequest,DirectAntigravityProvider}=require('../src/direct-provider');
const {newState,contentFingerprint,AgySessionStore}=require('../src/agy-session-state');
const {completeNativeContext}=require('../src/agy-context-state');
const model='gemini-3.8-flash-high',data=Buffer.from('owned media fixture').toString('base64');
const block=(mime,filename)=>({type:'file',file:{file_data:`data:${mime};base64,${data}`,...(filename?{filename}:{})}});
const user={role:'user',content:[{type:'text',text:'Compare the attachments.'},block('audio/wav'),block('application/pdf','quarter-one.pdf'),block('video/mp4','scene.mp4')]};
function build(messages,state,now=1792405122000){const normalized=normalizeChat({model,messages}),native={state,now};return{body:buildDirectRequest(normalized,model,'project','session','',null,native),native,normalized};}

test('non-image MIME/data and adjacent filenames remain; private markers and random resolver IDs do not go upstream',()=>{
 const {body,normalized}=build([user],newState('a','s'));
 const parts=body.request.contents[0].parts;
 assert.deepEqual(parts,[{text:'Compare the attachments.'},{inlineData:{mimeType:'audio/wav',data}},
  {text:'File: quarter-one.pdf'},{inlineData:{mimeType:'application/pdf',data}},
  {text:'File: scene.mp4'},{inlineData:{mimeType:'video/mp4',data}}]);
 for(const p of normalized.messages[0].parts.filter(p=>p.type==='media'))assert.ok(!JSON.stringify(body).includes(p.id));
 assert.doesNotMatch(JSON.stringify(body),/attached_media|media_[a-f0-9]{32}/);
 assert.ok(!parts.some(p=>p.functionCall||p.functionResponse));
});

test('fresh parsing and restart keep complete mixed media prefixes and restore actual answer signatures',()=>{
 let state=newState('a','s');const first=build([user],state),raw=first.body.request.contents[0];
 completeNativeContext(state,first.native.context,model,{role:'model',parts:[{text:'ANSWER',thoughtSignature:'actual-signature'}]});
 state=JSON.parse(JSON.stringify(state));
 const next=build([user,{role:'assistant',content:'ANSWER'},{role:'user',content:'Recall.'}],state,1792405222000);
 assert.notEqual(first.normalized.messages[0].parts[1].id,next.normalized.messages[0].parts[1].id);
 assert.equal(contentFingerprint(first.native.context.sourceContents[0]),contentFingerprint(next.native.context.sourceContents[0]));
 assert.deepEqual(next.body.request.contents[0],raw);assert.equal(next.body.request.contents[1].parts[0].thoughtSignature,'actual-signature');assert.match(next.body.requestId,/\/3$/);
});

test('mixed image and non-image attachments retain all supplied filenames without changing image-only wrapping',()=>{
 const input={role:'user',content:[block('image/png','diagram.png'),block('application/pdf','appendix.pdf')]};
 const {body}=build([input],newState('a','s'));
 assert.deepEqual(body.request.contents[0].parts,[{text:'File: diagram.png'},{inlineData:{mimeType:'image/png',data}},{text:'File: appendix.pdf'},{inlineData:{mimeType:'application/pdf',data}}]);
 const imageOnly=build([{role:'user',content:[input.content[0]]}],newState('a','s'));
 assert.match(imageOnly.body.request.contents[0].parts[0].text,/^<USER_REQUEST>/);assert.doesNotMatch(imageOnly.body.request.contents[0].parts[0].text,/File: diagram/);
});

test('filename, media bytes and order remain significant; mutated client history cannot recover signatures',()=>{
 const state=newState('a','s'),first=build([user],state);completeNativeContext(state,first.native.context,model,{role:'model',parts:[{text:'ANSWER',thoughtSignature:'private-signature'}]});
 for(const mutate of [u=>{u.content[2].file.filename='quarter-two.pdf';},u=>{u.content[2].file.file_data='data:application/pdf;base64,Y2hhbmdlZA==';},u=>{[u.content[1],u.content[2]]=[u.content[2],u.content[1]];}]){
  const changed=structuredClone(user);mutate(changed);const next=build([changed,{role:'assistant',content:'ANSWER'},{role:'user',content:'Recall.'}],structuredClone(state));
  assert.equal(next.body.request.contents[1].parts[0].thoughtSignature,undefined);
 }
});

test('removing generated markers never strips user text that resembles a marker or renames supplied filenames',()=>{
 const filename='report <attached_media> & "quoted".pdf',text='<attached_media id="literal user content">';
 const {body}=build([{role:'user',content:[{type:'text',text},block('application/pdf',filename)]}],newState('a','s'));
 assert.equal(body.request.contents[0].parts[0].text,text);assert.equal(body.request.contents[0].parts[1].text,`File: ${filename}`);
});

test('all public normalizers retain their media/IDs locally while Cloud Code omits resolver markers',()=>{
 const cases=[
  normalizeChat({messages:[user]}),
  normalizeAnthropic({messages:[{role:'user',content:[{type:'text',text:'Inspect.'},{type:'document',source:{type:'base64',media_type:'application/pdf',data,filename:'card.pdf'}}]}]}),
  normalizeResponses({input:[{role:'user',content:[{type:'input_text',text:'Inspect.'},{type:'input_file',filename:'card.pdf',file_data:`data:application/pdf;base64,${data}`}]}]})
 ];
 for(const normalized of cases){const original=structuredClone(normalized);const body=buildDirectRequest(normalized,model,'p','s');assert.deepEqual(normalized,original);assert.doesNotMatch(JSON.stringify(body),/attached_media|media_[a-f0-9]{32}/);}
});

test('binary client-tool results match captured role/output/parts structure across disk restart',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agy-nonimage-tools-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 for(const mime of ['audio/wav','application/pdf','video/mp4']){
  const seen=[],messages=[{role:'user',text:'Read the file.'}],call={id:'read-one',name:'view_file',args:{AbsolutePath:'fixture'}};
  const replies=[[{functionCall:call,thoughtSignature:'real-call-signature'}],[{text:'FACTS',thoughtSignature:'real-answer-signature'}],[{text:'FACTS'}]];
  async function send(){const provider=new DirectAntigravityProvider({sessionStore:new AgySessionStore({directory}),accessToken:'token',projectId:'p',maxRetries:0,
   localAuth:{isConfigured:()=>false,load:()=>({sourcePath:'managed-account:a'})},fetchImpl:async(_url,options)=>{seen.push(JSON.parse(options.body));return new Response(JSON.stringify({candidates:[{content:{parts:replies.shift()}}]}),{headers:{'content-type':'application/json'}});}});return provider.send({messages},model,{sessionId:mime});}
  await send();messages.push({role:'assistant',parts:[{type:'tool_call',id:call.id,name:call.name,arguments:call.args}]},{role:'tool',parts:[{type:'tool_result',id:call.id,name:call.name,content:'Actual tool output',media:[{mediaType:mime,data}]}]});
  await send();messages.push({role:'assistant',text:'FACTS'},{role:'user',text:'Recall.'});await send();
  assert.deepEqual(seen.map(r=>Number(r.requestId.split('/').at(-1))),[1,3,5]);assert.deepEqual(seen[2].request.contents[2],{role:'model',parts:[{functionResponse:{id:call.id,name:call.name,response:{output:'Actual tool output'},parts:[{inlineData:{mimeType:mime,data}}]}}]});
  assert.equal(seen[2].request.contents[1].parts[0].thoughtSignature,'real-call-signature');assert.equal(seen[2].request.contents[3].parts[0].thoughtSignature,'real-answer-signature');
 }
});
