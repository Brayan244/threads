// All writes use synthetic fixture origins and temporary history, never live sessions.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
const bin=fileURLToPath(new URL('../bin/threads',import.meta.url));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'threads-node-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const data=join(root,'data');
  const env={...process.env};delete env.CODEX_THREAD_ID;
  const args=['--data-dir',data,'--pi-session-id',A,'--pi-session-ref','/tmp/threads-fixture/pi.jsonl'];
  function raw(command,input='',status=0,options={}){
    let output;
    try{output=execFileSync(process.execPath,[bin,...(options.prefix??args),...command],{env:{...env,...options.env},input,encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']});assert.equal(status,0);}
    catch(error){assert.equal(error.status,status,error.stdout?.toString()+error.stderr?.toString());assert.equal(error.stderr?.toString(),'');output=error.stdout.toString();}
    const result=JSON.parse(output);assert.equal(result.contract_version,1);return result;
  }
  const record=(key,changes={})=>raw(['record'],JSON.stringify({kind:'progress',body:'Fixture work.',operation_key:key,...changes})).result.event;
  return {root,data,env,args,raw,record};
}

test('Node CLI help/list/current have the v1 JSON boundary and no startup threads',t=>{
  const {raw,data}=fixture(t);
  assert.equal(raw(['--help']).ok,true);
  assert.deepEqual(raw(['list']).result.threads,[]);
  assert.equal(raw(['current']).result.association,null);
  assert.equal(raw(['list'],'',0,{prefix:['--data-dir',data]}).ok,true);
});

test('identity override, invalid arguments, duplicate/oversized input and Unicode errors stay redacted',t=>{
  const {raw,data}=fixture(t);
  const bad=[
    '{"kind":"progress","kind":"observation"}',
    JSON.stringify({kind:'progress',body:'secret-fixture',operation_key:'x',origin:{agent:'forged'}}),
    JSON.stringify({kind:'progress',body:'\ud800',operation_key:'x'}),
    '{"kind":"progress","retained":NaN}',
    ' '.repeat(65537),
  ];
  for(const input of bad){const response=raw(['record'],input,2);assert.equal(response.ok,false);assert.doesNotMatch(JSON.stringify(response),/secret-fixture|forged|\/tmp\//);}
  for(const command of [[],['bogus'],['list','--limit','0'],['list','--reference-kind','issue'],['show'],['sessions','x','--include-origin']])assert.equal(raw(command,'',2).ok,false);
  assert.equal(raw(['list'],'private-payload',2).error.code,'invalid_input');
  const response=raw(['record'],JSON.stringify({kind:'progress',body:'Fixture',operation_key:'identity'}),2,{prefix:['--data-dir',data]});
  assert.equal(response.error.code,'identity_required');
  assert.equal(raw(['current'],'',2,{env:{CODEX_THREAD_ID:B}}).error.code,'identity_required');
});

test('Pi/Codex origins, exact retry, conflict and current binding survive the runtime change',t=>{
  const {raw,record,data}=fixture(t);
  const first=record('first');assert.equal(first.origin.agent,'pi');
  assert.deepEqual(record('first'),first);
  assert.equal(raw(['record'],JSON.stringify({kind:'progress',body:'different',operation_key:'first'}),3).error.code,'conflict');
  const second=raw(['record'],JSON.stringify({kind:'progress',body:'Codex fixture.',thread_id:first.thread_id,operation_key:'codex'}),0,
    {prefix:['--data-dir',data],env:{CODEX_THREAD_ID:B,CODEX_HOME:'/tmp/threads-fixture/codex'}}).result.event;
  assert.equal(second.origin.agent,'codex');assert.equal(second.thread_id,first.thread_id);
  assert.equal(raw(['current']).result.association.thread_id,first.thread_id);
  const third=record('new-work');
  raw(['associate'],JSON.stringify({thread_id:first.thread_id,operation_key:'switch'}));
  record('first');assert.equal(raw(['current']).result.association.thread_id,first.thread_id);
  assert.notEqual(third.thread_id,first.thread_id);
});

test('independent keyset pages omit internal references/origins by default and retain typed evidence',t=>{
  const {raw,record}=fixture(t);
  const first=record('create',{references:[{kind:'issue',reference:'DEMO-1'}]});
  for(let i=0;i<5;i++)record(`more-${i}`,{thread_id:first.thread_id,evidence:[{kind:'document',reference:'/tmp/fixture.md',target:{object_id:'plan',version:'v1'}}]});
  const show=raw(['show',first.thread_id,'--limit','2']).result;
  assert.equal(show.events.length,2);assert.equal(show.events[0].origin,undefined);assert.equal(show.thread.references,undefined);
  assert.equal(show.events[0].evidence[0].target.version,'v1');
  const older=raw(['show',first.thread_id,'--limit','2','--before-sequence',String(show.next_before_sequence),'--include-origin','--include-references']).result;
  assert.ok(older.events[0].origin);assert.deepEqual(older.thread.references,[{kind:'issue',reference:'DEMO-1'}]);
  const oldest=raw(['events',first.thread_id,'--limit','2']).result;
  assert.equal(oldest.events[0].sequence,1);assert.equal(oldest.next_after_sequence,2);
  assert.equal(raw(['list','--reference-kind','issue','--reference','DEMO-1']).result.threads.length,1);
  assert.equal(raw(['sessions',first.thread_id]).result.associations.length,6);
  assert.equal(raw(['show','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],'',4).error.code,'not_found');
});

test('busy SQLite and unsafe permissions return bounded errors without partial writes',t=>{
  const {raw,record,data}=fixture(t);const first=record('first');
  const db=new DatabaseSync(join(data,'threads.sqlite3'));db.exec('BEGIN IMMEDIATE');
  const busy=raw(['record'],JSON.stringify({kind:'progress',body:'Retry fixture.',thread_id:first.thread_id,operation_key:'busy'}),5,
    {prefix:['--data-dir',data,'--busy-timeout-ms','20','--pi-session-id',A,'--pi-session-ref','/tmp/threads-fixture/pi.jsonl']});
  assert.equal(busy.error.retryable,true);db.exec('ROLLBACK');db.close();
  assert.equal(raw(['show',first.thread_id]).result.thread.event_count,1);
  chmodSync(data,0o755);assert.equal(raw(['list'],'',6).error.code,'storage_error');chmodSync(data,0o700);
});

test('parallel Node processes preserve events and identical create retries create one thread',async t=>{
  const {raw,record,args,env}=fixture(t);const first=record('initial');
  function write(payload){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[bin,...args,'record'],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
    child.on('close',code=>{try{assert.equal(code,0,stdout+stderr);assert.equal(stderr,'');resolve(JSON.parse(stdout).result.event);}catch(error){reject(error);}});child.stdin.end(JSON.stringify(payload));});}
  await Promise.all(Array.from({length:12},(_,i)=>write({kind:'progress',body:'Parallel fixture.',thread_id:first.thread_id,operation_key:`parallel-${i}`})));
  assert.equal(raw(['show',first.thread_id]).result.thread.event_count,13);
  const retries=await Promise.all(Array.from({length:6},()=>write({kind:'progress',body:'Identical fixture.',operation_key:'same-create'})));
  assert.equal(new Set(retries.map(event=>event.thread_id)).size,1);assert.equal(new Set(retries.map(event=>event.sequence)).size,1);
});
