"""The single abstraction every LLM call goes through.

Nothing in the domain calls a provider SDK. Everything calls
:meth:`LlmGateway.generate_structured`, which owns model selection, structured output,
validation, retries, timeouts, usage accounting, cost, concurrency limiting and the circuit
breaker. An architecture test enforces that the SDK is imported only by provider modules.

Two loops, composed so they cannot multiply:

* the **semantic** loop runs at most twice - one attempt, then one corrective retry carrying
  the validation error back to the model (PRD 0.2);
* the **transport** loop retries genuinely transient failures with jittered backoff.

The provider SDK's own retry is disabled in the provider implementation. Leaving it on would
multiply with both of these into a dozen invisible HTTP calls and make every cost and latency
figure fiction.

Usage is recorded per *attempt*, not per successful call. A failed attempt still costs money,
and a report that counts only successes understates the bill.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, TypeVar

import orjson
from pydantic import BaseModel, ValidationError

from app.ai import pricing
from app.ai.errors import (
    BudgetExceededError,
    CircuitOpenError,
    InvalidOutputError,
    LlmError,
    ProviderAuthError,
    ProviderBadRequestError,
    ProviderRateLimitError,
    ProviderTransportError,
    RefusalError,
    TruncatedOutputError,
)
from app.ai.retry import CircuitBreaker, backoff_delay
from app.ai.types import (
    GenerationResult,
    LlmProvider,
    Outcome,
    Prompt,
    StructuredRequest,
    Tier,
    TokenUsage,
    UsageContext,
    UsageRecord,
    UsageRecorder,
)
from app.core.config import Settings
from app.core.logging import get_logger
from app.core.request_context import get_request_id

logger = get_logger(__name__)

TModel = TypeVar("TModel", bound=BaseModel)

# One corrective retry, as the PRD specifies. Not a loop: a model that fails the schema twice
# is not going to find it on the fifth attempt, and each try costs real money.
MAX_SEMANTIC_ATTEMPTS = 2


class NullUsageRecorder:
    """Discards usage. The default until a database-backed recorder is wired in."""

    async def record(self, record: UsageRecord) -> None:
        return None


class InMemoryUsageRecorder:
    """Keeps records in a list, for tests and for the cost-report script."""

    def __init__(self) -> None:
        self.records: list[UsageRecord] = []

    async def record(self, record: UsageRecord) -> None:
        self.records.append(record)

    @property
    def total_cost_usd(self) -> float:
        return sum(record.cost_usd for record in self.records)

    @property
    def total_usage(self) -> TokenUsage:
        total = TokenUsage()
        for record in self.records:
            total = total + record.usage
        return total


class SpendGuard:
    """Checks a spend cap before an expensive call.

    A Protocol-shaped seam rather than logic: the concurrency-safe implementation reserves
    budget in the database so simultaneous requests cannot all observe the same under-cap
    figure and all proceed. The default permits everything, which is correct for the MVP,
    where there are no organizations to cap.
    """

    async def check(self, context: UsageContext, estimated_cost_usd: float) -> None:
        return None


class LlmGateway:
    """Model selection, structured output, retries, accounting."""

    def __init__(
        self,
        *,
        provider: LlmProvider,
        settings: Settings,
        recorder: UsageRecorder | None = None,
        spend_guard: SpendGuard | None = None,
    ) -> None:
        self._provider = provider
        self._settings = settings
        self._recorder: UsageRecorder = recorder or NullUsageRecorder()
        self._spend_guard = spend_guard or SpendGuard()

        self._models: dict[str, str] = {
            "heavy": settings.llm_model_heavy,
            "fast": settings.llm_model_fast,
        }
        self._timeouts: dict[str, float] = {
            "heavy": settings.llm_timeout_heavy_seconds,
            "fast": settings.llm_timeout_fast_seconds,
        }
        # Process-wide, per tier. A per-job limit would not protect the provider: two
        # concurrent ingestion jobs each bounded at four would put eight calls in flight.
        self._inflight: dict[str, asyncio.Semaphore] = {
            "heavy": asyncio.Semaphore(settings.llm_max_inflight_heavy),
            "fast": asyncio.Semaphore(settings.llm_max_inflight_fast),
        }
        self._breakers: dict[str, CircuitBreaker] = {
            "heavy": CircuitBreaker(),
            "fast": CircuitBreaker(),
        }

    # ------------------------------------------------------------------
    def model_for(self, tier: Tier) -> str:
        model = self._models.get(tier) or ""
        if not model:
            raise ProviderBadRequestError(f"no model configured for the {tier} tier")
        return model

    async def generate_structured(
        self,
        *,
        schema: type[TModel],
        prompt: Prompt,
        tier: Tier,
        operation: str,
        context: UsageContext | None = None,
        max_output_tokens: int = 4096,
        temperature: float | None = None,
    ) -> GenerationResult:
        """Return a validated instance of `schema`, or raise from `app.ai.errors`."""
        usage_context = context or UsageContext(operation=operation)
        if usage_context.operation != operation:
            usage_context = UsageContext(
                operation=operation,
                user_id=usage_context.user_id,
                org_id=usage_context.org_id,
                lesson_id=usage_context.lesson_id,
                job_id=usage_context.job_id,
            )

        model = self.model_for(tier)
        breaker = self._breakers[tier]
        if breaker.is_open:
            raise CircuitOpenError(
                f"the {tier} model provider is failing; not sending further requests"
            )

        await self._spend_guard.check(usage_context, 0.0)

        json_schema = _strict_json_schema(schema)
        correction: tuple[str, str] | None = None
        total_usage = TokenUsage()
        total_cost = 0.0
        attempt_number = 0
        last_problems: list[str] = []

        for semantic_attempt in range(1, MAX_SEMANTIC_ATTEMPTS + 1):
            request = StructuredRequest(
                prompt=prompt,
                schema_name=schema.__name__,
                json_schema=json_schema,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                correction=correction,
            )

            response, attempts_used = await self._call_with_transport_retry(
                request,
                tier=tier,
                model=model,
                context=usage_context,
                attempt_offset=attempt_number,
            )
            attempt_number += attempts_used
            total_usage = total_usage + response.usage
            total_cost += pricing.estimate_cost(response.model, response.usage)

            if response.refusal:
                await self._record(
                    usage_context, tier, response, "refusal", attempt_number, 0
                )
                raise RefusalError(
                    "The model declined to produce this content.", category=response.refusal
                )

            if response.truncated:
                # Counts against the single semantic retry: the answer was cut off, so it is
                # worth one more try with room, but not an escalating sequence of them.
                if semantic_attempt < MAX_SEMANTIC_ATTEMPTS:
                    max_output_tokens = min(max_output_tokens * 2, 32_000)
                    correction = (
                        response.text,
                        "Your previous response was cut off. Return the complete JSON.",
                    )
                    continue
                raise TruncatedOutputError(
                    f"{operation}: the model's answer did not fit in the output budget"
                )

            try:
                value = schema.model_validate_json(response.text)
            except ValidationError as exc:
                last_problems = [
                    f"{'.'.join(str(p) for p in err.get('loc', ()))}: {err.get('msg', '')}"
                    for err in exc.errors()[:10]
                ]
                logger.warning(
                    "llm_output_invalid",
                    extra={
                        "operation": operation,
                        "tier": tier,
                        "semantic_attempt": semantic_attempt,
                        "problems": last_problems,
                    },
                )
                if semantic_attempt < MAX_SEMANTIC_ATTEMPTS:
                    correction = (response.text, _validation_feedback(last_problems))
                    continue
                raise InvalidOutputError(
                    f"{operation}: the model's output did not match the required schema",
                    operation=operation,
                    problems=last_problems,
                ) from exc

            breaker.record_success()
            return GenerationResult(
                value=value,
                usage=total_usage,
                cost_usd=total_cost,
                attempts=attempt_number,
                model=response.model,
            )

        raise InvalidOutputError(
            f"{operation}: the model's output did not match the required schema",
            operation=operation,
            problems=last_problems,
        )

    # ------------------------------------------------------------------
    async def _call_with_transport_retry(
        self,
        request: StructuredRequest,
        *,
        tier: Tier,
        model: str,
        context: UsageContext,
        attempt_offset: int,
    ) -> tuple[Any, int]:
        breaker = self._breakers[tier]
        timeout = self._timeouts[tier]
        attempts = self._settings.llm_max_attempts
        last_error: LlmError | None = None

        for attempt in range(1, attempts + 1):
            started = time.perf_counter()
            try:
                async with self._inflight[tier]:
                    response = await self._provider.generate_structured(
                        request, model=model, timeout_seconds=timeout
                    )
            except (ProviderAuthError, ProviderBadRequestError, BudgetExceededError):
                # Not data-dependent. No number of retries makes a bad key good, and in a
                # parallel stage every sibling call would fail identically - so fail now
                # rather than spending the whole fan-out discovering it.
                await self._record_failure(
                    context, tier, model, attempt_offset + attempt, "error",
                    _elapsed_ms(started)
                )
                breaker.record_failure()
                raise
            except ProviderTransportError as exc:
                last_error = exc
                outcome: Outcome = (
                    "rate_limited" if isinstance(exc, ProviderRateLimitError) else "error"
                )
                await self._record_failure(
                    context, tier, model, attempt_offset + attempt, outcome,
                    _elapsed_ms(started)
                )
                breaker.record_failure()

                if attempt >= attempts:
                    break

                retry_after = getattr(exc, "retry_after_seconds", None)
                delay = backoff_delay(attempt, retry_after_seconds=retry_after)
                logger.warning(
                    "llm_transport_retry",
                    extra={
                        "operation": context.operation,
                        "tier": tier,
                        "attempt": attempt,
                        "delay_seconds": round(delay, 2),
                        "failure": type(exc).__name__,
                    },
                )
                await asyncio.sleep(delay)
                continue

            await self._record(
                context, tier, response, "ok", attempt_offset + attempt, _elapsed_ms(started)
            )
            return response, attempt

        assert last_error is not None
        raise last_error

    async def _record(
        self,
        context: UsageContext,
        tier: Tier,
        response: Any,
        outcome: Outcome,
        attempt: int,
        latency_ms: int,
    ) -> None:
        await self._recorder.record(
            UsageRecord(
                context=context,
                tier=tier,
                provider=self._provider.name,
                model=response.model,
                attempt=attempt,
                outcome=outcome,
                usage=response.usage,
                latency_ms=latency_ms,
                cost_usd=pricing.estimate_cost(response.model, response.usage),
                request_id=get_request_id(),
            )
        )

    async def _record_failure(
        self,
        context: UsageContext,
        tier: Tier,
        model: str,
        attempt: int,
        outcome: Outcome,
        latency_ms: int,
    ) -> None:
        await self._recorder.record(
            UsageRecord(
                context=context,
                tier=tier,
                provider=self._provider.name,
                model=model,
                attempt=attempt,
                outcome=outcome,
                usage=TokenUsage(),
                latency_ms=latency_ms,
                cost_usd=0.0,
                request_id=get_request_id(),
            )
        )


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _validation_feedback(problems: list[str]) -> str:
    joined = "; ".join(problems) or "the response did not match the schema"
    return (
        "Your previous response failed schema validation: "
        f"{joined}. Return only JSON matching the required schema."
    )


def _strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """JSON Schema in the strict form providers require for constrained decoding.

    Strict structured output forbids optional keys: every property must appear in `required`
    and `additionalProperties` must be false. Models passed here are the LLM wire models in
    `app/ai/schemas/`, which are written with that in mind - nullable unions rather than
    optional fields. This normalises the schema and asserts the shape rather than trusting it,
    because a field added later without that discipline would otherwise fail at the provider
    with an opaque message.
    """
    schema = model.model_json_schema()
    _enforce_strict(schema)
    return schema


def _enforce_strict(node: Any) -> None:
    if isinstance(node, dict):
        if node.get("type") == "object" and "properties" in node:
            node["additionalProperties"] = False
            node["required"] = sorted(node["properties"].keys())
        for key, value in node.items():
            if key != "enum":
                _enforce_strict(value)
    elif isinstance(node, list):
        for item in node:
            _enforce_strict(item)


def dumps_compact(value: Any) -> str:
    return orjson.dumps(value).decode()
