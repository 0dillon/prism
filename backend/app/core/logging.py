"""Structured JSON logging with redaction.

Logs must carry enough identity to debug an incident without becoming a shadow copy of the
sensitive data in the database. Two defences, because either alone fails:

1. Key-based redaction catches values we know are sensitive by the name they are logged under.
2. Pattern-based redaction catches credentials that leak through an unexpected field, a
   formatted message, or an exception string from a provider SDK.

Neither is a licence to log secrets deliberately. They are a backstop for the cases nobody
anticipated, which are the cases that actually cause incidents.
"""

from __future__ import annotations

import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any, Final

import orjson

from app.core.request_context import current_context

REDACTED: Final = "[redacted]"

# Logged under a key containing any of these, the value never appears.
_REDACT_KEY_SUBSTRINGS: Final[tuple[str, ...]] = (
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "private_key",
    "signing_key",
    "bearer",
    "session_key",
)

# Exact keys that carry learner-sensitive content. PRD section 6.4: Render Profiles may reveal
# sensitive information, and voice audio is never persisted.
_REDACT_KEY_EXACT: Final[frozenset[str]] = frozenset(
    {
        "profile",
        "render_profile",
        "patch",
        "audio",
        "raw_audio",
        "voice_audio",
        "audio_bytes",
        "request_text",
        "utterance",
    }
)

# High-signal credential shapes, scrubbed wherever they appear in a string.
_VALUE_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"),  # JWT
    re.compile(r"\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}"),  # Supabase API keys
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),  # OpenAI-style keys
    re.compile(r"\b(?:whsec|rk_live|sk_live|pk_live)_[A-Za-z0-9_-]{8,}"),  # Stripe
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*"),  # Authorization headers
)

# Attributes the stdlib puts on every record; not payload, so never emitted as extras.
_STDLIB_ATTRS: Final[frozenset[str]] = frozenset(
    {
        "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
        "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
        "pathname", "process", "processName", "relativeCreated", "stack_info", "taskName",
        "thread", "threadName",
    }
)


def _should_redact_key(key: str) -> bool:
    lowered = key.lower()
    if lowered in _REDACT_KEY_EXACT:
        return True
    return any(fragment in lowered for fragment in _REDACT_KEY_SUBSTRINGS)


def scrub_text(value: str) -> str:
    """Remove credential-shaped substrings from free text."""
    for pattern in _VALUE_PATTERNS:
        value = pattern.sub(REDACTED, value)
    return value


def scrub(value: Any, *, key: str | None = None, _depth: int = 0) -> Any:
    """Recursively redact a value destined for a log record."""
    if key is not None and _should_redact_key(key):
        return REDACTED
    if _depth > 6:
        return "[truncated]"
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, dict):
        return {
            str(k): scrub(v, key=str(k), _depth=_depth + 1) for k, v in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [scrub(v, _depth=_depth + 1) for v in value]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return scrub_text(str(value))


class RedactionFilter(logging.Filter):
    """Scrubs the message and every structured extra before formatting."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = scrub_text(record.msg)
        for key, value in list(record.__dict__.items()):
            if key in _STDLIB_ATTRS or key.startswith("_"):
                continue
            record.__dict__[key] = scrub(value, key=key)
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with request correlation merged in."""

    def __init__(self, *, service_name: str) -> None:
        super().__init__()
        self._service_name = service_name

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "service": self._service_name,
            "logger": record.name,
            "message": record.getMessage(),
        }
        payload.update(current_context())

        for key, value in record.__dict__.items():
            if key in _STDLIB_ATTRS or key.startswith("_"):
                continue
            payload[key] = value

        if record.exc_info:
            payload["exception"] = scrub_text(self.formatException(record.exc_info))
        if record.stack_info:
            payload["stack"] = scrub_text(self.formatStack(record.stack_info))

        return orjson.dumps(payload, default=str).decode()


def configure_logging(*, level: str = "INFO", service_name: str = "prism-backend") -> None:
    """Install JSON formatting and redaction on the root logger. Idempotent."""
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter(service_name=service_name))
    handler.addFilter(RedactionFilter())

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)

    # uvicorn installs its own handlers; route them through ours instead of duplicating lines.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
