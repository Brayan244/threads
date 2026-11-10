#!/usr/bin/env python3
"""Read-only static diagnostics, never a substitute for actual host smoke tests."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
# Do not import Store or run installed launchers: either can create/migrate data.
from install import InstallError, configuration, read_manifest, resources, safe_path, unchanged


def permission_status(path):
    if not path.exists():
        parent = path.parent
        while not parent.exists():
            parent = parent.parent
        return {"exists": False, "parent_writable": os.access(parent, os.W_OK | os.X_OK),
                "host_sandbox_access": "unverified"}
    return {"exists": True, "owner_only": path.is_dir() and stat.S_IMODE(path.stat().st_mode) == 0o700 and path.stat().st_uid == os.getuid(),
            "writable": os.access(path, os.W_OK | os.X_OK), "host_sandbox_access": "unverified"}


def executable_status(name, config):
    executable = shutil.which(name)
    value = {"present": executable is not None, "version": "unavailable", "live_smoke": "pending"}
    if executable is not None:
        try:
            result = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5,
                                    env=dict(os.environ, HOME=str(config["home"]), HERDR_APP_HOME=str(config["herdr"])))
            # Report only the version token, not arbitrary diagnostic text/paths.
            match = re.search(r"(?<![0-9.])(\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.]+)?)\b", result.stdout[:1024])
            if result.returncode == 0 and match:
                value["version"] = match[1]
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return value


def diagnose(home, herdr_home, layout="main"):
    config = configuration(home, herdr_home, layout)
    installation = {"present": False, "intact": False}
    journal = config["manifest"]
    safe_path(journal, config["home"])
    if journal.exists():
        values = resources(config)
        manifest = read_manifest(config, values)
        expected = {str(p) for p in (*values, config["clone"])}
        changed = [p for p, record in manifest["files"].items() if not unchanged(Path(p), record)]
        installation = {"present": True, "status": manifest["status"],
                        "intact": manifest["status"] == "installed" and not changed and set(manifest["files"]) == expected,
                        "changed_resource_count": len(changed), "missing_resource_count": len(expected - set(manifest["files"]))}
    safe_path(config["data"], config["home"])
    report = {"ok": sys.version_info >= (3, 11), "coverage": {"checks": "static_read_only",
              "fixtures": "not_run_by_doctor", "skill_behavior": "pending", "live_hosts": "pending"},
              "python": {"version": ".".join(map(str, sys.version_info[:3])), "minimum": "3.11", "sqlite": sqlite3.sqlite_version},
              "executables": {name: executable_status(name, config) for name in ("python3", "node", "pi", "codex", "herdr-app")},
              "installation": installation, "storage": permission_status(config["data"]),
              "limits": ["Executable presence is not compatibility evidence.",
                         "No skill evaluation, agent invocation, native clone or UI check was performed.",
                         "Filesystem access does not establish Codex sandbox permission; use normal host approval.",
                         "No database was opened, initialized or migrated."],
              "next_gate": "Follow docs/compatibility.md with operator authorization and isolated data."}
    storage = report["storage"]
    report["ok"] = (report["ok"] and all(value["present"] for value in report["executables"].values()) and
                    (storage.get("owner_only", False) and storage["writable"] if storage["exists"] else storage["parent_writable"]))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--herdr-home", type=Path)
    parser.add_argument("--layout", default="main")
    args = parser.parse_args(argv)
    herdr = args.herdr_home if args.herdr_home is not None else args.home / ".config/herdr-app"
    try:
        report = diagnose(args.home, herdr, args.layout)
        report["ok"] = report["ok"] and (not report["installation"]["present"] or report["installation"]["intact"])
    except (InstallError, OSError, ValueError, TypeError, KeyError):
        report = {"ok": False, "coverage": {"checks": "static_read_only", "live_hosts": "pending", "skill_behavior": "pending"},
                  "error": "Invalid, changed or inaccessible installation roots/manifest; no repair attempted."}
    print(json.dumps(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
