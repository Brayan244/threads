// Simulated native host, isolated HOME, no real agent sessions or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root=fileURLToPath(new URL('../../',import.meta.url));
export const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
export function fixture(t){
  const temporary=fs.mkdtempSync(join(tmpdir(),'threads-install-node-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const home=join(temporary,'home with spaces'),herdr=join(home,'.config/herdr-app'),bin=join(temporary,'executables');
  fs.mkdirSync(join(herdr,'layouts'),{recursive:true});fs.mkdirSync(bin);fs.symlinkSync(process.execPath,join(bin,'node'));
  const source={id:'root',type:'row',titlebar:'none',traffic_lights:[12,16],background:'canvas',children:[
    {id:'sidebar',type:'column',size:{px:268},min:44,max:480,children:[{id:'sidebar-lists',type:'column',children:[
      {id:'spaces',type:'block',size:{weight:1},min:90,content:{mod:'spaces'}},
      {id:'agents',type:'block',size:{weight:1},min:90,content:{mod:'agents'}},
    ]}]},{id:'work',type:'block',content:{tab:'active'}}]};
  const sourcePath=join(herdr,'layouts/main.json');fs.writeFileSync(sourcePath,JSON.stringify(source));
  fs.writeFileSync(join(herdr,'settings.json'),'{"unrelated":true}');fs.mkdirSync(join(home,'.pi/agent'),{recursive:true});fs.writeFileSync(join(home,'.pi/agent/settings.json'),'{"hooks":"leave alone"}');
  const host=join(bin,'herdr-app');
  fs.writeFileSync(host,`#!${process.execPath}
const fs=require('node:fs'),{join}=require('node:path'),assert=require('node:assert/strict');
const home=process.env.HERDR_APP_HOME,args=process.argv.slice(2);
if(args.length===1&&args[0]==='--version'){console.log('fixture-only 0.0');process.exit(0);}
fs.appendFileSync(join(home,'fixture-calls.jsonl'),JSON.stringify(args)+'\\n');
assert.deepEqual(args.slice(0,2),['do','layout.clone']);
const options=JSON.parse(args[2]),source=join(home,'layouts',options.name+'.json'),dest=join(home,'layouts',options.as+'.json');
if(process.env.FIXTURE_CLONE_FAIL==='before'){console.log('{"error":"unavailable"}');process.exit(1);}
const layout=JSON.parse(fs.readFileSync(source));layout.cloned_from=Object.hasOwn(process.env,'FIXTURE_CLONED_FROM')?JSON.parse(process.env.FIXTURE_CLONED_FROM):{name:options.name,version:'fixture'};
if(process.env.FIXTURE_MUTATE_CLONE)layout.background='native mutation';
if(process.env.FIXTURE_MUTATE_SOURCE)fs.writeFileSync(source,JSON.stringify({...layout,background:'native source mutation'}));
fs.writeFileSync(dest,JSON.stringify(layout),{flag:'wx'});
fs.mkdirSync(join(home,'layouts/.state'),{recursive:true});fs.writeFileSync(join(home,'layouts/.state',options.as+'.json'),'fixture click state');
fs.writeFileSync(join(home,'fixture-selection'),options.as);
if(process.env.FIXTURE_CLONE_FAIL==='after'){console.log('lost receipt');process.exit(1);}
console.log(JSON.stringify({name:options.as}));
`,{mode:0o700});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(CODEX_|THREADS_|PI_|XDG_|HERDR_)/.test(key)));
  Object.assign(env,{HOME:home,PATH:bin});
  const launcher=join(home,'.local/bin/threads'),manifest=join(home,'.local/state/threads-install/manifest.json'),data=join(home,'.local/share/threads'),clone=join(herdr,'layouts/threads-main.json');
  function run(exe,args,{input='',status=0,extraEnv={}}={}){
    const result=spawnSync(exe,args,{input,env:{...env,...extraEnv},encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
    assert.equal(result.status,status,(result.stdout??'')+(result.stderr??'')+String(result.error??''));assert.equal(result.stderr,'');return JSON.parse(result.stdout);
  }
  const install=(action='install',options={})=>run(process.execPath,[join(root,'scripts/install.mjs'),action,'--home',home,'--herdr-home',herdr,'--herdr-command',host],options);
  const doctor=(options={})=>run(process.execPath,[join(root,'scripts/doctor.mjs'),'--home',home,'--herdr-home',herdr],options);
  const cli=(args,payload,options={})=>run(launcher,args,{...options,input:payload===undefined?'':JSON.stringify(payload)}).result;
  const calls=()=>fs.existsSync(join(herdr,'fixture-calls.jsonl'))?fs.readFileSync(join(herdr,'fixture-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  return {temporary,home,herdr,bin,source,sourcePath,host,env,launcher,manifest,data,clone,run,install,doctor,cli,calls};
}
