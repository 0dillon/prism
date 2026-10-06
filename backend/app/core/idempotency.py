"""Idempotency for expensive, non-event operations (brief section 16).

Network delivery is at-least-once, clients retry, and users double-click. An operation that
costs money or changes state must therefore be safe to receive twice.

Three mechanisms are in use across the backend, and this module is only the third:

1. **A natural key**, where the data has one. Learning Events carry a client-generated ULID
   and insert with conflict-ignore, so a replayed batch creates nothing. That is the cheapest
   and most reliable form, and it is used wherever the data allows it.
2. **A database constraint**, where concurrency is the real risk. One live ingestion job per
   lesson is a partial unique index, so a double-clicked Ingest is refused by Postgres rather
   than by a check that races.
3. **An idempotency key**, here, for operations with no natural key: the caller supplies one,
   the first request does the work and stores its response, and a retry replays that response
   instead of doing the work again.

The request hash matters. Without it, a client reusing a key for a different request would be
handed the previous request's answer, which is worse than doing the work twice.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Final, Protocol

import orjson

from app.core.logging import get_logger

logger = get_logger(__name__)

IDEMPOTENCY_HEADER: Final = "Idempotency-Key"

# Keys are stored and logged, so they are validated like any other external input.
_VALID_KEY: Final = re.compile(r"\A[A-Za-z0-9_.:-]{8,128}\Z")


class InvalidIdempotencyKeyError(ValueError):
    pass


def validate_key(raw: str | None) -> str | None:
    """Return a usable key, or None when the caller supplied none."""
    if raw is None:
        return None
    candidate = raw.strip()
    if not candidate:
        return None
    if not _VALID_KEY.match(candidate):
        raise InvalidIdempotencyKeyError(
            "An idempotency key must be 8 to 128 characters of letters, digits, "
            "'-', '_', '.' or ':'."
        )
    return candidate


def request_fingerprint(payload: Any) -> str:
    """A stable hash of the request body.

    Key order is normalised so two semantically identical bodies hash alike, and a caller
    reusing a key for a genuinely different request is detected rather than served the wrong
    stored response.
    """
    canonical = orjson.dumps(payload, option=orjson.OPT_SORT_KEYS)
    return hashlib.sha256(canonical).hexdigest()


@dataclass(frozen=True, slots=True)
class StoredResponse:
    status_code: int
    body: dict[str, Any]


@dataclass(frozen=True, slots=True)
class IdempotencyOutcome:
    """What the caller should do.

    `replay` carries a completed response. `conflict` means the key is in use for a different
    request, or an earlier attempt is still running - either way the caller must not proceed.
    """

    proceed: bool
    replay: StoredResponse | None = None
    conflict: bool = False
    reason: str | None = None


class IdempotencyStore(Protocol):
    async def begin(
        self, *, user_id: str, endpoint: str, key: str, fingerprint: str
    ) -> IdempotencyOutcome: ...

    async def complete(
        self, *, user_id: str, endpoint: str, key: str, response: StoredResponse
    ) -> None: ...

    async def abandon(self, *, user_id: str, endpoint: str, key: str) -> None: ...


class InMemoryIdempotencyStore:
    """For tests and single-process development."""

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str, str], tuple[str, StoredResponse | None]] = {}

    async def begin(
        self, *, user_id: str, endpoint: str, key: str, fingerprint: str
    ) -> IdempotencyOutcome:
        entry_key = (user_id, endpoint, key)
        existing = self._entries.get(entry_key)

        if existing is None:
            self._entries[entry_key] = (fingerprint, None)
            return IdempotencyOutcome(proceed=True)

        stored_fingerprint, response = existing
        if stored_fingerprint != fingerprint:
            return IdempotencyOutcome(
                proceed=False,
                conflict=True,
                reason="This idempotency key was already used for a different request.",
            )
        if response is None:
            return IdempotencyOutcome(
                proceed=False,
                conflict=True,
                reason="An identical request is still in progress.",
            )
        return IdempotencyOutcome(proceed=False, replay=response)

    async def complete(
        self, *, user_id: str, endpoint: str, key: str, response: StoredResponse
    ) -> None:
        entry_key = (user_id, endpoint, key)
        fingerprint = self._entries.get(entry_key, ("", None))[0]
        self._entries[entry_key] = (fingerprint, response)

    async def abandon(self, *, user_id: str, endpoint: str, key: str) -> None:
        """Release a reservation whose work failed, so a retry can genuinely retry.

        Without this, one transient failure would lock that key out permanently and the
        client's retry - the entire point of supplying a key - would be refused.
        """
        self._entries.pop((user_id, endpoint, key), None)

    def reset(self) -> None:
        self._entries.clear()
