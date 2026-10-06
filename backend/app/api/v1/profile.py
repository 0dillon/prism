"""Render profile endpoints.

    PUT  /api/profile        Save the learner's own profile
    POST /api/profile/parse  Describe needs in plain language (PRD CE-4, 5.4A)

A learner reads and writes only their own profile. There is no path here that accepts a user
id, and none that lets one account read another's settings - PRD 6.4 and B2B-5 make profiles
private by default, and the row-level security policy enforces it independently.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.ai.intents.profile import MAX_REQUEST_CHARACTERS, ProfileParser
from app.ai.types import UsageContext
from app.api.dependencies import CurrentUser, Db, Gateway, Limiter, enforce_rate_limit
from app.api.errors import ErrorResponse
from app.repositories import profiles as profile_repo
from app.schemas.render_profile import RenderProfile

router = APIRouter(tags=["profile"])


class ProfileEnvelope(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    profile: RenderProfile


class ParseRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    text: Annotated[str, Field(max_length=MAX_REQUEST_CHARACTERS)] = Field(
        description="What the learner said, in their own words."
    )


class ParseResponse(BaseModel):
    """What changed, in terms a learner can read and undo (PRD 5.4A step 4)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    profile: RenderProfile = Field(description="The profile after the change, or unchanged.")
    changed: bool
    explanation: str = Field(description="Plain language, addressed to the learner.")
    unsupported: list[str] = Field(
        default_factory=list,
        description="Anything no setting covers, so the client can say so plainly.",
    )


@router.get(
    "/profile",
    response_model=ProfileEnvelope,
    summary="Read your own Render Profile",
    description="Returns the caller's profile, creating the default one if they have none.",
)
async def read_profile(user: CurrentUser, db: Db) -> ProfileEnvelope:
    return ProfileEnvelope(profile=await profile_repo.get_or_create_profile(db, user.user_id))


@router.put(
    "/profile",
    response_model=ProfileEnvelope,
    summary="Save your own Render Profile",
    description=(
        "Replaces the caller's profile. The whole profile is sent, validated against the "
        "schema, and stored only if valid. Sharing consent is not changed by this endpoint."
    ),
    responses={422: {"model": ErrorResponse, "description": "The profile is not valid"}},
)
async def save_profile(
    payload: ProfileEnvelope, user: CurrentUser, db: Db
) -> ProfileEnvelope:
    # Validation happened during request parsing: an invalid profile never reaches storage.
    await profile_repo.save_profile(db, user.user_id, payload.profile)
    return payload


@router.post(
    "/profile/parse",
    response_model=ParseResponse,
    status_code=status.HTTP_200_OK,
    summary="Turn a description of your needs into settings",
    description=(
        "Interprets free text or a speech transcript against the caller's current profile.\n\n"
        "The model proposes a patch; the server validates the merged result and stores it only "
        "if it is valid. **A failed interpretation never changes the stored profile** - the "
        "response carries the unchanged profile and an explanation. Requests that no setting "
        "covers are returned in `unsupported` and recorded so the product can grow to cover "
        "them.\n\n"
        "Rate limited per user."
    ),
    responses={429: {"model": ErrorResponse, "description": "Rate limited"}},
)
async def parse_needs(
    payload: ParseRequest,
    request: Request,
    user: CurrentUser,
    db: Db,
    gateway: Gateway,
    limiter: Limiter,
) -> ParseResponse:
    await enforce_rate_limit(
        request=request, operation="profile.parse", identity=user, limiter=limiter
    )

    current = await profile_repo.get_or_create_profile(db, user.user_id)
    parser = ProfileParser(gateway)
    result = await parser.parse(
        request_text=payload.text,
        current=current,
        context=UsageContext(operation="profile.parse", user_id=user.user_id),
    )

    if result.changed:
        await profile_repo.save_profile(db, user.user_id, result.profile)

    # PRD 5.4A step 5: requests no setting covers guide the roadmap rather than vanishing.
    for unmet in result.unsupported:
        await profile_repo.record_unmet_need(db, user.user_id, unmet)

    return ParseResponse(
        profile=result.profile,
        changed=result.changed,
        explanation=result.explanation,
        unsupported=result.unsupported,
    )
