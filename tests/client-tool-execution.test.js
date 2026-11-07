'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { plan, expectedFile, callsFromClient } = require('../scripts/verify-client-tool-execution');
const ROOT = path.join(__dirname,'fixtures/client-tool-execution-20261107');
const chosen = [
  ['claude','write','claude-write-final'], ['claude','edit','native-fixed'], ['claude','terminal','terminal-fixed'],
  ['pi','write','pi-native-fixed'], ['pi','edit','initial'], ['pi','terminal','initial'],
  ...['write','edit','terminal'].map(s=>['hermes',s,'initial']),
  ['dsh','write','initial'], ['dsh','edit','initial'], ['dsh','terminal','terminal-fixed']
];
for(const[agent,scenario,directory]of chosen){
  test(`${agent} ${scenario} 完整网关样本证明客户端执行、参数恢复和磁盘结果`,()=>{
    const r=JSON.parse(fs.readFileSync(path.join(ROOT,directory,`${agent}-${scenario}.json`)));
    assert.equal(r.passed,true);
    assert.equal(r.realModelValidated,false);
    assert.equal(r.tlsValidated,false);
    assert.deepEqual(r.errors,[]);
    assert.equal(r.disk.actual,r.disk.expected);
    assert.equal(r.disk.expected,expectedFile(agent,scenario));
    const calls=callsFromClient(r.clientHTTP);
    assert.equal(calls.length,r.plan.length);
    for(const[i,call]of calls.entries()){
      assert.equal(call.name,r.plan[i].name);
      assert.deepEqual(call.arguments,r.plan[i].arguments);
      assert.equal(call.id,r.issued[i].id);
    }
    const receipts=r.upstream.flatMap(item=>(item.body.request?.contents||[]).flatMap(c=>c.parts||[]).filter(p=>p.functionResponse).map(p=>p.functionResponse));
    for(const issued of r.issued)assert.ok(receipts.some(result=>result.id===issued.id&&result.name===issued.name));
    if(scenario==='terminal')assert.ok(receipts.some(result=>JSON.stringify(result).includes('AGW_FIXED_TERMINAL_MARKER')));
    if(scenario==='write')assert.equal(r.issued.at(-1).name,'write_file');
    if(scenario==='edit'&&['claude','dsh'].includes(agent))assert.equal(r.issued.at(-1).name,'edit_file');
    if(scenario==='edit'&&['pi','hermes'].includes(agent))assert.match(r.issued.at(-1).name,/^mcp_gateway_/);
    assert.equal(r.sourceBefore.sha256,r.sourceAfter.sha256);
  });
}
test('执行计划限制为已知文件与固定printf，不引入后台/宽权限调用参数',()=>{
  for(const agent of ['claude','pi','hermes','dsh']){
    const tool=plan(agent,'terminal','/tmp/fixture/file','/tmp/fixture')[0];
    assert.equal(tool.arguments.command,"printf '%s\\n' 'AGW_FIXED_TERMINAL_MARKER'");
    assert.ok(!tool.arguments.sandbox_permissions);
    assert.notEqual(tool.arguments.run_in_background,true);
    assert.notEqual(tool.arguments.background,true);
  }
  const edits=plan('pi','edit','/tmp/fixture/file','/tmp/fixture')[1].arguments.edits;
  assert.equal(edits.length,2);assert.notEqual(edits[0].oldText,edits[1].oldText);
  assert.equal(plan('dsh','edit','/tmp/fixture/file','/tmp/fixture')[1].arguments.replace_all,true);
});
test('聚合报告固定12份成功证据的SHA和16次客户端真实工具执行',()=>{
  const crypto=require('node:crypto'),summary=JSON.parse(fs.readFileSync(path.join(ROOT,'verified-summary.json')));
  assert.equal(summary.records.length,12);assert.equal(summary.executedTools,16);
  assert.equal(summary.realModelValidated,false);assert.equal(summary.allTemporaryDirectoriesRemoved,true);
  for(const record of summary.records){
    const bytes=fs.readFileSync(path.join(ROOT,record.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),record.sha256);
    assert.equal(record.checks.clientCallArgumentsRestored,true);
    assert.equal(record.diskVerified,true);
  }
});
