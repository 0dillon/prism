"""A deterministic provider for tests and offline development.

The default in every environment that has no API key, so the whole backend runs end to end
without a network or a bill. It is scripted rather than clever: a test states exactly what the
model returns, including the failure it returns first, so a test about retry behaviour is
about retry behaviour and not about what a real model happened to say that day.
"""

from __future__ import annotations

import inspect
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import orjson

from app.ai.errors import LlmError
from app.ai.types import ProviderResponse, StructuredRequest, TokenUsage

# Either a canned response, an exception to raise, or a callable taking the request.
Script = (
    ProviderResponse
    | LlmError
    | Callable[[StructuredRequest], ProviderResponse]
    | Callable[[StructuredRequest], Awaitable[ProviderResponse]]
)


class FakeProvider:
    """Replays a script of responses and failures."""

    name = "fake"

    def __init__(
        self,
        script: Sequence[Script] | None = None,
        *,
        default: Script | None = None,
    ) -> None:
        self._script: deque[Script] = deque(script or ())
        self._default = default
        self.calls: list[StructuredRequest] = []
        self.models: list[str] = []

    # ------------------------------------------------------------------
    def queue(self, *items: Script) -> FakeProvider:
        self._script.extend(items)
        return self

    def queue_value(self, value: Any, **usage: int) -> FakeProvider:
        """Queue a successful response carrying `value` serialised as JSON."""
        return self.queue(response_for(value, usage=TokenUsage(**usage)))

    @property
    def call_count(self) -> int:
        return len(self.calls)

    @property
    def last_request(self) -> StructuredRequest:
        return self.calls[-1]

    # ------------------------------------------------------------------
    async def generate_structured(
        self, request: StructuredRequest, *, model: str, timeout_seconds: float
    ) -> ProviderResponse:
        self.calls.append(request)
        self.models.append(model)

        item: Script
        if self._script:
            item = self._script.popleft()
        elif self._default is not None:
            item = self._default
        else:
            raise AssertionError(
                "FakeProvider received an unscripted call for "
                f"{request.schema_name!r}. Queue a response or set a default."
            )

        if isinstance(item, LlmError):
            raise item
        if callable(item):
            produced = item(request)
            # A script may be an async callable when a test needs a real suspension
            # point, for instance to exercise concurrent callers.
            if inspect.isawaitable(produced):
                return await produced
            return produced
        return item


def response_for(
    value: Any,
    *,
    model: str = "fake-model",
    usage: TokenUsage | None = None,
    input_tokens: int = 100,
    output_tokens: int = 50,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> ProviderResponse:
    """A successful response carrying `value` as JSON."""
    return ProviderResponse(
        text=orjson.dumps(value).decode(),
        usage=usage
        or TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_creation_tokens=cache_creation_tokens,
        ),
        model=model,
    )


def malformed_response(text: str = '{"not": "the right shape"}') -> ProviderResponse:
    """A syntactically valid reply that fails schema validation."""
    return ProviderResponse(text=text, usage=TokenUsage(), model="fake-model")


def truncated_response(text: str = '{"partial": ') -> ProviderResponse:
    return ProviderResponse(text=text, usage=TokenUsage(), model="fake-model", truncated=True)


def refusal_response(category: str = "safety") -> ProviderResponse:
    return ProviderResponse(text="", usage=TokenUsage(), model="fake-model", refusal=category)
