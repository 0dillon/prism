"""Backoff and the circuit breaker.

Full jitter, not equal jitter, and not a fixed schedule. The map stage of ingestion runs four
workers against one provider; when they all meet the same 429, a deterministic or
narrowly-jittered backoff makes them collide again on the next attempt, and the one after.
Spreading each retry uniformly across its whole window is what actually decorrelates them.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field

from app.core.logging import get_logger

logger = get_logger(__name__)

BASE_DELAY_SECONDS = 1.0
MAX_DELAY_SECONDS = 20.0


def backoff_delay(
    attempt: int,
    *,
    retry_after_seconds: float | None = None,
    base: float = BASE_DELAY_SECONDS,
    cap: float = MAX_DELAY_SECONDS,
) -> float:
    """Seconds to wait before `attempt` (1-based).

    When the provider supplied a retry-after, it is a floor: it knows when it will be ready,
    and returning sooner just spends another request to be told the same thing.
    """
    window = min(cap, base * (2 ** max(0, attempt - 1)))
    jittered = random.uniform(0, window)  # noqa: S311 - jitter, not cryptography
    return max(retry_after_seconds or 0.0, jittered)


@dataclass
class CircuitBreaker:
    """Fails fast once a provider has clearly stopped working.

    Without one, every request queues behind a dead dependency holding a worker for its full
    timeout, and one provider's outage becomes this service's outage. PRD 6.5 requires the
    opposite: a failing dependency degrades its own feature and leaves the rest working.
    """

    failure_threshold: int = 5
    recovery_seconds: float = 30.0
    _consecutive_failures: int = field(default=0, init=False)
    _opened_at: float | None = field(default=None, init=False)

    @property
    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        # Once the recovery window has passed the breaker is half-open: one request is
        # let through to discover whether the provider has come back.
        return (time.monotonic() - self._opened_at) < self.recovery_seconds

    def record_success(self) -> None:
        if self._opened_at is not None:
            logger.info("circuit_closed")
        self._consecutive_failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.failure_threshold and self._opened_at is None:
            self._opened_at = time.monotonic()
            logger.warning(
                "circuit_opened",
                extra={
                    "consecutive_failures": self._consecutive_failures,
                    "recovery_seconds": self.recovery_seconds,
                },
            )
        elif self._opened_at is not None:
            # Failed again while half-open; restart the recovery window.
            self._opened_at = time.monotonic()

    def reset(self) -> None:
        self._consecutive_failures = 0
        self._opened_at = None
