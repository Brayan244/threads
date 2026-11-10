"""Resolve origin for THIS call, outside model-controlled semantic JSON.

Pi's bridge must pass fresh SessionManager values as argv on each invocation.
Codex must invoke the CLI from its current shell tool, never a long-lived MCP
server's startup environment. Shape validation is not authentication against
other processes of the same user, and fixtures do not establish host provenance.
"""
import os
from pathlib import Path
from collections.abc import Mapping

from .domain import Origin, ValidationError


class IdentityError(ValidationError):
    """A current, unambiguous runtime origin could not be established."""


def resolve_origin(environ: Mapping[str, str] | None = None, *,
                   pi_session_id: str | None = None,
                   pi_session_ref: str | None = None) -> Origin:
    """No cached runtime state, synthetic IDs, transcript search or stdin origin.

    Codex session_ref is an internal runtime-directory + UUID locator, NOT a
    transcript filename or supported deep link. Its availability stays unknown;
    directory existence proves neither conversation existence nor reopenability.
    """
    env = os.environ if environ is None else environ
    pi = pi_session_id is not None or pi_session_ref is not None
    try:
        if pi:
            if "CODEX_THREAD_ID" in env or not pi_session_id or not pi_session_ref:
                raise IdentityError("missing or ambiguous current runtime context")
            if not Path(pi_session_ref).is_absolute():
                raise IdentityError("Pi requires a current absolute session file reference")
            return Origin("pi", pi_session_id, pi_session_ref)
        session_id = env.get("CODEX_THREAD_ID")
        if not session_id:
            raise IdentityError("current shell CODEX_THREAD_ID or fresh Pi context required")
        home = Path(env["CODEX_HOME"]) if "CODEX_HOME" in env else Path.home() / ".codex"
        if not home.is_absolute() or any(ord(char) < 32 for char in str(home)):
            raise IdentityError("CODEX_HOME must be an absolute path without control characters")
        # Origin validates the UUID before it becomes part of a URI.
        origin = Origin("codex", session_id, home.as_uri())
        return Origin(origin.agent, origin.session_id, home.as_uri() + "#thread=" + origin.session_id)
    except (ValidationError, ValueError, TypeError) as exc:
        if isinstance(exc, IdentityError):
            raise
        raise IdentityError("invalid current runtime identity or reference") from exc
