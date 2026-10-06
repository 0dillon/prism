"""HTTP middleware: request correlation, access logging, and body size limits."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

import orjson
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.errors import ErrorBody, ErrorCode, ErrorResponse
from app.core.logging import get_logger
from app.core.request_context import (
    bind_request_context,
    get_request_id,
    new_request_id,
    reset_request_context,
    sanitize_request_id,
)

logger = get_logger(__name__)

REQUEST_ID_HEADER = "X-Request-ID"

# Health checks are polled constantly by orchestrators; logging each one buries real traffic.
_QUIET_PATHS = frozenset({"/health/live", "/health/ready"})


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a request id, binds it for the duration, and emits one access log line."""

    def __init__(self, app: ASGIApp, *, request_id_max_length: int) -> None:
        super().__init__(app)
        self._max_length = request_id_max_length

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        inbound = sanitize_request_id(
            request.headers.get(REQUEST_ID_HEADER), max_length=self._max_length
        )
        request_id = inbound or new_request_id()

        # Also on request.state, because Starlette's outermost error handler runs after this
        # middleware has reset its context variables. Without this, a 500 response would be
        # the one response that could not be correlated with its logs.
        request.state.request_id = request_id

        tokens = bind_request_context(request_id=request_id, route=request.url.path)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            # The exception handlers produce the body and log the traceback. Here we only
            # record timing, then re-raise so that chain still runs.
            logger.warning(
                "request_errored",
                extra={
                    "method": request.method,
                    "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                },
            )
            reset_request_context(tokens)
            raise

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers[REQUEST_ID_HEADER] = request_id

        if request.url.path not in _QUIET_PATHS:
            logger.info(
                "request_completed",
                extra={
                    "method": request.method,
                    "route": _matched_route(request) or request.url.path,
                    "status_code": response.status_code,
                    "latency_ms": latency_ms,
                },
            )
        reset_request_context(tokens)
        return response


def _matched_route(request: Request) -> str | None:
    """The path template (e.g. /api/lessons/{lesson_id}), so logs group by route not by id."""
    route: Any = request.scope.get("route")
    path_format = getattr(route, "path_format", None)
    return path_format if isinstance(path_format, str) else None


class BodySizeLimitMiddleware:
    """Rejects oversized request bodies before they are buffered.

    Implemented as raw ASGI rather than BaseHTTPMiddleware so the limit applies while the body
    streams. Checking Content-Length alone is not enough: a chunked request can omit it, and a
    dishonest one can understate it.
    """

    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = _declared_length(scope)
        if declared is not None and declared > self.max_bytes:
            await self._reject(send)
            return

        received = 0
        exceeded = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    exceeded = True
                    # Signal end-of-body so the application stops waiting; the 413 below is
                    # what the client actually sees.
                    return {"type": "http.disconnect"}
            return message

        await self.app(scope, limited_receive, send)
        if exceeded:
            logger.warning(
                "request_body_limit_exceeded",
                extra={"error_code": ErrorCode.PAYLOAD_TOO_LARGE.value, "limit": self.max_bytes},
            )

    async def _reject(self, send: Send) -> None:
        body = ErrorResponse(
            error=ErrorBody(
                code=ErrorCode.PAYLOAD_TOO_LARGE,
                message="The request body is larger than this endpoint accepts.",
                request_id=get_request_id(),
                details={"max_bytes": self.max_bytes},
            )
        )
        payload = orjson.dumps(body.model_dump(mode="json", exclude_none=True))
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode("latin-1")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})


def _declared_length(scope: Scope) -> int | None:
    """The Content-Length the client claims, when it supplies a usable one.

    Only a hint: chunked requests omit it and a dishonest client can understate it, which is
    why the streaming counter above is the actual enforcement.
    """
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            try:
                return int(value)
            except (ValueError, TypeError):
                return None
    return None
