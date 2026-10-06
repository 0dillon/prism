"""Content variants: get-or-create, safe against concurrent misses (PRD 5.5, task P2-17).

A variant is a concept's text rewritten at a different reading level, cached permanently per
`(concept_id, graph_version, reading_level)` (PRD 6.2).

**The problem.** Thirty students open the same lesson at the same time, all with
`readingLevel: plain`, and the cache is cold. The obvious implementation - look, miss,
generate, insert with conflict-ignore - does not prevent thirty model calls. It prevents
thirty *rows*. Twenty-nine of those calls are paid for and then discarded.

**The fix is claim-then-fill.** A `pending` placeholder row is inserted *before* generating.
The insert is conditional, so exactly one caller wins; the losers wait for the winner's result.
The condition also allows taking over a stale `pending` row, which is what recovers from a
worker that died mid-generation - without it, one crash would poison that key forever.

**Why not a lock.** A Postgres advisory lock held across the model call pins a connection for
seconds at a time; thirty concurrent learners would pin thirty. A Redis lock means introducing
Redis, plus fencing tokens and clock-skew handling, for a cache fill.

**The losers never fall back to generating.** That would reintroduce the duplicate call under
exactly the condition that makes it most expensive: a slow provider. They wait, and on timeout
the caller serves the original text instead. PRD 6.5 requires a published lesson to stay
usable at the `original` reading level when the LLM is unavailable, so that fallback is a
product requirement rather than a consolation.
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID, uuid4

from app.ai.errors import BudgetExceededError, LlmError
from app.ai.gateway import LlmGateway
from app.ai.prompts.session import VARIANT_SYSTEM, build_variant_user_turn
from app.ai.schemas import VariantOut
from app.ai.types import Prompt, UsageContext
from app.core.logging import get_logger
from app.schemas.knowledge_graph import Concept, ReadingLevel

logger = get_logger(__name__)

# How long a caller waits for whoever is generating. Comfortably more than a fast-tier call,
# and short enough that a learner is not left looking at a spinner.
WAIT_BUDGET_SECONDS = 6.0
FIRST_POLL_SECONDS = 0.15
MAX_POLL_SECONDS = 0.8

# A `pending` row older than this is assumed abandoned and may be taken over. Roughly three
# times the p99 of a fast-tier call.
STALE_CLAIM_SECONDS = 90

VariantStatus = Literal["pending", "ready", "failed"]


@dataclass(frozen=True, slots=True)
class VariantKey:
    concept_id: str
    graph_version: int
    reading_level: ReadingLevel


@dataclass(frozen=True, slots=True)
class Variant:
    summary: str
    body: str
    status: VariantStatus = "ready"


class VariantNotReadyError(Exception):
    """Someone else is generating and did not finish within the wait budget.

    Not an error condition for the learner: the caller serves the original text and the client
    asks again shortly.
    """


class VariantStore(Protocol):
    """Persistence for the variant cache. A Protocol so this logic needs no database to test."""

    async def get(self, key: VariantKey) -> tuple[Variant, UUID | None] | None:
        """The stored variant and the id of whoever claimed it, or None if absent."""

    async def claim(self, key: VariantKey, claimant: UUID, *, stale_after: int) -> bool:
        """Insert or take over a `pending` row. True only for the caller that won."""

    async def fill(self, key: VariantKey, claimant: UUID, variant: Variant) -> None:
        """Store a generated variant and mark it ready."""

    async def fail(self, key: VariantKey, claimant: UUID) -> None:
        """Mark a claim failed so the next reader may take it over."""

    async def release(self, key: VariantKey, claimant: UUID) -> None:
        """Remove a claim without marking failure, so a later attempt starts clean."""


class InMemoryVariantStore:
    """A faithful in-process model of the claim-then-fill semantics, for tests."""

    def __init__(self) -> None:
        self._rows: dict[tuple[str, int, str], tuple[Variant, UUID | None, float]] = {}

    def _key(self, key: VariantKey) -> tuple[str, int, str]:
        return (key.concept_id, key.graph_version, key.reading_level)

    async def get(self, key: VariantKey) -> tuple[Variant, UUID | None] | None:
        row = self._rows.get(self._key(key))
        return (row[0], row[1]) if row else None

    async def claim(self, key: VariantKey, claimant: UUID, *, stale_after: int) -> bool:
        now = time.monotonic()
        row = self._rows.get(self._key(key))
        if row is not None:
            variant, _, claimed_at = row
            takeable = variant.status == "failed" or (
                variant.status == "pending" and (now - claimed_at) > stale_after
            )
            if not takeable:
                return False
        self._rows[self._key(key)] = (Variant(summary="", body="", status="pending"), claimant, now)
        return True

    async def fill(self, key: VariantKey, claimant: UUID, variant: Variant) -> None:
        self._rows[self._key(key)] = (variant, claimant, time.monotonic())

    async def fail(self, key: VariantKey, claimant: UUID) -> None:
        row = self._rows.get(self._key(key))
        if row is not None:
            self._rows[self._key(key)] = (
                Variant(summary="", body="", status="failed"),
                claimant,
                time.monotonic(),
            )

    async def release(self, key: VariantKey, claimant: UUID) -> None:
        self._rows.pop(self._key(key), None)


class VariantService:
    def __init__(self, *, gateway: LlmGateway, store: VariantStore) -> None:
        self._gateway = gateway
        self._store = store
        # Collapses the stampede within one process before it reaches the database at all:
        # thirty concurrent requests on one worker become one claim, not one claim and
        # twenty-nine polls.
        self._in_flight: dict[tuple[str, int, str], asyncio.Future[Variant]] = {}

    async def get_or_create(
        self,
        *,
        concept: Concept,
        graph_version: int,
        reading_level: ReadingLevel,
        context: UsageContext | None = None,
    ) -> Variant:
        """Return the cached variant, generating it once if nobody has yet.

        Raises `VariantNotReadyError` when someone else is generating and did not finish in
        time. The caller serves the original text and lets the client retry.
        """
        if reading_level == "original":
            return Variant(summary=concept.summary, body=concept.body)

        key = VariantKey(concept.id, graph_version, reading_level)
        cache_key = (key.concept_id, key.graph_version, key.reading_level)

        existing = await self._store.get(key)
        if existing is not None and existing[0].status == "ready":
            return existing[0]

        if (pending := self._in_flight.get(cache_key)) is not None:
            return await pending

        future: asyncio.Future[Variant] = asyncio.get_running_loop().create_future()
        self._in_flight[cache_key] = future
        try:
            variant = await self._generate_or_wait(
                key=key, concept=concept, reading_level=reading_level, context=context
            )
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
            raise
        else:
            if not future.done():
                future.set_result(variant)
            return variant
        finally:
            self._in_flight.pop(cache_key, None)
            # Nobody is left to observe the future, but an unretrieved exception on it would
            # otherwise be reported at garbage-collection time as an unhandled error.
            if future.done() and not future.cancelled():
                future.exception()

    async def _generate_or_wait(
        self,
        *,
        key: VariantKey,
        concept: Concept,
        reading_level: ReadingLevel,
        context: UsageContext | None,
    ) -> Variant:
        claimant = uuid4()
        won = await self._store.claim(key, claimant, stale_after=STALE_CLAIM_SECONDS)

        if not won:
            return await self._wait_for_winner(key)

        try:
            variant = await self._generate(
                concept=concept, reading_level=reading_level, context=context
            )
        except BudgetExceededError:
            # Not a failure of this key, so do not poison it: a later request, under a reset
            # budget, should be able to generate normally.
            await self._store.release(key, claimant)
            raise
        except LlmError:
            await self._store.fail(key, claimant)
            raise

        await self._store.fill(key, claimant, variant)
        return variant

    async def _wait_for_winner(self, key: VariantKey) -> Variant:
        """Poll for the winner's result.

        Polling rather than LISTEN/NOTIFY: that would need a session-mode connection, which is
        not available under a transaction pooler, and maintaining a second pool to be notified
        about cache fills is disproportionate. A 150 ms first poll is well inside the budget.
        """
        deadline = time.monotonic() + WAIT_BUDGET_SECONDS
        delay = FIRST_POLL_SECONDS

        while time.monotonic() < deadline:
            await asyncio.sleep(delay + random.uniform(0, delay * 0.3))  # noqa: S311
            row = await self._store.get(key)
            if row is None or row[0].status == "failed":
                break
            if row[0].status == "ready":
                return row[0]
            delay = min(delay * 1.6, MAX_POLL_SECONDS)

        # Deliberately not falling back to generating here. That would reintroduce the
        # duplicate call under exactly the condition where it costs most: a slow provider.
        raise VariantNotReadyError(key.concept_id)

    async def _generate(
        self,
        *,
        concept: Concept,
        reading_level: ReadingLevel,
        context: UsageContext | None,
    ) -> Variant:
        prompt = Prompt(
            system=VARIANT_SYSTEM,
            user=build_variant_user_turn(
                title=concept.title,
                summary=concept.summary,
                body=concept.body,
                reading_level=reading_level,
            ),
        )
        result = await self._gateway.generate_structured(
            schema=VariantOut,
            prompt=prompt,
            tier="fast",
            operation="variant.generate",
            context=context or UsageContext(operation="variant.generate"),
            max_output_tokens=2000,
        )
        generated: VariantOut = result.value
        return Variant(
            summary=generated.summary.strip()[:240],
            body=generated.body.strip(),
            status="ready",
        )
