"""Shared test fixtures.

Tests never read the developer's real environment: `test_settings` builds configuration
explicitly, so a stray `.env` cannot make a test pass or fail for the wrong reason.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import AppEnv, Settings
from app.core.readiness import clear_probes
from app.main import create_app


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        app_env=AppEnv.test,
        log_level="DEBUG",
        llm_provider="fake",
        rate_limit_backend="memory",
        _env_file=None,  # type: ignore[call-arg]
    )


@pytest.fixture
def app(test_settings: Settings) -> Iterator[FastAPI]:
    clear_probes()
    yield create_app(test_settings)
    clear_probes()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    # The context manager runs the lifespan hooks, so startup wiring is exercised too.
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client
