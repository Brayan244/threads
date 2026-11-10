-- Synthetic fixture created by the previous Python store; no real session data.
-- SQLite dump loading is temporary fixture setup, not the production connection policy.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE association_operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL, session_id TEXT NOT NULL, operation_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        request_json TEXT NOT NULL, binding_json TEXT NOT NULL,
        UNIQUE(agent, session_id, operation_key));
INSERT INTO "association_operations" VALUES(1,'pi','11111111-1111-4111-8111-111111111111','record:legacy-create','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"origin":{"agent":"pi","session_id":"11111111-1111-4111-8111-111111111111","session_ref":"/tmp/threads-fixture/pi.jsonl"},"thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}','{"operation_key":"legacy-create","origin":{"agent":"pi","session_id":"11111111-1111-4111-8111-111111111111","session_ref":"/tmp/threads-fixture/pi.jsonl"},"received_at":"2026-01-01T00:00:00.000000+00:00","source":"record","thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}');
INSERT INTO "association_operations" VALUES(2,'codex','22222222-2222-4222-8222-222222222222','record:legacy-validation','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"origin":{"agent":"codex","session_id":"22222222-2222-4222-8222-222222222222","session_ref":"file:///tmp/threads-fixture/codex#thread=22222222-2222-4222-8222-222222222222"},"thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}','{"operation_key":"legacy-validation","origin":{"agent":"codex","session_id":"22222222-2222-4222-8222-222222222222","session_ref":"file:///tmp/threads-fixture/codex#thread=22222222-2222-4222-8222-222222222222"},"received_at":"2026-01-01T00:00:01.000000+00:00","source":"record","thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}');
CREATE TABLE current_associations (
        agent TEXT NOT NULL, session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL REFERENCES association_operations(sequence),
        PRIMARY KEY(agent, session_id));
INSERT INTO "current_associations" VALUES('pi','11111111-1111-4111-8111-111111111111',1);
INSERT INTO "current_associations" VALUES('codex','22222222-2222-4222-8222-222222222222',2);
CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        agent TEXT NOT NULL, session_id TEXT NOT NULL, operation_key TEXT NOT NULL,
        request_json TEXT NOT NULL, event_json TEXT NOT NULL,
        UNIQUE(agent, session_id, operation_key));
INSERT INTO "events" VALUES(1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','pi','11111111-1111-4111-8111-111111111111','legacy-create','{"body":"Se registró el avance. Café y 🚌.","evidence":[],"kind":"progress","operation_key":"legacy-create","origin":{"agent":"pi","session_id":"11111111-1111-4111-8111-111111111111","session_ref":"/tmp/threads-fixture/pi.jsonl"},"references":[{"kind":"issue","reference":"DEMO-1"}],"retained":null,"review":null,"summary":null,"thread_id":null,"title":"Trabajo legado","validation":null}','{"body":"Se registró el avance. Café y 🚌.","evidence":[],"kind":"progress","operation_key":"legacy-create","origin":{"agent":"pi","session_id":"11111111-1111-4111-8111-111111111111","session_ref":"/tmp/threads-fixture/pi.jsonl"},"received_at":"2026-01-01T00:00:00.000000+00:00","references":[{"kind":"issue","reference":"DEMO-1"}],"retained":null,"review":null,"summary":null,"thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","title":"Trabajo legado","validation":null}');
INSERT INTO "events" VALUES(2,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','codex','22222222-2222-4222-8222-222222222222','legacy-validation','{"body":"Validación de fixture, no sesión real.","evidence":[],"kind":"validation","operation_key":"legacy-validation","origin":{"agent":"codex","session_id":"22222222-2222-4222-8222-222222222222","session_ref":"file:///tmp/threads-fixture/codex#thread=22222222-2222-4222-8222-222222222222"},"references":null,"retained":null,"review":null,"summary":null,"thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","title":null,"validation":{"outcome":"passed","target":{"digest":null,"object_id":"plan","version":"v1"}}}','{"body":"Validación de fixture, no sesión real.","evidence":[],"kind":"validation","operation_key":"legacy-validation","origin":{"agent":"codex","session_id":"22222222-2222-4222-8222-222222222222","session_ref":"file:///tmp/threads-fixture/codex#thread=22222222-2222-4222-8222-222222222222"},"received_at":"2026-01-01T00:00:01.000000+00:00","references":null,"retained":null,"review":null,"summary":null,"thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","title":null,"validation":{"outcome":"passed","target":{"digest":null,"object_id":"plan","version":"v1"}}}');
CREATE TABLE external_references (
        thread_id TEXT NOT NULL REFERENCES threads(id), kind TEXT NOT NULL,
        reference TEXT NOT NULL, PRIMARY KEY(thread_id, kind, reference));
INSERT INTO "external_references" VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','issue','DEMO-1');
CREATE TABLE sessions (
        thread_id TEXT NOT NULL REFERENCES threads(id), agent TEXT NOT NULL,
        session_id TEXT NOT NULL, PRIMARY KEY(thread_id, agent, session_id));
INSERT INTO "sessions" VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','pi','11111111-1111-4111-8111-111111111111');
INSERT INTO "sessions" VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','codex','22222222-2222-4222-8222-222222222222');
CREATE TABLE threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
        retained INTEGER NOT NULL CHECK(retained IN (0,1)), references_json TEXT NOT NULL,
        latest_sequence INTEGER NOT NULL, event_count INTEGER NOT NULL, received_at TEXT NOT NULL);
INSERT INTO "threads" VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Trabajo legado','Validación de fixture, no sesión real.',0,'[{"kind":"issue","reference":"DEMO-1"}]',2,2,'2026-01-01T00:00:01.000000+00:00');
CREATE INDEX event_thread_sequence ON events(thread_id, sequence);
CREATE INDEX thread_latest ON threads(latest_sequence DESC);
CREATE INDEX session_lookup ON sessions(agent, session_id, thread_id);
CREATE INDEX reference_lookup ON external_references(kind, reference, thread_id);
CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE INDEX association_thread ON association_operations(thread_id, sequence);
CREATE TRIGGER immutable_associations_update BEFORE UPDATE ON association_operations
        BEGIN SELECT RAISE(ABORT, 'associations are append-only'); END;
CREATE TRIGGER immutable_associations_delete BEFORE DELETE ON association_operations
        BEGIN SELECT RAISE(ABORT, 'associations are append-only'); END;
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('events',2);
INSERT INTO "sqlite_sequence" VALUES('association_operations',2);
COMMIT;
PRAGMA user_version=2;
PRAGMA foreign_keys=ON;
