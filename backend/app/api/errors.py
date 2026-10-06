"""Stable application error codes and the single error response shape.

Every failure leaves through this module, so clients see one predictable envelope:

    {"error": {"code": "LESSON_NOT_FOUND", "message": "...", "request_id": "..."}}

Two rules worth stating because they are easy to erode:

* Production responses never carry stack traces, SQL, or raw provider error text. The detail
  goes to the logs, keyed by the same request id the client is handed.
* Authorization failures on resources whose existence is itself a secret return 404, not 403.
  A 403 confirms the row exists, which turns an id-guessing attempt into an enumeration oracle.
  Use :class:`NotFoundError` for those. :class:`ForbiddenError` is for resources the
  caller can already legitimately see.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

import orjson
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from app.core.logging import get_logger
from app.core.request_context import get_request_id

logger = get_logger(__name__)


def _request_id_for(request: Request) -> str | None:
    """Prefer the id stashed on the request.

    Starlette's outermost error handler runs after the correlation middleware has reset its
    context variables, so on the 500 path the context variable is already gone.
    """
    stashed = getattr(request.state, "request_id", None)
    return stashed if isinstance(stashed, str) else get_request_id()


class ErrorCode(StrEnum):
    """Stable, client-facing error identifiers. Values are API surface: never rename one."""

    # --- request shape -------------------------------------------------
    MALFORMED_REQUEST = "MALFORMED_REQUEST"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
    UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE"

    # --- identity and access -------------------------------------------
    UNAUTHENTICATED = "UNAUTHENTICATED"
    INVALID_TOKEN = "INVALID_TOKEN"  # noqa: S105 - an error code, not a credential
    FORBIDDEN = "FORBIDDEN"
    NOT_ENTITLED = "NOT_ENTITLED"

    # --- resources ------------------------------------------------------
    NOT_FOUND = "NOT_FOUND"
    LESSON_NOT_FOUND = "LESSON_NOT_FOUND"
    CONCEPT_NOT_FOUND = "CONCEPT_NOT_FOUND"
    PROFILE_NOT_FOUND = "PROFILE_NOT_FOUND"

    # --- state ----------------------------------------------------------
    CONFLICT = "CONFLICT"
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION"
    LESSON_NOT_PUBLISHED = "LESSON_NOT_PUBLISHED"
    INGESTION_ALREADY_RUNNING = "INGESTION_ALREADY_RUNNING"

    # --- content validation ---------------------------------------------
    GRAPH_INVALID = "GRAPH_INVALID"
    PROFILE_PATCH_INVALID = "PROFILE_PATCH_INVALID"

    # --- limits ----------------------------------------------------------
    RATE_LIMITED = "RATE_LIMITED"
    BUDGET_EXCEEDED = "BUDGET_EXCEEDED"

    # --- upstream ---------------------------------------------------------
    UPSTREAM_FAILURE = "UPSTREAM_FAILURE"
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    SPEECH_PROVIDER_BROWSER = "SPEECH_PROVIDER_BROWSER"
    AUTH_UNAVAILABLE = "AUTH_UNAVAILABLE"

    # --- catch-all ---------------------------------------------------------
    INTERNAL_ERROR = "INTERNAL_ERROR"


class ErrorBody(BaseModel):
    code: ErrorCode
    message: str = Field(description="Human-readable, safe to show a user.")
    request_id: str | None = Field(
        default=None, description="Correlates this response with server logs."
    )
    details: dict[str, Any] | None = Field(
        default=None,
        description="Structured, non-sensitive context. Present for validation failures.",
    )


class ErrorResponse(BaseModel):
    """The response body for every non-2xx response this service produces."""

    error: ErrorBody


class AppError(Exception):
    """Base class for failures with a defined client representation."""

    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR
    code: ErrorCode = ErrorCode.INTERNAL_ERROR
    message: str = "An unexpected error occurred."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: ErrorCode | None = None,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.message = message or self.message
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        self.details = details
        self.headers = headers or {}
        super().__init__(self.message)

    def to_response(self, request_id: str | None = None) -> Response:
        body = ErrorResponse(
            error=ErrorBody(
                code=self.code,
                message=self.message,
                request_id=request_id or get_request_id(),
                details=self.details,
            )
        )
        return Response(
            status_code=self.status_code,
            content=orjson.dumps(body.model_dump(mode="json", exclude_none=True)),
            media_type="application/json",
            headers=self.headers,
        )


# --------------------------------------------------------------------------
# Concrete errors, one per HTTP status in the brief's table.
# --------------------------------------------------------------------------
class MalformedRequestError(AppError):
    status_code = status.HTTP_400_BAD_REQUEST
    code = ErrorCode.MALFORMED_REQUEST
    message = "The request could not be understood."


class UnauthenticatedError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = ErrorCode.UNAUTHENTICATED
    message = "Authentication is required."

    def __init__(self, message: str | None = None, **kwargs: Any) -> None:
        headers = {"WWW-Authenticate": "Bearer", **(kwargs.pop("headers", None) or {})}
        super().__init__(message, headers=headers, **kwargs)


class ForbiddenError(AppError):
    """For resources the caller may already know exist. Otherwise prefer NotFoundError."""

    status_code = status.HTTP_403_FORBIDDEN
    code = ErrorCode.FORBIDDEN
    message = "You do not have permission to perform this action."


class NotFoundError(AppError):
    """Also the correct answer for "exists but you may not see it"."""

    status_code = status.HTTP_404_NOT_FOUND
    code = ErrorCode.NOT_FOUND
    message = "The requested resource does not exist."


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = ErrorCode.CONFLICT
    message = "The request conflicts with the current state of the resource."


class PayloadTooLargeError(AppError):
    status_code = status.HTTP_413_CONTENT_TOO_LARGE
    code = ErrorCode.PAYLOAD_TOO_LARGE
    message = "The request body is larger than this endpoint accepts."


class ValidationFailedError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    code = ErrorCode.VALIDATION_FAILED
    message = "The request was well-formed but failed validation."


class RateLimitError(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = ErrorCode.RATE_LIMITED
    message = "Too many requests. Please retry shortly."

    def __init__(self, *, retry_after_seconds: int, message: str | None = None) -> None:
        super().__init__(
            message,
            details={"retry_after_seconds": retry_after_seconds},
            headers={"Retry-After": str(retry_after_seconds)},
        )


class UpstreamError(AppError):
    status_code = status.HTTP_502_BAD_GATEWAY
    code = ErrorCode.UPSTREAM_FAILURE
    message = "An upstream provider failed."


class ServiceUnavailableError(AppError):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = ErrorCode.PROVIDER_UNAVAILABLE
    message = "The service is temporarily unavailable."


class UpstreamTimeoutError(AppError):
    status_code = status.HTTP_504_GATEWAY_TIMEOUT
    code = ErrorCode.UPSTREAM_TIMEOUT
    message = "An upstream provider did not respond in time."


# --------------------------------------------------------------------------
# Handlers
# --------------------------------------------------------------------------
async def _app_error_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, AppError)
    log = logger.warning if exc.status_code < 500 else logger.error
    log(
        "request_failed",
        extra={
            "error_code": exc.code.value,
            "status_code": exc.status_code,
            "detail": exc.message,
        },
    )
    return exc.to_response(_request_id_for(request))


async def _validation_handler(request: Request, exc: Exception) -> Response:
    """Pydantic rejections. The field paths are returned; submitted values are not."""
    assert isinstance(exc, RequestValidationError)
    fields = [
        {
            "location": ".".join(str(part) for part in err.get("loc", ())),
            "problem": err.get("msg", "invalid"),
        }
        for err in exc.errors()[:20]
    ]
    logger.warning(
        "request_validation_failed",
        extra={"error_code": ErrorCode.VALIDATION_FAILED.value, "status_code": 422},
    )
    return ValidationFailedError(details={"fields": fields}).to_response(_request_id_for(request))


async def _http_exception_handler(request: Request, exc: Exception) -> Response:
    """Starlette's own errors (404 routing, 405, body limits) in our envelope."""
    assert isinstance(exc, StarletteHTTPException)
    mapped = {
        status.HTTP_400_BAD_REQUEST: ErrorCode.MALFORMED_REQUEST,
        status.HTTP_401_UNAUTHORIZED: ErrorCode.UNAUTHENTICATED,
        status.HTTP_403_FORBIDDEN: ErrorCode.FORBIDDEN,
        status.HTTP_404_NOT_FOUND: ErrorCode.NOT_FOUND,
        status.HTTP_409_CONFLICT: ErrorCode.CONFLICT,
        status.HTTP_413_CONTENT_TOO_LARGE: ErrorCode.PAYLOAD_TOO_LARGE,
        status.HTTP_415_UNSUPPORTED_MEDIA_TYPE: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        status.HTTP_429_TOO_MANY_REQUESTS: ErrorCode.RATE_LIMITED,
    }.get(exc.status_code, ErrorCode.INTERNAL_ERROR)
    detail = exc.detail if isinstance(exc.detail, str) and exc.detail else "Request failed."
    return AppError(
        detail,
        code=mapped,
        status_code=exc.status_code,
        headers=dict(exc.headers or {}),
    ).to_response(_request_id_for(request))


async def _unhandled_handler(request: Request, exc: Exception) -> Response:
    """Last resort. The detail is logged; the client gets a request id and nothing else."""
    logger.exception(
        "unhandled_exception",
        extra={"error_code": ErrorCode.INTERNAL_ERROR.value, "status_code": 500},
        exc_info=exc,
    )
    return AppError().to_response(_request_id_for(request))


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(Exception, _unhandled_handler)
