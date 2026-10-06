"""Privileged (service-role) database access.

Code holding a `PrivilegedConnection` is equivalent to root access to application data: the
service role bypasses row-level security entirely. So this module is built to make privileged
access rare, deliberate, visible and explainable.

* Every call names a `PrivilegedReason`. There is no default, so "why is this bypassing RLS?"
  is answered at the call site and greppable.
* Every privileged transaction logs at WARNING with its reason and the request id.
* The reason is also pushed into a database setting, so a trigger can record *why* a row was
  written without the caller remembering to.
* Importing this module is banned by ruff outside an allowlist in `pyproject.toml`, so adding
  a new privileged call site requires editing that file — a reviewable, greppable event.
* The pool is capped at three connections. If privileged access ever lands on a hot path by
  mistake, the service saturates and alerts rather than quietly running at full speed.

Before adding a value to `PrivilegedReason`, document in `docs/privileged-access.md` why
row-level security cannot cover the case, which tables are touched, and which authorization
invariant the caller is now responsible for upholding — the one RLS would otherwise have
enforced for free.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from enum import StrEnum
from typing import Final
from uuid import UUID

from app.core.logging import get_logger
from app.core.request_context import get_request_id
from app.db.pools import get_privileged_pool
from app.db.types import PrivilegedConnection

logger = get_logger(__name__)

EXPECTED_LOGIN_ROLE: Final = "prism_service"


class PrivilegedReason(StrEnum):
    """Every value must have an entry in docs/privileged-access.md."""

    # No end-user JWT exists: the caller is Stripe, and by design no `authenticated` role may
    # ever write `purchases` - otherwise a learner could grant themselves entitlement.
    STRIPE_CHECKOUT_COMPLETED = "stripe_checkout_completed"
    STRIPE_CHARGE_REFUNDED = "stripe_charge_refunded"
    STRIPE_ACCOUNT_UPDATED = "stripe_account_updated"

    # The invitee is not yet a member, so no policy predicate can authorise their own insert
    # without opening a self-join hole.
    ORG_INVITE_ACCEPT = "org_invite_accept"

    # Must read across every tenant-scoped table for one data subject.
    GDPR_EXPORT = "gdpr_export"
    GDPR_DELETE = "gdpr_delete"

    # Cross-tenant by definition. Read-only, aggregate-only.
    PLATFORM_ANALYTICS = "platform_analytics"
    MODERATION_QUEUE = "moderation_queue"

    # Server-owned operational tables with no policies at all.
    USAGE_ACCOUNTING = "usage_accounting"
    RATE_LIMIT_ACCOUNTING = "rate_limit_accounting"
    IDEMPOTENCY_LEDGER = "idempotency_ledger"


@asynccontextmanager
async def privileged_session(
    reason: PrivilegedReason,
    *,
    subject_id: UUID | None = None,
    actor_id: UUID | None = None,
) -> AsyncIterator[PrivilegedConnection]:
    """Acquire a service-role connection for one transaction.

    Args:
        reason: why row-level security cannot cover this operation.
        subject_id: the user this is being done to or for, where there is one.
        actor_id: who requested it, where a person did.
    """
    logger.warning(
        "privileged_db_access",
        extra={
            "reason": reason.value,
            "subject_id": str(subject_id) if subject_id else None,
            "actor_id": str(actor_id) if actor_id else None,
            "request_id": get_request_id(),
        },
    )

    pool = get_privileged_pool()
    async with pool.acquire() as connection:
        current_user = await connection.fetchval("select current_user")
        if current_user != EXPECTED_LOGIN_ROLE:
            raise RuntimeError(
                f"the privileged pool is connected as {current_user!r}, expected "
                f"{EXPECTED_LOGIN_ROLE!r}"
            )

        async with connection.transaction():
            await connection.execute("select set_config('role', 'service_role', true)")
            await connection.execute("select set_config('search_path', 'public', true)")
            await connection.execute(
                "select set_config('app.privileged_reason', $1, true)", reason.value
            )
            yield PrivilegedConnection(connection)
