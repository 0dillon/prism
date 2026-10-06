"""Render profile persistence.

Every query runs on an `RlsConnection`, so row-level security applies: the policy on
`render_profiles` restricts a learner to their own row, and the sharing branch requires the
learner's explicit opt-in. That is the enforcement. The `where user_id = $1` clauses below are
a second, independent statement of the same rule, not the thing keeping the data private.
"""

from __future__ import annotations

from uuid import UUID

import orjson

from app.db.types import RlsConnection
from app.domain.profiles.presets import default_profile
from app.schemas.render_profile import RenderProfile


async def get_profile(connection: RlsConnection, user_id: UUID) -> RenderProfile | None:
    """The learner's stored profile, or None if they have none yet."""
    row = await connection.fetchrow(
        "select profile from public.render_profiles where user_id = $1", user_id
    )
    if row is None:
        return None
    # Validated rather than trusted: a profile written under an older schema version upgrades
    # cleanly because every field has a default, and one that cannot be read at all is better
    # replaced than served.
    return RenderProfile.model_validate(row["profile"])


async def get_or_create_profile(
    connection: RlsConnection, user_id: UUID
) -> RenderProfile:
    """The learner's profile, creating the default one if the bootstrap trigger has not."""
    existing = await get_profile(connection, user_id)
    if existing is not None:
        return existing

    profile = default_profile()
    await connection.execute(
        """
        insert into public.render_profiles (user_id, profile)
        values ($1, $2::jsonb)
        on conflict (user_id) do nothing
        """,
        user_id,
        orjson.dumps(profile.model_dump(mode="json", by_alias=True)).decode(),
    )
    return await get_profile(connection, user_id) or profile


async def save_profile(
    connection: RlsConnection, user_id: UUID, profile: RenderProfile
) -> None:
    """Replace the learner's profile.

    `share_with_teachers` is deliberately not touched here. It is a consent decision with its
    own audited path, and a profile save - which happens constantly as a learner adjusts
    settings - must never be able to change it as a side effect.
    """
    await connection.execute(
        """
        insert into public.render_profiles (user_id, profile)
        values ($1, $2::jsonb)
        on conflict (user_id) do update set profile = excluded.profile
        """,
        user_id,
        orjson.dumps(profile.model_dump(mode="json", by_alias=True)).decode(),
    )


async def set_sharing_consent(
    connection: RlsConnection, user_id: UUID, *, share: bool
) -> None:
    """Record the learner's decision to share their settings with their teachers.

    The audit entry is written by a database trigger rather than here, so the record exists
    whichever path changes the flag (PRD 6.4, task P6-09).
    """
    await connection.execute(
        "update public.render_profiles set share_with_teachers = $2 where user_id = $1",
        user_id,
        share,
    )


async def record_unmet_need(
    connection: RlsConnection, user_id: UUID | None, request_text: str
) -> None:
    """Store a request no setting covers (PRD 5.4A step 5).

    Free learner text, so it is length-bounded here as well as by a database constraint, and
    it needs a retention policy before any school pilot (PRD 9.3).
    """
    text = request_text.strip()[:2000]
    if not text:
        return
    await connection.execute(
        "insert into public.unmet_needs (user_id, request_text) values ($1, $2)",
        user_id,
        text,
    )
