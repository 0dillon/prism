"""LLM failure taxonomy.

"The model call failed" is not one thing, and treating it as one thing produces either a
system that retries an invalid API key forever or one that gives up on a transient blip. Each
class below is handled differently, and the distinction that matters most is whether retrying
could possibly help.

| Failure              | Retried?                      | Why                                      |
| -------------------- | ----------------------------- | ---------------------------------------- |
| Invalid output       | Once, with validation feedback | The model can correct a schema mistake   |
| Truncated output     | Once, with a larger budget     | The answer was cut off, not wrong        |
| Refusal              | Never                          | Retrying a safety decline buys a decline |
| Connection / timeout | Yes, backoff with jitter       | Genuinely transient                      |
| Rate limited         | Yes, honouring retry-after     | The provider told us when to return      |
| Provider outage      | Yes, then the breaker opens    | Queueing behind a dead provider is waste |
| Authentication       | Never                          | Configuration, not data                  |
| Bad request          | Never                          | Our bug; it must be loud                 |
| Budget exceeded      | Never                          | A decision, not a failure                |
"""

from __future__ import annotations


class LlmError(Exception):
    """Base class for every failure raised by the gateway."""

    retryable: bool = False


# --------------------------------------------------------------------------
# Output problems: the call succeeded, the content did not.
# --------------------------------------------------------------------------
class InvalidOutputError(LlmError):
    """Structured output failed validation, and the one corrective retry did not fix it."""

    def __init__(self, message: str, *, operation: str, problems: list[str] | None = None):
        super().__init__(message)
        self.operation = operation
        self.problems = problems or []


class TruncatedOutputError(LlmError):
    """The model hit its output limit mid-answer."""


class RefusalError(LlmError):
    """The model declined.

    Never retried. A safety decline is a decision about the content, and asking again spends
    money to be declined again. For one chunk of a document this degrades that chunk; it does
    not fail the job.
    """

    def __init__(self, message: str, *, category: str | None = None):
        super().__init__(message)
        self.category = category


# --------------------------------------------------------------------------
# Transport problems: worth retrying.
# --------------------------------------------------------------------------
class ProviderTransportError(LlmError):
    retryable = True


class ProviderConnectionError(ProviderTransportError):
    """The request never reached the provider."""


class ProviderTimeoutError(ProviderTransportError):
    """No response within the operation's budget."""


class ProviderRateLimitError(ProviderTransportError):
    """Throttled. `retry_after_seconds` is the provider's own instruction, where it gave one."""

    def __init__(self, message: str, *, retry_after_seconds: float | None = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class ProviderUnavailableError(ProviderTransportError):
    """A 5xx. Repeated occurrences open the circuit breaker."""


# --------------------------------------------------------------------------
# Terminal problems: retrying cannot help.
# --------------------------------------------------------------------------
class ProviderAuthError(LlmError):
    """Rejected credentials. Configuration, so it needs an operator, not a retry."""


class ProviderBadRequestError(LlmError):
    """The provider rejected the request shape. Our bug, and it should be loud in development."""


class BudgetExceededError(LlmError):
    """A spend cap would be crossed. Raised before the call, so nothing is spent."""

    def __init__(self, message: str, *, scope: str | None = None):
        super().__init__(message)
        self.scope = scope


class CircuitOpenError(LlmError):
    """The breaker is open after repeated provider failures.

    Fail fast rather than queue work behind a provider that is already down: a backlog of
    waiting requests turns one dependency's outage into this service's outage.
    """


__all__ = [
    "BudgetExceededError",
    "CircuitOpenError",
    "InvalidOutputError",
    "LlmError",
    "ProviderAuthError",
    "ProviderBadRequestError",
    "ProviderConnectionError",
    "ProviderRateLimitError",
    "ProviderTimeoutError",
    "ProviderTransportError",
    "ProviderUnavailableError",
    "RefusalError",
    "TruncatedOutputError",
]
