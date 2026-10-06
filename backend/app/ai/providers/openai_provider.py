"""OpenAI provider.

The only module in the backend that imports the OpenAI SDK; an architecture test enforces
that. Its entire job is to translate between the gateway's vendor-neutral types and this
vendor's API, including translating the SDK's exceptions into the shared failure taxonomy.

Two choices worth stating:

**The SDK's own retries are disabled** (`max_retries=0`). The gateway owns retry. Leaving the
SDK's layer on would multiply with it - two SDK attempts times three transport attempts times
two semantic attempts is twelve HTTP calls where the logs would show two - and every retry it
performed would be invisible to cost and latency accounting.

**Strict structured output requires a closed schema**: every property in `required`,
`additionalProperties: false`, and an object at the root. The models in `app/ai/schemas/` are
written for that, with nullable unions in place of optional fields, and the gateway normalises
the schema before it arrives here. This keeps a provider limitation from reaching back and
reshaping the PRD's own contracts, which carry genuine optionals.
"""

from __future__ import annotations

from typing import Any

import openai
from openai import AsyncOpenAI

from app.ai.errors import (
    ProviderAuthError,
    ProviderBadRequestError,
    ProviderConnectionError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.ai.types import ProviderResponse, StructuredRequest, TokenUsage
from app.core.logging import get_logger

logger = get_logger(__name__)


class OpenAIProvider:
    """Structured generation through the Responses API."""

    name = "openai"

    def __init__(self, *, api_key: str, base_url: str | None = None) -> None:
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url or None,
            max_retries=0,
        )

    async def generate_structured(
        self, request: StructuredRequest, *, model: str, timeout_seconds: float
    ) -> ProviderResponse:
        payload: dict[str, Any] = {
            "model": model,
            "instructions": request.prompt.system,
            "input": self._build_input(request),
            "max_output_tokens": request.max_output_tokens,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": request.schema_name,
                    "schema": request.json_schema,
                    "strict": True,
                }
            },
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature

        try:
            response = await self._client.responses.create(
                **payload, timeout=timeout_seconds
            )
        except openai.APITimeoutError as exc:
            raise ProviderTimeoutError(str(exc)) from exc
        except openai.APIConnectionError as exc:
            raise ProviderConnectionError(str(exc)) from exc
        except openai.RateLimitError as exc:
            raise ProviderRateLimitError(
                str(exc), retry_after_seconds=_retry_after(exc)
            ) from exc
        except openai.AuthenticationError as exc:
            raise ProviderAuthError("the LLM API key was rejected") from exc
        except openai.PermissionDeniedError as exc:
            raise ProviderAuthError("the LLM credentials lack access to this model") from exc
        except openai.BadRequestError as exc:
            # Our bug: a malformed schema or an unsupported parameter. Loud, never retried.
            raise ProviderBadRequestError(str(exc)) from exc
        except openai.APIStatusError as exc:
            if exc.status_code >= 500:
                raise ProviderUnavailableError(str(exc)) from exc
            raise ProviderBadRequestError(str(exc)) from exc

        return self._to_response(response, model=model)

    # ------------------------------------------------------------------
    def _build_input(self, request: StructuredRequest) -> list[dict[str, Any]]:
        """The conversation turns.

        On a corrective retry the invalid output and the reason are replayed as prior turns,
        so the model can see what it got wrong. The feedback is attributed to the system, not
        to the user, so text inside an uploaded document cannot forge it.
        """
        messages: list[dict[str, Any]] = [
            {"role": "user", "content": request.prompt.user},
        ]
        if request.correction is not None:
            previous, feedback = request.correction
            messages.append({"role": "assistant", "content": previous})
            messages.append({"role": "system", "content": feedback})
        return messages

    def _to_response(self, response: Any, *, model: str) -> ProviderResponse:
        refusal = _first_refusal(response)
        text = "" if refusal else (getattr(response, "output_text", "") or "")
        incomplete = getattr(response, "incomplete_details", None)
        truncated = bool(incomplete and getattr(incomplete, "reason", "") == "max_output_tokens")

        return ProviderResponse(
            text=text,
            usage=_usage(response),
            model=getattr(response, "model", model) or model,
            truncated=truncated,
            refusal=refusal,
        )


def _usage(response: Any) -> TokenUsage:
    usage = getattr(response, "usage", None)
    if usage is None:
        return TokenUsage()
    details = getattr(usage, "input_tokens_details", None)
    cached = int(getattr(details, "cached_tokens", 0) or 0)
    total_input = int(getattr(usage, "input_tokens", 0) or 0)
    return TokenUsage(
        # The gateway's convention: `input_tokens` is the uncached remainder, so that
        # total_input is the sum of the three fields and nothing is double counted.
        input_tokens=max(total_input - cached, 0),
        output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
        cache_read_tokens=cached,
    )


def _first_refusal(response: Any) -> str | None:
    for item in getattr(response, "output", None) or []:
        for part in getattr(item, "content", None) or []:
            if getattr(part, "type", None) == "refusal":
                return str(getattr(part, "refusal", "") or "refused")
    return None


def _retry_after(exc: Exception) -> float | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if not headers:
        return None
    raw = headers.get("retry-after")
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None
