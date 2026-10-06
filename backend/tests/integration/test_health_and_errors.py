"""Health endpoints and the single error envelope."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.errors import ErrorCode, ForbiddenError, NotFoundError, RateLimitError
from app.api.middleware import REQUEST_ID_HEADER
from app.core.readiness import clear_probes, register_probe


class TestLiveness:
    def test_liveness_is_always_served(self, client: TestClient) -> None:
        response = client.get("/health/live")
        assert response.status_code == 200
        assert response.json() == {"status": "alive"}

    def test_liveness_ignores_failing_dependencies(self, client: TestClient) -> None:
        """A database blip must not make orchestrators restart healthy processes."""

        async def broken() -> None:
            raise RuntimeError("database unreachable")

        register_probe("database", broken)
        try:
            assert client.get("/health/live").status_code == 200
            assert client.get("/health/ready").status_code == 503
        finally:
            clear_probes()


class TestReadiness:
    def test_ready_with_no_registered_dependencies(self, client: TestClient) -> None:
        response = client.get("/health/ready")
        assert response.status_code == 200
        assert response.json()["status"] == "ready"

    def test_a_failing_probe_removes_the_instance_from_traffic(
        self, client: TestClient
    ) -> None:
        async def ok() -> None:
            return None

        async def broken() -> None:
            raise RuntimeError("down")

        register_probe("llm", ok)
        register_probe("database", broken)
        try:
            response = client.get("/health/ready")
            assert response.status_code == 503
            body = response.json()
            assert body["status"] == "not_ready"
            assert body["checks"] == {"llm": "ok", "database": "failed"}
        finally:
            clear_probes()

    def test_a_hanging_probe_times_out_rather_than_hanging_the_endpoint(
        self, client: TestClient
    ) -> None:
        import asyncio

        async def hangs() -> None:
            await asyncio.sleep(30)

        register_probe("slow", hangs)
        try:
            response = client.get("/health/ready")
            assert response.status_code == 503
            assert response.json()["checks"]["slow"] == "timeout"
        finally:
            clear_probes()


class TestRequestCorrelation:
    def test_every_response_carries_a_request_id(self, client: TestClient) -> None:
        assert client.get("/health/live").headers[REQUEST_ID_HEADER]

    def test_a_safe_inbound_request_id_is_adopted(self, client: TestClient) -> None:
        response = client.get("/health/live", headers={REQUEST_ID_HEADER: "trace-abc.1"})
        assert response.headers[REQUEST_ID_HEADER] == "trace-abc.1"

    def test_an_unsafe_inbound_request_id_is_replaced(self, client: TestClient) -> None:
        response = client.get("/health/live", headers={REQUEST_ID_HEADER: "bad\nvalue"})
        assert response.headers[REQUEST_ID_HEADER] != "bad\nvalue"
        assert "\n" not in response.headers[REQUEST_ID_HEADER]


class TestErrorEnvelope:
    @pytest.fixture
    def failing_app(self, app: FastAPI) -> FastAPI:
        @app.get("/test/not-found")
        async def _not_found() -> None:
            raise NotFoundError(
                "The requested lesson does not exist.", code=ErrorCode.LESSON_NOT_FOUND
            )

        @app.get("/test/forbidden")
        async def _forbidden() -> None:
            raise ForbiddenError()

        @app.get("/test/rate-limited")
        async def _rate_limited() -> None:
            raise RateLimitError(retry_after_seconds=30)

        @app.get("/test/boom")
        async def _boom() -> None:
            raise RuntimeError("secret internal detail: sk-proj1234567890abcdefghij")

        return app

    def test_application_errors_use_the_envelope(self, failing_app: FastAPI) -> None:
        with TestClient(failing_app, raise_server_exceptions=False) as client:
            response = client.get("/test/not-found")
        assert response.status_code == 404
        body = response.json()["error"]
        assert body["code"] == "LESSON_NOT_FOUND"
        assert body["message"] == "The requested lesson does not exist."
        assert body["request_id"]

    def test_rate_limiting_returns_a_retry_indication(self, failing_app: FastAPI) -> None:
        with TestClient(failing_app, raise_server_exceptions=False) as client:
            response = client.get("/test/rate-limited")
        assert response.status_code == 429
        assert response.headers["Retry-After"] == "30"
        assert response.json()["error"]["details"]["retry_after_seconds"] == 30

    def test_unhandled_errors_never_leak_internals(self, failing_app: FastAPI) -> None:
        with TestClient(failing_app, raise_server_exceptions=False) as client:
            response = client.get("/test/boom")
        assert response.status_code == 500
        raw = response.text
        assert "sk-proj1234567890abcdefghij" not in raw
        assert "Traceback" not in raw
        assert "RuntimeError" not in raw
        body = response.json()["error"]
        assert body["code"] == "INTERNAL_ERROR"
        assert body["request_id"]

    def test_unknown_routes_use_the_envelope_too(self, client: TestClient) -> None:
        response = client.get("/api/does-not-exist")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"


class TestBodySizeLimit:
    def test_an_oversized_declared_body_is_rejected(self, app: FastAPI) -> None:
        @app.post("/test/echo")
        async def _echo(payload: dict[str, str]) -> dict[str, str]:
            return payload

        with TestClient(app, raise_server_exceptions=False) as client:
            oversized = {"blob": "x" * (app.state.settings.max_request_bytes + 1024)}
            response = client.post("/test/echo", json=oversized)

        assert response.status_code == 413
        assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
