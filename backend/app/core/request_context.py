"""Per-request correlation state.

Every request carries an id that reaches logs, background jobs, provider calls, errors and
audit records, so a production incident can be traced from the HTTP request through the domain
operation, the database transaction and the provider call that failed.

The id is held in context variables rather than passed through every signature. Context
variables are per-task in asyncio, so concurrent requests cannot observe one another's values,
and a value set in a request cannot leak into an unrelated task.
"""

from __future__ import annotations

import re
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Final

from ulid import ULID

# An externally supplied id is accepted only after sanitization: it ends up in log files and
# trace backends, so unbounded or structured input would let a caller forge log lines.
_SAFE_REQUEST_ID: Final = re.compile(r"\A[A-Za-z0-9_.:-]+\Z")

_request_id: ContextVar[str | None] = ContextVar("prism_request_id", default=None)
_user_id: ContextVar[str | None] = ContextVar("prism_user_id", default=None)
_route: ContextVar[str | None] = ContextVar("prism_route", default=None)


def new_request_id() -> str:
    """A fresh, sortable, collision-resistant request id."""
    return str(ULID())


def sanitize_request_id(raw: str | None, *, max_length: int) -> str | None:
    """Return a caller-supplied request id if it is safe to log, else None.

    Rejects empty values, over-long values, and anything outside a conservative character
    set. Callers treat None as "generate your own".
    """
    if raw is None:
        return None
    candidate = raw.strip()
    if not candidate or len(candidate) > max_length:
        return None
    if not _SAFE_REQUEST_ID.match(candidate):
        return None
    return candidate


def get_request_id() -> str | None:
    return _request_id.get()


def get_user_id() -> str | None:
    return _user_id.get()


def get_route() -> str | None:
    return _route.get()


@dataclass(slots=True)
class _ContextTokens:
    request_id: Token[str | None]
    user_id: Token[str | None]
    route: Token[str | None]


def bind_request_context(
    *,
    request_id: str,
    user_id: str | None = None,
    route: str | None = None,
) -> _ContextTokens:
    """Bind correlation values for the current task. Reset with :func:`reset_request_context`."""
    return _ContextTokens(
        request_id=_request_id.set(request_id),
        user_id=_user_id.set(user_id),
        route=_route.set(route),
    )


def reset_request_context(tokens: _ContextTokens) -> None:
    _request_id.reset(tokens.request_id)
    _user_id.reset(tokens.user_id)
    _route.reset(tokens.route)


def set_user_id(user_id: str | None) -> None:
    """Record the authenticated principal once authentication has resolved it."""
    _user_id.set(user_id)


def current_context() -> dict[str, str]:
    """Correlation fields for logs, provider calls and audit records."""
    fields: dict[str, str] = {}
    if (rid := _request_id.get()) is not None:
        fields["request_id"] = rid
    if (uid := _user_id.get()) is not None:
        fields["user_id"] = uid
    if (route := _route.get()) is not None:
        fields["route"] = route
    return fields
