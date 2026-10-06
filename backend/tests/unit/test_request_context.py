"""Request ids reach log files, so an externally supplied one is untrusted input."""

from __future__ import annotations

import asyncio

import pytest

from app.core.request_context import (
    bind_request_context,
    current_context,
    get_request_id,
    new_request_id,
    reset_request_context,
    sanitize_request_id,
)


class TestSanitization:
    @pytest.mark.parametrize(
        "value",
        [
            "01HZX3QK9J2W8V5N6M7P8Q9R0S",
            "trace-abc.123",
            "req:42",
            "a-b_c.d:e",
        ],
    )
    def test_safe_values_are_accepted(self, value: str) -> None:
        assert sanitize_request_id(value, max_length=128) == value

    @pytest.mark.parametrize(
        ("value", "reason"),
        [
            (None, "absent"),
            ("", "empty"),
            ("   ", "whitespace only"),
            ("a" * 129, "over the length limit"),
            ("line\ninjected", "newline would forge a log line"),
            ('{"json":"payload"}', "structured input"),
            ("<script>alert(1)</script>", "markup"),
            ("drop table;--", "sql-ish punctuation"),
            ("emoji-\U0001f600", "non-ascii"),
        ],
    )
    def test_unsafe_values_are_rejected(self, value: str | None, reason: str) -> None:
        assert sanitize_request_id(value, max_length=128) is None, reason

    def test_generated_ids_are_unique_and_safe(self) -> None:
        ids = {new_request_id() for _ in range(200)}
        assert len(ids) == 200
        assert all(sanitize_request_id(i, max_length=128) == i for i in ids)

    def test_generated_ids_sort_in_creation_order(self) -> None:
        """ULIDs are lexicographically sortable, which makes log scans chronological."""
        issued = [new_request_id() for _ in range(50)]
        assert issued == sorted(issued)


class TestBinding:
    def test_context_is_bound_and_reset(self) -> None:
        assert get_request_id() is None
        tokens = bind_request_context(request_id="req-1", user_id="user-1", route="/api/events")
        assert current_context() == {
            "request_id": "req-1",
            "user_id": "user-1",
            "route": "/api/events",
        }
        reset_request_context(tokens)
        assert get_request_id() is None

    async def test_concurrent_tasks_do_not_observe_each_others_ids(self) -> None:
        """Context variables are per-task, so one request cannot read another's correlation."""
        observed: list[str | None] = []

        async def handler(request_id: str, delay: float) -> None:
            tokens = bind_request_context(request_id=request_id)
            await asyncio.sleep(delay)
            observed.append(get_request_id())
            reset_request_context(tokens)

        await asyncio.gather(handler("req-a", 0.02), handler("req-b", 0.01))
        assert sorted(observed) == ["req-a", "req-b"]
