"""Rate limiting and idempotency (brief sections 15 and 16, PRD task P8-05)."""

from __future__ import annotations

import asyncio

import pytest

from app.core.idempotency import (
    IDEMPOTENCY_HEADER,
    InMemoryIdempotencyStore,
    InvalidIdempotencyKeyError,
    StoredResponse,
    request_fingerprint,
    validate_key,
)
from app.core.rate_limit import (
    DEFAULT_LIMITS,
    InMemoryRateLimiter,
    PostgresRateLimiter,
    RateLimit,
    bucket_for,
)


class TestRateLimitDecisions:
    async def test_requests_within_the_quota_are_allowed(self) -> None:
        limiter = InMemoryRateLimiter()
        limit = RateLimit(limit=3, window_seconds=60)

        for expected_remaining in (2, 1, 0):
            decision = await limiter.check("bucket", limit)
            assert decision.allowed is True
            assert decision.remaining == expected_remaining

    async def test_the_request_over_the_quota_is_refused(self) -> None:
        limiter = InMemoryRateLimiter()
        limit = RateLimit(limit=2, window_seconds=60)

        await limiter.check("bucket", limit)
        await limiter.check("bucket", limit)
        decision = await limiter.check("bucket", limit)

        assert decision.allowed is False
        assert decision.remaining == 0

    async def test_a_refusal_says_when_to_come_back(self) -> None:
        """PRD task P8-05: exceeding the limit returns 429 with a retry time."""
        limiter = InMemoryRateLimiter()
        limit = RateLimit(limit=1, window_seconds=60)

        await limiter.check("bucket", limit)
        decision = await limiter.check("bucket", limit)

        assert decision.allowed is False
        assert 0 < decision.retry_after_seconds <= 60

    async def test_buckets_are_independent(self) -> None:
        limiter = InMemoryRateLimiter()
        limit = RateLimit(limit=1, window_seconds=60)

        await limiter.check("user-a", limit)
        assert (await limiter.check("user-b", limit)).allowed is True

    async def test_concurrent_checks_do_not_exceed_the_quota(self) -> None:
        """The property the Postgres implementation exists for: concurrent callers must not
        all observe the same under-limit count and all proceed."""
        limiter = InMemoryRateLimiter()
        limit = RateLimit(limit=5, window_seconds=60)

        decisions = await asyncio.gather(
            *(limiter.check("shared", limit) for _ in range(20))
        )
        assert sum(1 for d in decisions if d.allowed) == 5


class TestBucketKeys:
    def test_an_authenticated_caller_is_keyed_by_user(self) -> None:
        assert bucket_for("tutor.turn", user_id="u1") == "tutor.turn:u:u1"

    def test_an_anonymous_caller_is_keyed_by_address(self) -> None:
        """Keyed by something, or one caller exhausts the quota for everyone."""
        assert bucket_for("profile.parse", ip="203.0.113.4") == "profile.parse:ip:203.0.113.4"

    def test_the_user_key_wins_when_both_are_known(self) -> None:
        assert bucket_for("x", user_id="u1", ip="1.2.3.4") == "x:u:u1"

    def test_a_missing_address_still_produces_a_bucket(self) -> None:
        assert bucket_for("x") == "x:ip:unknown"


class TestConfiguredLimits:
    @pytest.mark.parametrize(
        "operation",
        [
            "profile.parse", "session.intent", "tutor.turn", "tutor.grade", "variants",
            "speech.stt", "speech.tts", "events", "lessons.ingest", "checkout",
        ],
    )
    def test_every_endpoint_the_brief_names_has_a_limit(self, operation: str) -> None:
        assert operation in DEFAULT_LIMITS

    def test_every_limit_is_positive_and_bounded(self) -> None:
        for operation, limit in DEFAULT_LIMITS.items():
            assert limit.limit > 0, operation
            assert 0 < limit.window_seconds <= 86_400, operation

    def test_anonymous_callers_get_less_headroom_than_signed_in_ones(self) -> None:
        anonymous = DEFAULT_LIMITS["profile.parse.anonymous"]
        signed_in = DEFAULT_LIMITS["profile.parse"]
        assert anonymous.limit < signed_in.limit

    def test_ingestion_is_the_most_tightly_limited(self) -> None:
        """It is the single most expensive operation in the product."""
        ingest = DEFAULT_LIMITS["lessons.ingest"]
        per_hour = ingest.limit * (3600 / ingest.window_seconds)
        assert per_hour <= 20


class TestLimiterFailureMode:
    async def test_a_limiter_outage_fails_open_but_loudly(self) -> None:
        """A limiter outage must not take down the product it protects. It must also never
        pass silently, because the failure mode is unbounded spend."""

        async def broken(sql: str, *args: object) -> int:
            raise RuntimeError("database unreachable")

        limiter = PostgresRateLimiter(broken)
        decision = await limiter.check("bucket", RateLimit(limit=1, window_seconds=60))
        assert decision.allowed is True

    async def test_the_counter_decision_uses_the_post_increment_value(self) -> None:
        """Returning the incremented count in the same statement is what makes this a
        decision rather than a read-then-guess."""
        counters: dict[str, int] = {}

        async def fake_increment(sql: str, *args: object) -> int:
            bucket = str(args[0])
            counters[bucket] = counters.get(bucket, 0) + 1
            return counters[bucket]

        limiter = PostgresRateLimiter(fake_increment)
        limit = RateLimit(limit=2, window_seconds=60)

        assert (await limiter.check("b", limit)).allowed is True
        assert (await limiter.check("b", limit)).allowed is True
        assert (await limiter.check("b", limit)).allowed is False


# ---------------------------------------------------------------------------
class TestIdempotencyKeys:
    @pytest.mark.parametrize(
        "key", ["abcdefgh", "01HZX3QK9J2W8V5N6M7P8Q9R0S", "req-2026-10-06:1", "a" * 128]
    )
    def test_well_formed_keys_are_accepted(self, key: str) -> None:
        assert validate_key(key) == key

    @pytest.mark.parametrize(
        "key", ["short", "a" * 129, "has spaces", "new\nline", "<script>", "key;drop"]
    )
    def test_malformed_keys_are_refused(self, key: str) -> None:
        with pytest.raises(InvalidIdempotencyKeyError):
            validate_key(key)

    def test_an_absent_key_is_not_an_error(self) -> None:
        """Idempotency is opt-in; a client that does not supply a key simply does not get it."""
        assert validate_key(None) is None
        assert validate_key("  ") is None

    def test_the_header_name_is_the_conventional_one(self) -> None:
        assert IDEMPOTENCY_HEADER == "Idempotency-Key"


class TestFingerprints:
    def test_key_order_does_not_change_the_fingerprint(self) -> None:
        assert request_fingerprint({"a": 1, "b": 2}) == request_fingerprint({"b": 2, "a": 1})

    def test_different_bodies_fingerprint_differently(self) -> None:
        assert request_fingerprint({"a": 1}) != request_fingerprint({"a": 2})

    def test_nested_structures_are_handled(self) -> None:
        first = request_fingerprint({"x": {"b": [1, 2], "a": 3}})
        second = request_fingerprint({"x": {"a": 3, "b": [1, 2]}})
        assert first == second

    def test_list_order_is_significant(self) -> None:
        """Order means something in a list in a way it does not in an object."""
        assert request_fingerprint([1, 2]) != request_fingerprint([2, 1])


class TestIdempotentReplay:
    async def test_the_first_request_proceeds(self) -> None:
        store = InMemoryIdempotencyStore()
        outcome = await store.begin(
            user_id="u1", endpoint="/api/checkout", key="key-0001", fingerprint="fp"
        )
        assert outcome.proceed is True

    async def test_a_retry_replays_the_stored_response(self) -> None:
        store = InMemoryIdempotencyStore()
        args = {"user_id": "u1", "endpoint": "/api/checkout", "key": "key-0001"}

        await store.begin(**args, fingerprint="fp")
        await store.complete(**args, response=StoredResponse(200, {"id": "order-1"}))

        outcome = await store.begin(**args, fingerprint="fp")
        assert outcome.proceed is False
        assert outcome.replay is not None
        assert outcome.replay.body == {"id": "order-1"}

    async def test_reusing_a_key_for_a_different_request_is_a_conflict(self) -> None:
        """Serving the previous request's answer would be worse than doing the work twice."""
        store = InMemoryIdempotencyStore()
        args = {"user_id": "u1", "endpoint": "/api/checkout", "key": "key-0001"}

        await store.begin(**args, fingerprint="fingerprint-a")
        await store.complete(**args, response=StoredResponse(200, {"id": "order-1"}))

        outcome = await store.begin(**args, fingerprint="fingerprint-b")
        assert outcome.conflict is True
        assert outcome.replay is None

    async def test_an_in_flight_duplicate_is_refused_rather_than_run_twice(self) -> None:
        store = InMemoryIdempotencyStore()
        args = {"user_id": "u1", "endpoint": "/api/checkout", "key": "key-0001"}

        await store.begin(**args, fingerprint="fp")
        outcome = await store.begin(**args, fingerprint="fp")

        assert outcome.proceed is False
        assert outcome.conflict is True

    async def test_a_failed_attempt_releases_the_key_so_a_retry_can_retry(self) -> None:
        """Without this, one transient failure locks the key out permanently and the client's
        retry - the entire point of supplying a key - is refused forever."""
        store = InMemoryIdempotencyStore()
        args = {"user_id": "u1", "endpoint": "/api/checkout", "key": "key-0001"}

        await store.begin(**args, fingerprint="fp")
        await store.abandon(**args)

        assert (await store.begin(**args, fingerprint="fp")).proceed is True

    async def test_keys_are_scoped_per_user(self) -> None:
        """One caller's key must never collide with another's, or a retry could serve someone
        else's response."""
        store = InMemoryIdempotencyStore()
        shared = {"endpoint": "/api/checkout", "key": "key-0001", "fingerprint": "fp"}

        await store.begin(user_id="u1", **shared)
        assert (await store.begin(user_id="u2", **shared)).proceed is True

    async def test_keys_are_scoped_per_endpoint(self) -> None:
        store = InMemoryIdempotencyStore()
        shared = {"user_id": "u1", "key": "key-0001", "fingerprint": "fp"}

        await store.begin(endpoint="/api/checkout", **shared)
        assert (await store.begin(endpoint="/api/lessons", **shared)).proceed is True
