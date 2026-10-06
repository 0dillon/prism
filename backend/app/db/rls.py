"""The single chokepoint through which request identity reaches Postgres.

Supabase's PostgREST establishes a request's identity by setting transaction-local
configuration before running the query: `request.jwt.claims` carries the verified JWT payload,
and `role` becomes the role from that payload. `auth.uid()` then reads the `sub` claim out of
that setting, and every row-level security policy is written in terms of it.

This module replicates that exactly, so the policies behave identically whether a query
arrives through PostgREST or through this backend.

Four independent things keep one request's identity from leaking into another:

1. **Postgres.** `set_config(..., is_local => true)` is reverted by the engine at COMMIT or
   ROLLBACK. That is transactional semantics, not best effort.
2. **asyncpg.** Releasing a connection to the pool runs `RESET ALL`, clearing any session
   setting as a backstop.
3. **The login role.** `prism_app` is NOINHERIT and holds no table grants. A code path that
   acquires a connection and forgets to establish identity gets "permission denied", not a
   silent full-table read. This is the layer that turns a bug into an error.
4. **A runtime assertion** that the connection really is `prism_app`, so a misconfigured DSN
   fails loudly rather than quietly running with more privilege than intended.

The transaction is mandatory. `SET LOCAL` outside a transaction block is a no-op with a
warning, which would leave `auth.uid()` NULL and every query returning nothing - and the
tempting "fix" for that symptom is session-scoped `SET`, which is exactly the leak this
design exists to prevent.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Final

from app.auth.identity import Identity
from app.core.config import get_settings
from app.db.pools import get_rls_pool
from app.db.types import RlsConnection

# The database role is chosen from this fixed set, never taken from the token. A token is
# attacker-influenced input; the role it maps to is a server decision.
ROLE_AUTHENTICATED: Final = "authenticated"
ROLE_ANON: Final = "anon"

# The login role the RLS pool must be connected as.
EXPECTED_LOGIN_ROLE: Final = "prism_app"

# Claims forwarded into the database. `user_metadata` is deliberately excluded: it is
# user-writable, it is never used for authorization, and it can be arbitrarily large.
_CLAIM_ALLOWLIST: Final[frozenset[str]] = frozenset(
    {
        "sub", "role", "aud", "iss", "exp", "iat",
        "email", "phone", "session_id", "aal", "is_anonymous", "app_metadata",
    }
)


class RlsSessionError(RuntimeError):
    """The RLS session could not be established safely."""


def claims_for_database(identity: Identity) -> str:
    """The JSON that becomes `request.jwt.claims`.

    Built with json.dumps rather than string concatenation because
    `current_setting('request.jwt.claims')::jsonb` is evaluated inside policies, on every row.
    Malformed JSON there would raise from within the authorization layer itself.
    """
    allowed = {k: v for k, v in identity.claims.items() if k in _CLAIM_ALLOWLIST}
    return json.dumps(allowed, separators=(",", ":"), default=str)


@asynccontextmanager
async def rls_session(
    identity: Identity | None,
    *,
    statement_timeout_ms: int | None = None,
    verify_role: bool = True,
) -> AsyncIterator[RlsConnection]:
    """Acquire a connection bound to `identity` for exactly one transaction.

    `identity=None` yields an anonymous session, for the few endpoints that serve signed-out
    visitors. A request needing two independent transactions opens this twice.
    """
    settings = get_settings()
    pool = get_rls_pool()

    async with pool.acquire() as connection:
        if verify_role:
            current_user = await connection.fetchval("select current_user")
            if current_user != EXPECTED_LOGIN_ROLE:
                raise RlsSessionError(
                    f"the RLS pool is connected as {current_user!r}, expected "
                    f"{EXPECTED_LOGIN_ROLE!r}. Refusing to run with unverified privilege."
                )

        async with connection.transaction():
            # Claims first, role second. Once the role is dropped to `authenticated` there are
            # fewer privileges available, and policies are evaluated per statement, so the
            # claims must already be in place.
            if identity is not None:
                await connection.execute(
                    "select set_config('request.jwt.claims', $1, true)",
                    claims_for_database(identity),
                )
                role = ROLE_AUTHENTICATED
            else:
                role = ROLE_ANON

            # set_config rather than `SET LOCAL ROLE`, because SET cannot take a parameter and
            # a literal would mean interpolating into SQL. The value is a module constant
            # regardless.
            await connection.execute("select set_config('role', $1, true)", role)
            await connection.execute("select set_config('search_path', 'public', true)")
            await connection.execute(
                "select set_config('statement_timeout', $1, true)",
                str(statement_timeout_ms or settings.db_statement_timeout_ms),
            )

            yield RlsConnection(connection)
        # COMMIT or ROLLBACK here. Every SET LOCAL above is discarded by Postgres, before the
        # connection returns to the pool.


@asynccontextmanager
async def anonymous_session(
    *, statement_timeout_ms: int | None = None
) -> AsyncIterator[RlsConnection]:
    """An explicitly anonymous session, for endpoints that serve signed-out visitors."""
    async with rls_session(None, statement_timeout_ms=statement_timeout_ms) as connection:
        yield connection


async def current_database_identity(connection: Any) -> dict[str, Any]:
    """What the database currently believes about the caller. Used by tests and diagnostics."""
    row = await connection.fetchrow(
        """
        select current_user                                    as login_role,
               current_setting('role', true)                   as active_role,
               (select auth.uid())::text                       as auth_uid,
               current_setting('request.jwt.claims', true)     as claims,
               current_setting('request.jwt.claim.sub', true)  as legacy_sub
        """
    )
    return dict(row) if row is not None else {}
