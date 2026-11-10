"""Installed-launcher/SQLite/Herdr-model journey, with synthetic host identities."""
import json
from pathlib import Path
import shutil
import subprocess
from test_install import InstallationFixture, ROOT

PI = "11111111-1111-4111-8111-111111111111"
CODEX = "22222222-2222-4222-8222-222222222222"


class InstalledJourneyTests(InstallationFixture):
    def test_installed_pi_discovery_entry_loads_and_uses_pinned_storage(self):
        self.install()
        pi = shutil.which("pi")
        self.assertIsNotNone(pi, "Installed Pi loader is required; no agent is launched")
        package = Path(pi).resolve().parent
        while package.parent != package:
            metadata = package / "package.json"
            if metadata.is_file() and json.loads(metadata.read_text()).get("name") == "@earendil-works/pi-coding-agent":
                break
            package = package.parent
        self.assertNotEqual(package.parent, package, "Installed Pi package not found")
        script = '''
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [loader,extension,cwd,id] = process.argv.slice(1);
const {loadExtensions} = await import(pathToFileURL(loader));
const loaded = await loadExtensions([extension],cwd);
assert.deepEqual(loaded.errors,[]);
const tools = loaded.extensions[0].tools;
assert.equal(tools.size,5);
const ctx = {cwd,sessionManager:{getSessionId:()=>id,getSessionFile:()=>cwd+'/synthetic-session.jsonl'}};
const list = await tools.get('threads_list').definition.execute('fixture',{},undefined,undefined,ctx);
assert.equal(list.details.threads.length,0);
const result = await tools.get('threads_record').definition.execute('fixture',{
  kind:'hypothesis',body:'Installed bridge fixture, not live provenance.',operation_key:'installed-pi'
},undefined,undefined,ctx);
assert.equal(result.details.event.origin.session_id,id);
console.log('installed Pi loader + bridge fixture passed');
'''
        poisoned_xdg = self.home / "must-not-use-ambient-xdg"
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script,
                                 str(package / "dist/core/extensions/loader.js"),
                                 str(self.home / ".pi/agent/extensions/threads.ts"), str(self.home), PI],
                                capture_output=True, text=True,
                                env={**self.env, "XDG_DATA_HOME": str(poisoned_xdg)}, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(poisoned_xdg.exists())
        self.assertEqual(len(self.cli(["list"])["threads"]), 1)

    def test_empty_start_cross_host_references_refresh_and_removal_preserve_data(self):
        self.install()
        self.assertEqual(self.cli(["list"])["threads"], [])
        first = self.cli(["--pi-session-id", PI, "--pi-session-ref", str(self.home / "pi-session.jsonl"), "record"],
                         {"kind": "hypothesis", "body": "Fixture failure might be a stale binding.",
                          "operation_key": "pi-first", "title": "Investigate binding", "summary": "Reproduced; inspect binding.",
                          "references": [{"kind": "issue", "reference": "EXAMPLE-1"}, {"kind": "issue", "reference": "EXAMPLE-2"}],
                          "evidence": [{"kind": "document", "reference": str(self.home / "plan.md"),
                                        "target": {"object_id": "plan", "version": "v1"}}]})["event"]
        id_ = first["thread_id"]
        codex_env = {"CODEX_THREAD_ID": CODEX, "CODEX_HOME": str(self.home / ".codex")}
        self.cli(["associate"], {"thread_id": id_, "operation_key": "codex-choose"}, env=codex_env)
        self.cli(["record"], {"thread_id": id_, "kind": "review_finding", "body": "Fixture binding finding; v1 approved by example human.",
                             "operation_key": "codex-next", "retained": True,
                             "references": [{"kind": "issue", "reference": "EXAMPLE-3"}, {"kind": "pr", "reference": "PR-4"}],
                             "review": {"target": {"object_id": "plan", "version": "v1"},
                                        "instruction": "Example human approves only v1", "disposition": "approved"}}, env=codex_env)
        events = self.cli(["events", id_, "--include-origin", "--include-references"])["events"]
        self.assertEqual([e["origin"]["agent"] for e in events], ["pi", "codex"])
        self.assertEqual([e["origin"]["session_id"] for e in events], [PI, CODEX])
        self.assertEqual(events[0]["references"][0]["reference"], "EXAMPLE-1")
        for i in range(4):
            self.cli(["record"], {"kind": "progress", "body": "Separate fixture work", "operation_key": f"other-{i}"}, env=codex_env)
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node required for real Herdr-model/installed CLI integration")
        script = '''
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [modulePath, cli, data, id] = process.argv.slice(1);
const {createClient, ThreadsModel, reviewLabel} = await import(pathToFileURL(modulePath));
const client = createClient(async (exe,args) => ({code:0,stderr:'',stdout:execFileSync(exe,args,{encoding:'utf8'})}), {cli, dataDir:data});
const model = new ThreadsModel(client);
await model.refresh(); assert.equal(model.threads.length,5);
const other = model.threads.find(t=>t.id !== id).id;
await model.toggleHistory(id); await model.toggleHistory(other); await model.selectDetail(id);
const original = model.page('detail',id);
assert.match(reviewLabel(original.events[0]), /v1/);
assert.doesNotMatch(reviewLabel(original.events[0]), /v2/);
assert.equal(model.seen.size,0);
execFileSync(cli,['record'],{input:JSON.stringify({thread_id:id,kind:'progress',body:'Fixture plan changed to v2',operation_key:'v2'})});
await model.refresh();
assert.equal(model.selected,id); assert.equal(model.expanded.size,2);
assert.equal(model.page('detail',id),original); assert.equal(model.hasUpdates('detail',id),true);
assert.equal(model.seen.size,0);
await model.latest('detail',id);
assert.equal(model.page('detail',id).events[0].review,null);
assert.equal(reviewLabel(model.page('detail',id).events[0]),'');
assert.equal(model.referenceGroups(id).find(g=>g.kind==='issue').count,1);
console.log('installed CLI + five-thread model journey passed (fixture identities only)');
'''
        result = subprocess.run([node, "--input-type=module", "-e", script,
                                 str(self.herdr / "mods/threads/view-model.js"), str(self.launcher), str(self.data), id_],
                                capture_output=True, text=True, env={**self.env, **codex_env}, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        history = self.cli(["events", id_, "--include-origin", "--include-references"])
        listing = self.cli(["list", "--include-references"])
        self.install("remove")
        self.assertTrue(self.data.joinpath("threads.sqlite3").is_file())
        self.install()
        self.assertEqual(self.cli(["events", id_, "--include-origin", "--include-references"]), history)
        self.assertEqual(self.cli(["list", "--include-references"]), listing)
