"""The HTTP surface: authentication, degraded modes, and rate limiting.

The authentication test is generated from the OpenAPI document rather than written per route,
so a route added later without an auth dependency fails the build automatically. A list
maintained by hand would simply not mention the route somebody forgot.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.gateway import LlmGateway
from app.ai.providers.fake import FakeProvider, response_for
from app.api.errors import ErrorCode
from app.auth.dependencies import current_identity
from app.auth.identity import Identity
from app.core.config import AppEnv, Settings
from app.core.rate_limit import InMemoryRateLimiter
from app.main import create_app

# Health endpoints are unauthenticated by design: an orchestrator cannot hold a credential.
PUBLIC_PATHS = {"/health/live", "/health/ready"}


def build_app(**overrides: Any) -> FastAPI:
    settings = Settings(
        app_env=AppEnv.test,
        llm_provider="fake",
        rate_limit_backend="memory",
        _env_file=None,  # type: ignore[call-arg]
        **overrides,
    )
    return create_app(settings)


@pytest.fixture
def api_app() -> FastAPI:
    return build_app()


@pytest.fixture
def anonymous(api_app: FastAPI) -> Any:
    with TestClient(api_app, raise_server_exceptions=False) as client:
        yield client


def route_table(app: FastAPI) -> list[tuple[str, str]]:
    with TestClient(app) as client:
        spec = client.get("/openapi.json").json()
    return [
        (method.upper(), path)
        for path, operations in spec["paths"].items()
        for method in operations
        if path not in PUBLIC_PATHS
    ]


class TestAuthenticationIsRequiredEverywhere:
    def test_the_surface_is_not_empty(self, api_app: FastAPI) -> None:
        """Guards the test below: a generated check over nothing passes vacuously."""
        assert len(route_table(api_app)) >= 8

    def test_no_api_route_is_reachable_without_a_token(self, api_app: FastAPI) -> None:
        reachable: list[str] = []
        with TestClient(api_app, raise_server_exceptions=False) as client:
            for method, path in route_table(api_app):
                response = client.request(method, path, json={})
                if response.status_code not in (401, 503):
                    reachable.append(f"{method} {path} -> {response.status_code}")

        assert not reachable, (
            "these routes answered without authentication, which would expose learner data: "
            f"{reachable}"
        )

    def test_a_malformed_token_is_refused(self, api_app: FastAPI) -> None:
        with TestClient(api_app, raise_server_exceptions=False) as client:
            response = client.put(
                "/api/profile",
                json={"profile": {}},
                headers={"Authorization": "Bearer not-a-real-token"},
            )
        # 503 when no verifier is configured in this environment, 401 when one is.
        assert response.status_code in (401, 503)
        assert response.json()["error"]["code"] in {
            ErrorCode.UNAUTHENTICATED.value,
            ErrorCode.INVALID_TOKEN.value,
            ErrorCode.AUTH_UNAVAILABLE.value,
        }

    def test_an_unconfigured_verifier_answers_503_not_401(self, anonymous: Any) -> None:
        """A 401 would send every client into a re-authentication loop over a server-side
        configuration problem."""
        response = anonymous.post("/api/session/intent", json={"utterance": "next"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == ErrorCode.AUTH_UNAVAILABLE.value


# ---------------------------------------------------------------------------
@pytest.fixture
def identity() -> Identity:
    user_id = uuid4()
    return Identity(
        user_id=user_id,
        role="authenticated",
        session_id=str(uuid4()),
        claims={"sub": str(user_id), "role": "authenticated"},
    )


@pytest.fixture
def signed_in(api_app: FastAPI, identity: Identity) -> Any:
    """A client whose requests carry a verified principal.

    The verifier itself is covered exhaustively in tests/security; overriding it here keeps
    these tests about the routes.
    """
    api_app.dependency_overrides[current_identity] = lambda: identity
    api_app.state.rate_limiter = InMemoryRateLimiter()
    with TestClient(api_app, raise_server_exceptions=False) as client:
        yield client
    api_app.dependency_overrides.clear()


class TestSessionIntent:
    def test_a_local_command_is_resolved_without_the_model(
        self, api_app: FastAPI, signed_in: Any
    ) -> None:
        provider = FakeProvider()
        api_app.state.gateway = LlmGateway(
            provider=provider, settings=api_app.state.settings
        )

        response = signed_in.post("/api/session/intent", json={"utterance": "next"})

        assert response.status_code == 200
        body = response.json()
        assert body["intent"]["type"] == "next"
        assert body["source"] == "local"
        assert provider.call_count == 0

    def test_an_unusual_phrasing_reaches_the_model(
        self, api_app: FastAPI, signed_in: Any
    ) -> None:
        api_app.state.gateway = LlmGateway(
            provider=FakeProvider(
                [
                    response_for(
                        {
                            "type": "simplify", "value": None, "target": None,
                            "direction": None, "request": None, "text": None,
                        }
                    )
                ]
            ),
            settings=api_app.state.settings,
        )

        response = signed_in.post(
            "/api/session/intent",
            json={"utterance": "could you go over that again but easier"},
        )

        assert response.status_code == 200
        assert response.json()["intent"]["type"] == "simplify"
        assert response.json()["source"] == "model"

    def test_an_oversized_utterance_is_rejected(self, signed_in: Any) -> None:
        response = signed_in.post("/api/session/intent", json={"utterance": "x" * 5000})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == ErrorCode.VALIDATION_FAILED.value

    def test_an_unknown_field_is_rejected(self, signed_in: Any) -> None:
        """Stricter than Zod's stripping, so a renamed field is a loud 422 rather than data
        that silently vanishes between the two languages."""
        response = signed_in.post(
            "/api/session/intent", json={"utterance": "next", "userId": "someone-else"}
        )
        assert response.status_code == 422


class TestSpeechDegradedMode:
    """PRD 6.5 and brief 39: an actionable answer, not a 500."""

    @pytest.mark.parametrize("endpoint", ["/api/speech/stt", "/api/speech/tts"])
    def test_browser_mode_tells_the_client_what_to_do(
        self, signed_in: Any, endpoint: str
    ) -> None:
        response = signed_in.post(endpoint, json={})

        assert response.status_code == 200
        error = response.json()["error"]
        assert error["code"] == ErrorCode.SPEECH_PROVIDER_BROWSER.value
        assert error["details"]["fallback"] == "browser"
        assert "browser" in error["message"].lower()


class TestRateLimiting:
    def test_exceeding_the_quota_returns_429_with_a_retry_time(
        self, api_app: FastAPI, signed_in: Any
    ) -> None:
        """PRD task P8-05."""
        from app.core.rate_limit import DEFAULT_LIMITS

        limit = DEFAULT_LIMITS["session.intent"].limit
        last = None
        for _ in range(limit + 2):
            last = signed_in.post("/api/session/intent", json={"utterance": "next"})

        assert last is not None
        assert last.status_code == 429
        assert last.json()["error"]["code"] == ErrorCode.RATE_LIMITED.value
        assert int(last.headers["Retry-After"]) > 0

    def test_separate_users_have_separate_quotas(
        self, api_app: FastAPI, identity: Identity
    ) -> None:
        """Keyed per user, or one busy learner would lock out a whole classroom."""
        from app.core.rate_limit import DEFAULT_LIMITS

        limiter = InMemoryRateLimiter()
        api_app.state.rate_limiter = limiter
        limit = DEFAULT_LIMITS["session.intent"].limit

        api_app.dependency_overrides[current_identity] = lambda: identity
        with TestClient(api_app, raise_server_exceptions=False) as client:
            for _ in range(limit + 1):
                client.post("/api/session/intent", json={"utterance": "next"})

        other = Identity(
            user_id=uuid4(), role="authenticated", claims={"sub": str(uuid4())}
        )
        api_app.dependency_overrides[current_identity] = lambda: other
        with TestClient(api_app, raise_server_exceptions=False) as client:
            response = client.post("/api/session/intent", json={"utterance": "next"})

        assert response.status_code == 200
        api_app.dependency_overrides.clear()


class TestOpenApiDocumentation:
    def test_every_route_documents_what_it_does(self, api_app: FastAPI) -> None:
        """Brief section 68: documentation describes behaviour, not implementation."""
        with TestClient(api_app) as client:
            spec = client.get("/openapi.json").json()

        thin: list[str] = []
        for path, operations in spec["paths"].items():
            for method, operation in operations.items():
                summary = operation.get("summary", "")
                description = operation.get("description", "")
                if not summary or len(description) < 40:
                    thin.append(f"{method.upper()} {path}")
        assert not thin, f"these operations are not adequately documented: {thin}"

    def test_error_responses_are_documented(self, api_app: FastAPI) -> None:
        with TestClient(api_app) as client:
            spec = client.get("/openapi.json").json()

        operation = spec["paths"]["/api/events"]["post"]
        assert "429" in operation["responses"]
        assert "401" in operation["responses"]

    def test_docs_are_served_outside_production(self, anonymous: Any) -> None:
        assert anonymous.get("/docs").status_code == 200

    def test_docs_are_hidden_in_production(self) -> None:
        app = create_app(
            Settings(
                app_env=AppEnv.production,
                supabase_url="https://p.supabase.co",
                supabase_secret_key="s",
                database_url_rls="postgresql://a@b/c",
                database_url_privileged="postgresql://a@b/c",
                llm_provider="fake",
                llm_api_key="k",
                _env_file=None,  # type: ignore[call-arg]
            )
        )
        with TestClient(app, raise_server_exceptions=False) as client:
            assert client.get("/openapi.json").status_code == 404
            assert client.get("/docs").status_code == 404
