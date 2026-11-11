// Hook protocol fixtures only, not real Claude/Gemini/Cursor executions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveOrigin } from '../src/threads/identity.mjs';
const bin=fileURLToPath(new URL('../bin/threads',import.meta.url));
const hook=fileURLToPath(new URL('../integrations/hooks/native.mjs',import.meta.url));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const cases=[
  ['claude-code',{hook_event_name:'PreToolUse',tool_name:'Bash',session_id:A,transcript_path:'/tmp/claude-fixture.jsonl',agent_id:'native-child'},result=>result.hookSpecificOutput.updatedInput],
  ['gemini-cli',{hook_event_name:'BeforeTool',tool_name:'run_shell_command',session_id:A,transcript_path:'/tmp/gemini-fixture.json'},result=>result.hookSpecificOutput.tool_input],
  ['cursor',{hook_event_name:'preToolUse',tool_name:'Shell',conversation_id:A},result=>result.updated_input],
];
for(const [host,base,updated] of cases){
  test(`${host} rewrites only direct Threads calls with fresh command-scoped metadata`,async()=>{
    const {transformHook}=await import('../integrations/hooks/native.mjs');
    const command='threads --require-native-context record <<\'JSON\'\n{"kind":"progress","body":"Synthetic fixture.","operation_key":"same"}\nJSON';
    const input={...base,tool_input:{command,description:'Keep this argument.'}};
    const response=transformHook(host,input,bin),args=updated(response);
    assert.equal(args.description,'Keep this argument.');assert.ok(args.command.endsWith(command));
    assert.match(args.command,/^THREADS_RUNTIME_CONTEXT='v1\.[A-Za-z0-9_-]+' /);
    const encoded=args.command.match(/^THREADS_RUNTIME_CONTEXT='([^']+)'/)[1];
    const origin=resolveOrigin({THREADS_RUNTIME_CONTEXT:encoded});
    assert.equal(origin.agent,host);assert.equal(origin.session_id,A);
    assert.equal(origin.session_ref,base.transcript_path??null);
    assert.equal(origin.actor_id,host==='claude-code'?'native-child':undefined);
    assert.doesNotMatch(JSON.stringify(response),/permissionDecision|updatedPermissions|"permission"|"decision"|"continue"/);
    const next={...input,session_id:B,conversation_id:B};
    const newCommand=updated(transformHook(host,next,bin)).command;
    assert.equal(resolveOrigin({THREADS_RUNTIME_CONTEXT:newCommand.match(/^THREADS_RUNTIME_CONTEXT='([^']+)'/)[1]}).session_id,B);
    assert.equal(input.tool_input.command,command,'input is not mutated');
    assert.deepEqual(transformHook(host,{...base,tool_input:{command:'git status'}},bin),{});
    assert.deepEqual(transformHook(host,{...base,tool_input:{command:'threads-unrelated record'}},bin),{});
    assert.deepEqual(transformHook(host,{...base,tool_input:{command:'printf x | threads --require-native-context record'}},bin),{});
    assert.throws(()=>transformHook(host,{...input,session_id:undefined,conversation_id:undefined},bin));
  });
}

test('hook metadata reaches real CLI/SQLite only for its command, not later shell commands',async t=>{
  const {transformHook}=await import('../integrations/hooks/native.mjs');
  const root=fs.mkdtempSync(join(tmpdir(),'threads-hook-shell-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cli=join(root,'threads');fs.writeFileSync(cli,`#!/bin/sh\nexec '${process.execPath}' '${bin}' --data-dir '${join(root,'data')}' "$@"\n`,{mode:0o700});
  const payload=JSON.stringify({kind:'progress',body:'Actual subprocess fixture.',operation_key:'hook-write'});
  const command=`'${cli}' --require-native-context record <<'JSON'\n${payload}\nJSON\nprintf '\\nAFTER=%s\\n' "\${THREADS_RUNTIME_CONTEXT-unset}"`;
  const result=transformHook('claude-code',{...cases[0][1],tool_input:{command}},cli);
  const run=spawnSync('/bin/sh',['-c',result.hookSpecificOutput.updatedInput.command],{env:{...process.env,CODEX_THREAD_ID:B},encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(run.stderr,'');
  const event=JSON.parse(run.stdout.split('\n')[0]).result.event;
  assert.equal(event.origin.agent,'claude-code');assert.equal(event.origin.session_id,A);
  assert.match(run.stdout,/AFTER=unset/);
});

test('hook executable is bounded JSON only; malformed metadata blocks rather than approving',()=>{
  const result=spawnSync(process.execPath,[hook,'--host','claude-code','--cli',bin],{input:'{bad-private-input',encoding:'utf8',timeout:15000});
  assert.equal(result.status,2);assert.deepEqual(JSON.parse(result.stdout),{});
  assert.doesNotMatch(result.stderr,/bad-private-input|session_id/);
});
