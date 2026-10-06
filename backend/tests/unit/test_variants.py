"""The variant cache under concurrency (PRD task P2-17, 5.5, 6.2)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.ai.errors import BudgetExceededError, ProviderUnavailableError
from app.ai.gateway import LlmGateway
from app.ai.providers.fake import FakeProvider, response_for
from app.ai.tutor.variants import (
    InMemoryVariantStore,
    Variant,
    VariantKey,
    VariantNotReadyError,
    VariantService,
)
from app.core.config import AppEnv, Settings
from app.schemas.knowledge_graph import Concept

CONCEPT = Concept.model_validate(
    {
        "id": "c_1",
        "sectionId": "s_1",
        "order": 0,
        "title": "Evaporation",
        "summary": "Liquid water becomes vapour when it gains enough energy.",
        "body": "When water molecules absorb sufficient thermal energy they transition.",
        "source": {"kind": "page", "start": 1, "excerpt": "Water evaporates when heated."},
    }
)

GENERATED = {"summary": "Water turns into gas when it gets hot.", "body": "Heat makes water rise."}


def settings() -> Settings:
    return Settings(
        app_env=AppEnv.test,
        llm_provider="fake",
        llm_model_heavy="h",
        llm_model_fast="f",
        llm_max_attempts=1,
        _env_file=None,  # type: ignore[call-arg]
    )


def service_for(*script: Any) -> tuple[VariantService, FakeProvider, InMemoryVariantStore]:
    provider = FakeProvider(script, default=script[-1] if script else None)
    gateway = LlmGateway(provider=provider, settings=settings())
    store = InMemoryVariantStore()
    return VariantService(gateway=gateway, store=store), provider, store


async def fetch(service: VariantService, level: str = "plain") -> Variant:
    return await service.get_or_create(
        concept=CONCEPT, graph_version=1, reading_level=level  # type: ignore[arg-type]
    )


class TestCaching:
    async def test_a_miss_generates_and_stores(self) -> None:
        service, provider, store = service_for(response_for(GENERATED))

        variant = await fetch(service)

        assert variant.summary == GENERATED["summary"]
        assert provider.call_count == 1
        assert await store.get(VariantKey("c_1", 1, "plain")) is not None

    async def test_a_second_request_makes_no_model_call(self) -> None:
        """PRD task P2-17, done when: a second request for the same variant makes no LLM call."""
        service, provider, _ = service_for(response_for(GENERATED))

        await fetch(service)
        again = await fetch(service)

        assert provider.call_count == 1
        assert again.summary == GENERATED["summary"]

    async def test_the_original_level_never_calls_the_model(self) -> None:
        """The concept already holds its own text; generating it would be pure waste."""
        service, provider, _ = service_for()

        variant = await fetch(service, "original")

        assert provider.call_count == 0
        assert variant.summary == CONCEPT.summary
        assert variant.body == CONCEPT.body

    async def test_reading_levels_are_cached_separately(self) -> None:
        service, provider, _ = service_for(
            response_for(GENERATED), response_for({"summary": "Even simpler.", "body": "Short."})
        )

        plain = await fetch(service, "plain")
        simple = await fetch(service, "simple")

        assert provider.call_count == 2
        assert plain.summary != simple.summary

    async def test_a_republish_invalidates_the_cache(self) -> None:
        """Keyed on graph version, so a teacher's edit is not served from the old text."""
        service, provider, _ = service_for(response_for(GENERATED))

        await service.get_or_create(concept=CONCEPT, graph_version=1, reading_level="plain")
        await service.get_or_create(concept=CONCEPT, graph_version=2, reading_level="plain")

        assert provider.call_count == 2

    async def test_an_overlong_summary_is_trimmed_to_the_contract_limit(self) -> None:
        service, _, _ = service_for(
            response_for({"summary": "x" * 500, "body": "Fine."})
        )
        variant = await fetch(service)
        assert len(variant.summary) <= 240


class TestConcurrentMisses:
    async def test_simultaneous_misses_produce_exactly_one_model_call(self) -> None:
        """The whole point. Thirty learners opening the same lesson must not buy thirty
        identical rewrites."""
        calls = 0

        async def slow_generate(_: object) -> object:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            return response_for(GENERATED)

        provider = FakeProvider(default=slow_generate)  # type: ignore[arg-type]
        service = VariantService(
            gateway=LlmGateway(provider=provider, settings=settings()),
            store=InMemoryVariantStore(),
        )

        results = await asyncio.gather(*(fetch(service) for _ in range(30)))

        assert calls == 1
        assert all(result.summary == GENERATED["summary"] for result in results)

    async def test_a_loser_waits_rather_than_generating_its_own(self) -> None:
        """Falling back to generating would reintroduce the duplicate call under exactly the
        condition where it costs most: a slow provider."""
        store = InMemoryVariantStore()
        key = VariantKey("c_1", 1, "plain")

        from uuid import uuid4

        winner = uuid4()
        await store.claim(key, winner, stale_after=90)

        provider = FakeProvider(default=response_for(GENERATED))
        service = VariantService(
            gateway=LlmGateway(provider=provider, settings=settings()), store=store
        )

        async def finish_shortly() -> None:
            await asyncio.sleep(0.2)
            await store.fill(key, winner, Variant(summary="From the winner", body="Body"))

        asyncio.create_task(finish_shortly())  # noqa: RUF006
        variant = await fetch(service)

        assert variant.summary == "From the winner"
        assert provider.call_count == 0

    async def test_a_loser_gives_up_rather_than_blocking_the_lesson(self) -> None:
        """PRD 6.5 and 6.1: the renderer shows the original text and retries, rather than
        holding first paint on a cache fill."""
        store = InMemoryVariantStore()
        from uuid import uuid4

        await store.claim(VariantKey("c_1", 1, "plain"), uuid4(), stale_after=90)

        service = VariantService(
            gateway=LlmGateway(provider=FakeProvider(), settings=settings()), store=store
        )

        import app.ai.tutor.variants as variants_module

        original = variants_module.WAIT_BUDGET_SECONDS
        variants_module.WAIT_BUDGET_SECONDS = 0.3
        try:
            with pytest.raises(VariantNotReadyError):
                await fetch(service)
        finally:
            variants_module.WAIT_BUDGET_SECONDS = original


class TestClaimRecovery:
    async def test_a_stale_claim_can_be_taken_over(self) -> None:
        """A worker that died mid-generation must not poison that key forever."""
        store = InMemoryVariantStore()
        from uuid import uuid4

        key = VariantKey("c_1", 1, "plain")
        assert await store.claim(key, uuid4(), stale_after=90) is True
        assert await store.claim(key, uuid4(), stale_after=90) is False
        # With a zero staleness window the abandoned claim is immediately takeable.
        assert await store.claim(key, uuid4(), stale_after=0) is True

    async def test_a_failed_claim_is_retried_by_the_next_reader(self) -> None:
        service, provider, _ = service_for(
            ProviderUnavailableError("down"), response_for(GENERATED)
        )

        with pytest.raises(ProviderUnavailableError):
            await fetch(service)

        variant = await fetch(service)
        assert variant.summary == GENERATED["summary"]
        assert provider.call_count == 2

    async def test_a_budget_failure_does_not_poison_the_key(self) -> None:
        """Running out of budget is a decision about spending, not a fact about this concept.
        Once the budget resets the variant must be generable normally."""
        service, _, store = service_for(BudgetExceededError("over cap"))

        with pytest.raises(BudgetExceededError):
            await fetch(service)

        assert await store.get(VariantKey("c_1", 1, "plain")) is None


class TestGeneratedContent:
    async def test_the_prompt_forbids_dropping_facts(self) -> None:
        """A shorter rewrite that loses a detail changes what the learner is taught, and the
        teacher approved the original."""
        from app.ai.prompts.session import VARIANT_SYSTEM

        lowered = " ".join(VARIANT_SYSTEM.lower().split())
        assert "keep every fact" in lowered
        assert "never add facts that are not in the original" in lowered

    async def test_the_prompt_carries_the_original_text(self) -> None:
        service, provider, _ = service_for(response_for(GENERATED))
        await fetch(service)

        user_turn = provider.last_request.prompt.user
        assert CONCEPT.title in user_turn
        assert CONCEPT.body in user_turn
        assert "plain" in user_turn
