"""Bounded JSON/argv contract v1 for the Pi bridge, current Codex shell and Herdr.

Invocation: bin/threads [--data-dir ABS] [--busy-timeout-ms 1..60000]
  [--pi-session-id UUID --pi-session-ref ABS_FILE] COMMAND [OPTIONS]
Only Pi's trusted bridge supplies the Pi argv pair, freshly per call. Codex uses
this shell's CODEX_THREAD_ID and CODEX_HOME, not stdin or an MCP startup snapshot.

Every response is one JSON object on stdout; stderr is empty. Exit 0: success,
2: invalid input/identity, 3: conflict, 4: not found, 5: busy, 6: storage failure.
Envelope: {contract_version:1, ok:true, result:{...}} or
{contract_version:1, ok:false, error:{code,message,retryable}}. Errors redact all
payloads, paths and exception details; only busy errors are retryable.

record: stdin object = RecordDraft fields EXCEPT origin (forbidden, not ignored).
thread_id null/omitted creates atomically with content; an existing ID continues.
No implicit use of current binding: consumers explicitly choose a thread ID.
Returns {event: Event}, including trusted origin and assigned sequence/time.
Typed nested fields match domain.py: evidence [{kind,reference,target?,availability}],
target {object_id,version?,digest?}; review {target,instruction,disposition:
approved|changes_requested}; validation {target,outcome:passed|failed}. These are
claims, not automatic approval; consumers establish versions/availability separately.
associate: stdin {thread_id,operation_key}; returns {association: receipt}.
record and associate keys have separate namespaces, each scoped to agent/session.
A replay receipt is NOT a claim of current binding; old retries never rewind it.
current: no stdin; returns {association: binding|null} for THIS runtime identity.

list [--limit 1..100] [--before-sequence N] [--current-session]
  [--reference-kind issue|pr|session --reference TEXT] [--include-references]
  -> {threads, next_before_sequence}; newest thread.latest_sequence first.
show THREAD_ID [--limit 1..200] [--before-sequence N] [--include-origin]
  [--include-references] -> {thread,events,next_before_sequence}; newest events first.
events THREAD_ID [--limit 1..200] [--after-sequence N] [--include-origin]
  [--include-references] -> {events,next_after_sequence}; oldest events first.
sessions THREAD_ID [--limit 1..200] [--after-sequence N]
  -> {associations,next_after_sequence}; explicit internal attribution control.

Cursors are independent: list uses thread.latest_sequence, show/events use event
sequence, sessions uses association sequence. A full page returns its last cursor;
a shorter/empty page returns null (one final empty page is possible). Thread pages
are live keyset views, not snapshots; changing threads may reorder them.
Thread list/show snapshots also include session_count (distinct attributed
agent/session pairs, not association operations). Session
origins and issue/PR/session references are omitted unless explicitly requested;
evidence/review/validation always remain with their event. No pager, prompt,
transcript import, opening links, network access, unbounded export or auto-thread.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys

from .domain import (ConflictError, ExternalReference, NotFoundError, RecordDraft,
                     StorageError, StoreBusyError, ValidationError)
from .identity import IdentityError, resolve_origin
from .store import Store

CONTRACT_VERSION = 1
MAX_INPUT_BYTES = 65536


class InputError(ValueError):
    pass


class ArgumentsError(ValueError):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default usage/error echoes arbitrary private argv values.
        raise ArgumentsError("invalid arguments")


def _integer(maximum, minimum=0):
    def parse(value):
        try:
            number = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("integer required") from exc
        if not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError("integer outside bounds")
        return number
    return parse


def _parser():
    parser = Parser(add_help=False, allow_abbrev=False)
    parser.add_argument("--help", action="store_true")
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--busy-timeout-ms", type=_integer(60000, 1), default=5000)
    parser.add_argument("--pi-session-id")
    parser.add_argument("--pi-session-ref")
    commands = parser.add_subparsers(dest="command", parser_class=Parser)
    for name in ("record", "associate", "current"):
        commands.add_parser(name, add_help=False, allow_abbrev=False)
    listing = commands.add_parser("list", add_help=False, allow_abbrev=False)
    listing.add_argument("--limit", type=_integer(100, 1), default=50)
    listing.add_argument("--before-sequence", type=_integer(2**63 - 1))
    listing.add_argument("--current-session", action="store_true")
    listing.add_argument("--reference-kind", choices=("issue", "pr", "session"))
    listing.add_argument("--reference")
    listing.add_argument("--include-references", action="store_true")
    for name in ("show", "events", "sessions"):
        command = commands.add_parser(name, add_help=False, allow_abbrev=False)
        command.add_argument("thread_id")
        command.add_argument("--limit", type=_integer(200, 1), default=10 if name == "show" else 50)
        if name == "show":
            command.add_argument("--before-sequence", type=_integer(2**63 - 1))
        else:
            command.add_argument("--after-sequence", type=_integer(2**63 - 1), default=0)
        if name != "sessions":
            command.add_argument("--include-origin", action="store_true")
            command.add_argument("--include-references", action="store_true")
    return parser


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InputError("duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise InputError("non-finite JSON number")


def _input(stream, *, required):
    raw = b"" if stream.isatty() else stream.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise InputError("input too large")
    if not required:
        if raw.strip():
            raise InputError("read commands do not accept payloads")
        return None
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=_invalid_constant)
    except (ValueError, RecursionError) as exc:
        raise InputError("invalid JSON payload") from exc
    if not isinstance(value, dict):
        raise InputError("payload must be an object")
    return value


def _snapshot(thread, include_references, store):
    result = dict(thread.to_dict(), session_count=store.session_count(thread.id))
    if not include_references:
        result.pop("references")
    return result


def _event(event, args):
    result = event.to_dict()
    if not args.include_origin:
        result.pop("origin")
    if not args.include_references:
        result.pop("references")
    return result


def _next(page, limit, field):
    if len(page) != limit:
        return None
    last = page[-1]
    return last[field] if isinstance(last, dict) else getattr(last, field)


def _execute(args, payload, environ):
    def origin():
        return resolve_origin(environ, pi_session_id=args.pi_session_id, pi_session_ref=args.pi_session_ref)

    # Validate semantic input and origin before opening/creating any storage.
    draft = None
    runtime = None
    if args.command == "record":
        if "origin" in payload:
            raise InputError("semantic input must not contain origin")
        runtime = origin()
        draft = RecordDraft.from_dict(dict(payload, origin=runtime.__dict__))
    elif args.command == "associate":
        if set(payload) != {"thread_id", "operation_key"}:
            raise InputError("invalid association payload")
        runtime = origin()
    elif args.command == "current" or (args.command == "list" and args.current_session):
        runtime = origin()
    if args.command == "list" and bool(args.reference_kind) != bool(args.reference):
        raise ArgumentsError("reference kind and value required together")
    store = Store(args.data_dir, busy_timeout_ms=args.busy_timeout_ms)
    if args.command == "record":
        return dict(event=store.append(draft).to_dict())
    if args.command == "associate":
        return dict(association=store.associate(runtime, payload["thread_id"], payload["operation_key"]))
    if args.command == "current":
        return dict(association=store.current_association(runtime))
    if args.command == "list":
        reference = ExternalReference(args.reference_kind, args.reference) if args.reference_kind else None
        page = store.list_threads(limit=args.limit, before_sequence=args.before_sequence,
                                  origin=runtime, reference=reference)
        return dict(threads=[_snapshot(t, args.include_references, store) for t in page],
                    next_before_sequence=_next(page, args.limit, "latest_sequence"))
    if args.command == "sessions":
        page = store.association_history(args.thread_id, limit=args.limit, after_sequence=args.after_sequence)
        return dict(associations=page, next_after_sequence=_next(page, args.limit, "sequence"))
    if args.command == "events":
        page = store.events(args.thread_id, limit=args.limit, after_sequence=args.after_sequence)
        return dict(events=[_event(e, args) for e in page], next_after_sequence=_next(page, args.limit, "sequence"))
    thread = store.get_thread(args.thread_id)
    page = store.recent_events(args.thread_id, limit=args.limit, before_sequence=args.before_sequence)
    return dict(thread=_snapshot(thread, args.include_references, store), events=[_event(e, args) for e in page],
                next_before_sequence=_next(page, args.limit, "sequence"))


def main(argv=None) -> int:
    """One short-lived invocation; environment is read here, never at import time."""
    try:
        args = _parser().parse_args(argv)
        if args.help:
            result = dict(help=__doc__, max_input_bytes=MAX_INPUT_BYTES)
        else:
            if args.command is None:
                raise ArgumentsError("command required")
            payload = _input(sys.stdin.buffer, required=args.command in {"record", "associate"})
            result = _execute(args, payload, os.environ)
        response, status = dict(ok=True, result=result), 0
    except ArgumentsError:
        response, status = _error("invalid_arguments", "Invalid command arguments; run --help.", 2)
    except IdentityError:
        response, status = _error("identity_required", "Fresh, unambiguous Pi context or current shell CODEX_THREAD_ID required.", 2)
    except (InputError, ValidationError, TypeError, RecursionError):
        response, status = _error("invalid_input", "Invalid or oversized input; check contract and field bounds.", 2)
    except ConflictError:
        response, status = _error("conflict", "Operation key was already used with different input.", 3)
    except NotFoundError:
        response, status = _error("not_found", "Requested thread does not exist.", 4)
    except StoreBusyError:
        response, status = _error("busy", "Local history is busy; retry the identical operation.", 5, retryable=True)
    except (StorageError, OSError, sqlite3.Error):
        response, status = _error("storage_error", "Cannot access local history; check private storage permissions, path and schema.", 6)
    print(json.dumps(dict(contract_version=CONTRACT_VERSION, **response), ensure_ascii=True,
                     sort_keys=True, separators=(",", ":")))
    return status


def _error(code, message, status, *, retryable=False):
    return dict(ok=False, error=dict(code=code, message=message, retryable=retryable)), status


if __name__ == "__main__":
    raise SystemExit(main())
