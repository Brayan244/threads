// Installed-runtime journeys. Fixture identities are not live-host provenance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fixture, A, B } from './fixtures/install-fixture.mjs';

test('installed Pi discovery entry loads all five tools and writes pinned storage with no Python on PATH',t=>{
  const f=fixture(t);f.install();
  const executable=(process.env.PATH??'').split(delimiter).map(path=>join(path,'pi')).find(path=>fs.existsSync(path));assert.ok(executable,'Installed Pi loader required; no dependency download or model call');
  let piRoot=dirname(fs.realpathSync(executable));
  while(!fs.existsSync(join(piRoot,'package.json'))||JSON.parse(fs.readFileSync(join(piRoot,'package.json'))).name!=='@earendil-works/pi-coding-agent'){
    assert.notEqual(piRoot,dirname(piRoot));piRoot=dirname(piRoot);
  }
  const script=`
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [loader,extension,cwd,id]=process.argv.slice(1);
const {loadExtensions}=await import(pathToFileURL(loader));
const loaded=await loadExtensions([extension],cwd);assert.deepEqual(loaded.errors,[]);
const tools=loaded.extensions[0].tools;assert.equal(tools.size,5);
const ctx={cwd,sessionManager:{getSessionId:()=>id,getSessionFile:()=>cwd+'/fixture-session.jsonl'}};
const listing=await tools.get('threads_list').definition.execute('fixture',{},undefined,undefined,ctx);assert.deepEqual(listing.details.threads,[]);
const result=await tools.get('threads_record').definition.execute('fixture',{kind:'hypothesis',body:'Installed fixture, not live provenance.',operation_key:'installed-pi'},undefined,undefined,ctx);
assert.equal(result.details.event.origin.session_id,id);console.log(JSON.stringify({ok:true}));`;
  const poison=join(f.home,'must-not-use-ambient-xdg');
  assert.equal(f.run(process.execPath,['--input-type=module','-e',script,join(piRoot,'dist/core/extensions/loader.js'),join(f.home,'.pi/agent/extensions/threads.ts'),f.home,A],{extraEnv:{XDG_DATA_HOME:poison}}).ok,true);
  assert.equal(fs.existsSync(poison),false);assert.equal(f.cli(['list']).threads.length,1);
});

test('installed Node CLI, cross-host records and Herdr model survive refresh/removal/reinstall without Python',t=>{
  const f=fixture(t);f.install();assert.deepEqual(f.cli(['list']).threads,[]);
  const first=f.cli(['--pi-session-id',A,'--pi-session-ref',join(f.home,'fixture-session.jsonl'),'record'],{
    kind:'hypothesis',body:'Fixture binding might be stale.',operation_key:'pi-first',title:'Fixture investigation',summary:'Inspect the binding.',
    references:[{kind:'issue',reference:'DEMO-1'}],evidence:[{kind:'document',reference:join(f.home,'plan.md'),target:{object_id:'plan',version:'v1'}}],
  }).event;
  const codex={CODEX_THREAD_ID:B,CODEX_HOME:join(f.home,'.codex')};
  f.cli(['associate'],{thread_id:first.thread_id,operation_key:'choose'},{extraEnv:codex});
  f.cli(['record'],{thread_id:first.thread_id,kind:'review_finding',body:'Fixture review of v1 only.',operation_key:'codex-next',retained:true,
    references:[{kind:'issue',reference:'DEMO-2'},{kind:'pr',reference:'PR-3'}],review:{target:{object_id:'plan',version:'v1'},instruction:'Example human approves only v1',disposition:'approved'},
  },{extraEnv:codex});
  assert.deepEqual(f.cli(['events',first.thread_id,'--include-origin']).events.map(event=>event.origin.agent),['pi','codex']);
  for(let i=0;i<4;i++)f.cli(['record'],{kind:'progress',body:'Separate fixture work.',operation_key:`other-${i}`},{extraEnv:codex});
  const script=`
import assert from 'node:assert/strict';import {execFileSync}from'node:child_process';import{pathToFileURL}from'node:url';
const [modulePath,cli,data,id]=process.argv.slice(1);const{createClient,ThreadsModel,reviewLabel}=await import(pathToFileURL(modulePath));
const client=createClient(async(exe,args)=>({code:0,stderr:'',stdout:execFileSync(exe,args,{encoding:'utf8'})}),{cli,dataDir:data});
const model=new ThreadsModel(client);await model.refresh();assert.equal(model.threads.length,5);
const other=model.threads.find(thread=>thread.id!==id).id;await model.toggleHistory(id);await model.toggleHistory(other);await model.selectDetail(id);
const original=model.page('detail',id);assert.match(reviewLabel(original.events[0]),/v1/);assert.doesNotMatch(reviewLabel(original.events[0]),/v2/);assert.equal(model.seen.size,0);
execFileSync(cli,['record'],{input:JSON.stringify({thread_id:id,kind:'progress',body:'Fixture plan now v2.',operation_key:'v2'})});
await model.refresh();assert.equal(model.selected,id);assert.equal(model.expanded.size,2);assert.equal(model.page('detail',id),original);assert.equal(model.hasUpdates('detail',id),true);assert.equal(model.seen.size,0);
await model.latest('detail',id);assert.equal(model.page('detail',id).events[0].review,null);assert.equal(reviewLabel(model.page('detail',id).events[0]),'');
assert.equal(model.referenceGroups(id).find(group=>group.kind==='issue').count,1);console.log(JSON.stringify({ok:true}));`;
  assert.equal(f.run(process.execPath,['--input-type=module','-e',script,join(f.herdr,'mods/threads/view-model.js'),f.launcher,f.data,first.thread_id],{extraEnv:codex}).ok,true);
  const before=f.cli(['events',first.thread_id,'--include-origin','--include-references']);
  f.install('remove');assert.equal(fs.existsSync(join(f.data,'threads.sqlite3')),true);f.install();assert.deepEqual(f.cli(['events',first.thread_id,'--include-origin','--include-references']),before);
});
