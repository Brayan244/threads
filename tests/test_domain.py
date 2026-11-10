import dataclasses
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


class DomainTests(unittest.TestCase):
    def test_origin_requires_uuid_and_real_source_reference_shape(self):
        from threads.domain import Origin, ValidationError
        for agent, session_id, reference in [("", "11111111-1111-4111-8111-111111111111", "/tmp/s"),
                                              ("pi", "00000000-0000-0000-0000-000000000000", "/tmp/s"),
                                              ("pi", "11111111-1111-4111-8111-111111111111", ""),
                                              ("pi", "11111111-1111-4111-8111-111111111111", "shell:run")]:
            with self.subTest(agent=agent, reference=reference), self.assertRaises(ValidationError):
                Origin(agent, session_id, reference)

    def test_unencodable_semantic_and_origin_text_is_rejected(self):
        from threads.domain import (Evidence, EvidenceKind, ExternalReference, ObjectVersion,
                                    Origin, ReferenceKind, Review, ReviewDisposition, ValidationError)
        from test_store import draft
        factories = [lambda: draft(body="private\ud800"),
                     lambda: draft(title="private\udfff"),
                     lambda: draft(summary="private\ud800"),
                     lambda: draft(operation_key="private\ud800"),
                     lambda: ObjectVersion("private\ud800"),
                     lambda: ObjectVersion("plan", version="private\ud800"),
                     lambda: ObjectVersion("plan", digest="private\ud800"),
                     lambda: Evidence(EvidenceKind.DOCUMENT, "/tmp/private\ud800"),
                     lambda: ExternalReference(ReferenceKind.ISSUE, "private\ud800"),
                     lambda: Review(ObjectVersion("plan"), "private\ud800", ReviewDisposition.APPROVED),
                     lambda: Origin("private\ud800", "11111111-1111-4111-8111-111111111111", "/tmp/pi"),
                     lambda: Origin("pi", "11111111-1111-4111-8111-111111111111", "/tmp/private\ud800")]
        for factory in factories:
            with self.subTest(factory=factory), self.assertRaises(ValidationError):
                factory()
        self.assertEqual(draft(body="Valid Unicode: café, 日本語, 🧵").body, "Valid Unicode: café, 日本語, 🧵")

    def test_malformed_uri_is_a_domain_error(self):
        from threads.domain import Evidence, EvidenceKind, ValidationError
        with self.assertRaises(ValidationError):
            Evidence(EvidenceKind.LINK, "https://[not-an-ipv6-address]/report")

    def test_json_contract_round_trip_and_rejects_untyped_or_extra_fields(self):
        from threads.domain import RecordDraft, ValidationError
        from test_store import draft
        original = draft()
        self.assertEqual(RecordDraft.from_dict(original.to_dict()), original)
        for changed in [dict(original.to_dict(), unexpected=True),
                        dict(original.to_dict(), origin=None),
                        dict(original.to_dict(), evidence=[{"reference": "/tmp/x"}]),
                        dict(original.to_dict(), retained="true")]:
            with self.subTest(changed=changed), self.assertRaises(ValidationError):
                RecordDraft.from_dict(changed)

    def test_typed_bounds_and_explicit_review_kind_enforced(self):
        from threads.domain import (Evidence, EvidenceKind, ExternalReference, ObjectVersion,
                                    ReferenceKind, Review, ReviewDisposition, ValidationError)
        from test_store import draft
        target = ObjectVersion("plan", version="1")
        for changes in [dict(evidence=(Evidence(EvidenceKind.DOCUMENT, "/tmp/p"),) * 33),
                        dict(references=(ExternalReference(ReferenceKind.ISSUE, "ISSUE-1"),) * 2),
                        dict(review=Review(target, "User approved", ReviewDisposition.APPROVED)),
                        dict(title="x" * 241), dict(summary="x" * 4001), dict(operation_key="")]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                draft(**changes)

    def test_review_without_version_remains_unverifiable_after_content_changes(self):
        from threads.domain import (Assurance, Availability, Evidence, EvidenceKind, ObjectVersion,
                                    Review, ReviewDisposition, assess)
        old = ObjectVersion("plan")
        evidence = (Evidence(EvidenceKind.DOCUMENT, "/tmp/p", old, Availability.AVAILABLE),)
        review = Review(old, "Review this plan", ReviewDisposition.APPROVED)
        for current in (old, ObjectVersion("plan", version="future")):
            self.assertEqual(assess(evidence, current, review=review), Assurance.UNVERIFIABLE)

    def test_six_semantic_kinds_and_no_read_approval_kind(self):
        from threads.domain import RecordKind
        self.assertEqual({k.value for k in RecordKind},
                         {"observation", "hypothesis", "decision", "progress", "review_finding", "validation"})

    def test_unsafe_evidence_scheme_rejected_without_opening_anything(self):
        from threads.domain import Evidence, EvidenceKind, ValidationError
        for uri in ["javascript:alert(1)", "command:rm", "data:text/plain,hi", "https://user:secret@example.org/x"]:
            with self.subTest(uri=uri), self.assertRaises(ValidationError):
                Evidence(EvidenceKind.LINK, uri)

    def test_versioned_review_is_current_only_for_exact_object_and_version(self):
        from threads.domain import (Assurance, Availability, Evidence, EvidenceKind, ObjectVersion,
                                    Review, ReviewDisposition, assess)
        target = ObjectVersion("plan", version="commit-1", digest="sha256:abc")
        evidence = Evidence(EvidenceKind.DOCUMENT, "/tmp/plan.md", target, Availability.AVAILABLE)
        review = Review(target, "User requested review of commit-1", ReviewDisposition.APPROVED)
        self.assertEqual(assess((evidence,), target, review=review), Assurance.REVIEWED)
        self.assertEqual(assess((evidence,), ObjectVersion("plan", version="commit-2"), review=review), Assurance.STALE)
        self.assertEqual(assess((evidence,), ObjectVersion("different", version="commit-1"), review=review), Assurance.STALE)
        self.assertEqual(assess((evidence,), ObjectVersion("plan", version="commit-1", digest="sha256:changed"), review=review), Assurance.STALE)

    def test_broken_unknown_and_unversioned_references_never_validate(self):
        from threads.domain import (Assurance, Availability, Evidence, EvidenceKind, ObjectVersion,
                                    Validation, ValidationOutcome, assess)
        for availability, expected in [(Availability.UNAVAILABLE, Assurance.UNAVAILABLE),
                                       (Availability.UNKNOWN, Assurance.UNVERIFIABLE),
                                       (Availability.AVAILABLE, Assurance.VALIDATED)]:
            target = ObjectVersion("report", version="v1")
            evidence = Evidence(EvidenceKind.REPORT, "/tmp/report", target, availability)
            validation = Validation(target, ValidationOutcome.PASSED)
            self.assertEqual(assess((evidence,), target, validation=validation), expected)
        target = ObjectVersion("mutable-plan")
        evidence = Evidence(EvidenceKind.DOCUMENT, "/tmp/plan", target, Availability.AVAILABLE)
        self.assertEqual(assess((evidence,), target, validation=Validation(target, ValidationOutcome.PASSED)), Assurance.UNVERIFIABLE)

    def test_link_alone_failed_validation_and_requested_changes_are_not_approval(self):
        from threads.domain import (Assurance, Availability, Evidence, EvidenceKind, ObjectVersion,
                                    Review, ReviewDisposition, Validation, ValidationOutcome, assess)
        target = ObjectVersion("plan", digest="sha256:one")
        evidence = (Evidence(EvidenceKind.DOCUMENT, "/tmp/p", target, Availability.AVAILABLE),)
        self.assertEqual(assess(evidence, target), Assurance.NONE)
        self.assertEqual(assess(evidence, target, validation=Validation(target, ValidationOutcome.FAILED)), Assurance.NONE)
        self.assertEqual(assess(evidence, target, review=Review(target, "Revise this", ReviewDisposition.CHANGES_REQUESTED)), Assurance.NONE)

    def test_review_requires_human_instruction_and_bounded_semantic_text(self):
        from threads.domain import ObjectVersion, Review, ReviewDisposition, ValidationError
        with self.assertRaises(ValidationError):
            Review(ObjectVersion("p", version="1"), "", ReviewDisposition.APPROVED)
        from test_store import draft
        with self.assertRaises(ValidationError):
            draft(body="x" * 16001)
        with self.assertRaises(ValidationError):
            draft(body="")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            draft().body = "changed"


if __name__ == "__main__":
    unittest.main()
