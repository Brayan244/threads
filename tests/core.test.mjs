// Domain/store fixtures only. These identities do not establish live provenance.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, chmodSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Origin, RecordDraft, ObjectVersion, Evidence, Review, Validation, assess,
  ValidationError, ConflictError, NotFoundError, StorageError, StoreBusyError } from '../src/threads/domain.mjs';
import { resolveOrigin, IdentityError } from '../src/threads/identity.mjs';
import { Store } from '../src/threads/store.mjs';
import { parseJSON, stringify } from '../src/threads/json.mjs';

const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const origin=new Origin({agent:'pi',session_id:A,session_ref:'/tmp/threads-fixture/pi.jsonl'});
const draft=(key,changes={})=>RecordDraft.fromDict({kind:'progress',body:'Un avance con evidencia.',origin,
  operation_key:key,...changes});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'threads-node-core-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,store:new Store(join(root,'data'))};}

test('strict JSON rejects duplicate keys, nonfinite numbers, malformed UTF-8 and excessive nesting',()=>{
  assert.throws(()=>parseJSON('{"kind":1,"kind":2}'));
  assert.throws(()=>parseJSON('{"x":{"x":1,"x":2}}'));
  for(const text of ['NaN','Infinity','{"x":1e999}','{bad}', '['.repeat(200)+']'.repeat(200)])assert.throws(()=>parseJSON(text));
  assert.deepEqual(JSON.parse(stringify(parseJSON('{"text":"🚌 café","n":1}'))),{text:'🚌 café',n:1});
});

test('domain validates every typed boundary and preserves canonical Unicode semantics',()=>{
  for(const kind of ['observation','hypothesis','decision','progress','review_finding','validation'])assert.equal(draft(kind,{kind}).kind,kind);
  for(const changes of [{kind:'read'},{body:''},{body:'\u0000'},{body:'\ud800'},{retained:1},{unexpected:true},
    {origin:{agent:'pi',session_id:'bad',session_ref:'/tmp/file'}},{references:[{kind:'issue',reference:'A'},{kind:'issue',reference:'A'}]}])assert.throws(()=>draft('invalid',changes),ValidationError);
  assert.equal(draft('unicode',{body:'🚌'.repeat(16000)}).body.length,32000,'bounds count Unicode code points like the existing store');
  assert.throws(()=>draft('too-long',{body:'🚌'.repeat(16001)}),ValidationError);
  assert.throws(()=>draft('bad-review',{review:{target:{object_id:'x'},instruction:'Review it',disposition:'approved'}}),ValidationError);
  assert.throws(()=>draft('bad-evidence',{evidence:[{kind:'link',reference:'https://user:secret@example.test/x'}]}),ValidationError);
  assert.throws(()=>draft('bad-url',{evidence:[{kind:'link',reference:'https://[broken'}]}),ValidationError);
  assert.throws(()=>draft('origin-unknown',{origin:{...origin,extra:true}}),ValidationError);
});

test('assurance is conservative about exact objects, pinned versions and availability',()=>{
  const v1=new ObjectVersion({object_id:'plan',version:'v1'}),v2=new ObjectVersion({object_id:'plan',version:'v2'});
  const evidence=new Evidence({kind:'document',reference:'/tmp/plan.md',target:v1,availability:'available'});
  const review=new Review({target:v1,instruction:'Approve this version only.',disposition:'approved'});
  assert.equal(assess([evidence],v1,{review}),'reviewed');
  assert.equal(assess(JSON.parse(JSON.stringify([evidence])),JSON.parse(JSON.stringify(v1)),{review:JSON.parse(JSON.stringify(review))}),'reviewed','persisted JSON values retain exact-version assurance');
  assert.equal(assess([evidence],v2,{review}),'stale');
  assert.equal(assess([evidence],new ObjectVersion({object_id:'plan'}),{review}),'unverifiable');
  assert.equal(assess([evidence],v1),'none');
  assert.equal(assess([],v1,{review}),'unverifiable');
  assert.equal(assess([new Evidence({...evidence,availability:'unavailable'})],v1,{review}),'unavailable');
  const validation=new Validation({target:v1,outcome:'failed'});
  assert.equal(assess([evidence],v1,{validation}),'none');
});

test('identity is resolved freshly and ambiguous/missing origins fail closed',()=>{
  assert.equal(resolveOrigin({}, {pi_session_id:A,pi_session_ref:'/tmp/pi.jsonl'}).agent,'pi');
  const env={CODEX_THREAD_ID:A,CODEX_HOME:'/tmp/fixture codex'};
  assert.match(resolveOrigin(env).session_ref,/fixture%20codex#thread=/);
  env.CODEX_THREAD_ID=B;assert.equal(resolveOrigin(env).session_id,B);
  for(const environment of [{},{CODEX_THREAD_ID:''},{CODEX_THREAD_ID:'bad'},{CODEX_THREAD_ID:A,CODEX_HOME:'relative'}])assert.throws(()=>resolveOrigin(environment),IdentityError);
  assert.throws(()=>resolveOrigin({CODEX_THREAD_ID:''},{pi_session_id:A,pi_session_ref:'/tmp/pi.jsonl'}),IdentityError);
  assert.throws(()=>resolveOrigin({},{pi_session_id:A,pi_session_ref:'relative'}),IdentityError);
});

test('create, retry, conflict and retention/reference snapshots are atomic and durable',t=>{
  const {root,store}=fixture(t);
  assert.deepEqual(store.listThreads(),[]);
  const first=store.append(draft('first',{title:'Trabajo',references:[{kind:'issue',reference:'DEMO-1'}],retained:true}));
  assert.deepEqual(store.append(draft('first',{title:'Trabajo',references:[{kind:'issue',reference:'DEMO-1'}],retained:true})),first);
  assert.throws(()=>store.append(draft('first',{body:'Different'})),ConflictError);
  const second=store.append(draft('second',{thread_id:first.thread_id,references:[]}));
  const snapshot=store.getThread(first.thread_id);
  assert.equal(snapshot.retained,true);assert.deepEqual(snapshot.references,[]);assert.equal(snapshot.event_count,2);
  assert.equal(second.sequence,first.sequence+1);
  assert.deepEqual(new Store(join(root,'data')).events(first.thread_id)[0],first);
  assert.equal(store.listThreads({reference:{kind:'issue',reference:'DEMO-1'}}).length,1,'historical reference lookup survives active-link replacement');
  assert.equal(statSync(join(root,'data')).mode&0o777,0o700);
  assert.equal(statSync(store.databasePath).mode&0o777,0o600);
});

test('explicit association replay does not rewind current work and sessions count distinct origins',t=>{
  const {store}=fixture(t), a=store.append(draft('a')), b=store.append(draft('b'));
  const old=store.associate(origin,a.thread_id,'switch-a');
  store.associate(origin,b.thread_id,'switch-b');
  assert.deepEqual(store.associate(origin,a.thread_id,'switch-a'),old);
  assert.equal(store.currentAssociation(origin).thread_id,b.thread_id);
  assert.throws(()=>store.associate(origin,b.thread_id,'switch-a'),ConflictError);
  assert.equal(store.sessionCount(a.thread_id),1);
  const other=new Origin({agent:'codex',session_id:B,session_ref:'/tmp/codex-fixture'});
  store.associate(other,a.thread_id,'other');
  assert.equal(store.sessionCount(a.thread_id),2);
  assert.equal(store.currentAssociation(origin).thread_id,b.thread_id);
  assert.throws(()=>store.getThread('missing'),NotFoundError);
  assert.throws(()=>store.append(draft('missing',{thread_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})),NotFoundError);
});

test('late SQLite failures roll back events, projections, references and binding',t=>{
  const {store}=fixture(t), first=store.append(draft('initial'));
  const db=new DatabaseSync(store.databasePath);
  db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON association_operations WHEN NEW.operation_key='record:fail' BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();
  const before=store.exportJson();
  assert.throws(()=>store.append(draft('fail',{thread_id:first.thread_id,title:'Wrong',retained:true,references:[{kind:'issue',reference:'WRONG'}]})));
  assert.equal(store.exportJson(),before);
  const audit=new DatabaseSync(store.databasePath);
  assert.throws(()=>audit.exec('UPDATE events SET operation_key=\'mutated\''));
  assert.throws(()=>audit.exec('DELETE FROM association_operations'));
  audit.close();
});

test('bounded paging, lock waits, unsafe paths and future schemas fail without hidden repair',t=>{
  const {root,store}=fixture(t), first=store.append(draft('one'));
  for(let i=0;i<5;i++)store.append(draft(`more-${i}`,{thread_id:first.thread_id}));
  assert.equal(store.recentEvents(first.thread_id,{limit:2}).length,2);
  assert.equal(store.events(first.thread_id,{limit:2}).length,2);
  for(const limit of [0,-1,201,true,1.2])assert.throws(()=>store.events(first.thread_id,{limit}),ValidationError);
  const db=new DatabaseSync(store.databasePath);db.exec('BEGIN IMMEDIATE');
  const start=Date.now();assert.throws(()=>new Store(join(root,'data'),{busy_timeout_ms:20}),StoreBusyError);assert.ok(Date.now()-start<1500);
  db.exec('ROLLBACK');db.close();
  const unsafe=join(root,'unsafe');mkdirSync(unsafe,{mode:0o755});assert.throws(()=>new Store(unsafe),StorageError);assert.equal(statSync(unsafe).mode&0o777,0o755);
  symlinkSync(join(root,'data'),join(root,'link'));assert.throws(()=>new Store(join(root,'link')),StorageError);
  const checkout=join(root,'checkout');mkdirSync(join(checkout,'.git'),{recursive:true});assert.throws(()=>new Store(join(checkout,'data')),StorageError);
  const future=new DatabaseSync(store.databasePath);future.exec('PRAGMA user_version=999');future.close();
  assert.throws(()=>new Store(join(root,'data')),StorageError);
  const check=new DatabaseSync(store.databasePath);assert.equal(check.prepare('PRAGMA user_version').get().user_version,999);check.close();
});

test('Node opens the Python-created schema v2 and replays its original operation without rewriting history',t=>{
  const root=mkdtempSync(join(tmpdir(),'threads-node-legacy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const data=join(root,'data');mkdirSync(data,{mode:0o700});
  const path=join(data,'threads.sqlite3'),db=new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/legacy-v2.sql',import.meta.url),'utf8'));db.close();chmodSync(path,0o600);
  const store=new Store(data),expected=JSON.parse(readFileSync(new URL('./fixtures/legacy-v2.json',import.meta.url),'utf8'));
  assert.deepEqual(JSON.parse(store.exportJson()),expected.export);
  const replay=store.append(RecordDraft.fromDict(expected.request));
  assert.equal(replay.sequence,1);
  assert.deepEqual(JSON.parse(store.exportJson()),expected.export);
  const next=store.append(draft('node-continuation',{thread_id:replay.thread_id}));
  assert.equal(next.sequence,3);
  assert.equal(store.getThread(replay.thread_id).event_count,3);
});
