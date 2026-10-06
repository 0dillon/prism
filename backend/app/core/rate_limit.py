"""Rate limiting (PRD 6.2, task P8-05, brief section 15).

Backed by Postgres rather than Redis. The limit has to hold across every FastAPI replica -
brief section 63 is explicit that process memory is never a correctness mechanism - and
Postgres is already a hard dependency while Redis would be a new one introduced for this
single purpose. Brief section 5: every infrastructure dependency needs a clear responsibility.

The whole mechanism is one atomic upsert. Concurrent requests serialise on the counter row and
each re-reads the committed value, so they cannot all observe the same under-limit count and
all proceed. Read-modify-write in application code is precisely the bug this avoids.

Fixed windows rather than sliding. A fixed window allows a burst of up to twice the limit
across a boundary, which for "how many tutor questions per minute" is an acceptable trade for
one indexed statement per check; a sliding window costs either a sorted set per user or a
per-request scan.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Final, Protocol

from app.core.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class RateLimit:
    """A quota: `limit` requests per `window_seconds`."""

    limit: int
    window_seconds: int

    def window_start(self, now: float) -> int:
        return int(now // self.window_seconds) * self.window_seconds


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    allowed: bool
    limit: int
    remaining: int
    retry_after_seconds: int


# PRD 6.2 requires per-user limits on all LLM-backed endpoints; brief section 15 lists the
# endpoints. Tuned so ordinary use never notices and abuse is bounded.
DEFAULT_LIMITS: Final[dict[str, RateLimit]] = {
    # Expensive and model-backed.
    "profile.parse": RateLimit(limit=20, window_seconds=300),
    "session.intent": RateLimit(limit=120, window_seconds=60),
    "tutor.turn": RateLimit(limit=60, window_seconds=60),
    "tutor.grade": RateLimit(limit=60, window_seconds=60),
    "variants": RateLimit(limit=120, window_seconds=60),
    "speech.stt": RateLimit(limit=120, window_seconds=60),
    "speech.tts": RateLimit(limit=240, window_seconds=60),
    # Ingestion is the single most expensive operation in the product.
    "lessons.ingest": RateLimit(limit=10, window_seconds=3600),
    # High volume by design: clients batch every five seconds and flush on page hide, so this
    # is set to catch a runaway loop rather than to shape ordinary use.
    "events": RateLimit(limit=600, window_seconds=60),
    "checkout": RateLimit(limit=20, window_seconds=3600),
    # Anonymous callers share an IP-keyed bucket and get far less headroom.
    "profile.parse.anonymous": RateLimit(limit=5, window_seconds=300),
}


class ExecuteReturningInt(Protocol):
    async def __call__(self, sql: str, *args: object) -> int: ...


class RateLimiter(Protocol):
    async def check(self, bucket: str, limit: RateLimit) -> RateLimitDecision: ...


def bucket_for(
    operation: str, *, user_id: str | None = None, ip: str | None = None
) -> str:
    """A counter key.

    Per user where there is one, per IP otherwise. Anonymous endpoints must be keyed by
    something, or one caller exhausts the quota for everyone.
    """
    if user_id:
        return f"{operation}:u:{user_id}"
    return f"{operation}:ip:{ip or 'unknown'}"


class InMemoryRateLimiter:
    """For tests and single-process development.

    Correct only within one process, which is exactly why it is not the production default.
    """

    def __init__(self) -> None:
        self._counters: dict[tuple[str, int], int] = {}

    async def check(self, bucket: str, limit: RateLimit) -> RateLimitDecision:
        now = time.time()
        window = limit.window_start(now)
        key = (bucket, window)
        used = self._counters.get(key, 0) + 1
        self._counters[key] = used

        retry_after = max(1, int(window + limit.window_seconds - now))
        if used > limit.limit:
            return RateLimitDecision(
                allowed=False, limit=limit.limit, remaining=0, retry_after_seconds=retry_after
            )
        return RateLimitDecision(
            allowed=True,
            limit=limit.limit,
            remaining=max(0, limit.limit - used),
            retry_after_seconds=retry_after,
        )

    def reset(self) -> None:
        self._counters.clear()


class NullRateLimiter:
    """Allows everything. Only for environments that have explicitly disabled limiting."""

    async def check(self, bucket: str, limit: RateLimit) -> RateLimitDecision:
        return RateLimitDecision(
            allowed=True,
            limit=limit.limit,
            remaining=limit.limit,
            retry_after_seconds=0,
        )


# The counter row is incremented and read in one statement, so concurrent callers serialise
# on it rather than racing. `hits` comes back post-increment, which is what makes the
# comparison below a decision rather than a guess.
_INCREMENT_SQL: Final = """
insert into public.rate_limit_counters (bucket, window_start, hits)
values ($1, to_timestamp($2), 1)
on conflict (bucket, window_start) do update
  set hits = public.rate_limit_counters.hits + 1
returning hits
"""


class PostgresRateLimiter:
    """The production limiter. Shared across replicas because the state is in the database."""

    def __init__(self, execute_returning_int: ExecuteReturningInt) -> None:
        self._execute = execute_returning_int

    async def check(self, bucket: str, limit: RateLimit) -> RateLimitDecision:
        now = time.time()
        window = limit.window_start(now)
        retry_after = max(1, int(window + limit.window_seconds - now))

        try:
            used = await self._execute(_INCREMENT_SQL, bucket, float(window))
        except Exception as exc:
            # Fail open, loudly. A limiter outage must not take down the product it protects,
            # but it must never pass silently either: unlimited spend is the failure mode.
            logger.error("rate_limiter_unavailable", extra={"detail": str(exc)})
            return RateLimitDecision(
                allowed=True, limit=limit.limit, remaining=0, retry_after_seconds=0
            )

        if used > limit.limit:
            return RateLimitDecision(
                allowed=False, limit=limit.limit, remaining=0, retry_after_seconds=retry_after
            )
        return RateLimitDecision(
            allowed=True,
            limit=limit.limit,
            remaining=max(0, limit.limit - used),
            retry_after_seconds=retry_after,
        )

