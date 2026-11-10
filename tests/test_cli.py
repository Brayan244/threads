"""Subprocess contract proofs against private temporary SQLite, not live hosts."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from threads.store import Store

ROOT = Path(__file__).resolve().parents[1]
PI = "11111111-1111-4111-8111-111111111111"
CODEX = "22222222-2222-4222-8222-222222222222"


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "data"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("CODEX_", "THREADS_"))}
        self.env["XDG_DATA_HOME"] = str(Path(self.temp.name) / "xdg")

    def call(self, command, payload=None, *, host=None, raw=None, extra=(), env=None, expected_status=None):
        args = [sys.executable, str(ROOT / "bin/threads"), "--data-dir", str(self.data),
                "--busy-timeout-ms", "25"]
        call_env = dict(self.env)
        if host == "pi":
            args += ["--pi-session-id", PI, "--pi-session-ref", "/tmp/pi-fixture.jsonl"]
        elif host == "codex":
            call_env.update(CODEX_THREAD_ID=CODEX, CODEX_HOME=str(Path(self.temp.name) / "codex"))
        call_env.update(env or {})
        result = subprocess.run(args + [command] + list(extra), input=raw if raw is not None else (
            json.dumps(payload).encode() if payload is not None else b""), capture_output=True,
            env=call_env, cwd=ROOT, timeout=10)
        self.assertEqual(result.stderr, b"")
        if expected_status is not None:
            self.assertEqual(result.returncode, expected_status)
        try:
            value = json.loads(result.stdout)
        except ValueError:
            self.fail(f"CLI did not return JSON: status={result.returncode}, stdout={result.stdout!r}")
        self.assertEqual(value["contract_version"], 1)
        self.assertEqual(value["ok"], result.returncode == 0)
        return value

    def record(self, key="first", **changes):
        return dict(dict(kind="progress", body="Investigated failure", operation_key=key), **changes)

    def success(self, command, payload=None, **kwargs):
        value = self.call(command, payload, **kwargs)
        self.assertTrue(value["ok"], value)
        return value["result"]

    def test_pi_and_codex_write_same_semantics_distinct_origins_and_retries(self):
        first = self.success("record", self.record(), host="pi")["event"]
        self.assertEqual(self.success("record", self.record(), host="pi")["event"], first)
        second = self.success("record", self.record("next", thread_id=first["thread_id"]), host="codex")["event"]
        self.assertEqual(first["body"], second["body"])
        self.assertEqual(first["origin"]["session_id"], PI)
        self.assertEqual(second["origin"]["session_id"], CODEX)
        self.assertEqual(len(Store(self.data).events(first["thread_id"])), 2)
        self.assertEqual(self.call("record", self.record(body="changed"), host="pi")["error"]["code"], "conflict")

    def test_identity_override_missing_and_conflicting_context_do_not_write(self):
        for payload, host, env in [(self.record(origin={"agent": "pi", "session_id": PI, "session_ref": "/tmp/x"}), "pi", {}),
                                   (self.record(), None, {}),
                                   (self.record(), "pi", {"CODEX_THREAD_ID": CODEX})]:
            with self.subTest(payload=payload, host=host):
                self.assertFalse(self.call("record", payload, host=host, env=env)["ok"])
        self.assertEqual(self.success("list")["threads"], [])

    def test_empty_reads_do_not_create_threads_or_require_identity(self):
        self.assertEqual(self.success("list")["threads"], [])
        self.assertEqual(Store(self.data).list_threads(), ())

    def test_association_switch_is_separate_durable_and_retry_does_not_rewind(self):
        first = self.success("record", self.record(), host="pi")["event"]
        second = self.success("record", self.record("second"), host="pi")["event"]
        bind = dict(thread_id=first["thread_id"], operation_key="choose-first")
        original = self.success("associate", bind, host="pi")
        self.assertEqual(self.success("current", host="pi")["association"]["thread_id"], first["thread_id"])
        self.success("associate", dict(thread_id=second["thread_id"], operation_key="choose-second"), host="pi")
        self.assertEqual(self.success("associate", bind, host="pi"), original)
        self.success("record", self.record(), host="pi")  # replay must not rewind either
        self.assertEqual(self.success("current", host="pi")["association"]["thread_id"], second["thread_id"])
        self.success("associate", bind, host="codex")
        self.assertEqual(self.success("current", host="codex")["association"]["thread_id"], first["thread_id"])
        self.assertEqual(sum(t.event_count for t in Store(self.data).list_threads()), 2)

    def test_independent_thread_and_event_pagination_and_private_metadata_controls(self):
        first = self.success("record", self.record(), host="pi")["event"]
        for i in range(4):
            self.success("record", self.record(str(i), thread_id=first["thread_id"]), host="pi")
        self.success("record", self.record("other"), host="codex")
        listing = self.success("list", extra=("--limit", "1"))
        self.assertNotIn("references", listing["threads"][0])
        self.assertEqual(len(self.success("list", extra=("--before-sequence", str(listing["next_before_sequence"])))["threads"]), 1)
        context = self.success("show", extra=(first["thread_id"], "--limit", "2"))
        self.assertEqual([e["sequence"] for e in context["events"]], [5, 4])
        self.assertNotIn("origin", context["events"][0])
        older = self.success("show", extra=(first["thread_id"], "--limit", "2", "--before-sequence", str(context["next_before_sequence"])))
        self.assertEqual([e["sequence"] for e in older["events"]], [3, 2])
        history = self.success("events", extra=(first["thread_id"], "--limit", "2", "--include-origin"))
        self.assertEqual([e["sequence"] for e in history["events"]], [1, 2])
        self.assertEqual(history["events"][0]["origin"]["session_id"], PI)
        self.assertEqual(history["next_after_sequence"], 2)
        self.assertEqual(len(self.success("sessions", extra=(first["thread_id"],))["associations"]), 5)

    def test_version_review_and_evidence_round_trip_without_implied_approval(self):
        target = dict(object_id="plan", version="v1", digest="sha256:abc")
        payload = self.record(kind="review_finding", review=dict(target=target, instruction="Review v1 requested by user", disposition="approved"),
                              evidence=[dict(kind="document", reference="/tmp/plan.md", target=target, availability="unknown")])
        event = self.success("record", payload, host="pi")["event"]
        shown = self.success("show", extra=(event["thread_id"],))["events"][0]
        self.assertEqual(shown["review"], payload["review"])
        self.assertEqual(shown["evidence"], payload["evidence"])
        self.assertNotIn("assurance", shown)

    def test_compact_projection_counts_distinct_sessions_not_association_operations(self):
        first = self.success("record", self.record(), host="pi")["event"]
        self.success("record", self.record("same-session", thread_id=first["thread_id"]), host="pi")
        self.success("associate", dict(thread_id=first["thread_id"], operation_key="again"), host="pi")
        self.assertEqual(self.success("list")["threads"][0]["session_count"], 1)
        self.success("associate", dict(thread_id=first["thread_id"], operation_key="other"), host="codex")
        self.assertEqual(self.success("list")["threads"][0]["session_count"], 2)
        shown = self.success("show", extra=(first["thread_id"],))
        self.assertEqual(shown["thread"]["session_count"], 2)
        self.assertNotIn("origin", shown["events"][0])
        self.assertNotIn("session_id", shown["thread"])

    def test_malformed_oversized_and_unknown_inputs_are_bounded_redacted(self):
        for raw in [b"{private-secret", b'{"kind":"progress","kind":"private-secret"}', b"[]", b"\xff", b"x" * 65537,
                    b'{"private-secret": true}', b'{"body": NaN}', b"[" * 2000]:
            value = self.call("record", host="pi", raw=raw)
            self.assertFalse(value["ok"])
            self.assertNotIn("private-secret", json.dumps(value))
        value = self.call("private-secret")
        self.assertEqual(value["error"]["code"], "invalid_arguments")
        self.assertNotIn("private-secret", json.dumps(value))
        self.assertFalse(self.call("list", raw=b"private-secret")["ok"])
        self.assertFalse(self.call("list", extra=("--limit", "101"))["ok"])
        self.assertFalse(self.call("events", extra=(PI, "--after-sequence", "-1"))["ok"])

    def test_unpaired_surrogates_in_semantic_text_fail_before_storage_creation(self):
        payloads = [self.record(body="private-fixture\ud800"),
                    self.record(evidence=[dict(kind="document", reference="/tmp/private-fixture\udfff")]),
                    self.record(kind="review_finding", review=dict(
                        target=dict(object_id="plan", version="private-fixture\ud800"),
                        instruction="Review this version", disposition="approved")),
                    self.record(references=[dict(kind="issue", reference="private-fixture\ud800")])]
        for payload in payloads:
            with self.subTest(payload=repr(payload)):
                value = self.call("record", payload, host="pi", expected_status=2)
                self.assertEqual(value["error"]["code"], "invalid_input")
                self.assertNotIn("private-fixture", json.dumps(value))
                # Failure occurs before Store opens, so no schema/thread/event/binding
                # or private data directory is created as a side effect.
                self.assertFalse(self.data.exists())
        store = Store(self.data)
        self.assertEqual(store.list_threads(), ())
        self.assertEqual(json.loads(store.export_json())["associations"], [])

    def test_lock_permissions_and_sql_failure_are_redacted_without_partial_writes(self):
        store = Store(self.data)
        with closing(sqlite3.connect(store.database_path)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            value = self.call("record", self.record(), host="pi")
            self.assertEqual(value["error"]["code"], "busy")
            self.assertTrue(value["error"]["retryable"])
            connection.rollback()
        self.data.chmod(0o755)
        self.assertEqual(self.call("record", self.record(), host="pi")["error"]["code"], "storage_error")
        self.data.chmod(0o700)
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            connection.execute("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'private-secret'); END")
        value = self.call("record", self.record(), host="pi")
        self.assertEqual(value["error"]["code"], "storage_error")
        self.assertNotIn("private-secret", json.dumps(value))
        self.assertEqual(store.list_threads(), ())


if __name__ == "__main__":
    unittest.main()
