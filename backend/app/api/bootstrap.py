"""Builds the long-lived services the request path depends on.

Constructed once at startup and held on `app.state`. Per-request construction would reset the
LLM gateway's circuit breaker and its concurrency semaphore on every call, quietly disabling
both, and would re-fetch JWKS constantly.

Each subsystem degrades independently. A deployment with no database configured still serves
`/health/live` and still exposes its OpenAPI; a deployment with no LLM key still serves
published lessons. PRD 6.5 requires that a failing dependency take down its own feature and
nothing else, and that starts with not refusing to boot.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI

from app.ai.gateway import LlmGateway
from app.ai.providers.fake import FakeProvider, response_for
from app.ai.types import LlmProvider
from app.auth.jwks import AsyncJwksCache
from app.auth.verifier import Verifier
from app.core.config import Settings
from app.core.logging import get_logger
from app.core.rate_limit import (
    InMemoryRateLimiter,
    NullRateLimiter,
    PostgresRateLimiter,
    RateLimiter,
)
from app.core.readiness import register_probe
from app.db import pools

logger = get_logger(__name__)


@dataclass(slots=True)
class Wiring:
    """Everything built at startup, so shutdown can take it back down in order."""

    jwks: AsyncJwksCache | None = None
    database_open: bool = False


def build_llm_provider(settings: Settings) -> LlmProvider:
    """The configured provider, or the deterministic fake.

    The fake is the default when no key is configured, so the whole backend runs end to end
    offline and no test can reach the network by accident.
    """
    if settings.llm_provider == "openai" and settings.llm_api_key.get_secret_value():
        from app.ai.providers.openai_provider import OpenAIProvider

        return OpenAIProvider(
            api_key=settings.llm_api_key.get_secret_value(),
            base_url=settings.llm_base_url or None,
        )

    if settings.llm_provider != "fake":
        logger.warning(
            "llm_provider_falling_back_to_fake",
            extra={"configured": settings.llm_provider, "reason": "no API key configured"},
        )
    return FakeProvider(default=response_for({}))


def build_rate_limiter(settings: Settings) -> RateLimiter:
    if not settings.rate_limit_enabled or settings.rate_limit_backend == "disabled":
        logger.warning("rate_limiting_disabled")
        return NullRateLimiter()

    if settings.rate_limit_backend == "postgres" and settings.database_url_rls:
        # The counter table has no policies and no grants, because a learner must not be able
        # to read or reset their own quota. The privileged call site lives in the allowlisted
        # repository package, with its justification.
        from app.repositories.privileged.rate_limits import increment

        return PostgresRateLimiter(increment)

    logger.warning(
        "rate_limiting_in_memory",
        extra={"detail": "correct only within one process; not suitable for production"},
    )
    return InMemoryRateLimiter()


async def start_services(app: FastAPI, settings: Settings) -> Wiring:
    wiring = Wiring()

    # --- database -----------------------------------------------------
    if settings.database_url_rls:
        try:
            await pools.open_pools(settings)
            wiring.database_open = True
            register_probe("database", pools.check_database_ready)
        except Exception as exc:
            # Readiness will report this. The process still starts, so an orchestrator sees a
            # live-but-not-ready instance rather than a crash loop.
            logger.error("database_unavailable_at_startup", extra={"detail": str(exc)})
    else:
        logger.warning("database_not_configured")

    # --- authentication ------------------------------------------------
    if settings.supabase_jwks_url:
        jwks = AsyncJwksCache(
            settings.supabase_jwks_url,
            ttl_seconds=settings.supabase_jwks_cache_ttl_seconds,
            cooldown_seconds=settings.supabase_jwks_refresh_cooldown_seconds,
            timeout_seconds=settings.supabase_jwks_timeout_seconds,
        )
        try:
            await jwks.startup()
        except Exception as exc:
            # Serving stale or no keys is a 503 on authenticated routes, never a crash.
            logger.error("jwks_unavailable_at_startup", extra={"detail": str(exc)})
        wiring.jwks = jwks
        app.state.verifier = Verifier(settings, jwks)
        register_probe("jwks", jwks.check_ready)
    else:
        logger.warning("jwks_not_configured")
        app.state.verifier = None

    # --- AI gateway ----------------------------------------------------
    provider = build_llm_provider(settings)
    app.state.gateway = LlmGateway(provider=provider, settings=settings)

    # --- limits --------------------------------------------------------
    app.state.rate_limiter = build_rate_limiter(settings)

    return wiring


async def stop_services(app: FastAPI, wiring: Wiring) -> None:
    if wiring.jwks is not None:
        await wiring.jwks.aclose()
    if wiring.database_open:
        await pools.close_pools()
    for attribute in ("verifier", "gateway", "rate_limiter"):
        if hasattr(app.state, attribute):
            setattr(app.state, attribute, None)


def describe_wiring(settings: Settings, app: FastAPI) -> dict[str, Any]:
    """What is actually wired, for the startup log. No secrets, only shapes."""
    return {
        "app_env": settings.app_env.value,
        "database": bool(settings.database_url_rls),
        "auth": getattr(app.state, "verifier", None) is not None,
        "llm_provider": settings.llm_provider,
        "rate_limit_backend": settings.rate_limit_backend,
        "ingestion_runner": settings.ingestion_runner,
        "stt_provider": settings.stt_provider,
        "tts_provider": settings.tts_provider,
    }
