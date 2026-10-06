"""Learning event ingestion (PRD 5.7, task P5-02).

    POST /api/events

The highest-volume endpoint in the product: every renderer flushes a batch every five seconds
and on page hide. Three things it must get right, each enforced twice.

**Identity.** The batch carries no user id; the server stamps the authenticated principal, and
the row-level security `WITH CHECK` rejects anything else. A learner cannot write events
attributed to someone else, and therefore cannot corrupt another student's mastery.

**Idempotency.** Event ids are client-generated ULIDs and are the primary key; inserts ignore
conflicts. Replaying a batch creates nothing, which is what makes the client's retry-with-
backoff queue safe.

**Cheapness.** Mastery is maintained by a database trigger rather than recomputed here, so an
event insert stays an insert. PRD 5.7 is explicit that progress is derived, not reported.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status

from app.api.dependencies import CurrentUser, Db, Limiter, enforce_rate_limit
from app.api.errors import ErrorResponse
from app.repositories import events as events_repo
from app.schemas.events import EventIngestResult, LearningEventBatch

router = APIRouter(tags=["events"])


@router.post(
    "/events",
    response_model=EventIngestResult,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Record a batch of Learning Events",
    description=(
        "Accepts a batch of interface-agnostic Learning Events.\n\n"
        "**Identity is taken from the access token.** The payload carries no user id, and one "
        "cannot be supplied.\n\n"
        "**Safe to retry.** Each event carries a client-generated ULID which is its "
        "idempotency key; re-sending a batch inserts nothing new. The response reports how "
        "many were new and how many were already recorded, so a client can confirm its retry "
        "was recognised.\n\n"
        "Per-event `durationMs` is capped at 60 seconds on write, per PRD 5.7."
    ),
    responses={
        413: {"model": ErrorResponse, "description": "Batch too large"},
        422: {"model": ErrorResponse, "description": "An event failed validation"},
        429: {"model": ErrorResponse, "description": "Rate limited"},
    },
)
async def ingest_events(
    batch: LearningEventBatch,
    request: Request,
    user: CurrentUser,
    db: Db,
    limiter: Limiter,
) -> EventIngestResult:
    await enforce_rate_limit(
        request=request, operation="events", identity=user, limiter=limiter
    )
    return await events_repo.insert_events(db, user_id=user.user_id, events=batch.events)
