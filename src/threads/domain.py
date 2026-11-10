"""Immutable semantic records. Source authenticity must be established by the host.

UUID/reference validation rejects missing attribution, not a fabricated but valid
UUID. Never import prompts, transcripts, secrets or reasoning into record bodies.
Availability is an explicit caller observation; this module does not fetch links.
"""
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import PurePosixPath
from urllib.parse import urlsplit
from uuid import UUID


class ValidationError(ValueError):
    """Invalid semantic input; nothing should be written."""


class ConflictError(Exception):
    """An operation key was already used with different semantic input."""


class NotFoundError(LookupError):
    """An explicitly requested thread does not exist."""


class StorageError(Exception):
    """Unsafe storage path or unsupported schema."""


class StoreBusyError(StorageError):
    """The bounded SQLite lock wait expired; retry the identical operation."""


class RecordKind(StrEnum):
    OBSERVATION = "observation"
    HYPOTHESIS = "hypothesis"
    DECISION = "decision"
    PROGRESS = "progress"
    REVIEW_FINDING = "review_finding"
    VALIDATION = "validation"


class ReferenceKind(StrEnum):
    ISSUE = "issue"
    PR = "pr"
    SESSION = "session"


class EvidenceKind(StrEnum):
    DOCUMENT = "document"
    SCREENSHOT = "screenshot"
    REPORT = "report"
    RESULT = "result"
    LINK = "link"
    OTHER = "other"


class Availability(StrEnum):
    UNKNOWN = "unknown"
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"


class ReviewDisposition(StrEnum):
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"


class ValidationOutcome(StrEnum):
    PASSED = "passed"
    FAILED = "failed"


class Assurance(StrEnum):
    NONE = "none"
    REVIEWED = "reviewed"
    VALIDATED = "validated"
    STALE = "stale"
    UNVERIFIABLE = "unverifiable"
    UNAVAILABLE = "unavailable"


def _text(value, name, maximum=2048):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise ValidationError(f"{name} must be nonblank text of at most {maximum} characters")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        # JSON may decode escaped unpaired surrogates; reject before persistence,
        # including nested references/review/version text, without echoing it.
        raise ValidationError(f"{name} must be valid Unicode text") from exc


def _uuid(value, name):
    try:
        parsed = UUID(value) if isinstance(value, str) else None
    except ValueError:
        parsed = None
    if parsed is None or parsed.int == 0 or str(parsed) != value:
        raise ValidationError(f"{name} must be a canonical, non-nil UUID")


def _reference(value):
    _text(value, "reference")
    if any(ord(c) < 32 for c in value):
        raise ValidationError("reference contains control characters")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValidationError("malformed reference URL") from exc
    if PurePosixPath(value).is_absolute() and not value.startswith("//"):
        return
    if parsed.scheme not in {"https", "http", "file"}:
        raise ValidationError("reference must be an absolute path or an http(s)/file URL")
    if parsed.username or parsed.password:
        raise ValidationError("credentials must not be stored in reference URLs")
    if parsed.scheme in {"https", "http"} and not parsed.hostname:
        raise ValidationError("URL requires a host")
    if parsed.scheme == "file" and (parsed.netloc not in {"", "localhost"} or not parsed.path.startswith("/")):
        raise ValidationError("file reference must be local and absolute")


def _enum(instance, field, enum):
    try:
        object.__setattr__(instance, field, enum(getattr(instance, field)))
    except (ValueError, TypeError) as exc:
        raise ValidationError(f"invalid {field}") from exc


@dataclass(frozen=True)
class Origin:
    agent: str
    session_id: str
    session_ref: str

    def __post_init__(self):
        _text(self.agent, "agent", 80)
        _uuid(self.session_id, "session_id")
        _reference(self.session_ref)


@dataclass(frozen=True)
class ExternalReference:
    kind: ReferenceKind
    reference: str

    def __post_init__(self):
        _enum(self, "kind", ReferenceKind)
        _text(self.reference, "external reference")
        # Opaque issue identifiers are data, never executable commands.
        if ":" in self.reference or self.reference.startswith("/"):
            _reference(self.reference)


@dataclass(frozen=True)
class ObjectVersion:
    object_id: str
    version: str | None = None
    digest: str | None = None

    def __post_init__(self):
        _text(self.object_id, "object_id")
        for name in ("version", "digest"):
            if getattr(self, name) is not None:
                _text(getattr(self, name), name, 256)

    @property
    def pinned(self) -> bool:
        return self.version is not None or self.digest is not None


@dataclass(frozen=True)
class Evidence:
    kind: EvidenceKind
    reference: str
    target: ObjectVersion | None = None
    availability: Availability = Availability.UNKNOWN

    def __post_init__(self):
        _enum(self, "kind", EvidenceKind)
        _enum(self, "availability", Availability)
        _reference(self.reference)
        if self.target is not None and not isinstance(self.target, ObjectVersion):
            raise ValidationError("evidence target must be ObjectVersion")


@dataclass(frozen=True)
class Review:
    target: ObjectVersion
    instruction: str
    disposition: ReviewDisposition

    def __post_init__(self):
        if not isinstance(self.target, ObjectVersion):
            raise ValidationError("review target must be ObjectVersion")
        _text(self.instruction, "human review instruction", 4000)
        _enum(self, "disposition", ReviewDisposition)


@dataclass(frozen=True)
class Validation:
    target: ObjectVersion
    outcome: ValidationOutcome

    def __post_init__(self):
        if not isinstance(self.target, ObjectVersion):
            raise ValidationError("validation target must be ObjectVersion")
        _enum(self, "outcome", ValidationOutcome)


@dataclass(frozen=True)
class RecordDraft:
    """One stable operation. An empty refs tuple explicitly clears active links.

    thread_id=None atomically starts a thread with this first meaningful record.
    Reuse the exact draft on retry, including None on initial creation. A new key
    denotes a new operation. None preserves title/retention/references; summary
    defaults to the bounded latest body. Projection updates are recorded together.
    """
    kind: RecordKind
    body: str
    origin: Origin
    operation_key: str
    thread_id: str | None = None
    title: str | None = None
    summary: str | None = None
    references: tuple[ExternalReference, ...] | None = None
    retained: bool | None = None
    evidence: tuple[Evidence, ...] = ()
    review: Review | None = None
    validation: Validation | None = None

    def __post_init__(self):
        _enum(self, "kind", RecordKind)
        _text(self.body, "body", 16000)
        _text(self.operation_key, "operation_key", 200)
        if not isinstance(self.origin, Origin):
            raise ValidationError("origin must be Origin")
        if self.thread_id is not None:
            _uuid(self.thread_id, "thread_id")
        for name, maximum in (("title", 240), ("summary", 4000)):
            if getattr(self, name) is not None:
                _text(getattr(self, name), name, maximum)
        if self.retained is not None and type(self.retained) is not bool:
            raise ValidationError("retained must be boolean")
        for name, expected in (("evidence", Evidence), ("references", ExternalReference)):
            value = getattr(self, name)
            if value is None and name == "references":
                continue
            if not isinstance(value, (tuple, list)) or len(value) > 32 or any(not isinstance(v, expected) for v in value):
                raise ValidationError(f"{name} must contain at most 32 typed references")
            object.__setattr__(self, name, tuple(value))
        if self.references is not None and len(set(self.references)) != len(self.references):
            raise ValidationError("duplicate external references")
        if self.review is not None and (not isinstance(self.review, Review) or self.kind != RecordKind.REVIEW_FINDING):
            raise ValidationError("explicit review requires review_finding kind")
        if self.validation is not None and (not isinstance(self.validation, Validation) or self.kind != RecordKind.VALIDATION):
            raise ValidationError("validation result requires validation kind")

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict):
        """Decode the JSON-shaped domain contract, rejecting malformed inputs."""
        try:
            values = dict(data)
            values["origin"] = Origin(**values["origin"])
            if values.get("references") is not None:
                values["references"] = tuple(ExternalReference(**r) for r in values["references"])
            evidence = []
            for item in values.get("evidence", ()):
                item = dict(item)
                if item.get("target") is not None:
                    item["target"] = ObjectVersion(**item["target"])
                evidence.append(Evidence(**item))
            values["evidence"] = tuple(evidence)
            for name, model in (("review", Review), ("validation", Validation)):
                if values.get(name) is not None:
                    item = dict(values[name])
                    item["target"] = ObjectVersion(**item["target"])
                    values[name] = model(**item)
            return cls(**values)
        except (TypeError, KeyError, ValueError) as exc:
            raise ValidationError(f"invalid record: {exc}") from exc


@dataclass(frozen=True, kw_only=True)
class Event(RecordDraft):
    """Durable record with global monotonic sequence and store-assigned UTC time."""
    sequence: int
    received_at: str


@dataclass(frozen=True)
class ThreadSnapshot:
    id: str
    title: str
    summary: str
    retained: bool
    references: tuple[ExternalReference, ...]
    latest_sequence: int
    event_count: int
    received_at: str

    def to_dict(self) -> dict:
        return asdict(self)


def _matches(recorded: ObjectVersion, current: ObjectVersion) -> bool:
    return (recorded.object_id == current.object_id and recorded.pinned and
            all(getattr(current, field) == getattr(recorded, field)
                for field in ("version", "digest") if getattr(recorded, field) is not None))


def assess(evidence: tuple[Evidence, ...], current: ObjectVersion, *,
           review: Review | None = None, validation: Validation | None = None) -> Assurance:
    """Conservative, pure assessment; viewing a reference never changes approval.

    CURRENT requires an explicit successful result, matching pinned object and an
    available matching evidence reference. Callers must establish current version
    and availability; this function does not claim to verify external content.
    """
    action = review if review is not None else validation
    if action is None or (review is not None and review.disposition != ReviewDisposition.APPROVED) or (
            validation is not None and validation.outcome != ValidationOutcome.PASSED):
        return Assurance.NONE
    if not action.target.pinned or not current.pinned:
        return Assurance.UNVERIFIABLE
    if not _matches(action.target, current):
        return Assurance.STALE
    matching = [e for e in evidence if e.target is not None and _matches(e.target, current)]
    if any(e.availability == Availability.AVAILABLE for e in matching):
        return Assurance.REVIEWED if review is not None else Assurance.VALIDATED
    if any(e.availability == Availability.UNAVAILABLE for e in matching):
        return Assurance.UNAVAILABLE
    return Assurance.UNVERIFIABLE
