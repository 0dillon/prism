"""Connection pools.

Two pools, two Postgres login roles, held in module-private globals rather than a dict keyed
by a string so there is no code path that can ask for "the privileged pool" by name.

The privileged pool is deliberately tiny. If privileged access ever lands on a hot path by
mistake, the service saturates and alerts rather than quietly exfiltrating at full speed.
"""

from __future__ import annotations

from typing import Any

import asyncpg
import orjson

from app.core.config import Settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_rls_pool: asyncpg.Pool[Any] | None = None
_privileged_pool: asyncpg.Pool[Any] | None = None


class DatabaseNotReadyError(RuntimeError):
    """A pool was requested before startup wired it up."""


async def _init_connection(connection: asyncpg.Connection[Any]) -> None:
    """Per-connection setup.

    asyncpg hands back jsonb as raw strings by default. Registering codecs here means
    repositories work with Python objects and nothing has to remember to call json.loads.
    """
    for type_name in ("json", "jsonb"):
        await connection.set_type_codec(
            type_name,
            encoder=lambda value: orjson.dumps(value).decode(),
            decoder=orjson.loads,
            schema="pg_catalog",
        )


def _pool_kwargs(settings: Settings) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "init": _init_connection,
        "command_timeout": settings.db_statement_timeout_ms / 1000,
        "timeout": settings.db_connect_timeout_seconds,
    }
    if settings.db_use_transaction_pooler:
        # A transaction-mode pooler hands out a different backend per transaction, so a
        # prepared statement cached against one connection will not exist on the next.
        kwargs["statement_cache_size"] = 0
    return kwargs


async def open_pools(settings: Settings) -> None:
    """Create both pools. Called once, from the application lifespan."""
    global _rls_pool, _privileged_pool

    if not settings.database_url_rls:
        raise DatabaseNotReadyError("DATABASE_URL_RLS is not configured")

    _rls_pool = await asyncpg.create_pool(
        settings.database_url_rls,
        min_size=settings.db_rls_pool_min_size,
        max_size=settings.db_rls_pool_max_size,
        **_pool_kwargs(settings),
    )
    logger.info(
        "db_pool_opened",
        extra={"pool": "rls", "max_size": settings.db_rls_pool_max_size},
    )

    if settings.database_url_privileged:
        _privileged_pool = await asyncpg.create_pool(
            settings.database_url_privileged,
            min_size=settings.db_privileged_pool_min_size,
            max_size=settings.db_privileged_pool_max_size,
            **_pool_kwargs(settings),
        )
        logger.info(
            "db_pool_opened",
            extra={"pool": "privileged", "max_size": settings.db_privileged_pool_max_size},
        )


async def close_pools() -> None:
    global _rls_pool, _privileged_pool
    for pool in (_rls_pool, _privileged_pool):
        if pool is not None:
            await pool.close()
    _rls_pool = None
    _privileged_pool = None
    logger.info("db_pools_closed")


def get_rls_pool() -> asyncpg.Pool[Any]:
    if _rls_pool is None:
        raise DatabaseNotReadyError("the RLS pool is not open")
    return _rls_pool


def get_privileged_pool() -> asyncpg.Pool[Any]:
    if _privileged_pool is None:
        raise DatabaseNotReadyError("the privileged pool is not open")
    return _privileged_pool


def set_pools_for_testing(
    *,
    rls: asyncpg.Pool[Any] | None,
    privileged: asyncpg.Pool[Any] | None = None,
) -> None:
    """Point the module at test pools. Only used from the test suite."""
    global _rls_pool, _privileged_pool
    _rls_pool = rls
    _privileged_pool = privileged


async def check_database_ready() -> None:
    """Readiness probe. Deliberately trivial: this answers reachability, not correctness."""
    pool = get_rls_pool()
    async with pool.acquire() as connection:
        await connection.execute("select 1")
