#!/usr/bin/env node
// Explicit roots; native layout cloning is a journaled, non-atomic operation.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parseJSON, stringify } from '../src/threads/json.mjs';
import { MIN_NODE, supportedNode } from '../src/threads/runtime.mjs';
export const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
export const MOD_FILES=['main.js','detail.js','view-model.js','mod.json','package.json'];
export const CORE_FILES=['cli.mjs','domain.mjs','identity.mjs','store.mjs','json.mjs','runtime.mjs'];
const LEGACY_CORE=['__init__.py','cli.py','domain.py','identity.py','store.py'];
export class InstallError extends Error {}
const exists=path=>{try{fs.lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
export const within=(path,root)=>{const part=relative(root,path);return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');};
export function absolute(value) {
  if(typeof value!=='string'||!isAbsolute(value)||value.split('/').includes('..')||/[\x00-\x1f]/.test(value)||!value.isWellFormed())throw new InstallError('Paths must be explicit absolute paths without traversal or control characters.');
  const path=resolve(value);
  if(exists(path)&&fs.lstatSync(path).isSymbolicLink())throw new InstallError('A selected root must not be a symlink.');
  return path;
}
export function safePath(path,root) {
  if(!within(path,root))throw new InstallError('Resource escaped its selected root.');
  for(let item=path;;item=dirname(item)){
    if(exists(item)){const info=fs.lstatSync(item);if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new InstallError('Symlinks and special files are not supported inside installation roots.');}
    if(item===root)break;
  }
}
export function writableParent(path,root) {
  safePath(path,root);let parent=dirname(path);while(!exists(parent))parent=dirname(parent);
  const info=fs.statSync(parent);
  if(!info.isDirectory()||(info.mode&0o300)!==0o300)throw new InstallError('Installation parent is not writable/searchable; no permissions were changed.');
  fs.accessSync(parent,fs.constants.W_OK|fs.constants.X_OK);
}
export function fingerprint(path) {
  const info=fs.lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink())throw new InstallError('Expected a regular owned file.');
  return {sha256:createHash('sha256').update(fs.readFileSync(path)).digest('hex'),mode:info.mode&0o7777};
}
export const encode=value=>Buffer.from(stringify(value,{pretty:true})+'\n');
export function sameCreatedFile(path,created) {
  try{const current=fs.lstatSync(path);return current.dev===created.dev&&current.ino===created.ino;}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
function note(error,message){(error.notes??=[]).push(message);}
export function cleanupCreatedFile(path,created,error) {
  try{if(sameCreatedFile(path,created))fs.unlinkSync(path);}
  catch {note(error,'Could not clean up exclusive write.');error.incomplete_write={path,created};}
}
export function writeOwned(path,content,mode) {
  const fd=fs.openSync(path,'wx',mode);let created,failure;
  try {
    created=fs.fstatSync(fd);const bytes=Buffer.isBuffer(content)?content:Buffer.from(content);let offset=0;
    while(offset<bytes.length){const count=fs.writeSync(fd,bytes,offset,bytes.length-offset,null);if(!Number.isInteger(count)||count<=0||count>bytes.length-offset)throw new InstallError('Exclusive file write made no progress.');offset+=count;}
    fs.fsyncSync(fd);
  } catch(error){failure=error;if(created)cleanupCreatedFile(path,created,error);throw error;}
  finally {
    try{fs.closeSync(fd);}catch(error){
      // Never retry close: the OS may already have released the descriptor.
      if(failure)note(failure,'Closing the raw descriptor also failed.');
      else{if(created)cleanupCreatedFile(path,created,error);throw error;}
    }
  }
  return created;
}
const manifestPending=path=>path.replace(/\.json$/,'.json.pending');
const clonePending=path=>path.replace(/\.json$/,'.threads-pending');
export function saveManifest(path,manifest) {
  const temporary=manifestPending(path);let created;
  try{created=writeOwned(temporary,encode(manifest),0o600);if(!sameCreatedFile(temporary,created))throw new InstallError('Manifest staging file changed; replacement was preserved.');fs.renameSync(temporary,path);}
  catch(error){if(created)cleanupCreatedFile(temporary,created,error);throw error;}
}
export function configuration(home,herdr,layout='main') {
  home=absolute(home);herdr=absolute(herdr);
  if(typeof layout!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(layout))throw new InstallError('Invalid layout name.');
  if(!fs.statSync(home).isDirectory()||!fs.statSync(herdr).isDirectory())throw new InstallError('Explicit HOME and initialized Herdr home must already exist.');
  return {home,herdr,layout,data:join(home,'.local/share/threads'),runtime:join(home,'.local/share/threads-runtime'),
    launcher:join(home,'.local/bin/threads'),manifest:join(home,'.local/state/threads-install/manifest.json'),clone:join(herdr,`layouts/threads-${layout}.json`)};
}
export function resources(config) {
  const values=new Map(),copy=(source,target)=>{safePath(source,ROOT);values.set(target,[fs.readFileSync(source),0o600]);};
  for(const name of CORE_FILES)copy(join(ROOT,'src/threads',name),join(config.runtime,'src/threads',name));
  for(const name of ['index.ts','cli.mjs','bridge-loader.mjs'])copy(join(ROOT,'integrations/pi',name),join(config.runtime,'integrations/pi',name));
  for(const name of ['SKILL.md','references/reporting.md'])copy(join(ROOT,'skills/threads',name),join(config.home,'.agents/skills/threads',name));
  for(const name of MOD_FILES)copy(join(ROOT,'herdr/mods/threads',name),join(config.herdr,'mods/threads',name));
  if(parseJSON(values.get(join(config.herdr,'mods/threads/mod.json'))[0].toString()).place!=='none')throw new InstallError('Threads mod must not auto-dock into an unrelated layout.');
  const entry=Buffer.from(`#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(join(config.runtime,'src/threads/cli.mjs')).href)}).then(({main})=>main(['--data-dir',${JSON.stringify(config.data)},...process.argv.slice(2)])).then(status=>{process.exitCode=status;},()=>{process.stdout.write('{"contract_version":1,"ok":false,"error":{"code":"storage_error","message":"Cannot load local Threads runtime.","retryable":false}}\\n');process.exitCode=6;});\n`);
  values.set(join(config.runtime,'bin/threads'),[entry,0o700]);values.set(config.launcher,[entry,0o700]);
  values.set(join(config.home,'.pi/agent/extensions/threads.ts'),[Buffer.from(`export { default } from ${JSON.stringify(pathToFileURL(join(config.runtime,'integrations/pi/index.ts')).href)};\n`),0o600]);
  return values;
}
export const rootFor=(path,config)=>within(path,config.herdr)?config.herdr:config.home;
export function sidebarSections(layout) {
  const sidebar=layout.children.find(node=>node.id==='sidebar');
  function find(node){
    const children=node.children??[],ids=children.map(child=>child.id);
    if(node.type==='column'&&ids.includes('spaces')&&ids.indexOf('agents')===ids.indexOf('spaces')+1&&['spaces','agents'].every(id=>children[ids.indexOf(id)]?.type==='block'))return children;
    for(const child of children){const found=find(child);if(found)return found;}
    return null;
  }
  const result=sidebar?.type==='column'?find(sidebar):null;
  if(!result)throw new InstallError('An existing left sidebar with adjacent Spaces then Agents sections is required; no layout was switched.');
  return result;
}
export function validateLayout(value) {
  if(!value||value.type!=='row'||!Array.isArray(value.children)||!value.children.length)throw new InstallError('Only a nonempty row-root layout is supported; source was not rewritten.');
  const ids=new Set();
  function visit(node){
    if(!node||typeof node!=='object'||Array.isArray(node)||typeof node.id!=='string'||ids.has(node.id)||['threads-sidebar','threads-reader'].includes(node.id))throw new InstallError('Layout IDs must be unique and must not collide with Threads.');
    ids.add(node.id);
    if(!['block','row','column','stack'].includes(node.type))throw new InstallError('Unsupported layout node.');
    const content=Object.hasOwn(node,'content')?node.content:{},children=Object.hasOwn(node,'children')?node.children:[];
    if(!content||typeof content!=='object'||Array.isArray(content)||!Array.isArray(children))throw new InstallError('Invalid layout content/children.');
    if(content.mod==='threads')throw new InstallError('Source layout already refers to Threads.');
    children.forEach(visit);
  }
  visit(value);sidebarSections(value);
}
export function sidebarLayout(clone,config) {
  const sections=sidebarSections(clone),position=sections.findIndex(node=>node.id==='spaces')+1;
  sections.splice(position,0,{id:'threads-sidebar',type:'block',size:{weight:1},min:90,content:{mod:'threads',props:{cli:config.launcher,dataDir:config.data,channel:'threads-'+config.layout,role:'section'}}});
}
function ownedPaths(config,values){return new Set([...values.keys(),config.clone,...LEGACY_CORE.map(name=>join(config.runtime,'src/threads',name))]);}
export function readManifest(config,values=resources(config)) {
  safePath(config.manifest,config.home);const value=parseJSON(fs.readFileSync(config.manifest,'utf8'));
  if(!value||value.version!==1||value.home!==config.home||value.herdr_home!==config.herdr||value.layout!==config.layout)throw new InstallError('Manifest does not match the explicit roots/layout.');
  const allowed=ownedPaths(config,values),dirs=new Set();
  for(const file of [...allowed,config.manifest])for(let parent=dirname(file);;parent=dirname(parent)){
    if(within(parent,config.home)&&parent!==config.home||within(parent,config.herdr)&&parent!==config.herdr)dirs.add(parent);
    if(dirname(parent)===parent)break;
  }
  if(!value.files||typeof value.files!=='object'||Array.isArray(value.files)||!Array.isArray(value.directories)||Object.keys(value.files).some(path=>!allowed.has(path))||value.directories.some(path=>!dirs.has(path)))throw new InstallError('Invalid ownership records.');
  if(value.incomplete_write!==undefined&&(![...allowed,config.manifest,manifestPending(config.manifest),clonePending(config.clone)].includes(value.incomplete_write)))throw new InstallError('Invalid incomplete write recovery path.');
  for(const [path,record]of Object.entries(value.files)){
    if(!record||Object.keys(record).sort().join(',')!=='mode,sha256'||! /^[0-9a-f]{64}$/.test(record.sha256)||!Number.isInteger(record.mode)||record.mode<0||record.mode>0o7777)throw new InstallError('Invalid file fingerprint.');
    safePath(path,rootFor(path,config));
  }
  return value;
}
export function unchanged(path,record) {
  if(!exists(path)||!fs.lstatSync(path).isFile())return false;
  return stringify(fingerprint(path))===stringify(record);
}
function makeParents(path,config,manifest) {
  safePath(path,rootFor(path,config));const missing=[];let parent=dirname(path);
  while(!exists(parent)){missing.push(parent);parent=dirname(parent);}
  for(const directory of missing.reverse()){fs.mkdirSync(directory,{mode:0o700});manifest.directories.push(directory);}
}
export function removeOwned(config,manifest) {
  const preserved=[];
  for(const [path,record]of Object.entries(manifest.files)){
    safePath(path,rootFor(path,config));
    if(!exists(path))delete manifest.files[path];
    else if(unchanged(path,record)){fs.unlinkSync(path);delete manifest.files[path];}
    else preserved.push(path);
  }
  for(const path of [...manifest.directories].sort((a,b)=>b.length-a.length)){
    safePath(path,rootFor(path,config));if(within(config.manifest,path))continue;
    try{fs.rmdirSync(path);}catch{/* Never recurse: foreign additions survive. */}
  }
  return preserved;
}
export function install(home,herdrHome,herdrCommand,layout='main') {
  if(!supportedNode())throw new InstallError(`Node ${MIN_NODE} or newer is required.`);
  const config=configuration(home,herdrHome,layout),values=resources(config),journal=config.manifest;
  if(exists(journal)){
    const manifest=readManifest(config,values),expected=new Set([...values.keys(),config.clone]);
    if(manifest.status==='installed'&&Object.keys(manifest.files).length===expected.size&&Object.keys(manifest.files).every(path=>expected.has(path)&&unchanged(path,manifest.files[path]))&&
      [...values].every(([path,[data,mode]])=>stringify(fingerprint(path))===stringify({sha256:createHash('sha256').update(data).digest('hex'),mode})))return {ok:true,status:'unchanged',live_compatibility:'pending'};
    throw new InstallError('Existing install is edited, different, or incomplete; inspect its journal before removal/retry.');
  }
  safePath(journal,config.home);const source=join(config.herdr,`layouts/${layout}.json`);safePath(source,config.herdr);
  const original=fs.readFileSync(source);validateLayout(parseJSON(original.toString()));
  const command=absolute(herdrCommand);if(!fs.statSync(command).isFile())throw new InstallError('An explicit executable Herdr command is required.');fs.accessSync(command,fs.constants.X_OK);
  for(const path of [config.runtime,join(config.home,'.agents/skills/threads'),join(config.herdr,'mods/threads'),config.clone,clonePending(config.clone),...values.keys(),manifestPending(journal)]){
    writableParent(path,rootFor(path,config));if(exists(path))throw new InstallError('An unowned resource name is already taken; nothing was overwritten.');
  }
  writableParent(journal,config.home);safePath(config.data,config.home);writableParent(join(config.data,'permission-check'),config.home);
  for(let path=config.data;;path=dirname(path)){if(exists(join(path,'.git')))throw new InstallError('History must remain outside Git checkouts.');if(dirname(path)===path)break;}
  if(exists(config.data)&&(!fs.statSync(config.data).isDirectory()||(fs.statSync(config.data).mode&0o7777)!==0o700))throw new InstallError('Existing history directory must already have owner-only permissions.');
  const manifest={version:1,home:config.home,herdr_home:config.herdr,layout,status:'cloning',files:{},directories:[],data_dir:config.data,
    native_side_effects:['layout.clone switches to threads-'+layout,'Native copied click state is not owned or removed; switch away before removal.'],unconfirmed_clone:config.clone};
  makeParents(journal,config,manifest);writeOwned(journal,encode(manifest),0o600);let confirmed=false;
  try{
    const result=spawnSync(command,['do','layout.clone',JSON.stringify({name:layout,as:'threads-'+layout})],{env:{...process.env,HOME:config.home,HERDR_APP_HOME:config.herdr},encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    if(result.error||result.status!==0)throw new InstallError('Native clone did not confirm success.');
    const receipt=parseJSON(result.stdout);if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||Object.hasOwn(receipt,'error'))throw new InstallError('Native clone did not confirm success.');
    safePath(config.clone,config.herdr);const clone=parseJSON(fs.readFileSync(config.clone,'utf8'));validateLayout(clone);
    if(!clone.cloned_from||clone.cloned_from.name!==layout||!fs.readFileSync(source).equals(original))throw new InstallError('Native clone/source contract mismatch.');
    for(const [key,value]of Object.entries(parseJSON(original.toString())))if(key!=='cloned_from'&&stringify(clone[key])!==stringify(value))throw new InstallError('Native clone changed the source tree; inspect manually.');
    manifest.files[config.clone]=fingerprint(config.clone);delete manifest.unconfirmed_clone;confirmed=true;saveManifest(journal,manifest);
    for(const [path,[content,mode]]of values){makeParents(path,config,manifest);writeOwned(path,content,mode);manifest.files[path]=fingerprint(path);saveManifest(journal,manifest);}
    sidebarLayout(clone,config);if(!unchanged(config.clone,manifest.files[config.clone]))throw new InstallError('Clone changed during installation; preserved for inspection.');
    const temporary=clonePending(config.clone);writeOwned(temporary,encode(clone),0o600);fs.renameSync(temporary,config.clone);
    manifest.files[config.clone]=fingerprint(config.clone);manifest.status='installed';saveManifest(journal,manifest);
  }catch(error){
    if(error.incomplete_write){const {path,created}=error.incomplete_write;manifest.incomplete_write=path;
      try{if(values.has(path)&&sameCreatedFile(path,created)){const record=fingerprint(path);if(sameCreatedFile(path,created)){manifest.files[path]=record;delete manifest.incomplete_write;}}}catch{note(error,'Could not fingerprint incomplete write.');}}
    let rollbackFailed=false;
    if(confirmed)try{removeOwned(config,manifest);}catch{rollbackFailed=true;note(error,'Rollback needs recovery.');}
    manifest.status=confirmed&&!Object.keys(manifest.files).length&&!manifest.incomplete_write&&!rollbackFailed?'rolled_back':'recovery_required';
    try{saveManifest(journal,manifest);}catch{note(error,'Could not save recovery state; previous journal retained.');}
    throw new InstallError('Installation failed; inspect manifest recovery state. Native selection/click-state effects may remain.',{cause:error});
  }
  return {ok:true,status:'installed',manifest:journal,data_dir:config.data,live_compatibility:'pending',native_side_effects:manifest.native_side_effects};
}
export function remove(home,herdrHome,layout='main') {
  const config=configuration(home,herdrHome,layout);if(!exists(config.manifest))return {ok:true,status:'absent',preserved:[]};
  const manifest=readManifest(config);
  for(const path of [manifestPending(config.manifest),clonePending(config.clone)]){safePath(path,rootFor(path,config));if(exists(path))throw new InstallError('Unowned staging file needs inspection before removal/retry.');}
  const preserved=removeOwned(config,manifest);
  if(manifest.incomplete_write){safePath(manifest.incomplete_write,rootFor(manifest.incomplete_write,config));if(exists(manifest.incomplete_write))preserved.push(manifest.incomplete_write);else delete manifest.incomplete_write;}
  if(preserved.length||manifest.unconfirmed_clone){manifest.status='recovery_required';saveManifest(config.manifest,manifest);}
  else{fs.unlinkSync(config.manifest);for(const path of [...manifest.directories].sort((a,b)=>b.length-a.length)){safePath(path,rootFor(path,config));try{fs.rmdirSync(path);}catch{/* Only proven empty directories. */}}}
  return {ok:true,status:preserved.length?'preserved_edits':manifest.unconfirmed_clone?'recovery_required':'removed',preserved,data_preserved:true,note:'No layout switch or .state cleanup performed. Native click state and all history remain.'};
}
export function calledAsMain(url){return Boolean(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(url));}
export function main(argv=process.argv.slice(2)) {
  let result;
  try{
    const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{home:{type:'string'},'herdr-home':{type:'string'},'herdr-command':{type:'string'},layout:{type:'string',default:'main'},help:{type:'boolean'}}});
    if(values.help)result={ok:true,help:'node scripts/install.mjs install|remove --home ABS --herdr-home ABS [--herdr-command ABS --layout main]'};
    else{if(positionals.length!==1||!['install','remove'].includes(positionals[0]))throw new InstallError('Choose install or remove.');result=positionals[0]==='install'?install(values.home,values['herdr-home'],values['herdr-command'],values.layout):remove(values.home,values['herdr-home'],values.layout);}
  }catch(error){result={ok:false,error:error instanceof InstallError?error.message:'Invalid configuration or inaccessible resources; inspect explicit roots.'};}
  process.stdout.write(stringify(result)+'\n');return result.ok?0:1;
}
if(calledAsMain(import.meta.url))process.exitCode=main();
