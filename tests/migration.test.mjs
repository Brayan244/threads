// Legacy-format and runtime-edge fixtures. No real history or host identities.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/threads/store.mjs';
import { Origin, RecordDraft, StorageError, ValidationError } from '../src/threads/domain.mjs';
import { resolveOrigin } from '../src/threads/identity.mjs';
import { parseJSON } from '../src/threads/json.mjs';
const bin=fileURLToPath(new URL('../bin/threads',import.meta.url)),A='11111111-1111-4111-8111-111111111111';
const origin=new Origin({agent:'pi',session_id:A,session_ref:'/tmp/threads-fixture/pi.jsonl'});
const draft=(operation_key,changes={})=>RecordDraft.fromDict({kind:'progress',body:'Fixture work.',origin,operation_key,...changes});
function temporary(t){const path=fs.mkdtempSync(join(tmpdir(),'threads-node-migration-'));t.after(()=>fs.rmSync(path,{recursive:true,force:true}));return path;}

test('v1 upgrade preserves all events/snapshots and never fabricates a current binding',t=>{
  const root=temporary(t),data=join(root,'data');fs.mkdirSync(data,{mode:0o700});const path=join(data,'threads.sqlite3'),db=new DatabaseSync(path);
  db.exec(fs.readFileSync(new URL('./fixtures/legacy-v2.sql',import.meta.url),'utf8'));
  db.exec('DROP TABLE current_associations; DROP TABLE association_operations; PRAGMA user_version=1');db.close();fs.chmodSync(path,0o600);
  const expected=JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-v2.json',import.meta.url))),store=new Store(data),exported=JSON.parse(store.exportJson());
  assert.deepEqual(exported.events,expected.export.events);assert.deepEqual(exported.threads,expected.export.threads);assert.deepEqual(exported.associations,[]);
  assert.equal(store.currentAssociation(origin),null);assert.equal(store.append(RecordDraft.fromDict(expected.request)).sequence,1);assert.equal(store.currentAssociation(origin),null);
  assert.equal(store.sessionCount(expected.export.threads[0].id),2);
  store.associate(origin,expected.export.threads[0].id,'explicit');assert.equal(store.currentAssociation(origin).thread_id,expected.export.threads[0].id);
});

test('first-open races initialize exactly one empty schema without missing tables',async t=>{
  const root=temporary(t),args=[bin,'--data-dir',join(root,'data'),'list'];
  const results=await Promise.all(Array.from({length:10},()=>{
    const pending=promisify(execFile)(process.execPath,args,{encoding:'utf8',timeout:15000});pending.child.stdin.end();return pending;
  }));
  for(const result of results){assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout).result.threads,[]);}
});

test('Codex directory URI spelling matches legacy pathlib attribution, including trailing slash and parent segments',()=>{
  for(const [home,uri]of [
    ['/tmp/codex/','file:///tmp/codex'],['/tmp/./codex','file:///tmp/codex'],['/tmp/path/..//codex/','file:///tmp/path/../codex'],
    ['//tmp/codex/','file:////tmp/codex'],['/tmp/!a(1)*?# café/','file:///tmp/%21a%281%29%2A%3F%23%20caf%C3%A9'],
  ])assert.equal(resolveOrigin({CODEX_THREAD_ID:A,CODEX_HOME:home}).session_ref,uri+'#thread='+A);
});

test('store resolves symlink ancestors before parent traversal and rejects a symlink leaf even with trailing dot/slash',t=>{
  const root=temporary(t),a=join(root,'a'),b=join(root,'b');fs.mkdirSync(a);fs.mkdirSync(join(b,'child'),{recursive:true});fs.symlinkSync(join(b,'child'),join(a,'link'));
  const store=new Store(a+'/link/../data');assert.equal(store.dataDir,fs.realpathSync.native(join(b,'data')));assert.equal(fs.existsSync(join(a,'data')),false);
  fs.symlinkSync(store.dataDir,join(root,'leaf'));
  for(const suffix of ['','/','/.','/./'])assert.throws(()=>new Store(join(root,'leaf')+suffix),StorageError);
});

test('invalid nested Unicode/typed fields and binary/BOM input fail before storage exists',t=>{
  const root=temporary(t),data=join(root,'data'),env={...process.env};delete env.CODEX_THREAD_ID;
  const prefix=[bin,'--data-dir',data,'--pi-session-id',A,'--pi-session-ref','/tmp/fixture.jsonl','record'];
  const changes=[...['body','title','summary','operation_key'].map(key=>({[key]:'\ud800'})),
    {references:[{kind:'issue',reference:'\ud800'}]},
    {evidence:[{kind:'document',reference:'/tmp/\ud800'}]},
    ...['object_id','version','digest'].map(key=>({evidence:[{kind:'document',reference:'/tmp/fixture',target:{object_id:'plan',[key]:'\ud800'}}]})),
    {kind:'review_finding',review:{target:{object_id:'plan'},instruction:'\ud800',disposition:'approved'}},
    {evidence:[{kind:'document',reference:'/tmp/fixture',availability:null}]},{evidence:null},{references:{}},
  ];
  const payload={kind:'progress',body:'Fixture work.',operation_key:'invalid'};
  for(const input of [...changes.map(change=>JSON.stringify({...payload,...change})),Buffer.from([0xc0,0x28]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(payload))])]){
    const result=spawnSync(process.execPath,prefix,{input,env,encoding:'utf8',timeout:15000});assert.equal(result.status,2,result.stdout+result.stderr);assert.equal(result.stderr,'');assert.equal(fs.existsSync(data),false);
  }
});

test('runtime storage respects XDG without writes to HOME and rejects relative roots',t=>{
  const root=temporary(t),home=join(root,'never-home'),xdg=join(root,'xdg'),env={...process.env,HOME:home,XDG_DATA_HOME:xdg};
  const result=JSON.parse(execFileSync(process.execPath,[bin,'list'],{env,input:'',encoding:'utf8',timeout:15000}));assert.deepEqual(result.result.threads,[]);
  assert.equal(fs.existsSync(join(xdg,'threads/threads.sqlite3')),true);assert.equal(fs.existsSync(home),false);
  const bad=spawnSync(process.execPath,[bin,'list'],{env:{...env,XDG_DATA_HOME:'relative'},input:'',encoding:'utf8',timeout:15000});assert.equal(bad.status,6);assert.equal(bad.stderr,'');assert.equal(fs.existsSync(home),false);
});

test('full-width SQLite sequences and CLI cursors remain exact beyond Number.MAX_SAFE_INTEGER',t=>{
  const root=temporary(t),data=join(root,'data'),store=new Store(data),first=store.append(draft('first'));
  const db=new DatabaseSync(store.databasePath);db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='events'").run(9007199254740992n);db.close();
  const second=store.append(draft('large',{thread_id:first.thread_id}));assert.equal(second.sequence,9007199254740993n);
  const raw=execFileSync(process.execPath,[bin,'--data-dir',data,'events',first.thread_id,'--after-sequence','9007199254740992'],{input:'',encoding:'utf8',timeout:15000});
  assert.equal(parseJSON(raw).result.events[0].sequence,9007199254740993n);assert.match(raw,/"sequence":9007199254740993/);
  assert.deepEqual(store.events(first.thread_id,{after_sequence:9223372036854775807n}),[]);assert.throws(()=>store.events(first.thread_id,{after_sequence:9223372036854775808n}),ValidationError);
});
