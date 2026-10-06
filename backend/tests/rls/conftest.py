"""Fixtures for database-backed tests.

Every test in this package is marked `requires_db` and skips cleanly when no database is
configured, so the default `pytest` run stays fast and infrastructure-free. They are written
in full and ready to execute: point `DATABASE_URL_RLS` at a migrated database and they run.

To run them:

    npx supabase start
    npx supabase db reset
    DATABASE_URL_RLS=postgresql://postgres:postgres@127.0.0.1:54322/postgres \\
      uv run pytest -m requires_db
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID, uuid4

import pytest

DATABASE_URL_ENV = "DATABASE_URL_RLS"

pytestmark = pytest.mark.requires_db


def database_url() -> str | None:
    return os.environ.get(DATABASE_URL_ENV) or None


@pytest.fixture(scope="session")
def require_database() -> str:
    url = database_url()
    if not url:
        pytest.skip(
            f"{DATABASE_URL_ENV} is not set. Start the local Supabase stack "
            "(`npx supabase start && npx supabase db reset`) and set it to run these tests."
        )
    return url


@pytest.fixture
async def connection(require_database: str) -> AsyncIterator[Any]:
    """A superuser connection, for arranging fixtures and asserting on raw state.

    Never used to exercise application behaviour: that goes through `rls_session`, so the
    tests cover the production code path rather than a convenient substitute.
    """
    import asyncpg

    conn = await asyncpg.connect(require_database)
    try:
        yield conn
    finally:
        await conn.close()


@pytest.fixture
async def isolated(connection: Any) -> AsyncIterator[Any]:
    """Wrap a test in a transaction that is always rolled back.

    Faster than resetting the database per test, and it keeps tests independent of each
    other's leftovers. `rls_session` opens a nested transaction, which Postgres implements as
    a savepoint, so `SET LOCAL` is still correctly scoped and discarded.
    """
    transaction = connection.transaction()
    await transaction.start()
    try:
        yield connection
    finally:
        await transaction.rollback()


@pytest.fixture
async def make_user(isolated: Any) -> Any:
    """Create an auth user, which the bootstrap trigger equips with a profile."""

    async def _make(email: str | None = None) -> UUID:
        user_id = uuid4()
        await isolated.execute(
            """
            insert into auth.users (id, instance_id, aud, role, email,
                                    encrypted_password, email_confirmed_at,
                                    raw_app_meta_data, raw_user_meta_data,
                                    created_at, updated_at)
            values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
                    'authenticated', $2, 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
            """,
            user_id,
            email or f"{user_id}@example.test",
        )
        return user_id

    return _make


def identity_for(user_id: UUID) -> Any:
    """A verified principal, as the verifier would produce from a real token."""
    from app.auth.identity import Identity

    return Identity(
        user_id=user_id,
        role="authenticated",
        session_id=str(uuid4()),
        claims={
            "sub": str(user_id),
            "role": "authenticated",
            "aud": "authenticated",
            "session_id": str(uuid4()),
        },
    )
