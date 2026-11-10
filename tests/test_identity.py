"""Runtime identity fixtures are not proof of real host compatibility."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
PI = "11111111-1111-4111-8111-111111111111"
CODEX = "22222222-2222-4222-8222-222222222222"


class IdentityTests(unittest.TestCase):
    def test_pi_context_and_codex_shell_context_are_fresh_and_distinct(self):
        from threads.identity import resolve_origin
        pi = resolve_origin({}, pi_session_id=PI, pi_session_ref="/tmp/current-pi.jsonl")
        codex = resolve_origin({"CODEX_THREAD_ID": CODEX, "CODEX_HOME": "/tmp/codex home"})
        self.assertEqual((pi.agent, pi.session_id, pi.session_ref), ("pi", PI, "/tmp/current-pi.jsonl"))
        self.assertEqual((codex.agent, codex.session_id), ("codex", CODEX))
        self.assertEqual(codex.session_ref, "file:///tmp/codex%20home#thread=" + CODEX)
        self.assertEqual(resolve_origin({"CODEX_THREAD_ID": PI}).session_id, PI)
        self.assertEqual(resolve_origin({"CODEX_THREAD_ID": CODEX}).session_id, CODEX)
        self.assertEqual(resolve_origin({}, pi_session_id=CODEX, pi_session_ref="/tmp/resumed.jsonl").session_id, CODEX)
        env = {"CODEX_THREAD_ID": PI}
        self.assertEqual(resolve_origin(env).session_id, PI)
        env["CODEX_THREAD_ID"] = CODEX
        self.assertEqual(resolve_origin(env).session_id, CODEX)

    def test_unencodable_runtime_reference_is_an_identity_error(self):
        from threads.identity import IdentityError, resolve_origin
        for env, kwargs in [({}, dict(pi_session_id=PI, pi_session_ref="/tmp/private\ud800")),
                            ({"CODEX_THREAD_ID": CODEX, "CODEX_HOME": "/tmp/private\ud800"}, {})]:
            with self.subTest(env=repr(env), kwargs=repr(kwargs)), self.assertRaises(IdentityError):
                resolve_origin(env, **kwargs)

    def test_missing_invalid_and_ambiguous_runtime_fail_closed(self):
        from threads.identity import IdentityError, resolve_origin
        for env, kwargs in [({}, {}), ({"CODEX_THREAD_ID": ""}, {}),
                            ({"CODEX_THREAD_ID": "not-uuid"}, {}),
                            ({"CODEX_THREAD_ID": CODEX, "CODEX_HOME": "relative"}, {}),
                            ({"CODEX_THREAD_ID": CODEX, "CODEX_HOME": "/tmp/invalid\u0000home"}, {}),
                            ({"CODEX_THREAD_ID": CODEX}, dict(pi_session_id=PI, pi_session_ref="/tmp/pi")),
                            ({}, dict(pi_session_id=PI)),
                            ({}, dict(pi_session_id=PI, pi_session_ref="https://example.org/not-a-session"))]:
            with self.subTest(env=env, kwargs=kwargs), self.assertRaises(IdentityError):
                resolve_origin(env, **kwargs)


if __name__ == "__main__":
    unittest.main()
