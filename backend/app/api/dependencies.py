"""Shared request dependencies: services, database sessions, and rate limiting.

Services are built once at startup and held on `app.state`, not constructed per request. A
gateway rebuilt per request would reset its circuit breaker and its concurrency semaphore on
every call, which would quietly disable both.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request

from app.ai.gateway import LlmGateway
from app.api.errors import RateLimitError, ServiceUnavailableError
from app.auth.dependencies import CurrentUser, MaybeUser
from app.auth.identity import Identity
from app.core.config import Settings
from app.core.rate_limit import DEFAULT_LIMITS, RateLimit, RateLimiter, bucket_for
from app.db.rls import rls_session
from app.db.types import RlsConnection


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_gateway(request: Request) -> LlmGateway:
    gateway = getattr(request.app.state, "gateway", None)
    if gateway is None:
        raise ServiceUnavailableError("The AI gateway is not configured.")
    return gateway  # type: ignore[no-any-return]


def get_rate_limiter(request: Request) -> RateLimiter:
    limiter = getattr(request.app.state, "rate_limiter", None)
    if limiter is None:
        raise ServiceUnavailableError("Rate limiting is not configured.")
    return limiter  # type: ignore[no-any-return]


def client_ip(request: Request) -> str | None:
    """The caller's address, for keying anonymous rate limits.

    Only the first entry of X-Forwarded-For, and only because the deployment terminates TLS at
    a proxy it controls. The header is client-supplied and trivially forged, so it is used for
    rate-limit bucketing and nothing else - never for an authorisation decision.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64] or None
    return request.client.host if request.client else None


Gateway = Annotated[LlmGateway, Depends(get_gateway)]
AppSettings = Annotated[Settings, Depends(get_settings_dep)]
Limiter = Annotated[RateLimiter, Depends(get_rate_limiter)]


async def db_session(user: CurrentUser) -> AsyncIterator[RlsConnection]:
    """A database session carrying the authenticated identity.

    One transaction per dependency. A handler needing two independent transactions opens a
    second session explicitly rather than reusing this one, so transaction boundaries stay
    visible in the handler rather than hidden in a dependency.
    """
    async with rls_session(user) as connection:
        yield connection


Db = Annotated[RlsConnection, Depends(db_session)]


async def enforce_rate_limit(
    *,
    request: Request,
    operation: str,
    identity: Identity | None,
    limiter: RateLimiter,
    limit: RateLimit | None = None,
) -> None:
    """Check a quota and raise 429 with a retry time when it is exceeded.

    Anonymous callers use the stricter `<operation>.anonymous` limit where one is defined,
    because an unauthenticated endpoint is the easiest surface to abuse.
    """
    user_id = str(identity.user_id) if identity is not None else None
    resolved = limit
    if resolved is None:
        key = operation if user_id else f"{operation}.anonymous"
        resolved = DEFAULT_LIMITS.get(key) or DEFAULT_LIMITS[operation]

    decision = await limiter.check(
        bucket_for(operation, user_id=user_id, ip=client_ip(request)), resolved
    )
    if not decision.allowed:
        raise RateLimitError(retry_after_seconds=decision.retry_after_seconds)


__all__ = [
    "AppSettings",
    "CurrentUser",
    "Db",
    "Gateway",
    "Limiter",
    "MaybeUser",
    "client_ip",
    "enforce_rate_limit",
]
