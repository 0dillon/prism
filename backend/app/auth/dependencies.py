"""FastAPI dependencies for authentication.

`CurrentUser` is how a route states that it needs a principal. There is no variant that reads
an identity from the request body or a query parameter, so a route cannot accidentally be
written against an unauthenticated caller's claim about who they are.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.api.errors import AppError, ErrorCode, ServiceUnavailableError, UnauthenticatedError
from app.auth.identity import Identity
from app.auth.jwks import JwksUnavailableError
from app.auth.verifier import InvalidTokenError, Verifier
from app.core.request_context import set_user_id

# auto_error=False so a missing header produces our error envelope rather than Starlette's.
_bearer = HTTPBearer(auto_error=False, description="Supabase access token.")


def get_verifier(request: Request) -> Verifier:
    verifier = getattr(request.app.state, "verifier", None)
    if verifier is None:
        raise ServiceUnavailableError(
            "Authentication is not configured.", code=ErrorCode.AUTH_UNAVAILABLE
        )
    return verifier  # type: ignore[no-any-return]


async def current_identity(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    verifier: Annotated[Verifier, Depends(get_verifier)],
) -> Identity:
    """The verified principal. Raises 401 when absent or invalid, 503 when keys are missing."""
    if credentials is None or not credentials.credentials:
        raise UnauthenticatedError("A bearer token is required.")

    try:
        identity = await verifier.verify(credentials.credentials)
    except InvalidTokenError as exc:
        raise UnauthenticatedError(
            "The access token is not valid.", code=ErrorCode.INVALID_TOKEN
        ) from exc
    except JwksUnavailableError as exc:
        # Not a 401. The token may be perfectly good; we cannot currently check it. Answering
        # 401 would send every client into a re-authentication loop and amplify the outage.
        raise ServiceUnavailableError(
            "Authentication is temporarily unavailable. Please retry shortly.",
            code=ErrorCode.AUTH_UNAVAILABLE,
        ) from exc

    # Correlates subsequent log lines for this request with the learner, for debugging.
    set_user_id(str(identity.user_id))
    return identity


async def optional_identity(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    verifier: Annotated[Verifier, Depends(get_verifier)],
) -> Identity | None:
    """For the few endpoints that serve signed-out visitors.

    A token that is present but invalid is still rejected: silently degrading a bad token to
    "anonymous" would hide expiry bugs and let a revoked session keep working in a lesser mode.
    """
    if credentials is None or not credentials.credentials:
        return None
    try:
        return await current_identity(credentials, verifier)
    except AppError:
        raise


CurrentUser = Annotated[Identity, Depends(current_identity)]
MaybeUser = Annotated[Identity | None, Depends(optional_identity)]
