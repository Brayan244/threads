// Synthetic native IDs and temporary storage. These are not live-host receipts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Origin, RecordDraft, ValidationError } from '../src/threads/domain.mjs';
import * as identity from '../src/threads/identity.mjs';
import { Store } from '../src/threads/store.mjs';
const bin=fileURLToPath(new URL('../bin/threads',import.meta.url));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const envelope=value=>'v1.'+Buffer.from(JSON.stringify({version:1,origin:value})).toString('base64url');
const native=(changes={})=>({agent:'opencode',session_id:'ses_fixture_current',session_ref:null,...changes});
function fixture(t){const root=fs.mkdtempSync(join(tmpdir(),'threads-native-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,data:join(root,'data')};}

test('neutral identity keeps opaque native IDs and explicit missing locators without fabrication',()=>{
  const value=native();assert.deepEqual({...new Origin(value)},value);
  assert.deepEqual({...identity.resolveOrigin({THREADS_RUNTIME_CONTEXT:envelope(value)})},value);
  const supplied=native({agent:'another-host',session_id:'conversation:original-42',session_ref:'/tmp/native-fixture.jsonl'});
  assert.deepEqual({...identity.resolveOrigin({THREADS_RUNTIME_CONTEXT:envelope(supplied)})},supplied);
  for(const agent of ['pi','codex'])assert.throws(()=>new Origin({agent,session_id:'opaque-id',session_ref:null}),ValidationError);
});

test('per-call context changes native attribution; invalid context never falls back to an ancestor',()=>{
  const env={CODEX_THREAD_ID:A,THREADS_RUNTIME_CONTEXT:envelope(native())};
  assert.equal(identity.resolveOrigin(env).session_id,'ses_fixture_current');
  env.THREADS_RUNTIME_CONTEXT=envelope(native({session_id:'ses_fixture_after_new'}));
  assert.equal(identity.resolveOrigin(env).session_id,'ses_fixture_after_new');
  env.THREADS_RUNTIME_CONTEXT='broken';assert.throws(()=>identity.resolveOrigin(env),identity.IdentityError);
  assert.throws(()=>identity.resolveOrigin({CODEX_THREAD_ID:A},{require_native_context:true}),identity.IdentityError);
  assert.throws(()=>identity.resolveOrigin({THREADS_RUNTIME_CONTEXT:envelope(native())},{pi_session_id:A,pi_session_ref:'/tmp/pi.jsonl'}),identity.IdentityError);
});

test('neutral envelopes are strict, bounded, and cannot impersonate existing Pi/Codex adapters',()=>{
  for(const value of ['', 'v1.!!!', 'v1.'+'x'.repeat(17000),
    envelope(native({origin:'forged'})),envelope(native({session_id:''})),envelope(native({session_id:'\ud800'})),
    envelope(native({session_id:'[reserved]'})),envelope(native({session_ref:'https://user:secret@example.test/'})),
    envelope({agent:'pi',session_id:A,session_ref:'/tmp/pi.jsonl'}),
    envelope({agent:'codex',session_id:A,session_ref:'/tmp/codex'}),
    'v1.'+Buffer.from('{"version":1,"version":1,"origin":{}}').toString('base64url'),
    'v1.'+Buffer.from(JSON.stringify({version:2,origin:native()})).toString('base64url'),
  ])assert.throws(()=>identity.resolveOrigin({THREADS_RUNTIME_CONTEXT:value}),identity.IdentityError);
});

test('one native session can distinguish actual subagent actors without replacing its native ID',t=>{
  const {data}=fixture(t),store=new Store(data);
  const root=new Origin(native({agent:'claude-code',session_id:A,session_ref:'/tmp/claude.jsonl'}));
  const child=new Origin({...root,actor_id:'native-agent-child'});
  const draft=origin=>RecordDraft.fromDict({kind:'progress',body:'Synthetic actor milestone.',operation_key:'same-key',origin});
  const first=store.append(draft(root)),second=store.append(draft(child));
  assert.notEqual(first.thread_id,second.thread_id);
  assert.equal(second.origin.session_id,A);assert.equal(second.origin.actor_id,'native-agent-child');
  assert.deepEqual(store.append(draft(child)),second);
  assert.equal(store.currentAssociation(root).thread_id,first.thread_id);
  assert.equal(store.currentAssociation(child).thread_id,second.thread_id);
  assert.deepEqual(store.listThreads({origin:root}).map(row=>row.id),[first.thread_id]);
  assert.deepEqual(store.listThreads({origin:child}).map(row=>row.id),[second.thread_id]);
});

test('CLI uses runtime metadata outside semantic input and preserves exact retries across native hosts',t=>{
  const {data}=fixture(t);
  function run(origin,payload){const result=spawnSync(process.execPath,[bin,'--data-dir',data,'--require-native-context','record'],{input:JSON.stringify(payload),encoding:'utf8',timeout:15000,
    env:{...process.env,CODEX_THREAD_ID:B,THREADS_RUNTIME_CONTEXT:envelope(origin)}});assert.equal(result.stderr,'');return {status:result.status,...JSON.parse(result.stdout)};}
  const payload={kind:'progress',body:'Native runtime fixture.',operation_key:'native-write'};
  let thread;
  for(const agent of ['claude-code','gemini-cli','cursor','opencode']){
    const origin=native({agent,session_id:agent==='opencode'?'ses_fixture_native':A});
    const own=thread?{...payload,thread_id:thread}:payload;
    const saved=run(origin,own);assert.equal(saved.status,0);assert.deepEqual(saved.result.event.origin,origin);
    assert.deepEqual(run(origin,own),saved);thread=saved.result.event.thread_id;
    const invalid=run(origin,{...own,origin:{agent:'forged'}});assert.equal(invalid.status,2);assert.equal(invalid.ok,false);
  }
});

test('native context encoding is canonical and round-trips only allowed origin fields',()=>{
  const value=native({actor_id:'native-actor'}),encoded=identity.encodeNativeContext(value);
  assert.equal(typeof encoded,'string');assert.deepEqual({...identity.resolveOrigin({THREADS_RUNTIME_CONTEXT:encoded})},value);
});
