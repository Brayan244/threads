#!/usr/bin/env node
// Explicit public allowlist. No recursive checkout copy, Git data or host files.
import fs from 'node:fs';
import { dirname, basename, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ROOT, CORE_FILES, MOD_FILES, absolute, calledAsMain, within, safePath } from './install.mjs';
const TEST_FILES=['cli','core','distribution','herdr-mod','herdr-view-model','install','installed-journey','migration','native-hooks','native-identity','opencode-adapter','pi-bridge','retrieval'].map(name=>'tests/'+name+'.test.mjs');
export const PACKAGE_FILES=[
  'README.md','LICENSE','RECIPE.md','preview.svg','package.json','.gitignore',
  'docs/usage.md','docs/compatibility.md','docs/distribution.md','docs/native-integrations.md',
  'bin/threads',...CORE_FILES.map(name=>'src/threads/'+name),...MOD_FILES.map(name=>'mods/threads/'+name),
  ...['pi/index.ts','pi/cli.mjs','pi/bridge-loader.mjs','common/invoke.mjs','hooks/native.mjs','opencode/tools.mjs'].map(name=>'integrations/'+name),
  'skills/threads/SKILL.md','skills/threads/references/reporting.md',
  ...['install','doctor','host-config','package'].map(name=>'scripts/'+name+'.mjs'),
  ...TEST_FILES,'tests/skill-scenarios.md','tests/fixtures/install-fixture.mjs','tests/fixtures/legacy-v2.json','tests/fixtures/legacy-v2.sql',
];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function publicFiles(){
  const files=[...PACKAGE_FILES];
  // Never call an illustration a native screenshot. A future approved preview
  // can be added explicitly, but presence is not privacy/live-render validation.
  if(fs.existsSync(join(ROOT,'preview.png')))files.push('preview.png');
  return files;
}
export function buildPackage(output) {
  output=absolute(output);
  const parent=fs.realpathSync(dirname(output));output=join(parent,basename(output));
  for(let path=parent;;path=dirname(path)){
    if(fs.existsSync(join(path,'.git')))throw Error('Distribution output must stay outside Git');
    if(dirname(path)===path)break;
  }
  if(within(output,ROOT))throw Error('Distribution output must stay outside the source checkout');
  const files=publicFiles(),contents=new Map();
  for(const name of files){
    const source=join(ROOT,name);safePath(source,ROOT);const info=fs.lstatSync(source);
    if(!info.isFile()||info.isSymbolicLink())throw Error('Only regular allowlisted files may be packaged');
    contents.set(name,{bytes:fs.readFileSync(source),mode:info.mode&0o111?0o700:0o600});
  }
  fs.mkdirSync(output,{mode:0o700});
  const manifest={format_version:1,name:'threads',version:JSON.parse(contents.get('package.json').bytes).version,license:'MIT',publication:'build_only',
    validation:{native_hosts:'pending_live_verification',preview:files.includes('preview.png')?'provided_unverified':'illustration_only_native_png_pending'},files:{}};
  // A partial failed build remains inspectable. Never recursively delete user
  // additions or overwrite an occupied output directory to force a retry.
  for(const [name,{bytes,mode}] of contents){
    const path=join(output,name);fs.mkdirSync(dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,bytes,{flag:'wx',mode});
    manifest.files[name]={sha256:hash(bytes),mode};
  }
  fs.writeFileSync(join(output,'package-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return {ok:true,output,file_count:contents.size,validation:manifest.validation,publication:manifest.publication};
}
export function verifyPackage(output) {
  try {
    output=absolute(output);const manifestPath=join(output,'package-manifest.json');safePath(manifestPath,output);
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    if(manifest.format_version!==1||manifest.license!=='MIT'||!manifest.files||Array.isArray(manifest.files))return {ok:false};
    const expected=new Set(PACKAGE_FILES);if(Object.hasOwn(manifest.files,'preview.png'))expected.add('preview.png');
    if(Object.keys(manifest.files).length!==expected.size)return {ok:false};
    const directories=new Set();
    for(const name of expected)for(let parent=dirname(name);parent!=='.';parent=dirname(parent))directories.add(parent);
    const actual=new Set();
    function walk(directory){
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        const path=join(directory,entry.name),name=relative(output,path);safePath(path,output);
        if(entry.isSymbolicLink())throw Error('Unknown symlink');
        if(entry.isDirectory()){
          if(!directories.has(name))throw Error('Unlisted directory');
          walk(path);
        }else if(entry.isFile()){
          if(name!=='package-manifest.json'&&!expected.has(name))throw Error('Unlisted file');
          actual.add(name);
        }else throw Error('Unknown file type');
      }
    }
    walk(output);
    if(actual.size!==expected.size+1||[...actual].some(name=>name!=='package-manifest.json'&&!expected.has(name)))return {ok:false};
    for(const [name,proof] of Object.entries(manifest.files)){
      if(!expected.has(name)||isAbsolute(name)||relative('.',name).startsWith('..'))return {ok:false};
      const path=join(output,name);safePath(path,output);const info=fs.lstatSync(path);
      if(!info.isFile()||info.isSymbolicLink()||hash(fs.readFileSync(path))!==proof.sha256||(info.mode&0o7777)!==proof.mode)return {ok:false};
    }
    return {ok:true,file_count:expected.size,validation:manifest.validation};
  }catch{return {ok:false};}
}
export function main(argv=process.argv.slice(2)) {
  try {
    const {values}=parseArgs({args:argv,options:{output:{type:'string'},verify:{type:'string'}}});
    if(Boolean(values.output)===Boolean(values.verify))throw Error();
    const result=values.verify?verifyPackage(values.verify):buildPackage(values.output);console.log(JSON.stringify(result));return result.ok?0:1;
  }catch{console.log(JSON.stringify({ok:false,error:'Choose a new --output or existing --verify absolute path outside Git; inspect any partial build. No existing directory was overwritten.'}));return 1;}
}
if(calledAsMain(import.meta.url))process.exitCode=main();
