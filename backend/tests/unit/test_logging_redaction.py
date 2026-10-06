"""Logs must not become a shadow copy of the sensitive data in the database.

Brief section 11 names what may never be logged: passwords, access and refresh tokens, API
keys, service-role keys, payment secrets, raw voice audio, and learner profile contents.
"""

from __future__ import annotations

import json
import logging

import pytest

from app.core.logging import REDACTED, JsonFormatter, RedactionFilter, scrub, scrub_text


def _format(record: logging.LogRecord) -> dict[str, object]:
    RedactionFilter().filter(record)
    rendered = JsonFormatter(service_name="test").format(record)
    parsed: dict[str, object] = json.loads(rendered)
    return parsed


def _record(message: str = "event", **extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname=__file__, lineno=1,
        msg=message, args=(), exc_info=None,
    )
    record.__dict__.update(extra)
    return record


class TestKeyBasedRedaction:
    @pytest.mark.parametrize(
        "key",
        [
            "password",
            "access_token",
            "refresh_token",
            "api_key",
            "service_role_secret",
            "authorization",
            "stripe_webhook_secret",
            "signing_key",
            "cookie",
        ],
    )
    def test_credential_keys_are_redacted(self, key: str) -> None:
        output = _format(_record(**{key: "the-actual-value"}))
        assert output[key] == REDACTED
        assert "the-actual-value" not in json.dumps(output)

    @pytest.mark.parametrize("key", ["profile", "render_profile", "patch", "audio", "utterance"])
    def test_learner_sensitive_keys_are_redacted(self, key: str) -> None:
        """PRD 6.4: profiles may reveal sensitive information; voice audio is never kept."""
        output = _format(_record(**{key: {"preset": "visual_sign"}}))
        assert output[key] == REDACTED

    def test_nested_values_are_redacted(self) -> None:
        output = _format(_record(context={"user": {"id": "u1", "api_key": "leak-me"}}))
        assert "leak-me" not in json.dumps(output)
        assert output["context"] == {"user": {"id": "u1", "api_key": REDACTED}}

    def test_benign_fields_survive_intact(self) -> None:
        output = _format(_record(lesson_id="l_123", status_code=200, latency_ms=12.5))
        assert output["lesson_id"] == "l_123"
        assert output["status_code"] == 200
        assert output["latency_ms"] == 12.5


class TestPatternBasedRedaction:
    @pytest.mark.parametrize(
        "secret",
        [
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r0",
            "sb_secret_abcdefghijklmnop",
            "sb_publishable_abcdefghijklmnop",
            "sk-proj1234567890abcdefghij",
            "whsec_abcdefghijklmnop",
            "Bearer abcdefghijklmnopqrstuvwxyz",
        ],
    )
    def test_credential_shapes_are_scrubbed_from_free_text(self, secret: str) -> None:
        assert secret not in scrub_text(f"upstream rejected the call: {secret} is invalid")

    def test_a_secret_leaking_through_an_innocent_key_is_still_caught(self) -> None:
        """The second line of defence: an unexpected field carrying a credential."""
        output = _format(_record(detail="provider said: sk-proj1234567890abcdefghij"))
        assert "sk-proj1234567890abcdefghij" not in json.dumps(output)

    def test_an_exception_message_is_scrubbed(self) -> None:
        try:
            raise RuntimeError("auth failed for sb_secret_abcdefghijklmnop")
        except RuntimeError as exc:
            record = _record("boom")
            record.exc_info = (type(exc), exc, exc.__traceback__)
        output = _format(record)
        assert "sb_secret_abcdefghijklmnop" not in json.dumps(output)


class TestFormatterShape:
    def test_every_line_carries_the_operational_fields(self) -> None:
        output = _format(_record("request_completed", status_code=200))
        for field in ("timestamp", "level", "service", "logger", "message"):
            assert field in output
        assert output["message"] == "request_completed"

    def test_recursion_is_bounded(self) -> None:
        deep: dict[str, object] = {"k": "v"}
        for _ in range(20):
            deep = {"k": deep}
        assert "[truncated]" in json.dumps(scrub(deep))
