"""Transactional local history. Public consumers never need a SQLite connection.

Store opening creates only private storage/schema, never a thread. Every append
atomically records its event, associations and bounded summary projection. Event
history is append-only; external references are snapshots, not thread identities.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import stat
from uuid import uuid4

from .domain import (ConflictError, Event, ExternalReference, NotFoundError, Origin,
                     RecordDraft, StorageError, StoreBusyError, ThreadSnapshot, ValidationError)


SCHEMA_VERSION = 2
_MIGRATION_1 = (
    """CREATE TABLE threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
        retained INTEGER NOT NULL CHECK(retained IN (0,1)), references_json TEXT NOT NULL,
        latest_sequence INTEGER NOT NULL, event_count INTEGER NOT NULL, received_at TEXT NOT NULL)""",
    """CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        agent TEXT NOT NULL, session_id TEXT NOT NULL, operation_key TEXT NOT NULL,
        request_json TEXT NOT NULL, event_json TEXT NOT NULL,
        UNIQUE(agent, session_id, operation_key))""",
    "CREATE INDEX event_thread_sequence ON events(thread_id, sequence)",
    "CREATE INDEX thread_latest ON threads(latest_sequence DESC)",
    """CREATE TABLE sessions (
        thread_id TEXT NOT NULL REFERENCES threads(id), agent TEXT NOT NULL,
        session_id TEXT NOT NULL, PRIMARY KEY(thread_id, agent, session_id))""",
    "CREATE INDEX session_lookup ON sessions(agent, session_id, thread_id)",
    """CREATE TABLE external_references (
        thread_id TEXT NOT NULL REFERENCES threads(id), kind TEXT NOT NULL,
        reference TEXT NOT NULL, PRIMARY KEY(thread_id, kind, reference))""",
    "CREATE INDEX reference_lookup ON external_references(kind, reference, thread_id)",
    """CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END""",
    """CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END""",
)


_MIGRATION_2 = (
    """CREATE TABLE association_operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL, session_id TEXT NOT NULL, operation_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        request_json TEXT NOT NULL, binding_json TEXT NOT NULL,
        UNIQUE(agent, session_id, operation_key))""",
    "CREATE INDEX association_thread ON association_operations(thread_id, sequence)",
    """CREATE TABLE current_associations (
        agent TEXT NOT NULL, session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL REFERENCES association_operations(sequence),
        PRIMARY KEY(agent, session_id))""",
    """CREATE TRIGGER immutable_associations_update BEFORE UPDATE ON association_operations
        BEGIN SELECT RAISE(ABORT, 'associations are append-only'); END""",
    """CREATE TRIGGER immutable_associations_delete BEFORE DELETE ON association_operations
        BEGIN SELECT RAISE(ABORT, 'associations are append-only'); END""",
)


def default_data_dir() -> Path:
    """XDG local data location (or ~/.local/share), independent of the checkout."""
    base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    if not base.is_absolute():
        raise StorageError("XDG_DATA_HOME must be absolute")
    return base / "threads"


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _bound(value, maximum, name):
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValidationError(f"{name} must be between 1 and {maximum}")


def _cursor(value, name):
    if type(value) is not int or value < 0:
        raise ValidationError(f"{name} must be a nonnegative integer")


class Store:
    """Short-lived connections support independent concurrent processes.

    data_dir must be dedicated, owner-only and outside any Git checkout. Existing
    unsafe permissions are rejected, never changed behind the user's back. The
    busy timeout bounds lock waits; retry StoreBusyError with the identical draft.
    """
    def __init__(self, data_dir: Path | None = None, *, busy_timeout_ms: int = 5000):
        _bound(busy_timeout_ms, 60000, "busy_timeout_ms")
        self.busy_timeout_ms = busy_timeout_ms
        candidate = Path(data_dir) if data_dir is not None else default_data_dir()
        if not candidate.is_absolute():
            raise StorageError("data_dir must be absolute")
        if candidate.is_symlink():
            raise StorageError("data_dir must not be a symlink")
        self.data_dir = candidate.resolve()
        if any((parent / ".git").exists() for parent in (self.data_dir, *self.data_dir.parents)):
            raise StorageError("user data must remain outside Git checkouts")
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._private(self.data_dir, directory=True)
        self.database_path = self.data_dir / "threads.sqlite3"
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        try:
            fd = os.open(self.database_path, flags, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(fd)
        self._private(self.database_path, directory=False)
        with self._connection(write=True) as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise StorageError(f"unsupported schema {version}; supported: {SCHEMA_VERSION}")
            if version == 0:
                for statement in _MIGRATION_1:
                    connection.execute(statement)
                version = 1
            if version == 1:
                for statement in _MIGRATION_2:
                    connection.execute(statement)
                connection.execute("PRAGMA user_version=2")

    @staticmethod
    def _private(path: Path, *, directory: bool):
        info = path.lstat()
        expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
        if not expected or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise StorageError(f"storage must be owner-only and not a symlink: {path}")

    @contextmanager
    def _connection(self, *, write=False):
        connection = sqlite3.connect(self.database_path, timeout=self.busy_timeout_ms / 1000)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield connection
            connection.commit()
        except sqlite3.OperationalError as exc:
            connection.rollback()
            if getattr(exc, "sqlite_errorcode", None) in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                raise StoreBusyError("local history is busy; retry the same operation") from exc
            raise
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _event(row) -> Event:
        value = json.loads(row["event_json"])
        value["sequence"] = row["sequence"]
        return Event.from_dict(value)

    @staticmethod
    def _snapshot(row) -> ThreadSnapshot:
        values = dict(row)
        values["references"] = tuple(ExternalReference(**r) for r in json.loads(values.pop("references_json")))
        values["retained"] = bool(values["retained"])
        return ThreadSnapshot(**values)

    def append(self, draft: RecordDraft) -> Event:
        """Write or replay one operation; different input for a used key conflicts.

        Deduplication scope is (agent, session UUID, operation key), including across
        threads. Session references and all semantic fields participate in conflict
        detection. A retry returns the original time, sequence and generated UUID.
        """
        if not isinstance(draft, RecordDraft) or isinstance(draft, Event):
            raise ValidationError("append requires a RecordDraft, not a stored Event")
        request = _json(draft.to_dict())
        with self._connection(write=True) as connection:
            previous = connection.execute(
                "SELECT * FROM events WHERE agent=? AND session_id=? AND operation_key=?",
                (draft.origin.agent, draft.origin.session_id, draft.operation_key)).fetchone()
            if previous is not None:
                if previous["request_json"] != request:
                    raise ConflictError("operation key already used with different content")
                return self._event(previous)
            thread_id = draft.thread_id or str(uuid4())
            received_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
            if draft.thread_id is None:
                connection.execute(
                    "INSERT INTO threads VALUES (?, ?, ?, 0, '[]', 0, 0, ?)",
                    (thread_id, draft.title or draft.body.strip().splitlines()[0][:240], draft.summary or draft.body[:4000], received_at))
            row = connection.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
            if row is None:
                raise NotFoundError(thread_id)
            values = draft.to_dict()
            values.update(thread_id=thread_id, received_at=received_at)
            cursor = connection.execute(
                "INSERT INTO events(thread_id, agent, session_id, operation_key, request_json, event_json) VALUES (?, ?, ?, ?, ?, ?)",
                (thread_id, draft.origin.agent, draft.origin.session_id, draft.operation_key, request, _json(values)))
            sequence = cursor.lastrowid
            references = row["references_json"] if draft.references is None else _json(values["references"])
            connection.execute(
                """UPDATE threads SET title=?, summary=?, retained=?, references_json=?,
                    latest_sequence=?, event_count=event_count+1, received_at=? WHERE id=?""",
                (draft.title if draft.title is not None else row["title"],
                 draft.summary if draft.summary is not None else draft.body[:4000],
                 row["retained"] if draft.retained is None else int(draft.retained),
                 references, sequence, received_at, thread_id))
            connection.execute("INSERT OR IGNORE INTO sessions VALUES (?, ?, ?)",
                               (thread_id, draft.origin.agent, draft.origin.session_id))
            for reference in draft.references or ():
                connection.execute("INSERT OR IGNORE INTO external_references VALUES (?, ?, ?)",
                                   (thread_id, reference.kind.value, reference.reference))
            self._associate(connection, draft.origin, thread_id, draft.operation_key,
                            source="record", received_at=received_at)
            return Event.from_dict(dict(values, sequence=sequence))

    def associate(self, origin: Origin, thread_id: str, operation_key: str) -> dict:
        """Switch current work without a semantic event or projection update.

        Operation keys are scoped by origin and command (record vs associate).
        An old retry returns its original binding but NEVER reapplies it over a
        newer switch. The returned binding is a receipt, not a current-state claim.
        """
        # Reuse domain validation without appending a mechanical semantic record.
        RecordDraft(kind="observation", body="association", origin=origin,
                    operation_key=operation_key, thread_id=thread_id)
        if thread_id is None:
            raise ValidationError("association requires thread_id")
        with self._connection(write=True) as connection:
            return self._associate(connection, origin, thread_id, operation_key, source="associate",
                                   received_at=datetime.now(timezone.utc).isoformat(timespec="microseconds"))

    @staticmethod
    def _associate(connection, origin, thread_id, operation_key, *, source, received_at):
        key = source + ":" + operation_key
        request = _json(dict(origin=origin.__dict__, thread_id=thread_id))
        previous = connection.execute(
            "SELECT * FROM association_operations WHERE agent=? AND session_id=? AND operation_key=?",
            (origin.agent, origin.session_id, key)).fetchone()
        if previous is not None:
            if previous["request_json"] != request:
                raise ConflictError("association operation key already used with different content")
            return dict(json.loads(previous["binding_json"]), sequence=previous["sequence"])
        if connection.execute("SELECT 1 FROM threads WHERE id=?", (thread_id,)).fetchone() is None:
            raise NotFoundError(thread_id)
        binding = dict(origin=origin.__dict__, thread_id=thread_id, operation_key=operation_key,
                       source=source, received_at=received_at)
        cursor = connection.execute(
            "INSERT INTO association_operations(agent, session_id, operation_key, thread_id, request_json, binding_json) VALUES (?, ?, ?, ?, ?, ?)",
            (origin.agent, origin.session_id, key, thread_id, request, _json(binding)))
        sequence = cursor.lastrowid
        connection.execute(
            "INSERT INTO current_associations VALUES (?, ?, ?) ON CONFLICT(agent, session_id) DO UPDATE SET sequence=excluded.sequence",
            (origin.agent, origin.session_id, sequence))
        connection.execute("INSERT OR IGNORE INTO sessions VALUES (?, ?, ?)",
                           (thread_id, origin.agent, origin.session_id))
        return dict(binding, sequence=sequence)

    def current_association(self, origin: Origin) -> dict | None:
        """Internal current binding, or None; v1 migration invents no binding."""
        if not isinstance(origin, Origin):
            raise ValidationError("current association requires Origin")
        with self._connection() as connection:
            row = connection.execute(
                """SELECT a.* FROM current_associations c JOIN association_operations a ON a.sequence=c.sequence
                   WHERE c.agent=? AND c.session_id=?""", (origin.agent, origin.session_id)).fetchone()
            return None if row is None else dict(json.loads(row["binding_json"]), sequence=row["sequence"])

    def association_history(self, thread_id: str, *, after_sequence: int = 0, limit: int = 50) -> tuple[dict, ...]:
        """Explicit internal attribution page; independent association sequence."""
        _cursor(after_sequence, "after_sequence")
        _bound(limit, 200, "limit")
        with self._connection() as connection:
            if connection.execute("SELECT 1 FROM threads WHERE id=?", (thread_id,)).fetchone() is None:
                raise NotFoundError(thread_id)
            rows = connection.execute(
                "SELECT * FROM association_operations WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT ?",
                (thread_id, after_sequence, limit)).fetchall()
            return tuple(dict(json.loads(row["binding_json"]), sequence=row["sequence"]) for row in rows)

    def session_count(self, thread_id: str) -> int:
        """Distinct attributed sessions, not association-operation/event count.

        Read-only compact UI metadata; the sessions primary key deduplicates
        repeated records and rebindings from the same agent/session.
        """
        with self._connection() as connection:
            return connection.execute("SELECT COUNT(*) FROM sessions WHERE thread_id=?", (thread_id,)).fetchone()[0]

    def get_thread(self, thread_id: str) -> ThreadSnapshot:
        """Fetch the compact current projection; does not mark anything as read."""
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
            if row is None:
                raise NotFoundError(thread_id)
            return self._snapshot(row)

    def list_threads(self, *, limit: int = 50, before_sequence: int | None = None,
                     origin: Origin | None = None, reference: ExternalReference | None = None) -> tuple[ThreadSnapshot, ...]:
        """Newest-first keyset page (max 100). Filters include historical associations.

        External links and sessions are many-to-many, not thread identity. Replacing
        an active link does not remove its lookup association or event history.
        """
        _bound(limit, 100, "limit")
        clauses, parameters = [], []
        if before_sequence is not None:
            _cursor(before_sequence, "before_sequence")
            clauses.append("t.latest_sequence < ?")
            parameters.append(before_sequence)
        if origin is not None:
            if not isinstance(origin, Origin):
                raise ValidationError("origin filter must be Origin")
            clauses.append("EXISTS (SELECT 1 FROM sessions s WHERE s.thread_id=t.id AND s.agent=? AND s.session_id=?)")
            parameters.extend((origin.agent, origin.session_id))
        if reference is not None:
            if not isinstance(reference, ExternalReference):
                raise ValidationError("reference filter must be ExternalReference")
            clauses.append("EXISTS (SELECT 1 FROM external_references r WHERE r.thread_id=t.id AND r.kind=? AND r.reference=?)")
            parameters.extend((reference.kind.value, reference.reference))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._connection() as connection:
            rows = connection.execute("SELECT t.* FROM threads t" + where + " ORDER BY t.latest_sequence DESC LIMIT ?",
                                      (*parameters, limit)).fetchall()
            return tuple(self._snapshot(row) for row in rows)

    def events(self, thread_id: str, *, after_sequence: int = 0, limit: int = 50) -> tuple[Event, ...]:
        """Oldest-first keyset page (max 200); unknown threads raise NotFoundError."""
        _cursor(after_sequence, "after_sequence")
        return self._events_page(thread_id, limit, after_sequence, newest=False)

    def recent_events(self, thread_id: str, *, limit: int = 10,
                      before_sequence: int | None = None) -> tuple[Event, ...]:
        """Newest-first bounded context (max 200), without loading older history."""
        if before_sequence is not None:
            _cursor(before_sequence, "before_sequence")
        return self._events_page(thread_id, limit, before_sequence, newest=True)

    def _events_page(self, thread_id, limit, cursor, *, newest):
        _bound(limit, 200, "limit")
        clause = "" if cursor is None else (" AND sequence<?" if newest else " AND sequence>?")
        parameters = (thread_id, limit) if cursor is None else (thread_id, cursor, limit)
        order = "DESC" if newest else "ASC"
        with self._connection() as connection:
            if connection.execute("SELECT 1 FROM threads WHERE id=?", (thread_id,)).fetchone() is None:
                raise NotFoundError(thread_id)
            rows = connection.execute(
                "SELECT * FROM events WHERE thread_id=?" + clause + " ORDER BY sequence " + order + " LIMIT ?",
                parameters).fetchall()
            return tuple(self._event(row) for row in rows)

    def export_json(self) -> str:
        """Explicit full, consistent, readable export; never used for routine context.

        Returns private data to the caller, not a file. No network, content fetching,
        session reopening, deletion/expiry, telemetry or bulk conversation import.
        """
        with self._connection() as connection:
            threads = [self._snapshot(r).to_dict() for r in connection.execute("SELECT * FROM threads ORDER BY latest_sequence")]
            events = [self._event(r).to_dict() for r in connection.execute("SELECT * FROM events ORDER BY sequence")]
            associations = [dict(json.loads(r["binding_json"]), sequence=r["sequence"])
                            for r in connection.execute("SELECT * FROM association_operations ORDER BY sequence")]
            current = [dict(json.loads(r["binding_json"]), sequence=r["sequence"])
                       for r in connection.execute(
                           "SELECT a.* FROM current_associations c JOIN association_operations a ON a.sequence=c.sequence ORDER BY a.sequence")]
            return json.dumps(dict(schema_version=SCHEMA_VERSION, threads=threads, events=events,
                                   associations=associations, current_associations=current),
                              ensure_ascii=False, sort_keys=True, indent=2)
