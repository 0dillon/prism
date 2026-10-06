"""Operational health endpoints.

These are unauthenticated by design: an orchestrator cannot hold a user credential. They
therefore expose no information beyond which named subsystems are reachable.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, Field

from app.core.readiness import check_readiness

router = APIRouter(tags=["health"])


class LivenessResponse(BaseModel):
    status: str = Field(examples=["alive"])


class ReadinessResponse(BaseModel):
    status: str = Field(examples=["ready", "not_ready"])
    checks: dict[str, str] = Field(
        default_factory=dict,
        description="Per-dependency outcome: ok, failed or timeout.",
    )


@router.get(
    "/health/live",
    response_model=LivenessResponse,
    summary="Process liveness",
    description="Returns 200 whenever the process can serve requests. Checks no dependencies.",
)
async def liveness() -> LivenessResponse:
    return LivenessResponse(status="alive")


@router.get(
    "/health/ready",
    response_model=ReadinessResponse,
    summary="Traffic readiness",
    description=(
        "Returns 200 when every registered dependency probe succeeds, otherwise 503. "
        "Use this to gate load balancer traffic, never to decide whether to restart."
    ),
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ReadinessResponse}},
)
async def readiness(response: Response) -> ReadinessResponse:
    result = await check_readiness()
    if not result.ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        status="ready" if result.ready else "not_ready",
        checks=result.checks,
    )
