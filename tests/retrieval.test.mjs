// Synthetic search/projection fixtures; never open the installed history.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Origin, RecordDraft, ValidationError } from '../src/threads/domain.mjs';
import { Store } from '../src/threads/store.mjs';
import { parseJSON } from '../src/threads/json.mjs';
const bin=fileURLToPath(new URL('../bin/threads',import.meta.url));
const origin=new Origin({agent:'pi',session_id:'11111111-1111-4111-8111-111111111111',session_ref:'/tmp/retrieval-fixture.jsonl'});
function fixture(t){
  const root=fs.mkdtempSync(join(tmpdir(),'threads-retrieval-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=join(root,'data'),store=new Store(data);
  const append=(key,changes={})=>store.append(RecordDraft.fromDict({kind:'progress',body:'Fixture body, not a conversation.',summary:'Fixture summary.',title:'Fixture work',origin,operation_key:key,...changes}));
  function cli(args,status=0){
    const result=spawnSync(process.execPath,[bin,'--data-dir',data,...args],{input:'',encoding:'utf8',timeout:15000});
    assert.equal(result.status,status,result.stdout+result.stderr);assert.equal(result.stderr,'');
    const value=parseJSON(result.stdout);assert.equal(value.contract_version,1);return {raw:result.stdout,...value};
  }
  return {root,data,store,append,cli};
}

test('indexed title/summary search finds old work without paging recent threads',t=>{
  const {store,append}=fixture(t);
  const old=append('old',{title:'Sesión de café portable',summary:'Identidad para agentes.'});
  for(let i=0;i<1200;i++)append(`noise-${i}`,{title:`Unrelated ${i}`});
  assert.equal(store.listThreads({limit:20}).some(row=>row.id===old.thread_id),false);
  assert.deepEqual(store.searchThreads('CAFE sesion').threads.map(row=>row.id),[old.thread_id]);
  assert.deepEqual(store.searchThreads('portabl').threads.map(row=>row.id),[old.thread_id]);
  assert.deepEqual(store.searchThreads('nonexistent').threads,[]);
  const db=new DatabaseSync(store.databasePath);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM thread_search_v1 WHERE thread_search_v1 MATCH ?').all('cafe');
  assert.ok(plan.some(row=>/VIRTUAL TABLE INDEX/.test(row.detail)));db.close();
});

test('search is bounded, relevance-ranked, and uses literal terms instead of query operators',t=>{
  const {store,append}=fixture(t);
  const title=append('title',{title:'Orquídea',summary:'Unique fixture.'});
  const summary=append('summary',{title:'Another topic',summary:'Orquídea'});
  const results=store.searchThreads('orquidea',{limit:1});
  assert.equal(results.threads[0].id,title.thread_id);assert.equal(results.has_more,true);
  assert.deepEqual(new Set(store.searchThreads('orquidea').threads.map(row=>row.id)),new Set([title.thread_id,summary.thread_id]));
  assert.deepEqual(store.searchThreads('orquidea OR nonexistent').threads,[]);
  for(const query of ['', '   ', '* : "', 'x'.repeat(321), Array(17).fill('word').join(' '), null, '\ud800'])assert.throws(()=>store.searchThreads(query),ValidationError);
  for(const limit of [0,21,true,1.5])assert.throws(()=>store.searchThreads('orquidea',{limit}),ValidationError);
});

test('index follows snapshot updates and rolls back with a failed record',t=>{
  const {store,append}=fixture(t),first=append('first',{title:'Magnolia',summary:'Old description.'});
  append('renamed',{thread_id:first.thread_id,title:'Jacaranda',summary:'New description.'});
  assert.deepEqual(store.searchThreads('magnolia').threads,[]);
  assert.equal(store.searchThreads('jacaranda').threads[0].id,first.thread_id);
  const db=new DatabaseSync(store.databasePath);
  db.exec("CREATE TRIGGER fail_search_fixture BEFORE INSERT ON association_operations WHEN NEW.operation_key='record:fail' BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();
  const before=store.exportJson();
  assert.throws(()=>append('fail',{thread_id:first.thread_id,title:'Azalea',summary:'Uncommitted.'}));
  assert.equal(store.exportJson(),before);assert.deepEqual(store.searchThreads('azalea').threads,[]);
  assert.equal(store.searchThreads('jacaranda').threads[0].id,first.thread_id);
});

test('legacy v2 index backfill preserves the canonical export and original replay',t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'threads-search-legacy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=join(root,'data');fs.mkdirSync(data,{mode:0o700});const path=join(data,'threads.sqlite3'),db=new DatabaseSync(path);
  db.exec(fs.readFileSync(new URL('./fixtures/legacy-v2.sql',import.meta.url),'utf8'));db.close();fs.chmodSync(path,0o600);
  const expected=JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-v2.json',import.meta.url),'utf8')),store=new Store(data);
  assert.deepEqual(JSON.parse(store.exportJson()),expected.export);
  const thread=expected.export.threads[0],word=thread.title.match(/[\p{L}\p{N}]+/u)[0];
  assert.equal(store.searchThreads(word).threads[0].id,thread.id);
  assert.equal(store.append(RecordDraft.fromDict(expected.request)).sequence,1);
  assert.deepEqual(JSON.parse(new Store(data).exportJson()),expected.export);
});

test('search CLI returns five compact candidates and keeps private/full data out of discovery',t=>{
  const {append,cli}=fixture(t);
  for(let i=0;i<7;i++)append(`candidate-${i}`,{title:`Discovery ${i}`,summary:'Discovery '+ '🚌'.repeat(500),body:'Private fixture body.',references:[{kind:'session',reference:'fixture-private-session'}]});
  const result=cli(['search','discovery']);
  assert.equal(result.ok,true);assert.equal(result.result.threads.length,5);assert.equal(result.result.has_more,true);
  assert.ok(Buffer.byteLength(result.raw)<=8192);
  for(const row of result.result.threads){assert.equal(row.summary_truncated,true);assert.equal(Array.from(row.summary).length,240);assert.equal(row.references,undefined);assert.equal(row.origin,undefined);}
  assert.doesNotMatch(result.raw,/Private fixture body|fixture-private-session/);
  assert.equal(cli(['search','doesnotexist']).result.has_more,false);
  for(const args of [['search'],['search','***'],['search','ok','--limit','21'],['search','ok','--include-origin']])assert.equal(cli(args,2).ok,false);
});

test('compact list applies a byte budget and its cursor never skips an undisplayed row',t=>{
  const {append,cli}=fixture(t),ids=[];
  for(let i=0;i<13;i++)ids.push(append(`budget-${i}`,{title:'\u0001'.repeat(240),summary:'\u0001'.repeat(4000)}).thread_id);
  let cursor=null;const seen=[];
  do{
    const args=['list','--compact','--limit','20'];if(cursor!==null)args.push('--before-sequence',String(cursor));
    const response=cli(args);assert.ok(Buffer.byteLength(response.raw)<=8192);
    assert.ok(response.result.threads.length>0);
    for(const row of response.result.threads){assert.equal(row.summary_truncated,true);assert.equal(row.session_count,undefined);seen.push(row.id);}
    cursor=response.result.next_before_sequence;
  }while(cursor!==null);
  assert.deepEqual(seen,ids.reverse());assert.equal(new Set(seen).size,13);
});

test('compact show returns only a bounded summary; full history remains available unchanged',t=>{
  const {append,cli,store}=fixture(t),first=append('show',{title:'\u0001'.repeat(240),summary:'🚌'.repeat(4000),body:'Original fixture body.',evidence:[{kind:'document',reference:'/tmp/private-fixture.md'}]});
  const before=store.exportJson(),response=cli(['show',first.thread_id,'--compact']);
  assert.ok(Buffer.byteLength(response.raw)<=8192);assert.equal(response.result.thread.event_count,1);
  assert.equal(Array.from(response.result.thread.summary).length,600);assert.equal(response.result.thread.summary_truncated,true);
  assert.equal(response.result.events,undefined);assert.equal(response.result.detail_available,true);
  assert.doesNotMatch(response.raw,/Original fixture body|private-fixture.md/);
  const full=cli(['show',first.thread_id]);assert.equal(full.result.events[0].body,'Original fixture body.');
  assert.equal(full.result.thread.summary,'🚌'.repeat(4000));assert.equal(store.exportJson(),before);
  assert.equal(cli(['show',first.thread_id,'--compact','--include-origin'],2).ok,false);
  assert.equal(cli(['list','--compact','--include-references'],2).ok,false);
});

test('snapshot SQL from existing writers updates the derived index without a new API',t=>{
  const {store,append}=fixture(t),first=append('old-writer',{title:'Begonia'});
  const db=new DatabaseSync(store.databasePath);
  db.prepare('UPDATE threads SET title=?,summary=? WHERE id=?').run('Lantana','Existing writer snapshot.',first.thread_id);db.close();
  assert.equal(store.searchThreads('lantana').threads[0].id,first.thread_id);
  assert.deepEqual(store.searchThreads('begonia').threads,[]);
});

test('compact reads leave large original history stored without retrieving it by default',t=>{
  const {append,cli}=fixture(t),first=append('large',{body:'x'.repeat(16000),summary:'Small current summary.'});
  for(let i=0;i<9;i++)append(`large-${i}`,{thread_id:first.thread_id,body:'x'.repeat(16000),summary:'Small current summary.'});
  const full=cli(['show',first.thread_id]),compact=cli(['show',first.thread_id,'--compact']);
  assert.equal(full.result.events.length,10);assert.ok(Buffer.byteLength(full.raw)>160000);
  assert.ok(Buffer.byteLength(compact.raw)<1024);assert.equal(compact.result.thread.event_count,10);
});

test('invalid search is redacted and rejected before creating a storage root',t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'threads-invalid-search-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=join(root,'absent');
  const result=spawnSync(process.execPath,[bin,'--data-dir',data,'search','"***"'],{input:'',encoding:'utf8',timeout:15000});
  assert.equal(result.status,2);assert.equal(result.stderr,'');assert.equal(JSON.parse(result.stdout).error.code,'invalid_input');
  assert.equal(fs.existsSync(data),false);
});

test('compact reads keep full-width SQLite cursors exact',t=>{
  const {store,append,cli}=fixture(t),first=append('wide');
  const db=new DatabaseSync(store.databasePath);db.exec("UPDATE sqlite_sequence SET seq=9007199254740992 WHERE name='events'");db.close();
  append('wide-next',{thread_id:first.thread_id});
  const result=cli(['list','--compact','--limit','1']);
  assert.equal(result.result.next_before_sequence,9007199254740993n);
  assert.equal(cli(['list','--compact','--before-sequence','9007199254740993']).result.threads.length,0);
});
