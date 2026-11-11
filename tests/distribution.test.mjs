// Distribution fixtures never edit actual host settings or invoke models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for(const host of ['claude-code','gemini-cli','cursor','opencode'])test(`${host} emits opt-in configuration without replacing settings or permissions`,async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'threads-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=join(root,"home with a 'quote'");fs.mkdirSync(home);
  const {hostConfiguration}=await import('../scripts/host-config.mjs');
  const config=hostConfiguration(host,home);
  assert.equal(config.host,host);assert.equal(config.applied,false);
  assert.ok(config.skill.target.startsWith(home+'/'));
  assert.doesNotMatch(JSON.stringify(config),/bypassPermissions|skip-permissions|updatedPermissions|"permissionDecision"/);
  assert.deepEqual(fs.readdirSync(home),[]);
  if(host==='opencode'){
    assert.match(config.entry.content,/@opencode-ai\/plugin/);assert.match(config.entry.content,/createOpenCodeTools/);
    assert.match(config.entry.content,/threads-runtime/);assert.equal(config.entry.path,join(home,'.config/opencode/tools/threads.ts'));
  }else{
    assert.ok(config.settings.path.startsWith(home+'/'));
    const serialized=JSON.stringify(config.settings.merge);assert.match(serialized,/--host/);assert.match(serialized,/--cli/);
    assert.match(config.command_policy,/require-native-context/);
  }
});

test('package builds only the public allowlist, hashes its content and refuses collisions',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'threads-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {buildPackage,verifyPackage}=await import('../scripts/package.mjs');
  const output=join(root,'threads'),built=buildPackage(output);
  assert.equal(built.ok,true);assert.equal(verifyPackage(output).ok,true);
  const manifest=JSON.parse(fs.readFileSync(join(output,'package-manifest.json')));
  assert.equal(manifest.license,'MIT');assert.equal(manifest.publication,'build_only');
  assert.equal(manifest.version,JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).version);
  assert.ok(fs.existsSync(join(output,'RECIPE.md')));assert.ok(fs.existsSync(join(output,'mods/threads/main.js')));
  assert.ok(fs.existsSync(join(output,'integrations/hooks/native.mjs')));
  assert.equal(fs.existsSync(join(output,'docs/research')),false);assert.equal(fs.existsSync(join(output,'.git')),false);
  assert.equal(fs.existsSync(join(output,'threads.sqlite3')),false);
  assert.throws(()=>buildPackage(output));
  fs.mkdirSync(join(output,'unlisted-private-directory'));
  assert.equal(verifyPackage(output).ok,false,'even unlisted empty directories must not enter a release');
  fs.rmdirSync(join(output,'unlisted-private-directory'));
  fs.appendFileSync(join(output,'LICENSE'),'\nchanged');assert.equal(verifyPackage(output).ok,false);
});
