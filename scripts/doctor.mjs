#!/usr/bin/env node
// Static diagnostics. Never import Store, open SQLite or execute Threads launchers.
import fs from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { configuration, resources, readManifest, safePath, unchanged, calledAsMain } from './install.mjs';
import { MIN_NODE, supportedNode } from '../src/threads/runtime.mjs';
import { stringify } from '../src/threads/json.mjs';
function permissionStatus(path) {
  if(!fs.existsSync(path)){
    let parent=dirname(path);while(!fs.existsSync(parent))parent=dirname(parent);
    let writable=true;try{fs.accessSync(parent,fs.constants.W_OK|fs.constants.X_OK);}catch{writable=false;}
    return {exists:false,parent_writable:writable,host_sandbox_access:'unverified'};
  }
  const info=fs.statSync(path);let writable=true;try{fs.accessSync(path,fs.constants.W_OK|fs.constants.X_OK);}catch{writable=false;}
  return {exists:true,owner_only:info.isDirectory()&&(info.mode&0o7777)===0o700&&info.uid===process.getuid?.(),writable,host_sandbox_access:'unverified'};
}
export function executableStatus(name,config) {
  let executable=null;
  for(const directory of (process.env.PATH??'').split(delimiter)){
    const candidate=join(directory,name);try{fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile()){executable=candidate;break;}}catch{/* Continue PATH lookup. */}
  }
  const value={present:executable!==null,required:['node','herdr-app'].includes(name),version:'unavailable',live_smoke:'pending'};
  if(executable){
    const result=spawnSync(executable,['--version'],{env:{...process.env,HOME:config.home,HERDR_APP_HOME:config.herdr},encoding:'utf8',timeout:5000,maxBuffer:4096});
    const match=result.stdout?.slice(0,1024).match(/(?<![\d.])(\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.]+)?)\b/);
    if(result.status===0&&match)value.version=match[1];
  }
  return value;
}
export function diagnose(home,herdrHome,layout='main') {
  const config=configuration(home,herdrHome,layout);let installation={present:false,intact:false};
  safePath(config.manifest,config.home);
  if(fs.existsSync(config.manifest)){
    const values=resources(config),manifest=readManifest(config,values),expected=new Set([...values.keys(),config.clone]);
    const changed=Object.entries(manifest.files).filter(([path,record])=>!unchanged(path,record));
    installation={present:true,status:manifest.status,intact:manifest.status==='installed'&&!changed.length&&Object.keys(manifest.files).length===expected.size&&Object.keys(manifest.files).every(path=>expected.has(path)),
      changed_resource_count:changed.length,missing_resource_count:[...expected].filter(path=>!Object.hasOwn(manifest.files,path)).length};
  }
  safePath(config.data,config.home);
  const executables=Object.fromEntries(['node','pi','codex','herdr-app'].map(name=>[name,executableStatus(name,config)]));
  const storage=permissionStatus(config.data);
  const ok=supportedNode()&&Boolean(process.versions.sqlite)&&supportedNode(executables.node.version)&&Object.values(executables).every(value=>!value.required||value.present)&&
    (storage.exists?storage.owner_only&&storage.writable:storage.parent_writable)&&(!installation.present||installation.intact);
  return {ok,coverage:{checks:'static_read_only',fixtures:'not_run_by_doctor',skill_behavior:'pending',live_hosts:'pending'},
    node:{version:process.versions.node,minimum:MIN_NODE,sqlite:process.versions.sqlite??'unavailable'},executables,installation,storage,
    limits:['Executable presence is not compatibility evidence.','Pi and Codex are optional host integrations, not installation prerequisites.',
      'No skill evaluation, agent invocation, native clone or UI check was performed.','Filesystem access does not establish Codex sandbox permission; use normal host approval.',
      'No database was opened, initialized or migrated.'],next_gate:'Follow docs/compatibility.md with operator authorization and isolated data.'};
}
export function main(argv=process.argv.slice(2)) {
  let report;
  try{
    const {values}=parseArgs({args:argv,options:{home:{type:'string',default:homedir()},'herdr-home':{type:'string'},layout:{type:'string',default:'main'},help:{type:'boolean'}}});
    report=values.help?{ok:true,help:'node scripts/doctor.mjs --home ABS --herdr-home ABS [--layout main]'}:
      diagnose(values.home,values['herdr-home']??join(values.home,'.config/herdr-app'),values.layout);
  }catch{report={ok:false,coverage:{checks:'static_read_only',live_hosts:'pending',skill_behavior:'pending'},error:'Invalid, changed or inaccessible installation roots/manifest; no repair attempted.'};}
  process.stdout.write(stringify(report)+'\n');return report.ok?0:1;
}
if(calledAsMain(import.meta.url))process.exitCode=main();
