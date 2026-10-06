"""Application entry point.

Wiring only. Nothing here contains business logic, and nothing below this module imports it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.bootstrap import describe_wiring, start_services, stop_services
from app.api.errors import ErrorResponse, register_exception_handlers
from app.api.health import router as health_router
from app.api.middleware import BodySizeLimitMiddleware, RequestContextMiddleware
from app.api.router import api_router
from app.core.config import Settings, get_settings
from app.core.logging import configure_logging, get_logger
from app.core.readiness import clear_probes

logger = get_logger(__name__)

DESCRIPTION = """
Prism separates educational knowledge from its presentation.

A teacher or creator uploads a source once. The ingestion pipeline extracts a **Knowledge
Graph**. When a learner opens the lesson, the client composes an interface from that graph
according to the learner's **Render Profile**. Every renderer emits the same interface-agnostic
**Learning Events** against the same concept IDs, so progress is comparable across learners
regardless of how they consumed the lesson.

This service owns educational state. Renderers consume its contracts; they never own progress.

**Authentication.** All endpoints except `/health/*` require a Supabase-issued bearer token.
The authenticated principal is always taken from the verified token, never from the request
body. No endpoint accepts a client-supplied user id.

**Errors.** Every non-2xx response uses a single envelope with a stable `code` and the
`request_id` that correlates it with server logs.
""".strip()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    configure_logging(level=settings.log_level, service_name=settings.service_name)

    wiring = await start_services(app, settings)
    logger.info("startup", extra=describe_wiring(settings, app))

    try:
        yield
    finally:
        await stop_services(app, wiring)
        clear_probes()
        logger.info("shutdown")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(
        title="Prism API",
        description=DESCRIPTION,
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if settings.expose_docs else None,
        redoc_url="/redoc" if settings.expose_docs else None,
        openapi_url="/openapi.json" if settings.expose_docs else None,
        responses={
            400: {"model": ErrorResponse, "description": "Malformed request"},
            401: {"model": ErrorResponse, "description": "Unauthenticated"},
            403: {"model": ErrorResponse, "description": "Authenticated but not permitted"},
            404: {"model": ErrorResponse, "description": "Not found, or not visible to you"},
            422: {"model": ErrorResponse, "description": "Validation failure"},
            429: {"model": ErrorResponse, "description": "Rate limited"},
            500: {"model": ErrorResponse, "description": "Unexpected server failure"},
        },
    )

    # Held on app.state so the lifespan hook and tests share one resolved configuration
    # rather than each re-reading the environment.
    app.state.settings = settings

    # Added innermost-first: the most recently added middleware is the outermost, so request
    # correlation wraps the size limit and a 413 still carries a request id.
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_request_bytes)
    app.add_middleware(
        RequestContextMiddleware, request_id_max_length=settings.request_id_max_length
    )

    register_exception_handlers(app)

    app.include_router(health_router)
    app.include_router(api_router)
    return app


app = create_app()
