// Real filesystem fault injection, temporary HOME, simulated native Herdr only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test, mock } from 'node:test';
import { fixture, root, A, B } from './fixtures/install-fixture.mjs';
import { install, remove, InstallError, configuration, resources, fingerprint, writeOwned, saveManifest, CORE_FILES, validateLayout } from '../scripts/install.mjs';
import { MIN_NODE, supportedNode } from '../src/threads/runtime.mjs';

function storageFault(path,phase,action,{replacement=null,blockCleanup=false,closeAlsoFails=false}={}){
  const original={write:fs.writeSync,flush:fs.fsyncSync,close:fs.closeSync,unlink:fs.unlinkSync,rename:fs.renameSync};
  const error=Object.assign(new Error('fixture storage full'),{code:'ENOSPC'}),fault={error,fired:false,fd:null};
  const matches=fd=>{try{const a=fs.fstatSync(fd),b=fs.lstatSync(path);return a.dev===b.dev&&a.ino===b.ino;}catch{return false;}};
  const fail=fd=>{fault.fired=true;fault.fd=fd;if(replacement)original.rename(replacement,path);throw error;};
  const patches=[
    mock.method(fs,'writeSync',(fd,buffer,offset,length,position)=>{
      if(!fault.fired&&phase==='write'&&matches(fd)){original.write(fd,buffer,offset,Math.min(length,16),position);fail(fd);}
      return original.write(fd,buffer,offset,length,position);
    }),
    mock.method(fs,'fsyncSync',fd=>{original.flush(fd);if(!fault.fired&&phase==='flush'&&matches(fd))fail(fd);}),
    mock.method(fs,'closeSync',fd=>{const selected=!fault.fired&&phase==='close'&&matches(fd);original.close(fd);if(selected)fail(fd);if(closeAlsoFails&&fd===fault.fd)throw new Error('fixture secondary close');}),
    mock.method(fs,'unlinkSync',leaf=>{if(blockCleanup&&leaf===path)throw Object.assign(new Error('fixture cleanup blocked'),{code:'EACCES'});return original.unlink(leaf);}),
  ];
  try{action(fault);}finally{patches.forEach(patch=>patch.mock.restore());}
  assert.equal(fault.fired,true);return fault;
}
function temporaryFile(t,name){const f=fixture(t);return {f,path:join(f.temporary,name)};}

for(const phase of ['write','flush','close']){
  test(`exclusive ${phase} failure cleans only its inode, closes its descriptor and retains the first error`,t=>{
    const {path}=temporaryFile(t,phase);
    const fault=storageFault(path,phase,({error})=>assert.throws(()=>writeOwned(path,Buffer.alloc(128),0o600),actual=>actual===error),{closeAlsoFails:phase==='write'});
    assert.equal(fs.existsSync(path),false);assert.throws(()=>fs.fstatSync(fault.fd));
  });
  test(`manifest ${phase} failure retains the previous journal and permits a clean retry`,t=>{
    const {path}=temporaryFile(t,phase+'.json');fs.writeFileSync(path,'original journal');
    storageFault(path+'.pending',phase,({error})=>assert.throws(()=>saveManifest(path,{status:'changed'}),actual=>actual===error));
    assert.equal(fs.readFileSync(path,'utf8'),'original journal');assert.equal(fs.existsSync(path+'.pending'),false);
    saveManifest(path,{status:'recovered'});assert.equal(JSON.parse(fs.readFileSync(path)).status,'recovered');
  });
}

test('short writes finish, zero-progress writes clean their leaf, and empty writes are valid',t=>{
  const {f,path}=temporaryFile(t,'short'),original=fs.writeSync;
  const patch=mock.method(fs,'writeSync',(fd,buffer,offset,length,position)=>original(fd,buffer,offset,Math.min(7,length),position));
  try{writeOwned(path,Buffer.alloc(128,120),0o600);}finally{patch.mock.restore();}
  assert.equal(fs.readFileSync(path).length,128);
  for(const returned of [0,undefined]){
    const leaf=join(f.temporary,'no-progress-'+returned),mockWrite=mock.method(fs,'writeSync',()=>returned);
    try{assert.throws(()=>writeOwned(leaf,Buffer.from('content'),0o600));}finally{mockWrite.mock.restore();}
    assert.equal(fs.existsSync(leaf),false);
  }
  writeOwned(join(f.temporary,'empty'),Buffer.alloc(0),0o600);assert.equal(fs.statSync(join(f.temporary,'empty')).size,0);
});

for(const kind of ['file','symlink'])test(`failed owned writes preserve a concurrently substituted ${kind}`,t=>{
  const {f,path}=temporaryFile(t,'owned'),foreign=join(f.temporary,'replacement'),target=join(f.temporary,'foreign-target');
  fs.writeFileSync(target,'foreign');if(kind==='file')fs.writeFileSync(foreign,'foreign');else fs.symlinkSync(target,foreign);
  storageFault(path,'write',({error})=>assert.throws(()=>writeOwned(path,Buffer.alloc(128),0o600),actual=>actual===error),{replacement:foreign});
  assert.equal(fs.readFileSync(path,'utf8'),'foreign');assert.equal(fs.lstatSync(path).isSymbolicLink(),kind==='symlink');assert.equal(fs.readFileSync(target,'utf8'),'foreign');
});

test('preexisting and concurrently replaced staging leaves are not reclaimed',t=>{
  const {f,path}=temporaryFile(t,'manifest.json'),pending=path+'.pending';fs.writeFileSync(path,'original');fs.writeFileSync(pending,'foreign staging');
  assert.throws(()=>saveManifest(path,{status:'changed'}));assert.equal(fs.readFileSync(pending,'utf8'),'foreign staging');fs.unlinkSync(pending);
  const replacement=join(f.temporary,'replacement');fs.writeFileSync(replacement,'replacement staging');
  const original=fs.renameSync,error=new Error('fixture rename failure'),patch=mock.method(fs,'renameSync',(source)=>{original(replacement,source);throw error;});
  try{assert.throws(()=>saveManifest(path,{status:'changed'}),actual=>actual===error);}finally{patch.mock.restore();}
  assert.equal(fs.readFileSync(path,'utf8'),'original');assert.equal(fs.readFileSync(pending,'utf8'),'replacement staging');
});

test('rename errors remain primary even when staging cleanup fails',t=>{
  const {path}=temporaryFile(t,'manifest.json');fs.writeFileSync(path,'original');
  const original=fs.unlinkSync,error=new Error('fixture rename failure'),a=mock.method(fs,'renameSync',()=>{throw error;}),b=mock.method(fs,'unlinkSync',leaf=>{if(leaf===path+'.pending')throw new Error('fixture cleanup blocked');return original(leaf);});
  try{assert.throws(()=>saveManifest(path,{status:'changed'}),actual=>actual===error);}finally{a.mock.restore();b.mock.restore();}
  assert.equal(fs.readFileSync(path,'utf8'),'original');assert.ok(error.notes.length);assert.equal(fs.existsSync(path+'.pending'),true);
});

test('install/reinstall/remove preserve source layout, settings, native click state and all history',t=>{
  const f=fixture(t),source=fs.readFileSync(f.sourcePath);
  assert.equal(f.install().status,'installed');assert.equal(fs.existsSync(f.data),false);
  const journal=fs.readFileSync(f.manifest);assert.equal(f.install().status,'unchanged');assert.deepEqual(fs.readFileSync(f.manifest),journal);assert.equal(f.calls().length,1);
  assert.deepEqual(JSON.parse(f.calls()[0][2]),{name:'main',as:'threads-main'});
  const clone=JSON.parse(fs.readFileSync(f.clone)),sections=clone.children[0].children[0].children;
  assert.deepEqual(sections.map(value=>value.id),['spaces','threads-sidebar','agents']);
  assert.deepEqual(sections[1].content.props,{cli:f.launcher,dataDir:f.data,channel:'threads-main',role:'section'});
  sections.splice(1,1);delete clone.cloned_from;assert.deepEqual(clone,f.source);assert.deepEqual(fs.readFileSync(f.sourcePath),source);
  assert.equal(JSON.parse(fs.readFileSync(join(f.herdr,'mods/threads/mod.json'))).place,'none');
  assert.deepEqual(f.cli(['list']).threads,[]);fs.writeFileSync(join(f.data,'user-evidence.md'),'preserve');
  const history=fs.readdirSync(f.data).map(name=>[name,fs.readFileSync(join(f.data,name))]);
  assert.equal(f.install('remove').status,'removed');assert.equal(fs.existsSync(f.launcher),false);assert.equal(fs.existsSync(f.clone),false);
  for(const [name,bytes]of history)assert.deepEqual(fs.readFileSync(join(f.data,name)),bytes);
  assert.equal(fs.readFileSync(join(f.herdr,'settings.json'),'utf8'),'{"unrelated":true}');assert.equal(fs.readFileSync(join(f.home,'.pi/agent/settings.json'),'utf8'),'{"hooks":"leave alone"}');
  assert.equal(fs.readFileSync(join(f.herdr,'layouts/.state/threads-main.json'),'utf8'),'fixture click state');
  assert.equal(f.install('remove').status,'absent');assert.equal(f.install().status,'installed');assert.equal(fs.readFileSync(join(f.data,'user-evidence.md'),'utf8'),'preserve');
  assert.ok(CORE_FILES.every(name=>name.endsWith('.mjs')));assert.ok(!fs.readdirSync(join(f.home,'.local/share/threads-runtime/src/threads')).some(name=>name.endsWith('.py')));
});

for(const name of ['launcher','skill','mod','clone','staging','runtime'])test(`unowned ${name} collision fails before native clone`,t=>{
  const f=fixture(t),path={launcher:f.launcher,skill:join(f.home,'.agents/skills/threads'),mod:join(f.herdr,'mods/threads'),clone:f.clone,staging:f.clone.replace('.json','.threads-pending'),runtime:join(f.home,'.local/share/threads-runtime')}[name];
  fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,'foreign');assert.equal(f.install('install',{status:1}).ok,false);
  assert.equal(fs.readFileSync(path,'utf8'),'foreign');assert.deepEqual(f.calls(),[]);assert.equal(fs.existsSync(f.manifest),false);
});

test('symlink ancestors, source symlinks and non-writable parents fail without following/repair',t=>{
  const f=fixture(t),outside=join(f.temporary,'outside'),agents=join(f.home,'.agents');fs.mkdirSync(outside);fs.symlinkSync(outside,agents);
  assert.equal(f.install('install',{status:1}).ok,false);assert.deepEqual(fs.readdirSync(outside),[]);assert.deepEqual(f.calls(),[]);fs.unlinkSync(agents);
  fs.mkdirSync(agents,{mode:0o500});assert.equal(f.install('install',{status:1}).ok,false);assert.deepEqual(f.calls(),[]);assert.equal(fs.statSync(agents).mode&0o777,0o500);fs.chmodSync(agents,0o700);
  fs.unlinkSync(f.sourcePath);fs.symlinkSync(join(root,'herdr/mods/threads/mod.json'),f.sourcePath);assert.equal(f.install('install',{status:1}).ok,false);assert.deepEqual(f.calls(),[]);
});

test('malformed layouts, occupied reader IDs and unsupported sidebar slots never switch the layout',t=>{
  const f=fixture(t),variants=[[],{type:'row',id:'root',children:[false]},
    {...f.source,children:[f.source.children[1]]},
    {...f.source,children:[{id:'sidebar',type:'column',children:[]},f.source.children[1]]},
    {...f.source,children:[...f.source.children,{id:'threads-reader',type:'block',content:{mod:'foreign'}}]},
    {...f.source,children:[{id:'x',type:'block',content:null}]},
  ];
  for(const value of variants){fs.writeFileSync(f.sourcePath,JSON.stringify(value));assert.equal(f.install('install',{status:1}).ok,false);assert.deepEqual(f.calls(),[]);assert.equal(fs.existsSync(f.manifest),false);}
  assert.throws(()=>validateLayout({...f.source,children:[{id:'sidebar',type:'column',children:null}]}));
});

test('edited resources and foreign additions survive removal and block automatic reinstall',t=>{
  const f=fixture(t);f.install();fs.writeFileSync(f.launcher,'local edit');const foreign=join(f.herdr,'mods/threads/user-note.md');fs.writeFileSync(foreign,'note');
  assert.equal(f.install('install',{status:1}).ok,false);assert.ok(f.install('remove').preserved.includes(f.launcher));
  assert.equal(fs.readFileSync(f.launcher,'utf8'),'local edit');assert.equal(fs.readFileSync(foreign,'utf8'),'note');assert.equal(fs.existsSync(f.manifest),true);
});

for(const failure of ['after','before'])test(`unconfirmed native ${failure} failure keeps its recovery journal without claiming a clone`,t=>{
  const f=fixture(t);assert.equal(f.install('install',{status:1,extraEnv:{FIXTURE_CLONE_FAIL:failure}}).ok,false);
  assert.equal(fs.existsSync(f.clone),failure==='after');assert.equal(JSON.parse(fs.readFileSync(f.manifest)).status,'recovery_required');assert.equal(fs.existsSync(f.launcher),false);
  assert.equal(f.install('remove').status,'recovery_required');assert.equal(fs.existsSync(f.clone),failure==='after');
});
for(const metadata of [[],null,'fixture-private-diagnostic'])test(`malformed native clone metadata ${JSON.stringify(metadata)} stays unconfirmed and redacted`,t=>{
  const f=fixture(t),response=f.install('install',{status:1,extraEnv:{FIXTURE_CLONED_FROM:JSON.stringify(metadata)}});
  assert.doesNotMatch(JSON.stringify(response),/fixture-private-diagnostic/);const journal=JSON.parse(fs.readFileSync(f.manifest));assert.deepEqual(journal.files,{});assert.equal(journal.unconfirmed_clone,f.clone);assert.equal(fs.existsSync(f.launcher),false);
});

for(const target of ['resource','manifest_staging','clone_staging','initial_manifest'])for(const phase of ['write','flush','close'])test(`${target} ${phase} failure rolls back verified files and permits removal/reinstall`,t=>{
  const f=fixture(t),path={resource:join(f.home,'.local/share/threads-runtime/src/threads/cli.mjs'),manifest_staging:f.manifest+'.pending',clone_staging:f.clone.replace('.json','.threads-pending'),initial_manifest:f.manifest}[target];
  storageFault(path,phase,({error})=>assert.throws(()=>install(f.home,f.herdr,f.host),actual=>actual===error||actual instanceof InstallError&&actual.cause===error));
  assert.equal(fs.existsSync(f.manifest+'.pending'),false);assert.equal(fs.existsSync(f.clone.replace('.json','.threads-pending')),false);assert.equal(fs.existsSync(f.clone),false);
  assert.ok(['removed','absent'].includes(remove(f.home,f.herdr).status));assert.equal(f.install().status,'installed');assert.equal(f.install('remove').status,'removed');
});

test('blocked partial-resource cleanup is fingerprinted in recovery and can be retried',t=>{
  const f=fixture(t),path=join(f.home,'.local/share/threads-runtime/src/threads/cli.mjs');
  const fault=storageFault(path,'write',({error})=>assert.throws(()=>install(f.home,f.herdr,f.host),actual=>actual.cause===error),{blockCleanup:true});
  const journal=JSON.parse(fs.readFileSync(f.manifest));assert.equal(journal.status,'recovery_required');assert.deepEqual(journal.files[path],fingerprint(path));assert.ok(fault.error.notes.length);
  assert.equal(remove(f.home,f.herdr).status,'removed');assert.equal(fs.existsSync(path),false);assert.equal(f.install().status,'installed');
});

test('blocked journal staging cleanup retains the last durable journal and never guesses ownership',t=>{
  const f=fixture(t),path=f.manifest+'.pending';
  storageFault(path,'write',({error})=>assert.throws(()=>install(f.home,f.herdr,f.host),actual=>actual.cause===error),{blockCleanup:true});
  assert.equal(fs.existsSync(path),true);assert.notEqual(JSON.parse(fs.readFileSync(f.manifest)).status,'rolled_back');
  assert.throws(()=>remove(f.home,f.herdr),InstallError);assert.equal(fs.existsSync(path),true);
});

test('foreign pending files and tampered manifest ownership cannot be deleted by remove',t=>{
  const f=fixture(t);f.install();const pending=f.manifest+'.pending';fs.writeFileSync(pending,'unowned staging');
  assert.throws(()=>remove(f.home,f.herdr),InstallError);assert.equal(fs.readFileSync(pending,'utf8'),'unowned staging');assert.equal(fs.existsSync(f.launcher),true);fs.unlinkSync(pending);
  const journal=JSON.parse(fs.readFileSync(f.manifest)),foreign=join(f.herdr,'settings.json');journal.files[foreign]=fingerprint(foreign);fs.writeFileSync(f.manifest,JSON.stringify(journal));
  assert.throws(()=>remove(f.home,f.herdr),InstallError);assert.equal(fs.readFileSync(foreign,'utf8'),'{"unrelated":true}');assert.equal(fs.existsSync(f.launcher),true);
});

test('Node can inspect/remove a legacy Python ownership manifest without executing Python',t=>{
  const f=fixture(t);f.install();const journal=JSON.parse(fs.readFileSync(f.manifest)),base=join(f.home,'.local/share/threads-runtime/src/threads');
  for(const name of CORE_FILES){const path=join(base,name);fs.unlinkSync(path);delete journal.files[path];}
  for(const name of ['__init__.py','cli.py','domain.py','identity.py','store.py']){const path=join(base,name);fs.writeFileSync(path,'# synthetic legacy file\n',{mode:0o600});journal.files[path]=fingerprint(path);}
  fs.writeFileSync(f.manifest,JSON.stringify(journal));assert.equal(f.install('install',{status:1}).ok,false);
  assert.equal(f.doctor({status:1}).installation.intact,false);assert.equal(fs.existsSync(f.data),false);
  assert.equal(f.install('remove').status,'removed');assert.equal(fs.existsSync(base),false);assert.equal(f.install().status,'installed');
});

test('doctor is read-only, needs Node/Herdr only, and never treats static checks as live verification',t=>{
  const f=fixture(t);f.install();const manifest=fs.readFileSync(f.manifest),calls=f.calls();const report=f.doctor();
  assert.equal(report.ok,true);assert.equal(report.installation.intact,true);assert.equal(report.coverage.live_hosts,'pending');assert.equal(report.coverage.skill_behavior,'pending');
  assert.equal(report.node.minimum,MIN_NODE);assert.equal(report.executables.node.version,process.versions.node);
  assert.equal(report.executables.pi.present,false);assert.equal(report.executables.codex.present,false);assert.equal(report.executables.pi.required,false);
  assert.equal(fs.existsSync(f.data),false);assert.deepEqual(fs.readFileSync(f.manifest),manifest);assert.deepEqual(f.calls(),calls);
  assert.equal(supportedNode('24.14.99'),false);assert.equal(supportedNode('24.15.0'),true);assert.equal(supportedNode('25.0.0'),true);
});

test('doctor rejects incomplete ownership and unsafe data permissions without creating/repairing storage',t=>{
  const f=fixture(t);f.install();const journal=JSON.parse(fs.readFileSync(f.manifest));journal.files={};fs.writeFileSync(f.manifest,JSON.stringify(journal));
  assert.equal(f.doctor({status:1}).installation.intact,false);assert.equal(fs.existsSync(f.data),false);
  fs.mkdirSync(f.data,{mode:0o755});fs.chmodSync(f.data,0o755);assert.equal(f.doctor({status:1}).storage.owner_only,false);assert.equal(fs.statSync(f.data).mode&0o777,0o755);assert.deepEqual(fs.readdirSync(f.data),[]);
});
