"""Aggregates the versioned API surface.

PRD section 7.5 defines paths under `/api/...` with no version segment, and the brief requires
those paths be preserved exactly. Versioning is therefore structural rather than visible:
route modules live under `app/api/v1/` so a future `/api/v2` can be introduced without moving
code, but the mounted prefix stays `/api`.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import events, profile, session

api_router = APIRouter(prefix="/api")

api_router.include_router(profile.router)
api_router.include_router(session.router)
api_router.include_router(events.router)

# Still to be mounted as their milestones land: lessons (create, ingest, status, graph,
# publish, read), variants, and the streaming tutor turn.
