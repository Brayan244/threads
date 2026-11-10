#!/usr/bin/env python3
"""Explicit-root installer. Native Herdr cloning is a journaled, non-atomic step."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MOD_FILES = ("main.js", "detail.js", "view-model.js", "mod.json", "package.json")
CORE_FILES = ("__init__.py", "cli.py", "domain.py", "identity.py", "store.py")


class InstallError(Exception):
    pass


def absolute(value):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or any(ord(c) < 32 for c in str(path)):
        raise InstallError("Paths must be explicit absolute paths without traversal or control characters.")
    if path.is_symlink():
        raise InstallError("A selected root must not be a symlink.")
    return path


def safe_path(path, root):
    """Reject links/special nodes within an explicit root, without traversing them."""
    if not path.is_relative_to(root):
        raise InstallError("Resource escaped its selected root.")
    for item in (path, *path.parents):
        if item.is_symlink():
            raise InstallError("Symlinks are not supported inside installation roots.")
        if item.exists() and not (item.is_file() or item.is_dir()):
            raise InstallError("Special files are not supported.")
        if item == root:
            break


def writable_parent(path, root):
    safe_path(path, root)
    parent = path.parent
    while not parent.exists():
        parent = parent.parent
    if not parent.is_dir() or parent.stat().st_mode & 0o300 != 0o300 or not os.access(parent, os.W_OK | os.X_OK):
        raise InstallError("Installation parent is not writable/searchable; no permissions were changed.")


def fingerprint(path):
    if path.is_symlink() or not path.is_file():
        raise InstallError("Expected a regular owned file.")
    return {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "mode": stat.S_IMODE(path.stat().st_mode)}


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def same_created_file(path, created):
    try:
        current = path.lstat()
    except FileNotFoundError:
        return False
    return (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino)


def cleanup_created_file(path, created, error):
    """Never claim a replacement; cleanup errors must not hide the write error."""
    try:
        if same_created_file(path, created):
            path.unlink()
    except OSError as cleanup_error:
        error.add_note(f"Could not clean up exclusive write at {path}: {cleanup_error}")
        error.incomplete_write = (path, created)


def write_owned(path, content, mode):
    """Create exclusively; clean failed writes only while this leaf is still ours."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    created = None
    failure = None
    try:
        created = os.fstat(fd)
        # Keep the raw descriptor alive through cleanup, even if stream.close
        # fails. Its inode cannot be recycled into a replacement at this path.
        stream = os.fdopen(fd, "wb", closefd=False)
        try:
            remaining = memoryview(content)
            while remaining:
                written = stream.write(remaining)
                if not isinstance(written, int) or written <= 0:
                    raise OSError("Exclusive file write made no progress.")
                remaining = remaining[written:]
            stream.flush()
        except BaseException as error:
            try:
                stream.close()
            except BaseException as close_error:
                error.add_note(f"Closing the failed write also failed: {close_error}")
            raise
        else:
            stream.close()
    except BaseException as error:
        failure = error
        if created is not None:
            cleanup_created_file(path, created, error)
        raise
    finally:
        try:
            os.close(fd)
        except OSError as close_error:
            # Do not retry close: the OS may already have released the fd.
            if failure is not None:
                failure.add_note(f"Closing the raw descriptor also failed: {close_error}")
            else:
                if created is not None:
                    cleanup_created_file(path, created, close_error)
                raise
    return created


def save_manifest(path, manifest):
    # The journal already belongs to this operation. Atomic replacement never
    # truncates the last recovery record if serialization/write fails.
    temporary = path.with_suffix(".json.pending")
    created = None
    try:
        created = write_owned(temporary, encode(manifest), 0o600)
        if not same_created_file(temporary, created):
            raise InstallError("Manifest staging file changed; replacement was preserved.")
        os.replace(temporary, path)
    except BaseException as error:
        if created is not None:
            cleanup_created_file(temporary, created, error)
        raise


def configuration(home, herdr, layout):
    home, herdr = absolute(home), absolute(herdr)
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", layout):
        raise InstallError("Layout name must contain only letters, digits, underscore or hyphen.")
    if not home.is_dir() or not herdr.is_dir():
        raise InstallError("Explicit HOME and initialized Herdr home must already exist.")
    data = home / ".local/share/threads"
    runtime = home / ".local/share/threads-runtime"
    launcher = home / ".local/bin/threads"
    manifest = home / ".local/state/threads-install/manifest.json"
    clone = herdr / f"layouts/threads-{layout}.json"
    return {"home": home, "herdr": herdr, "layout": layout, "data": data,
            "runtime": runtime, "launcher": launcher, "manifest": manifest, "clone": clone}


def resources(config):
    home, runtime = config["home"], config["runtime"]
    values = {}
    def copy(source, target):
        safe_path(source, ROOT)
        values[target] = (source.read_bytes(), 0o600)
    for name in CORE_FILES:
        copy(ROOT / "src/threads" / name, runtime / "src/threads" / name)
    for name in ("index.ts", "cli.mjs"):
        copy(ROOT / "integrations/pi" / name, runtime / "integrations/pi" / name)
    for name in ("SKILL.md", "references/reporting.md"):
        copy(ROOT / "skills/threads" / name, home / ".agents/skills/threads" / name)
    for name in MOD_FILES:
        copy(ROOT / "herdr/mods/threads" / name, config["herdr"] / "mods/threads" / name)
    if json.loads(values[config["herdr"] / "mods/threads/mod.json"][0])["place"] != "none":
        raise InstallError("Threads mod must not auto-dock into an unrelated layout.")
    entry = (f"#!{sys.executable}\nimport sys\nsys.dont_write_bytecode = True\nsys.path.insert(0, {str(runtime / 'src')!r})\n"
             f"from threads.cli import main\nraise SystemExit(main(['--data-dir', {str(config['data'])!r}, *sys.argv[1:]]))\n").encode()
    values[runtime / "bin/threads"] = (entry, 0o700)
    values[config["launcher"]] = (entry, 0o700)
    extension = f"export {{ default }} from {json.dumps((runtime / 'integrations/pi/index.ts').as_uri())};\n"
    values[home / ".pi/agent/extensions/threads.ts"] = (extension.encode(), 0o600)
    return values


def root_for(path, config):
    # Herdr may be explicitly outside HOME; never infer it from ambient env.
    return config["herdr"] if path.is_relative_to(config["herdr"]) else config["home"]


def validate_layout(value):
    if not isinstance(value, dict) or value.get("type") != "row" or not isinstance(value.get("children"), list) or not value["children"]:
        raise InstallError("Only a nonempty row-root layout is supported; source was not rewritten.")
    ids = set()
    def visit(node):
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or node["id"] in ids or node["id"] in ("threads-sidebar", "threads-reader"):
            raise InstallError("Layout IDs must be unique and must not collide with Threads.")
        ids.add(node["id"])
        if node.get("type") not in ("block", "row", "column", "stack"):
            raise InstallError("Unsupported layout node.")
        content, children = node.get("content", {}), node.get("children", [])
        if not isinstance(content, dict) or not isinstance(children, list):
            raise InstallError("Invalid layout content/children.")
        if content.get("mod") == "threads":
            raise InstallError("Source layout already refers to Threads.")
        for child in children:
            visit(child)
    visit(value)
    sidebar_sections(value)


def sidebar_sections(layout):
    """Locate the existing vertical Spaces/Agents slot; never invent another bar."""
    sidebar = next((node for node in layout["children"] if node["id"] == "sidebar"), None)
    def find(node):
        if node.get("type") == "column":
            children = node.get("children", [])
            ids = [child["id"] for child in children]
            if "spaces" in ids and "agents" in ids and ids.index("agents") == ids.index("spaces") + 1:
                if all(children[ids.index(name)].get("type") == "block" for name in ("spaces", "agents")):
                    return children
        for child in node.get("children", []):
            found = find(child)
            if found is not None:
                return found
        return None
    sections = find(sidebar) if sidebar and sidebar.get("type") == "column" else None
    if sections is None:
        raise InstallError("An existing left sidebar with adjacent Spaces then Agents sections is required; no layout was switched.")
    return sections


def sidebar_layout(clone, config):
    """Add only the middle sidebar section to the confirmed clone."""
    sections = sidebar_sections(clone)
    position = next(index for index, node in enumerate(sections) if node["id"] == "spaces") + 1
    sections.insert(position, {"id": "threads-sidebar", "type": "block", "size": {"weight": 1}, "min": 90,
                               "content": {"mod": "threads", "props": {
                                   "cli": str(config["launcher"]), "dataDir": str(config["data"]),
                                   "channel": "threads-" + config["layout"], "role": "section"}}})


def read_manifest(config, values):
    path = config["manifest"]
    safe_path(path, config["home"])
    value = json.loads(path.read_text())
    if (not isinstance(value, dict) or value.get("version") != 1 or value.get("home") != str(config["home"]) or
            value.get("herdr_home") != str(config["herdr"]) or value.get("layout") != config["layout"]):
        raise InstallError("Manifest does not match the explicit roots/layout.")
    allowed = {*values, config["clone"]}
    files, directories = value.get("files"), value.get("directories")
    if not isinstance(files, dict) or not isinstance(directories, list):
        raise InstallError("Invalid ownership records.")
    allowed_dirs = {p for file in (*allowed, path) for p in file.parents
                    if (p.is_relative_to(config["home"]) and p != config["home"]) or
                    (p.is_relative_to(config["herdr"]) and p != config["herdr"])}
    if any(Path(p) not in allowed for p in files) or any(Path(p) not in allowed_dirs for p in directories):
        raise InstallError("Manifest includes resources outside Threads ownership.")
    incomplete = value.get("incomplete_write")
    if incomplete is not None and (not isinstance(incomplete, str) or Path(incomplete) not in
                                  {*allowed, path, path.with_suffix(".json.pending"), config["clone"].with_suffix(".threads-pending")}):
        raise InstallError("Invalid incomplete write recovery path.")
    for filename, record in files.items():
        if (not isinstance(record, dict) or set(record) != {"sha256", "mode"} or
                not re.fullmatch(r"[0-9a-f]{64}", record.get("sha256", "")) or type(record.get("mode")) is not int):
            raise InstallError("Invalid file fingerprint.")
        safe_path(Path(filename), root_for(Path(filename), config))
    return value


def unchanged(path, record):
    return path.is_file() and not path.is_symlink() and fingerprint(path) == record


def make_parents(path, config, manifest):
    missing = []
    parent = path.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        manifest["directories"].append(str(directory))


def remove_owned(config, manifest):
    preserved = []
    for filename, record in list(manifest["files"].items()):
        path = Path(filename)
        safe_path(path, root_for(path, config))
        if not path.exists():
            del manifest["files"][filename]
        elif unchanged(path, record):
            path.unlink()
            del manifest["files"][filename]
        else:
            preserved.append(filename)
    for filename in sorted(manifest["directories"], key=len, reverse=True):
        path = Path(filename)
        safe_path(path, root_for(path, config))
        if path == config["manifest"].parent or config["manifest"].is_relative_to(path):
            continue
        try:
            path.rmdir()  # Never recurse: foreign additions always survive.
        except (FileNotFoundError, OSError):
            pass
    return preserved


def install(home, herdr_home, herdr_command, layout="main"):
    if sys.version_info < (3, 11):
        raise InstallError("Python 3.11 or newer is required.")
    config = configuration(home, herdr_home, layout)
    values = resources(config)
    journal = config["manifest"]
    if journal.exists():
        manifest = read_manifest(config, values)
        expected = {str(p) for p in (*values, config["clone"])}
        if (manifest.get("status") == "installed" and set(manifest["files"]) == expected and
                all(unchanged(Path(p), r) for p, r in manifest["files"].items()) and
                all(fingerprint(p) == {"sha256": hashlib.sha256(data).hexdigest(), "mode": mode}
                    for p, (data, mode) in values.items())):
            return {"ok": True, "status": "unchanged", "live_compatibility": "pending"}
        raise InstallError("Existing install is edited, different, or incomplete; inspect its journal before removal/retry.")
    safe_path(journal, config["home"])
    source = config["herdr"] / f"layouts/{layout}.json"
    safe_path(source, config["herdr"])
    original = source.read_bytes()
    validate_layout(json.loads(original))
    command = absolute(herdr_command)
    if not command.is_file() or not os.access(command, os.X_OK):
        raise InstallError("An explicit executable Herdr command is required.")
    # Preflight whole resource namespaces, not just planned leaves.
    for path in (config["runtime"], config["home"] / ".agents/skills/threads",
                 config["herdr"] / "mods/threads", config["clone"], config["clone"].with_suffix(".threads-pending"),
                 *values, journal.with_suffix(".json.pending")):
        writable_parent(path, root_for(path, config))
        if path.exists():
            raise InstallError("An unowned resource name is already taken; nothing was overwritten.")
    writable_parent(journal, config["home"])
    safe_path(config["data"], config["home"])
    writable_parent(config["data"] / "permission-check", config["home"])
    if any((p / ".git").exists() for p in (config["data"], *config["data"].parents)):
        raise InstallError("History must remain outside Git checkouts.")
    if config["data"].exists() and (not config["data"].is_dir() or stat.S_IMODE(config["data"].stat().st_mode) != 0o700):
        raise InstallError("Existing history directory must already have owner-only permissions.")
    manifest = {"version": 1, "home": str(config["home"]), "herdr_home": str(config["herdr"]), "layout": layout,
                "status": "cloning", "files": {}, "directories": [], "data_dir": str(config["data"]),
                "native_side_effects": ["layout.clone switches to threads-" + layout,
                                        "Native copied click state is not owned or removed; switch away before removal."],
                "unconfirmed_clone": str(config["clone"])}
    make_parents(journal, config, manifest)
    write_owned(journal, encode(manifest), 0o600)
    confirmed = False
    try:
        env = dict(os.environ, HOME=str(config["home"]), HERDR_APP_HOME=str(config["herdr"]))
        result = subprocess.run([str(command), "do", "layout.clone", json.dumps({"name": layout, "as": "threads-" + layout})],
                                env=env, capture_output=True, text=True, timeout=30)
        receipt = json.loads(result.stdout)
        if result.returncode != 0 or not isinstance(receipt, dict) or "error" in receipt:
            raise InstallError("Native clone did not confirm success.")
        safe_path(config["clone"], config["herdr"])
        clone = json.loads(config["clone"].read_text())
        validate_layout(clone)
        cloned_from = clone.get("cloned_from")
        if not isinstance(cloned_from, dict) or cloned_from.get("name") != layout or source.read_bytes() != original:
            raise InstallError("Native clone/source contract mismatch.")
        # Verify the native clone before changing only this owned layout.
        for key, value in json.loads(original).items():
            if key != "cloned_from" and clone.get(key) != value:
                raise InstallError("Native clone changed the source tree; inspect manually.")
        manifest["files"][str(config["clone"])] = fingerprint(config["clone"])
        del manifest["unconfirmed_clone"]
        confirmed = True
        save_manifest(journal, manifest)
        for path, (content, mode) in values.items():
            make_parents(path, config, manifest)
            write_owned(path, content, mode)
            manifest["files"][str(path)] = fingerprint(path)
            save_manifest(journal, manifest)
        sidebar_layout(clone, config)
        if not unchanged(config["clone"], manifest["files"][str(config["clone"])]):
            raise InstallError("Clone changed during installation; preserved for inspection.")
        # Replace only a just-confirmed, unchanged owned clone.
        temporary = config["clone"].with_suffix(".threads-pending")
        write_owned(temporary, encode(clone), 0o600)
        os.replace(temporary, config["clone"])
        manifest["files"][str(config["clone"])] = fingerprint(config["clone"])
        manifest["status"] = "installed"
        save_manifest(journal, manifest)
    except (OSError, ValueError, TypeError, InstallError, subprocess.SubprocessError) as error:
        incomplete = getattr(error, "incomplete_write", None)
        if incomplete is not None:
            path, created = incomplete
            # A failed unlink may leave a partial resource. Journal its actual
            # bytes for the normal ownership-checked removal/retry path.
            manifest["incomplete_write"] = str(path)
            try:
                if path in values and same_created_file(path, created):
                    record = fingerprint(path)
                    if same_created_file(path, created):
                        manifest["files"][str(path)] = record
                        del manifest["incomplete_write"]
            except (OSError, InstallError) as recovery_error:
                error.add_note(f"Could not fingerprint incomplete write: {recovery_error}")
        rollback_failed = False
        if confirmed:
            try:
                remove_owned(config, manifest)
            except (OSError, InstallError) as recovery_error:
                rollback_failed = True
                error.add_note(f"Rollback needs recovery: {recovery_error}")
        manifest["status"] = ("rolled_back" if confirmed and not manifest["files"] and
                              not manifest.get("incomplete_write") and not rollback_failed else "recovery_required")
        try:
            save_manifest(journal, manifest)
        except (OSError, ValueError, TypeError, InstallError) as recovery_error:
            error.add_note(f"Could not save recovery state; previous journal retained: {recovery_error}")
        raise InstallError("Installation failed; inspect manifest recovery state. Native selection/click-state effects may remain.") from error
    return {"ok": True, "status": "installed", "manifest": str(journal), "data_dir": str(config["data"]),
            "live_compatibility": "pending", "native_side_effects": manifest["native_side_effects"]}


def remove(home, herdr_home, layout="main"):
    config = configuration(home, herdr_home, layout)
    if not config["manifest"].exists():
        return {"ok": True, "status": "absent", "preserved": []}
    manifest = read_manifest(config, resources(config))
    # A staging leaf without a completed ownership record cannot be reclaimed.
    # In particular, never report removal while a failed/foreign pending write
    # still blocks future journal updates or installation.
    for pending in (config["manifest"].with_suffix(".json.pending"), config["clone"].with_suffix(".threads-pending")):
        safe_path(pending, root_for(pending, config))
        if pending.exists():
            raise InstallError("Unowned staging file needs inspection before removal/retry.")
    preserved = remove_owned(config, manifest)
    incomplete = manifest.get("incomplete_write")
    if incomplete is not None:
        path = Path(incomplete)
        safe_path(path, root_for(path, config))
        if path.exists():
            preserved.append(incomplete)
        else:
            del manifest["incomplete_write"]
    if preserved or manifest.get("unconfirmed_clone"):
        manifest["status"] = "recovery_required"
        save_manifest(config["manifest"], manifest)
    else:
        config["manifest"].unlink()
        # Only empty directories proven created by this install may disappear.
        for filename in sorted(manifest["directories"], key=len, reverse=True):
            try:
                Path(filename).rmdir()
            except OSError:
                pass
    return {"ok": True, "status": "preserved_edits" if preserved else "recovery_required" if manifest.get("unconfirmed_clone") else "removed",
            "preserved": preserved, "data_preserved": True,
            "note": "No layout switch or .state cleanup performed. Native click state and all history remain."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "remove"))
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--herdr-home", required=True, type=Path)
    parser.add_argument("--herdr-command", type=Path, help="Absolute native executable; required for install only")
    parser.add_argument("--layout", default="main")
    args = parser.parse_args(argv)
    try:
        if args.action == "install" and args.herdr_command is None:
            raise InstallError("Install requires --herdr-command.")
        result = install(args.home, args.herdr_home, args.herdr_command, args.layout) if args.action == "install" else remove(args.home, args.herdr_home, args.layout)
    except (InstallError, OSError, ValueError, TypeError) as error:
        result = {"ok": False, "error": str(error) if isinstance(error, InstallError) else "Invalid configuration or inaccessible resources; inspect explicit roots."}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
