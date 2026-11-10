"""Temporary HOME + simulated native Herdr commands; never live-host proof."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MOD_FILES = {"main.js", "detail.js", "view-model.js", "mod.json", "package.json"}


class InstallationFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home with spaces"
        self.home.mkdir()
        self.herdr = self.home / ".config/herdr-app"
        (self.herdr / "layouts").mkdir(parents=True)
        self.source = {"id": "root", "type": "row", "titlebar": "none", "traffic_lights": [12, 16],
                       "background": "canvas", "children": [
                           {"id": "sidebar", "type": "column", "size": {"px": 268}, "min": 44, "max": 480,
                            "children": [{"id": "sidebar-lists", "type": "column", "children": [
                                {"id": "spaces", "type": "block", "size": {"weight": 1}, "min": 90,
                                 "content": {"mod": "spaces"}},
                                {"id": "agents", "type": "block", "size": {"weight": 1}, "min": 90,
                                 "content": {"mod": "agents"}}]}]},
                           {"id": "work", "type": "block", "content": {"tab": "active"}}]}
        (self.herdr / "layouts/main.json").write_text(json.dumps(self.source))
        (self.herdr / "settings.json").write_text('{"unrelated":true}')
        (self.home / ".pi/agent").mkdir(parents=True)
        (self.home / ".pi/agent/settings.json").write_text('{"hooks":"leave alone"}')
        self.host = Path(self.temp.name) / "herdr-fixture"
        self.host.write_text(f'''#!{sys.executable}
import json, os, pathlib, sys
home = pathlib.Path(os.environ["HERDR_APP_HOME"])
with (home / "fixture-calls.jsonl").open("a") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:] == ["--version"]:
    print("fixture-only 0.0"); raise SystemExit()
assert sys.argv[1:3] == ["do", "layout.clone"]
args = json.loads(sys.argv[3])
src = home / "layouts" / (args["name"] + ".json")
dest = home / "layouts" / (args["as"] + ".json")
if dest.exists():
    print(json.dumps({{"error":"name taken"}})); raise SystemExit(1)
if os.environ.get("FIXTURE_CLONE_FAIL") == "before":
    print(json.dumps({{"error":"unavailable"}})); raise SystemExit(1)
layout = json.loads(src.read_text())
layout["cloned_from"] = {{"name":args["name"], "version":"fixture"}}
if "FIXTURE_CLONED_FROM" in os.environ:
    layout["cloned_from"] = json.loads(os.environ["FIXTURE_CLONED_FROM"])
with dest.open("x") as out: json.dump(layout, out)
# Native command side effects are simulated, not fabricated by the installer.
state = home / "layouts/.state"
state.mkdir(exist_ok=True)
(state / (args["as"] + ".json")).write_text("fixture click state")
(home / "fixture-selection").write_text(args["as"])
if os.environ.get("FIXTURE_CLONE_FAIL") == "after":
    print("lost native receipt"); raise SystemExit(1)
print(json.dumps({{"name":args["as"]}}))
''')
        self.host.chmod(0o700)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("CODEX_", "THREADS_", "PI_", "XDG_", "HERDR_"))}
        self.env.update(HOME=str(self.home), PATH=os.environ["PATH"])
        self.manifest = self.home / ".local/state/threads-install/manifest.json"
        self.launcher = self.home / ".local/bin/threads"
        self.data = self.home / ".local/share/threads"
        self.clone = self.herdr / "layouts/threads-main.json"

    def install(self, action="install", *, expected=0, env=None):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/install.py"), action,
                                 "--home", str(self.home), "--herdr-home", str(self.herdr),
                                 "--herdr-command", str(self.host), "--layout", "main"],
                                env={**self.env, **(env or {})}, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def calls(self):
        log = self.herdr / "fixture-calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def cli(self, args, payload=None, env=None):
        result = subprocess.run([str(self.launcher), *args], input=json.dumps(payload) if payload else "",
                                capture_output=True, text=True, env={**self.env, **(env or {})}, timeout=15)
        self.assertEqual(result.stderr, "")
        self.assertEqual(result.returncode, 0, result.stdout)
        return json.loads(result.stdout)["result"]


def installer_module():
    spec = importlib.util.spec_from_file_location("threads_installer", ROOT / "scripts/install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StorageFault:
    """One real-file storage error; only the selected throwaway fixture leaf."""
    def __init__(self, path, phase, *, replacement=None, close_error=False):
        self.path, self.phase = path, phase
        self.replacement, self.close_error = replacement, close_error
        self.error = OSError(errno.ENOSPC, "fixture storage full")
        self.stream = None
        self.fd = None
        self.fired = False
        self.real_fdopen = os.fdopen

    def fdopen(self, fd, *args, **kwargs):
        stream = self.real_fdopen(fd, *args, **kwargs)
        current = os.fstat(fd)
        if self.fired or not self.path.exists() or self.path.stat().st_ino != current.st_ino:
            return stream
        self.stream, self.fd = stream, fd
        fault = self

        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self.close()

            def fail(self):
                fault.fired = True
                if fault.replacement is not None:
                    os.replace(fault.replacement, fault.path)
                raise fault.error

            def write(self, content):
                if fault.phase == "write":
                    stream.write(content[:32])
                    stream.flush()
                    self.fail()
                return stream.write(content)

            def flush(self):
                stream.flush()
                if fault.phase == "flush" and not fault.fired:
                    self.fail()

            def close(self):
                try:
                    if fault.phase == "flush" and not fault.fired:
                        self.flush()
                finally:
                    stream.close()
                if fault.phase == "close" and not fault.fired:
                    self.fail()
                if fault.close_error:
                    raise OSError(errno.EIO, "fixture secondary close error")

        return Stream()


class OwnedWriteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.module = installer_module()

    def test_storage_failures_remove_partial_leaf_and_preserve_original_error(self):
        for phase in ("write", "flush", "close"):
            with self.subTest(phase=phase):
                path = self.root / phase
                fault = StorageFault(path, phase, close_error=phase == "write")
                with patch.object(self.module.os, "fdopen", side_effect=fault.fdopen):
                    with self.assertRaises(OSError) as raised:
                        self.module.write_owned(path, b"x" * 128, 0o600)
                self.assertIs(raised.exception, fault.error)
                self.assertTrue(fault.stream.closed)
                with self.assertRaises(OSError):
                    os.fstat(fault.fd)
                self.assertFalse(path.exists(), "failed exclusive writes must not leave an unjournaled leaf")

    def test_partial_write_return_is_completed(self):
        path = self.root / "short-write"
        real_fdopen = os.fdopen

        def short_writer(fd, *args, **kwargs):
            stream = real_fdopen(fd, *args, **kwargs)
            original = stream.write
            stream.write = lambda content: original(content[:7])
            return stream

        with patch.object(self.module.os, "fdopen", side_effect=short_writer):
            self.module.write_owned(path, b"x" * 128, 0o600)
        self.assertEqual(path.read_bytes(), b"x" * 128)

    def test_fdopen_failure_closes_descriptor_and_removes_created_leaf(self):
        path = self.root / "fdopen"
        descriptor = []
        error = OSError(errno.ENOSPC, "fixture fdopen failure")

        def fail(fd, *args, **kwargs):
            descriptor.append(fd)
            raise error

        with patch.object(self.module.os, "fdopen", side_effect=fail):
            with self.assertRaises(OSError) as raised:
                self.module.write_owned(path, b"contents", 0o600)
        self.assertIs(raised.exception, error)
        with self.assertRaises(OSError):
            os.fstat(descriptor[0])
        self.assertFalse(path.exists())

    def test_raw_descriptor_close_failure_cleans_leaf_without_masking_write_error(self):
        real_close = os.close
        for write_fails in (False, True):
            with self.subTest(write_fails=write_fails):
                path = self.root / ("raw-close-" + str(write_fails))
                fault = StorageFault(path, "write" if write_fails else "none")
                close_error = OSError(errno.ENOSPC, "fixture raw descriptor close failure")

                def fail_close(fd):
                    real_close(fd)
                    raise close_error

                with patch.object(self.module.os, "fdopen", side_effect=fault.fdopen), patch.object(self.module.os, "close", side_effect=fail_close):
                    with self.assertRaises(OSError) as raised:
                        self.module.write_owned(path, b"x" * 128, 0o600)
                self.assertIs(raised.exception, fault.error if write_fails else close_error)
                self.assertFalse(path.exists())
                with self.assertRaises(OSError):
                    os.fstat(fault.fd)

    def test_no_progress_write_cleans_leaf_and_empty_write_succeeds(self):
        real_fdopen = os.fdopen
        for result in (0, None):
            with self.subTest(result=result):
                path = self.root / ("no-progress-" + str(result))

                def no_progress(fd, *args, **kwargs):
                    stream = real_fdopen(fd, *args, **kwargs)
                    stream.write = lambda content: result
                    return stream

                with patch.object(self.module.os, "fdopen", side_effect=no_progress):
                    with self.assertRaises(OSError):
                        self.module.write_owned(path, b"contents", 0o600)
                self.assertFalse(path.exists())
        empty = self.root / "empty"
        self.module.write_owned(empty, b"", 0o600)
        self.assertEqual(empty.read_bytes(), b"")

    def test_write_failure_preserves_concurrently_replaced_leaf(self):
        for kind in ("file", "symlink"):
            with self.subTest(kind=kind):
                path = self.root / ("owned-" + kind)
                foreign = self.root / ("replacement-" + kind)
                target = self.root / "foreign-target"
                target.write_bytes(b"foreign")
                if kind == "file":
                    foreign.write_bytes(b"foreign")
                else:
                    foreign.symlink_to(target)
                fault = StorageFault(path, "write", replacement=foreign)
                with patch.object(self.module.os, "fdopen", side_effect=fault.fdopen):
                    with self.assertRaises(OSError) as raised:
                        self.module.write_owned(path, b"x" * 128, 0o600)
                self.assertIs(raised.exception, fault.error)
                self.assertEqual(path.read_bytes(), b"foreign")
                self.assertEqual(path.is_symlink(), kind == "symlink")
                self.assertEqual(target.read_bytes(), b"foreign")

    def test_manifest_preserves_preexisting_and_replaced_staging_files(self):
        path = self.root / "manifest.json"
        path.write_bytes(b"original journal")
        staging = path.with_suffix(".json.pending")
        staging.write_bytes(b"foreign staging")
        with self.assertRaises(FileExistsError):
            self.module.save_manifest(path, {"status": "changed"})
        self.assertEqual(staging.read_bytes(), b"foreign staging")
        staging.unlink()
        foreign = self.root / "foreign"
        foreign.write_bytes(b"replacement staging")
        error = OSError(errno.ENOSPC, "fixture replacement failure")
        real_replace = os.replace

        def fail(source, destination):
            real_replace(foreign, source)
            raise error

        with patch.object(self.module.os, "replace", side_effect=fail):
            with self.assertRaises(OSError) as raised:
                self.module.save_manifest(path, {"status": "changed"})
        self.assertIs(raised.exception, error)
        self.assertEqual(staging.read_bytes(), b"replacement staging")
        self.assertEqual(path.read_bytes(), b"original journal")

    def test_manifest_replace_error_preserved_even_if_staging_cleanup_fails(self):
        real_unlink = Path.unlink
        for blocked in (False, True):
            with self.subTest(blocked=blocked):
                path = self.root / ("replace-error-" + str(blocked) + ".json")
                path.write_bytes(b"original journal")
                staging = path.with_suffix(".json.pending")
                error = OSError(errno.ENOSPC, "fixture manifest replacement failed")

                def unlink(leaf, *args, **kwargs):
                    if blocked and leaf == staging:
                        raise PermissionError(errno.EACCES, "fixture staging cleanup blocked")
                    return real_unlink(leaf, *args, **kwargs)

                with patch.object(self.module.os, "replace", side_effect=error), patch.object(Path, "unlink", unlink):
                    with self.assertRaises(OSError) as raised:
                        self.module.save_manifest(path, {"status": "changed"})
                self.assertIs(raised.exception, error)
                self.assertEqual(path.read_bytes(), b"original journal")
                self.assertEqual(staging.exists(), blocked)
                if blocked:
                    self.assertTrue(getattr(error, "__notes__", []))
                    staging.unlink()  # Reset only the known test-created leaf.
                self.module.save_manifest(path, {"status": "recovered"})

    def test_manifest_storage_failures_clean_staging_and_retain_previous_journal(self):
        for phase in ("write", "flush", "close"):
            with self.subTest(phase=phase):
                path = self.root / (phase + ".json")
                path.write_bytes(b"original journal")
                staging = path.with_suffix(".json.pending")
                fault = StorageFault(staging, phase)
                with patch.object(self.module.os, "fdopen", side_effect=fault.fdopen):
                    with self.assertRaises(OSError) as raised:
                        self.module.save_manifest(path, {"status": "changed"})
                self.assertIs(raised.exception, fault.error)
                self.assertEqual(path.read_bytes(), b"original journal")
                self.assertFalse(staging.exists())
                self.module.save_manifest(path, {"status": "recovered"})
                self.assertEqual(json.loads(path.read_text())["status"], "recovered")


class InstallTests(InstallationFixture):
    def test_install_reinstall_remove_preserves_foreign_configuration_and_history(self):
        original = (self.herdr / "layouts/main.json").read_bytes()
        self.assertTrue(self.install()["ok"])
        self.assertFalse(self.data.exists(), "installation must not initialize history")
        manifest_bytes = self.manifest.read_bytes()
        self.assertEqual(self.install()["status"], "unchanged")
        self.assertEqual(self.manifest.read_bytes(), manifest_bytes)
        self.assertEqual(len(self.calls()), 1, "reinstall must not clone/switch again")
        self.assertEqual(self.calls()[0][:2], ["do", "layout.clone"])
        self.assertEqual(json.loads(self.calls()[0][2]), {"name": "main", "as": "threads-main"})
        self.assertEqual((self.herdr / "layouts/main.json").read_bytes(), original)
        clone = json.loads(self.clone.read_text())
        for key in ("titlebar", "traffic_lights", "background"):
            self.assertEqual(clone[key], self.source[key])
        self.assertEqual([child["id"] for child in clone["children"]], ["sidebar", "work"])
        self.assertEqual(clone["children"][1], self.source["children"][1])
        sections = clone["children"][0]["children"][0]["children"]
        self.assertEqual([section["id"] for section in sections], ["spaces", "threads-sidebar", "agents"])
        block = sections[1]
        self.assertEqual(block["content"]["mod"], "threads")
        self.assertEqual(block["content"]["props"], {"cli": str(self.launcher), "dataDir": str(self.data),
                                                    "channel": "threads-main", "role": "section"})
        self.assertEqual(block["size"], {"weight": 1})
        self.assertGreaterEqual(block["min"], 90)
        mod = self.herdr / "mods/threads"
        self.assertEqual({f.name for f in mod.iterdir()}, MOD_FILES)
        self.assertEqual(json.loads((mod / "mod.json").read_text())["place"], "none")
        self.assertTrue((self.home / ".agents/skills/threads/references/reporting.md").is_file())
        self.assertTrue((self.home / ".pi/agent/extensions/threads.ts").is_file())
        self.assertEqual(self.cli(["list"])["threads"], [])
        self.data.joinpath("user-evidence.md").write_text("preserve")
        history = {f.name: f.read_bytes() for f in self.data.iterdir()}
        self.assertTrue(self.install("remove")["ok"])
        self.assertEqual({f.name: f.read_bytes() for f in self.data.iterdir()}, history)
        self.assertFalse(self.launcher.exists())
        self.assertFalse(self.clone.exists())
        self.assertEqual(self.install("remove")["status"], "absent")
        self.assertEqual((self.herdr / "settings.json").read_text(), '{"unrelated":true}')
        self.assertEqual((self.home / ".pi/agent/settings.json").read_text(), '{"hooks":"leave alone"}')
        self.assertEqual((self.herdr / "layouts/.state/threads-main.json").read_text(), "fixture click state")
        self.assertTrue(self.install()["ok"])
        self.assertEqual(self.data.joinpath("user-evidence.md").read_text(), "preserve")

    def test_collisions_and_invalid_layout_fail_before_native_command(self):
        for relative in (".local/bin/threads", ".agents/skills/threads", ".config/herdr-app/mods/threads",
                         ".config/herdr-app/layouts/threads-main.json"):
            with self.subTest(relative=relative):
                path = self.home / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("foreign")
                self.assertFalse(self.install(expected=1)["ok"])
                self.assertEqual(path.read_text(), "foreign")
                self.assertEqual(self.calls(), [])
                path.unlink()
        (self.herdr / "layouts/main.json").write_text('{"type":"stack","children":[]}')
        self.assertFalse(self.install(expected=1)["ok"])
        self.assertFalse(self.manifest.exists())
        self.assertEqual(self.calls(), [])

    def test_symlink_ancestors_and_source_symlinks_fail_without_following(self):
        external = Path(self.temp.name) / "outside"
        external.mkdir()
        (self.home / ".agents").symlink_to(external, target_is_directory=True)
        self.assertFalse(self.install(expected=1)["ok"])
        self.assertEqual(list(external.iterdir()), [])
        self.assertEqual(self.calls(), [])
        (self.home / ".agents").unlink()
        source = self.herdr / "layouts/main.json"
        source.unlink()
        source.symlink_to(ROOT / "herdr/mods/threads/mod.json")
        self.assertFalse(self.install(expected=1)["ok"])
        self.assertEqual(self.calls(), [])

    def test_invalid_configuration_shapes_fail_before_native_command(self):
        source = self.herdr / "layouts/main.json"
        for value in ([], {"type": "row", "id": "root", "children": [False]},
                      {"type": "row", "id": "root", "children": [{"id": "a", "type": "block", "content": []}]}):
            with self.subTest(value=value):
                source.write_text(json.dumps(value))
                self.assertFalse(self.install(expected=1)["ok"])
                self.assertFalse(self.manifest.exists())
                self.assertEqual(self.calls(), [])
        source.write_text(json.dumps(self.source))
        self.manifest.parent.mkdir(parents=True)
        self.manifest.write_text("[]")
        self.assertFalse(self.install(expected=1)["ok"])
        self.assertFalse(self.install("remove", expected=1)["ok"])
        self.assertEqual(self.calls(), [])

    def test_permissions_preflight_does_not_mutate_existing_state(self):
        directory = self.home / ".agents"
        directory.mkdir(mode=0o500)
        try:
            self.assertFalse(self.install(expected=1)["ok"])
            self.assertEqual(self.calls(), [])
            self.assertFalse(self.manifest.exists())
        finally:
            directory.chmod(0o700)

    def test_edited_owned_files_are_preserved_and_reinstall_fails_closed(self):
        self.install()
        self.launcher.write_text("local edit")
        foreign = self.herdr / "mods/threads/user-note.md"
        foreign.write_text("local note")
        self.assertFalse(self.install(expected=1)["ok"])
        removed = self.install("remove")
        self.assertIn(str(self.launcher), removed["preserved"])
        self.assertEqual(self.launcher.read_text(), "local edit")
        self.assertEqual(foreign.read_text(), "local note")
        self.assertTrue(self.manifest.exists(), "retain ownership record until unresolved edits are handled")

    def test_existing_sidebar_width_sections_and_work_are_preserved(self):
        source = self.herdr / "layouts/main.json"
        original = source.read_bytes()
        self.install()
        clone = json.loads(self.clone.read_text())
        self.assertEqual([child["id"] for child in clone["children"]], ["sidebar", "work"])
        self.assertEqual(clone["children"][0]["size"], {"px": 268})
        sections = clone["children"][0]["children"][0]["children"]
        self.assertEqual([child["id"] for child in sections], ["spaces", "threads-sidebar", "agents"])
        del sections[1]
        del clone["cloned_from"]
        self.assertEqual(clone, self.source, "only the middle section is added; Files/Changes and terminal structure stay intact")
        self.assertEqual(source.read_bytes(), original)

    def test_missing_or_ambiguous_sidebar_slots_fail_before_native_clone(self):
        source = self.herdr / "layouts/main.json"
        original = json.dumps(self.source)
        variants = [
            [self.source["children"][1]],
            [{"id": "sidebar", "type": "column", "children": []}, self.source["children"][1]],
            [{"id": "sidebar", "type": "column", "children": [
                {"id": "agents", "type": "block", "content": {"mod": "agents"}},
                {"id": "spaces", "type": "block", "content": {"mod": "spaces"}}]}, self.source["children"][1]],
        ]
        for children in variants:
            with self.subTest(children=children):
                source.write_text(json.dumps(dict(self.source, children=children)))
                self.assertFalse(self.install(expected=1)["ok"])
                self.assertFalse(self.manifest.exists())
                self.assertEqual(self.calls(), [], "unsupported layouts must not switch the live window")
        source.write_text(original)

    def test_existing_reader_id_is_a_preflight_collision_not_an_overwrite(self):
        self.source["children"].append({"id": "threads-reader", "type": "block", "content": {"mod": "foreign"}})
        (self.herdr / "layouts/main.json").write_text(json.dumps(self.source))
        result = self.install(expected=1)
        self.assertFalse(result["ok"])
        self.assertEqual(self.calls(), [])

    def test_ambiguous_native_failure_keeps_clone_and_recovery_journal(self):
        result = self.install(expected=1, env={"FIXTURE_CLONE_FAIL": "after"})
        self.assertFalse(result["ok"])
        self.assertTrue(self.clone.exists())
        self.assertEqual(json.loads(self.manifest.read_text())["status"], "recovery_required")
        self.assertFalse(self.launcher.exists())
        self.install("remove")
        self.assertTrue(self.clone.exists(), "an unconfirmed native clone is never claimed or removed")
        self.assertTrue(self.manifest.exists())

    def test_malformed_native_clone_metadata_is_structured_unconfirmed_failure(self):
        for metadata in ([], None, "fixture-private-diagnostic"):
            with self.subTest(metadata=metadata):
                original = (self.herdr / "layouts/main.json").read_bytes()
                result = subprocess.run([sys.executable, str(ROOT / "scripts/install.py"), "install",
                                         "--home", str(self.home), "--herdr-home", str(self.herdr),
                                         "--herdr-command", str(self.host), "--layout", "main"],
                                        env={**self.env, "FIXTURE_CLONED_FROM": json.dumps(metadata)},
                                        capture_output=True, text=True, timeout=20)
                try:
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stderr, "")
                    self.assertFalse(json.loads(result.stdout)["ok"])
                    self.assertNotIn("fixture-private-diagnostic", result.stdout)
                    manifest = json.loads(self.manifest.read_text())
                    self.assertEqual(manifest["status"], "recovery_required")
                    self.assertEqual(manifest["unconfirmed_clone"], str(self.clone))
                    self.assertEqual(manifest["files"], {})
                    self.assertEqual(json.loads(self.clone.read_text())["cloned_from"], metadata)
                    self.assertEqual((self.herdr / "layouts/main.json").read_bytes(), original)
                    self.assertFalse(self.launcher.exists())
                    self.assertFalse((self.home / ".local/share/threads-runtime").exists())
                    self.assertFalse((self.home / ".agents/skills/threads").exists())
                    self.assertFalse((self.herdr / "mods/threads").exists())
                finally:
                    # Reset only this test's simulated native outcome for the
                    # next malformed type, even when a red assertion fails.
                    self.clone.unlink(missing_ok=True)
                    self.manifest.unlink(missing_ok=True)

    def test_write_failure_rolls_back_only_confirmed_unchanged_resources(self):
        spec = importlib.util.spec_from_file_location("threads_installer", ROOT / "scripts/install.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original = module.write_owned
        def fail(path, content, mode):
            if Path(path) == self.launcher:
                raise PermissionError("fixture failure after native clone")
            return original(path, content, mode)
        with patch.object(module, "write_owned", side_effect=fail), patch.dict(os.environ, self.env, clear=True):
            with self.assertRaises(module.InstallError):
                module.install(self.home, self.herdr, self.host, "main")
        self.assertFalse(self.clone.exists())
        self.assertFalse(self.launcher.exists())
        self.assertFalse((self.home / ".local/share/threads-runtime/bin/threads").exists())
        self.assertTrue(self.manifest.exists(), "native switch/click-state side effects remain documented")
        self.assertEqual(json.loads(self.manifest.read_text())["status"], "rolled_back")
        self.assertEqual((self.herdr / "layouts/main.json").read_text(), json.dumps(self.source))

    def test_storage_errors_roll_back_remove_and_reinstall_without_unowned_leaves(self):
        module = installer_module()
        for selected in ("resource", "manifest_staging", "clone_staging", "initial_manifest"):
            for phase in ("write", "flush", "close"):
                with self.subTest(target=selected, phase=phase):
                    fixture = InstallationFixture()
                    fixture.setUp()
                    self.addCleanup(fixture.doCleanups)
                    resource = fixture.home / ".local/share/threads-runtime/src/threads/cli.py"
                    targets = {"resource": resource, "manifest_staging": fixture.manifest.with_suffix(".json.pending"),
                               "clone_staging": fixture.clone.with_suffix(".threads-pending"),
                               "initial_manifest": fixture.manifest}
                    target = targets[selected]
                    fault = StorageFault(target, phase)
                    with patch.object(module.os, "fdopen", side_effect=fault.fdopen), patch.dict(os.environ, fixture.env, clear=True):
                        with self.assertRaises((module.InstallError, OSError)) as raised:
                            module.install(fixture.home, fixture.herdr, fixture.host, "main")
                    self.assertTrue(fault.fired)
                    if isinstance(raised.exception, module.InstallError):
                        self.assertIs(raised.exception.__cause__, fault.error)
                    else:
                        self.assertIs(raised.exception, fault.error)
                    if target != fixture.manifest:
                        self.assertFalse(target.exists())
                    self.assertFalse(fixture.manifest.with_suffix(".json.pending").exists())
                    self.assertFalse(fixture.clone.with_suffix(".threads-pending").exists())
                    self.assertFalse(fixture.clone.exists())
                    self.assertFalse(resource.exists())
                    if fixture.manifest.exists():
                        journal = json.loads(fixture.manifest.read_text())
                        self.assertEqual(journal["status"], "rolled_back")
                        self.assertEqual(journal["files"], {})
                    self.assertIn(module.remove(fixture.home, fixture.herdr)["status"], ("removed", "absent"))
                    with patch.dict(os.environ, fixture.env, clear=True):
                        self.assertEqual(module.install(fixture.home, fixture.herdr, fixture.host)["status"], "installed")
                    self.assertEqual(module.remove(fixture.home, fixture.herdr)["status"], "removed")

    def test_failed_cleanup_is_journaled_as_recovery_and_remove_can_retry(self):
        module = installer_module()
        target = self.home / ".local/share/threads-runtime/src/threads/cli.py"
        fault = StorageFault(target, "write")
        real_unlink = Path.unlink

        def blocked(path, *args, **kwargs):
            if path == target:
                raise PermissionError(errno.EACCES, "fixture cleanup blocked")
            return real_unlink(path, *args, **kwargs)

        with patch.object(module.os, "fdopen", side_effect=fault.fdopen), patch.object(Path, "unlink", blocked), patch.dict(os.environ, self.env, clear=True):
            with self.assertRaises(module.InstallError) as raised:
                module.install(self.home, self.herdr, self.host)
        self.assertIs(raised.exception.__cause__, fault.error)
        self.assertTrue(target.exists())
        journal = json.loads(self.manifest.read_text())
        self.assertEqual(journal["status"], "recovery_required")
        self.assertEqual(journal["files"][str(target)], module.fingerprint(target))
        self.assertTrue(getattr(fault.error, "__notes__", []))
        self.assertEqual(module.remove(self.home, self.herdr)["status"], "removed")
        self.assertFalse(target.exists())
        with patch.dict(os.environ, self.env, clear=True):
            self.assertEqual(module.install(self.home, self.herdr, self.host)["status"], "installed")
        self.assertEqual(module.remove(self.home, self.herdr)["status"], "removed")

    def test_blocked_pending_cleanup_preserves_error_journal_and_staging(self):
        module = installer_module()
        pending = self.manifest.with_suffix(".json.pending")
        fault = StorageFault(pending, "write")
        real_unlink = Path.unlink

        def blocked(path, *args, **kwargs):
            if path == pending:
                raise PermissionError(errno.EACCES, "fixture staging cleanup blocked")
            return real_unlink(path, *args, **kwargs)

        with patch.object(module.os, "fdopen", side_effect=fault.fdopen), patch.object(Path, "unlink", blocked), patch.dict(os.environ, self.env, clear=True):
            with self.assertRaises(module.InstallError) as raised:
                module.install(self.home, self.herdr, self.host)
        self.assertIs(raised.exception.__cause__, fault.error)
        self.assertTrue(getattr(fault.error, "__notes__", []))
        self.assertTrue(pending.exists())
        self.assertNotEqual(json.loads(self.manifest.read_text())["status"], "rolled_back")
        with self.assertRaises(module.InstallError):
            module.remove(self.home, self.herdr)
        self.assertTrue(pending.exists(), "without durable ownership a later process must not guess")
        pending.unlink()  # Explicit fixture inspection/reset, not automatic ownership.
        self.assertEqual(module.remove(self.home, self.herdr)["status"], "recovery_required")
        # The last durable journal predates confirmation of the native clone.
        # Only this fixture knows it was removed; do not weaken native ownership
        # rules to infer confirmation when the recovery save itself was blocked.
        journal = json.loads(self.manifest.read_text())
        self.assertIn("unconfirmed_clone", journal)
        self.assertFalse(self.clone.exists())
        del journal["unconfirmed_clone"]
        self.manifest.write_text(json.dumps(journal))
        self.assertEqual(module.remove(self.home, self.herdr)["status"], "removed")
        with patch.dict(os.environ, self.env, clear=True):
            self.assertEqual(module.install(self.home, self.herdr, self.host)["status"], "installed")
        self.assertEqual(module.remove(self.home, self.herdr)["status"], "removed")

    def test_recovery_journal_failure_preserves_original_storage_error(self):
        module = installer_module()
        target = self.home / ".local/share/threads-runtime/src/threads/cli.py"
        fault = StorageFault(target, "write")
        save = module.save_manifest

        def fail_recovery(path, manifest):
            if fault.fired:
                raise OSError(errno.ENOSPC, "fixture journal storage full")
            return save(path, manifest)

        with patch.object(module.os, "fdopen", side_effect=fault.fdopen), patch.object(module, "save_manifest", side_effect=fail_recovery), patch.dict(os.environ, self.env, clear=True):
            with self.assertRaises(module.InstallError) as raised:
                module.install(self.home, self.herdr, self.host)
        self.assertIs(raised.exception.__cause__, fault.error)
        self.assertTrue(getattr(fault.error, "__notes__", []))
        self.assertNotEqual(json.loads(self.manifest.read_text())["status"], "rolled_back")
        self.assertFalse(target.exists())
        self.assertEqual(module.remove(self.home, self.herdr)["status"], "removed")

    def test_remove_never_reports_success_with_unowned_pending_write(self):
        module = installer_module()
        self.install()
        pending = self.manifest.with_suffix(".json.pending")
        pending.write_bytes(b"unowned partial or replacement")
        with self.assertRaises(module.InstallError):
            module.remove(self.home, self.herdr)
        self.assertEqual(pending.read_bytes(), b"unowned partial or replacement")
        self.assertTrue(self.manifest.exists())
        self.assertTrue(self.launcher.exists())
        pending.unlink()  # Only the test-created unowned fixture leaf is reset.
        self.assertEqual(module.remove(self.home, self.herdr)["status"], "removed")

    def test_manifest_tampering_cannot_claim_foreign_resources(self):
        self.install()
        value = json.loads(self.manifest.read_text())
        foreign = self.herdr / "settings.json"
        value["files"][str(foreign)] = {"sha256": "0" * 64, "mode": 384}
        self.manifest.write_text(json.dumps(value))
        self.assertFalse(self.install("remove", expected=1)["ok"])
        self.assertEqual(foreign.read_text(), '{"unrelated":true}')
        self.assertTrue(self.launcher.exists())

    def test_existing_clone_staging_name_is_a_preflight_collision(self):
        staging = self.clone.with_suffix(".threads-pending")
        staging.write_text("foreign staging file")
        self.assertFalse(self.install(expected=1)["ok"])
        self.assertEqual(self.calls(), [])
        self.assertEqual(staging.read_text(), "foreign staging file")
        self.assertFalse(self.manifest.exists())

    def test_doctor_rejects_incomplete_manifest_without_opening_database(self):
        self.install()
        value = json.loads(self.manifest.read_text())
        value["files"] = {}
        self.manifest.write_text(json.dumps(value))
        result = subprocess.run([sys.executable, str(ROOT / "scripts/doctor.py"), "--home", str(self.home),
                                 "--herdr-home", str(self.herdr)], env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)["installation"]["intact"])
        self.assertFalse(self.data.exists())

    def test_doctor_fails_for_unsafe_data_permissions_without_repair(self):
        self.install()
        self.data.mkdir(mode=0o755)
        self.data.chmod(0o755)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/doctor.py"), "--home", str(self.home),
                                 "--herdr-home", str(self.herdr)], env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)["storage"]["owner_only"])
        self.assertEqual(self.data.stat().st_mode & 0o777, 0o755)
        self.assertEqual(list(self.data.iterdir()), [])

    def test_doctor_read_only_reports_static_not_live_compatibility(self):
        self.install()
        before = {str(f.relative_to(self.home)): f.read_bytes() for f in self.home.rglob("*") if f.is_file()}
        result = subprocess.run([sys.executable, str(ROOT / "scripts/doctor.py"), "--home", str(self.home),
                                 "--herdr-home", str(self.herdr)], env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["coverage"]["live_hosts"], "pending")
        self.assertEqual(report["coverage"]["skill_behavior"], "pending")
        self.assertTrue(report["installation"]["intact"])
        node_version = subprocess.check_output(["node", "--version"], env=self.env, text=True, timeout=5).strip().removeprefix("v")
        self.assertEqual(report["executables"]["node"]["version"], node_version)
        self.assertEqual(report["executables"]["node"]["live_smoke"], "pending")
        self.assertFalse(self.data.exists())
        after = {str(f.relative_to(self.home)): f.read_bytes() for f in self.home.rglob("*") if f.is_file()}
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
