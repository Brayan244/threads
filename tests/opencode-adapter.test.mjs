// OpenCode tool-builder fixtures; CLI/storage are real, host execution is not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const schema=()=>({min(){return this;},max(){return this;},int(){return this;},optional(){return this;},describe(){return this;}});
const tool=definition=>definition;
tool.schema={string:schema,number:schema,boolean:schema,enum:schema};

test('OpenCode reads sessionID for every execution and keeps semantic origin out of tool arguments',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'threads-opencode-')),before=process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME=join(root,'xdg');
  t.after(()=>{if(before===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=before;fs.rmSync(root,{recursive:true,force:true});});
  const {createOpenCodeTools}=await import('../integrations/opencode/tools.mjs');
  const tools=createOpenCodeTools(tool);
  assert.deepEqual(Object.keys(tools).sort(),['associate','current','list','record','search','show']);
  const context={sessionID:'ses_fixture_first',directory:root,agent:'build'};
  const payload={kind:'progress',body:'OpenCode native context fixture.',operation_key:'same',title:'OpenCode fixture',summary:'Native session recorded.'};
  const saved=JSON.parse(await tools.record.execute({payload:JSON.stringify(payload)},context));
  assert.ok(saved.event.thread_id);assert.equal(saved.event.origin,undefined,'default model output omits private origin');
  const first=saved.event.thread_id;
  context.sessionID='ses_fixture_after_new';
  assert.equal(JSON.parse(await tools.current.execute({},context)).association,null);
  await tools.record.execute({payload:JSON.stringify({...payload,thread_id:first})},context);
  const {Store}=await import('../src/threads/store.mjs');
  const store=new Store(join(root,'xdg/threads'));
  assert.deepEqual(store.events(first).map(event=>event.origin.session_id),['ses_fixture_first','ses_fixture_after_new']);
  assert.deepEqual(store.events(first).map(event=>event.origin.agent),['opencode','opencode']);
  assert.equal(store.events(first)[0].origin.session_ref,null,'no invented transcript path');
  const summary=JSON.parse(await tools.show.execute({thread_id:first},context));assert.equal(summary.events,undefined);
  assert.equal(JSON.parse(await tools.search.execute({query:'opencode fixture'},context)).threads[0].id,first);
  await assert.rejects(tools.record.execute({payload:JSON.stringify({...payload,origin:{agent:'forged'}})},context),/invalid_input/);
  await assert.rejects(tools.record.execute({payload:JSON.stringify(payload)},{...context,sessionID:undefined}),/identity_required/);
  await assert.rejects(tools.list.execute({origin:'forged'},context),/invalid_input/);
});
