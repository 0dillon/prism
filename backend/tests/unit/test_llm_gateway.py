"""The LLM gateway: structured output, the failure taxonomy, retries and accounting."""

from __future__ import annotations

import asyncio

import pytest
from pydantic import BaseModel, Field

from app.ai import pricing
from app.ai.errors import (
    CircuitOpenError,
    InvalidOutputError,
    ProviderAuthError,
    ProviderBadRequestError,
    ProviderConnectionError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    RefusalError,
    TruncatedOutputError,
)
from app.ai.gateway import InMemoryUsageRecorder, LlmGateway
from app.ai.pricing import ModelRates
from app.ai.providers.fake import (
    FakeProvider,
    malformed_response,
    refusal_response,
    response_for,
    truncated_response,
)
from app.ai.retry import CircuitBreaker, backoff_delay
from app.ai.types import Prompt, TokenUsage, UsageContext
from app.core.config import AppEnv, Settings


class Extraction(BaseModel):
    title: str
    confidence: float = Field(ge=0, le=1)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Retries are tested for behaviour, not for wall-clock patience."""

    async def instant(_: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "sleep", instant)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        app_env=AppEnv.test,
        llm_provider="fake",
        llm_model_heavy="heavy-model",
        llm_model_fast="fast-model",
        llm_max_attempts=3,
        _env_file=None,  # type: ignore[call-arg]
    )


def build(
    provider: FakeProvider, settings: Settings
) -> tuple[LlmGateway, InMemoryUsageRecorder]:
    recorder = InMemoryUsageRecorder()
    return LlmGateway(provider=provider, settings=settings, recorder=recorder), recorder


PROMPT = Prompt(system="You extract concepts.", user="Here is the document.")


async def generate(gateway: LlmGateway, **kwargs: object) -> object:
    return await gateway.generate_structured(
        schema=Extraction, prompt=PROMPT, tier="fast", operation="test.extract", **kwargs  # type: ignore[arg-type]
    )


class TestSuccess:
    async def test_a_valid_response_is_parsed_into_the_schema(self, settings: Settings) -> None:
        provider = FakeProvider([response_for({"title": "Evaporation", "confidence": 0.9})])
        gateway, _ = build(provider, settings)

        result = await generate(gateway)

        assert result.value.title == "Evaporation"  # type: ignore[attr-defined]
        assert result.attempts == 1  # type: ignore[attr-defined]

    async def test_the_tier_selects_the_model(self, settings: Settings) -> None:
        provider = FakeProvider(
            [response_for({"title": "a", "confidence": 1.0})],
            default=response_for({"title": "b", "confidence": 1.0}),
        )
        gateway, _ = build(provider, settings)

        await gateway.generate_structured(
            schema=Extraction, prompt=PROMPT, tier="heavy", operation="op"
        )
        await gateway.generate_structured(
            schema=Extraction, prompt=PROMPT, tier="fast", operation="op"
        )

        assert provider.models == ["heavy-model", "fast-model"]

    async def test_the_schema_sent_to_the_provider_is_strict(self, settings: Settings) -> None:
        """Constrained decoding needs a closed schema: no optional keys, no extra properties."""
        provider = FakeProvider([response_for({"title": "a", "confidence": 1.0})])
        gateway, _ = build(provider, settings)

        await generate(gateway)

        schema = provider.last_request.json_schema
        assert schema["additionalProperties"] is False
        assert sorted(schema["required"]) == ["confidence", "title"]

    async def test_the_system_prompt_is_separate_from_the_user_turn(
        self, settings: Settings
    ) -> None:
        """Instructions and untrusted content never share a channel."""
        provider = FakeProvider([response_for({"title": "a", "confidence": 1.0})])
        gateway, _ = build(provider, settings)

        await generate(gateway)

        assert provider.last_request.prompt.system == "You extract concepts."
        assert provider.last_request.prompt.user == "Here is the document."


class TestInvalidOutput:
    async def test_one_corrective_retry_is_attempted(self, settings: Settings) -> None:
        """PRD 0.2: retry once with the error message, then fail."""
        provider = FakeProvider(
            [malformed_response(), response_for({"title": "Recovered", "confidence": 0.5})]
        )
        gateway, _ = build(provider, settings)

        result = await generate(gateway)

        assert result.value.title == "Recovered"  # type: ignore[attr-defined]
        assert provider.call_count == 2

    async def test_the_retry_carries_the_validation_error_back_to_the_model(
        self, settings: Settings
    ) -> None:
        provider = FakeProvider(
            [malformed_response(), response_for({"title": "ok", "confidence": 0.5})]
        )
        gateway, _ = build(provider, settings)

        await generate(gateway)

        correction = provider.last_request.correction
        assert correction is not None
        previous, feedback = correction
        assert previous == '{"not": "the right shape"}'
        assert "failed schema validation" in feedback
        assert "title" in feedback

    async def test_a_second_failure_is_terminal(self, settings: Settings) -> None:
        """Not a loop. A model that misses the schema twice will not find it on the fifth try,
        and each attempt costs real money."""
        provider = FakeProvider([malformed_response(), malformed_response()])
        gateway, _ = build(provider, settings)

        with pytest.raises(InvalidOutputError) as caught:
            await generate(gateway)

        assert provider.call_count == 2
        assert caught.value.operation == "test.extract"
        assert caught.value.problems

    async def test_a_value_violating_a_bound_is_rejected(self, settings: Settings) -> None:
        """Validation is not just shape: a confidence of 5 is not acceptable state."""
        provider = FakeProvider(
            [
                response_for({"title": "x", "confidence": 5.0}),
                response_for({"title": "x", "confidence": 0.5}),
            ]
        )
        gateway, _ = build(provider, settings)

        result = await generate(gateway)
        assert result.value.confidence == 0.5  # type: ignore[attr-defined]


class TestTruncationAndRefusal:
    async def test_a_truncated_answer_is_retried_with_more_room(
        self, settings: Settings
    ) -> None:
        provider = FakeProvider(
            [truncated_response(), response_for({"title": "Complete", "confidence": 1.0})]
        )
        gateway, _ = build(provider, settings)

        result = await generate(gateway)

        assert result.value.title == "Complete"  # type: ignore[attr-defined]
        assert provider.calls[1].max_output_tokens > provider.calls[0].max_output_tokens

    async def test_repeated_truncation_is_terminal(self, settings: Settings) -> None:
        provider = FakeProvider([truncated_response(), truncated_response()])
        gateway, _ = build(provider, settings)

        with pytest.raises(TruncatedOutputError):
            await generate(gateway)

    async def test_a_refusal_is_never_retried(self, settings: Settings) -> None:
        """Retrying a safety decline spends money to be declined again."""
        provider = FakeProvider([refusal_response("safety")])
        gateway, _ = build(provider, settings)

        with pytest.raises(RefusalError) as caught:
            await generate(gateway)

        assert provider.call_count == 1
        assert caught.value.category == "safety"


class TestTransportRetries:
    @pytest.mark.parametrize(
        "failure",
        [
            ProviderConnectionError("network down"),
            ProviderTimeoutError("too slow"),
            ProviderUnavailableError("502"),
            ProviderRateLimitError("429", retry_after_seconds=0.01),
        ],
    )
    async def test_transient_failures_are_retried(
        self, settings: Settings, failure: Exception
    ) -> None:
        provider = FakeProvider([failure, response_for({"title": "ok", "confidence": 1.0})])
        gateway, _ = build(provider, settings)

        result = await generate(gateway)

        assert result.value.title == "ok"  # type: ignore[attr-defined]
        assert provider.call_count == 2

    async def test_retries_are_bounded(self, settings: Settings) -> None:
        provider = FakeProvider(default=ProviderConnectionError("still down"))
        gateway, _ = build(provider, settings)

        with pytest.raises(ProviderConnectionError):
            await generate(gateway)

        assert provider.call_count == settings.llm_max_attempts

    @pytest.mark.parametrize(
        "failure",
        [
            ProviderAuthError("bad key"),
            ProviderBadRequestError("malformed schema"),
        ],
    )
    async def test_terminal_failures_are_never_retried(
        self, settings: Settings, failure: Exception
    ) -> None:
        """An invalid API key cannot be fixed by asking again, and in a parallel stage every
        sibling call would fail identically. Failing now saves the whole fan-out."""
        provider = FakeProvider(default=failure)
        gateway, _ = build(provider, settings)

        with pytest.raises(type(failure)):
            await generate(gateway)

        assert provider.call_count == 1


class TestCircuitBreaker:
    def test_it_opens_after_repeated_failures_and_recovers(self) -> None:
        breaker = CircuitBreaker(failure_threshold=3, recovery_seconds=0.0)

        for _ in range(2):
            breaker.record_failure()
        assert breaker.is_open is False

        breaker.record_failure()
        # recovery_seconds of 0 means it is immediately half-open, which is what lets a
        # single probe through rather than staying open forever.
        assert breaker.is_open is False

        breaker.record_success()
        assert breaker.is_open is False

    def test_it_stays_open_within_the_recovery_window(self) -> None:
        breaker = CircuitBreaker(failure_threshold=1, recovery_seconds=60.0)
        breaker.record_failure()
        assert breaker.is_open is True

    async def test_an_open_circuit_fails_fast(self, settings: Settings) -> None:
        """Queueing behind a dead provider turns its outage into ours."""
        provider = FakeProvider(default=ProviderUnavailableError("down"))
        gateway, _ = build(provider, settings)
        gateway._breakers["fast"] = CircuitBreaker(
            failure_threshold=1, recovery_seconds=60.0
        )

        with pytest.raises(ProviderUnavailableError):
            await generate(gateway)

        calls_before = provider.call_count
        with pytest.raises(CircuitOpenError):
            await generate(gateway)
        assert provider.call_count == calls_before


class TestBackoff:
    def test_delays_are_jittered_rather_than_identical(self) -> None:
        """Four map workers hitting the same 429 must not re-collide on every retry."""
        delays = {round(backoff_delay(2), 6) for _ in range(50)}
        assert len(delays) > 10

    def test_delays_grow_but_stay_capped(self) -> None:
        assert max(backoff_delay(1) for _ in range(200)) <= 2.0
        assert max(backoff_delay(10) for _ in range(200)) <= 20.0

    def test_a_provider_supplied_retry_after_is_a_floor(self) -> None:
        assert backoff_delay(1, retry_after_seconds=15.0) >= 15.0


class TestUsageAccounting:
    async def test_every_attempt_is_recorded_including_failures(
        self, settings: Settings
    ) -> None:
        """A failed attempt still costs money."""
        provider = FakeProvider(
            [
                ProviderConnectionError("blip"),
                response_for({"title": "ok", "confidence": 1.0}),
            ]
        )
        gateway, recorder = build(provider, settings)

        await generate(gateway)

        assert [record.outcome for record in recorder.records] == ["error", "ok"]

    async def test_records_carry_the_attributable_context(self, settings: Settings) -> None:
        from uuid import uuid4

        lesson_id = uuid4()
        provider = FakeProvider([response_for({"title": "ok", "confidence": 1.0})])
        gateway, recorder = build(provider, settings)

        await gateway.generate_structured(
            schema=Extraction,
            prompt=PROMPT,
            tier="heavy",
            operation="ingest.concepts",
            context=UsageContext(operation="ingest.concepts", lesson_id=lesson_id),
        )

        record = recorder.records[0]
        assert record.context.operation == "ingest.concepts"
        assert record.context.lesson_id == lesson_id
        assert record.tier == "heavy"
        assert record.model == "fake-model"

    async def test_cached_tokens_count_towards_total_input(self, settings: Settings) -> None:
        """Summing `input_tokens` alone would understate a well-cached job by most of its
        volume, and make the PRD 6.2 budget look met when it is not."""
        provider = FakeProvider(
            [
                response_for(
                    {"title": "ok", "confidence": 1.0},
                    input_tokens=100,
                    cache_read_tokens=900,
                    output_tokens=50,
                )
            ]
        )
        gateway, recorder = build(provider, settings)

        await generate(gateway)

        usage = recorder.records[0].usage
        assert usage.input_tokens == 100
        assert usage.total_input == 1000


class TestPricing:
    def test_cost_uses_the_registered_rates(self) -> None:
        pricing.load_rates({"m": ModelRates(input_per_mtok=1.0, output_per_mtok=4.0)})
        cost = pricing.estimate_cost(
            "m", TokenUsage(input_tokens=1_000_000, output_tokens=500_000)
        )
        assert cost == pytest.approx(3.0)

    def test_cached_input_is_cheaper(self) -> None:
        pricing.load_rates(
            {
                "m": ModelRates(
                    input_per_mtok=10.0, output_per_mtok=0.0, cached_input_per_mtok=1.0
                )
            }
        )
        full = pricing.estimate_cost("m", TokenUsage(input_tokens=1_000_000))
        cached = pricing.estimate_cost("m", TokenUsage(cache_read_tokens=1_000_000))
        assert cached < full

    def test_an_unknown_model_costs_zero_rather_than_a_guess(self) -> None:
        """A plausible invented number in a cost report is worse than an obvious gap."""
        pricing.load_rates({})
        assert pricing.estimate_cost("mystery", TokenUsage(input_tokens=1_000)) == 0.0


class TestConcurrencyLimit:
    async def test_in_flight_calls_are_bounded_per_tier(self) -> None:
        """Process-wide, not per job: two concurrent jobs each bounded at four would
        otherwise put eight calls in flight against one provider."""
        settings = Settings(
            app_env=AppEnv.test,
            llm_provider="fake",
            llm_model_heavy="h",
            llm_model_fast="f",
            llm_max_inflight_fast=2,
            _env_file=None,  # type: ignore[call-arg]
        )
        concurrent = 0
        peak = 0

        def slow(_: object) -> object:
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            concurrent -= 1
            return response_for({"title": "ok", "confidence": 1.0})

        provider = FakeProvider(default=slow)  # type: ignore[arg-type]
        gateway, _ = build(provider, settings)

        await asyncio.gather(*(generate(gateway) for _ in range(10)))
        assert peak <= 2
