"""U1 proofs use dedicated temporary data directories, never personal data."""
import concurrent.futures
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from uuid import uuid4
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def draft(key="first", **changes):
    from threads.domain import Origin, RecordDraft, RecordKind
    values = dict(kind=RecordKind.PROGRESS, body="Investigated the failure", operation_key=key,
                  origin=Origin("pi", "11111111-1111-4111-8111-111111111111", "/tmp/pi-session.jsonl"))
    values.update(changes)
    return RecordDraft(**values)


def write_batch(data_dir, thread_id, writer):
    from threads.store import Store
    store = Store(Path(data_dir))
    return [store.append(draft(f"{writer}-{i}", thread_id=thread_id)).sequence for i in range(12)]


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name) / "data"

    def store(self, **kwargs):
        from threads.store import Store
        return Store(self.data_dir, **kwargs)


class TransactionProofs(StoreCase):
    def test_first_record_and_thread_are_atomic_and_durable(self):
        store = self.store()
        event = store.append(draft(title="Investigate"))
        reopened = self.store()
        self.assertEqual(reopened.events(event.thread_id), (event,))
        thread = reopened.get_thread(event.thread_id)
        self.assertEqual((thread.id, thread.event_count, thread.summary),
                         (event.thread_id, 1, "Investigated the failure"))
        self.assertEqual(len(reopened.list_threads()), 1)
        self.assertTrue(event.received_at.endswith("+00:00"))

    def test_invalid_origin_leaves_no_thread_or_record(self):
        from threads.domain import Origin, ValidationError
        store = self.store()
        with self.assertRaises(ValidationError):
            store.append(draft(origin=Origin("pi", "not-a-real-uuid", "/tmp/session")))
        self.assertEqual(store.list_threads(), ())
        self.assertEqual(json.loads(store.export_json())["events"], [])

    def test_storage_failure_rolls_back_thread_creation(self):
        store = self.store()
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            connection.execute("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            store.append(draft())
        self.assertEqual(store.list_threads(), ())

    def test_retry_is_identical_and_conflicting_key_is_explicit(self):
        from threads.domain import ConflictError
        store = self.store()
        first = store.append(draft())
        self.assertEqual(self.store().append(draft()), first)
        with self.assertRaises(ConflictError):
            store.append(draft(body="A different semantic report"))
        self.assertEqual(store.events(first.thread_id), (first,))

    def test_concurrent_processes_preserve_every_event_in_sequence(self):
        store = self.store()
        first = store.append(draft())
        with concurrent.futures.ProcessPoolExecutor(max_workers=4) as pool:
            batches = list(pool.map(write_batch, [str(self.data_dir)] * 4,
                                    [first.thread_id] * 4, range(4)))
        events = store.events(first.thread_id, limit=100)
        self.assertEqual(len(events), 49)
        self.assertEqual([e.sequence for e in events], sorted({e.sequence for e in events}))
        self.assertEqual({s for batch in batches for s in batch}, {e.sequence for e in events[1:]})
        self.assertEqual(self.store().get_thread(first.thread_id).event_count, 49)

    def test_concurrent_identical_first_write_creates_only_one_thread(self):
        self.store()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            events = list(pool.map(lambda _: self.store().append(draft()), range(12)))
        self.assertTrue(all(event == events[0] for event in events))
        self.assertEqual(len(self.store().list_threads()), 1)

    def test_key_conflicts_include_metadata_and_keep_original_projections(self):
        from threads.domain import ConflictError, ExternalReference, Origin, ReferenceKind
        store = self.store()
        original = store.append(draft())
        before = store.get_thread(original.thread_id)
        for changes in [dict(title="Changed"), dict(retained=True), dict(thread_id=original.thread_id),
                        dict(references=(ExternalReference(ReferenceKind.ISSUE, "ISSUE-2"),)),
                        dict(origin=Origin(original.origin.agent, original.origin.session_id, "/tmp/moved.jsonl"))]:
            with self.subTest(changes=changes), self.assertRaises(ConflictError):
                store.append(draft(**changes))
        self.assertEqual(store.get_thread(original.thread_id), before)
        self.assertEqual(store.events(original.thread_id), (original,))

    def test_lock_wait_is_bounded_and_retry_safe(self):
        from threads.domain import StoreBusyError
        store = self.store(busy_timeout_ms=25)
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            with self.assertRaises(StoreBusyError):
                store.append(draft())
        self.assertEqual(store.list_threads(), ())
        self.assertEqual(store.append(draft()).sequence, 1)


class ProjectionAndPrivacyTests(StoreCase):
    def test_recent_history_is_bounded_without_loading_full_history(self):
        store = self.store()
        first = store.append(draft())
        records = [first] + [store.append(draft(str(i), thread_id=first.thread_id)) for i in range(5)]
        self.assertEqual(store.recent_events(first.thread_id, limit=2), tuple(reversed(records[-2:])))
        self.assertEqual(store.recent_events(first.thread_id, limit=2, before_sequence=records[-2].sequence),
                         tuple(reversed(records[-4:-2])))

    def test_initialization_race_and_new_thread_listing_pagination(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            events = list(pool.map(lambda i: self.store().append(draft(str(i))), range(8)))
        store = self.store()
        page = store.list_threads(limit=3)
        next_page = store.list_threads(limit=3, before_sequence=page[-1].latest_sequence)
        self.assertEqual(len(page), 3)
        self.assertEqual(len(next_page), 3)
        self.assertFalse({t.id for t in page} & {t.id for t in next_page})
        self.assertEqual(len(store.list_threads()), len(events))

    def test_summary_title_and_reference_limits_remain_bounded(self):
        store = self.store()
        first = store.append(draft(body="\n  Meaningful first line\n" + "x" * 5000))
        snapshot = store.get_thread(first.thread_id)
        self.assertEqual(snapshot.title, "Meaningful first line")
        self.assertEqual(len(snapshot.summary), 4000)

    def test_external_links_keep_history_uuid_and_session_association(self):
        from threads.domain import ExternalReference, ReferenceKind, Origin
        store = self.store()
        old = ExternalReference(ReferenceKind.ISSUE, "PROJ-1")
        new = ExternalReference(ReferenceKind.PR, "https://example.org/pr/2")
        first = store.append(draft(references=(old,)))
        codex = Origin("codex", "22222222-2222-4222-8222-222222222222", "/tmp/codex.jsonl")
        second = store.append(draft("second", thread_id=first.thread_id, origin=codex,
                                    references=(new,), retained=True, summary="Ready for review"))
        thread = store.get_thread(first.thread_id)
        self.assertEqual(thread.references, (new,))
        self.assertTrue(thread.retained)
        self.assertEqual(thread.summary, "Ready for review")
        self.assertEqual(store.events(first.thread_id), (first, second))
        self.assertEqual(first.references, (old,))
        for filters in [dict(reference=old), dict(reference=new), dict(origin=codex), dict(origin=first.origin)]:
            self.assertEqual(store.list_threads(**filters), (thread,))
        cleared = store.append(draft("clear", thread_id=first.thread_id, references=()))
        self.assertEqual(store.get_thread(first.thread_id).references, ())
        self.assertEqual(store.events(first.thread_id)[0].thread_id, cleared.thread_id)

    def test_failed_event_does_not_change_summary_links_or_retention(self):
        store = self.store()
        first = store.append(draft())
        before = store.get_thread(first.thread_id)
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            connection.execute("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            store.append(draft("next", thread_id=first.thread_id, summary="must roll back", retained=True))
        self.assertEqual(store.get_thread(first.thread_id), before)

    def test_late_association_failure_rolls_back_event_and_all_projections(self):
        from threads.domain import ExternalReference, Origin, ReferenceKind
        store = self.store()
        old = ExternalReference(ReferenceKind.ISSUE, "ISSUE-1")
        new = ExternalReference(ReferenceKind.PR, "https://example.org/pr/2")
        first = store.append(draft(references=(old,)))
        before = store.get_thread(first.thread_id)
        codex = Origin("codex", "22222222-2222-4222-8222-222222222222", "/tmp/codex.jsonl")
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            connection.execute("CREATE TRIGGER reject_link BEFORE INSERT ON external_references BEGIN SELECT RAISE(ABORT, 'injected late failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            store.append(draft("next", thread_id=first.thread_id, origin=codex, references=(new,),
                               title="Changed", summary="Changed", retained=True))
        self.assertEqual(store.get_thread(first.thread_id), before)
        self.assertEqual(store.events(first.thread_id), (first,))
        self.assertEqual(store.list_threads(origin=codex), ())
        self.assertEqual(store.list_threads(reference=new), ())

    def test_bounded_keyset_projections_and_reading_have_no_write_side_effect(self):
        from threads.domain import ValidationError
        store = self.store()
        first = store.append(draft())
        for i in range(6):
            store.append(draft(str(i), thread_id=first.thread_id))
        page = store.events(first.thread_id, limit=3)
        self.assertEqual(len(page), 3)
        self.assertEqual(len(store.events(first.thread_id, after_sequence=page[-1].sequence, limit=3)), 3)
        before = store.export_json()
        store.get_thread(first.thread_id)
        store.list_threads(limit=1)
        self.assertEqual(store.export_json(), before)
        for limit in [0, -1, 201, True]:
            with self.assertRaises(ValidationError):
                store.events(first.thread_id, limit=limit)
        for limit in [0, 101]:
            with self.assertRaises(ValidationError):
                store.list_threads(limit=limit)

    def test_missing_thread_does_not_get_created_and_agent_scopes_keys(self):
        from threads.domain import NotFoundError, Origin
        store = self.store()
        with self.assertRaises(NotFoundError):
            store.append(draft(thread_id=str(uuid4())))
        first = store.append(draft())
        other = Origin("codex", first.origin.session_id, first.origin.session_ref)
        second = store.append(draft(origin=other, thread_id=first.thread_id))
        self.assertNotEqual(first.sequence, second.sequence)
        with self.assertRaises(NotFoundError):
            store.get_thread(str(uuid4()))

    def test_export_preserves_typed_evidence_and_schema_version(self):
        from threads.domain import Availability, Evidence, EvidenceKind, ObjectVersion, RecordKind, Validation, ValidationOutcome
        target = ObjectVersion("report", version="v1")
        store = self.store()
        event = store.append(draft(kind=RecordKind.VALIDATION,
                                   evidence=(Evidence(EvidenceKind.REPORT, "/tmp/report", target, Availability.UNAVAILABLE),),
                                   validation=Validation(target, ValidationOutcome.PASSED)))
        self.assertEqual(self.store().events(event.thread_id), (event,))
        exported = json.loads(store.export_json())
        self.assertEqual(exported["schema_version"], 2)
        self.assertEqual(exported["events"][0]["evidence"][0]["availability"], "unavailable")
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM events")

    def test_owner_only_paths_no_checkout_data_or_symlink_escape(self):
        from threads.store import Store
        from threads.domain import StorageError
        store = self.store()
        self.assertEqual(self.data_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual(store.database_path.stat().st_mode & 0o777, 0o600)
        checkout = Path(self.temp.name) / "checkout"
        checkout.mkdir()
        (checkout / ".git").mkdir()
        with self.assertRaises(StorageError):
            Store(checkout / "data")
        public = Path(self.temp.name) / "public"
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        with self.assertRaises(StorageError):
            Store(public)
        link_dir = Path(self.temp.name) / "links"
        link_dir.mkdir(mode=0o700)
        (link_dir / "threads.sqlite3").symlink_to(store.database_path)
        with self.assertRaises(StorageError):
            Store(link_dir)

    def test_default_location_is_private_and_configurable_without_home_writes(self):
        from threads.store import Store
        from threads.domain import StorageError
        base = Path(self.temp.name) / "xdg"
        with patch.dict(os.environ, {"XDG_DATA_HOME": str(base)}):
            store = Store()
        self.assertEqual(store.data_dir, (base / "threads").resolve())
        self.assertEqual(store.list_threads(), ())
        self.assertEqual((base / "threads").stat().st_mode & 0o777, 0o700)
        with patch.dict(os.environ, {"XDG_DATA_HOME": "relative"}), self.assertRaises(StorageError):
            Store()
        store.database_path.chmod(0o644)
        with self.assertRaises(StorageError):
            Store(store.data_dir)

    def test_invalid_cursors_and_recent_limits_rejected(self):
        from threads.domain import ValidationError, NotFoundError
        store = self.store()
        first = store.append(draft())
        for changes in [dict(limit=201), dict(limit=True), dict(before_sequence=-1), dict(before_sequence="1")]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                store.recent_events(first.thread_id, **changes)
        with self.assertRaises(NotFoundError):
            store.recent_events(str(uuid4()))
        with self.assertRaises(ValidationError):
            store.events(first.thread_id, after_sequence=-1)
        with self.assertRaises(ValidationError):
            store.list_threads(before_sequence=-1)

    def test_future_schema_is_rejected_without_changing_it(self):
        from threads.domain import StorageError
        store = self.store()
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            connection.execute("PRAGMA user_version=99")
        with self.assertRaises(StorageError):
            self.store()
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 99)


class AssociationProofs(StoreCase):
    def test_explicit_switch_and_record_replay_do_not_rewind_current_association(self):
        from threads.domain import ConflictError
        store = self.store()
        first = store.append(draft())
        second = store.append(draft("second"))
        origin = first.origin
        chosen = store.associate(origin, first.thread_id, "choose-first")
        store.associate(origin, second.thread_id, "choose-second")
        self.assertEqual(store.associate(origin, first.thread_id, "choose-first"), chosen)
        store.append(draft())
        self.assertEqual(store.current_association(origin)["thread_id"], second.thread_id)
        with self.assertRaises(ConflictError):
            store.associate(origin, second.thread_id, "choose-first")
        self.assertEqual(len(store.association_history(first.thread_id)), 2)
        self.assertEqual(store.get_thread(first.thread_id).event_count, 1)
        self.assertEqual(self.store().current_association(origin)["thread_id"], second.thread_id)

    def test_binding_failure_rolls_back_record_and_projection_and_missing_thread_does_not_bind(self):
        from threads.domain import NotFoundError
        store = self.store()
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            connection.execute("CREATE TRIGGER reject_binding BEFORE INSERT ON association_operations BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            store.append(draft())
        self.assertEqual(store.list_threads(), ())
        self.assertIsNone(store.current_association(draft().origin))
        with self.assertRaises(NotFoundError):
            store.associate(draft().origin, str(uuid4()), "missing")

    def test_v1_migration_preserves_history_without_inventing_current_association(self):
        from threads.store import Store, _MIGRATION_1
        self.data_dir.mkdir(mode=0o700)
        database = self.data_dir / "threads.sqlite3"
        old_id = str(uuid4())
        old_event = dict(draft().to_dict(), thread_id=old_id, received_at="2026-11-03T00:00:00+00:00")
        with closing(sqlite3.connect(database)) as connection, connection:
            for statement in _MIGRATION_1:
                connection.execute(statement)
            connection.execute("INSERT INTO threads VALUES (?, 'Old title', 'Old summary', 1, '[]', 1, 1, ?)",
                               (old_id, old_event["received_at"]))
            connection.execute("INSERT INTO events VALUES (1, ?, ?, ?, 'first', ?, ?)",
                               (old_id, draft().origin.agent, draft().origin.session_id,
                                json.dumps(draft().to_dict()), json.dumps(old_event)))
            connection.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                               (old_id, draft().origin.agent, draft().origin.session_id))
            connection.execute("PRAGMA user_version=1")
        database.chmod(0o600)
        migrated = Store(self.data_dir)
        self.assertIsNone(migrated.current_association(draft().origin))
        self.assertEqual(migrated.get_thread(old_id).title, "Old title")
        self.assertTrue(migrated.get_thread(old_id).retained)
        self.assertEqual(migrated.events(old_id)[0].to_dict(), dict(old_event, sequence=1))
        self.assertEqual(len(migrated.list_threads(origin=draft().origin)), 1)
        event = migrated.append(draft("after-migration"))
        self.assertEqual(migrated.current_association(event.origin)["thread_id"], event.thread_id)
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)

    def test_explicit_binding_is_exported_with_current_state_and_history(self):
        store = self.store()
        first = store.append(draft())
        second = store.append(draft("other"))
        receipt = store.associate(first.origin, first.thread_id, "choose")
        exported = json.loads(store.export_json())
        self.assertEqual(len(exported["associations"]), 3)
        self.assertEqual(exported["current_associations"], [receipt])
        self.assertEqual(len(exported["events"]), 2)

    def test_explicit_association_lock_conflict_and_independent_sessions(self):
        from threads.domain import Origin, StoreBusyError, ValidationError
        store = self.store(busy_timeout_ms=25)
        first = store.append(draft())
        second = store.append(draft("other"))
        other = Origin("pi", "22222222-2222-4222-8222-222222222222", "/tmp/other-pi.jsonl")
        with closing(sqlite3.connect(store.database_path)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            with self.assertRaises(StoreBusyError):
                store.associate(other, first.thread_id, "bind")
            connection.rollback()
        self.assertIsNone(store.current_association(other))
        bound = store.associate(other, first.thread_id, "bind")
        self.assertEqual(store.current_association(first.origin)["thread_id"], second.thread_id)
        self.assertEqual(store.current_association(other), bound)
        self.assertEqual(store.list_threads(origin=other)[0].id, first.thread_id)
        for thread_id, key in [(None, "key"), (first.thread_id, ""), ("bad", "key")]:
            with self.assertRaises(ValidationError):
                store.associate(other, thread_id, key)
        self.assertEqual(store.current_association(other), bound)

    def test_association_history_is_bounded_and_append_only(self):
        from threads.domain import ValidationError
        store = self.store()
        first = store.append(draft())
        for i in range(3):
            store.associate(first.origin, first.thread_id, str(i))
        page = store.association_history(first.thread_id, limit=2)
        rest = store.association_history(first.thread_id, after_sequence=page[-1]["sequence"], limit=2)
        self.assertEqual(len(page), 2)
        self.assertEqual(len(rest), 2)
        self.assertLess(page[-1]["sequence"], rest[0]["sequence"])
        for kwargs in [dict(limit=201), dict(after_sequence=-1)]:
            with self.assertRaises(ValidationError):
                store.association_history(first.thread_id, **kwargs)
        with closing(sqlite3.connect(store.database_path)) as connection, connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM association_operations")


if __name__ == "__main__":
    unittest.main()
