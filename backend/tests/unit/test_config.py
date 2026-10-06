"""Configuration must fail loudly and early, never silently at the first request."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import AppEnv, Settings


def _settings(**overrides: object) -> Settings:
    """Build settings without reading any .env file from the developer's machine."""
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg, arg-type]


class TestDeploymentRequirements:
    def test_production_refuses_to_start_without_required_configuration(self) -> None:
        with pytest.raises(ValidationError) as caught:
            _settings(app_env=AppEnv.production)

        message = str(caught.value)
        # Every missing name is reported at once, so an operator fixes them in one pass
        # instead of discovering them one restart at a time.
        for name in (
            "SUPABASE_URL",
            "SUPABASE_SECRET_KEY",
            "DATABASE_URL_RLS",
            "DATABASE_URL_PRIVILEGED",
            "LLM_API_KEY",
        ):
            assert name in message

    def test_production_starts_when_fully_configured(self) -> None:
        settings = _settings(
            app_env=AppEnv.production,
            supabase_url="https://project.supabase.co",
            supabase_secret_key="sb_secret_example",
            database_url_rls="postgresql://prism_app@db.example/postgres",
            database_url_privileged="postgresql://prism_service@db.example/postgres",
            llm_provider="openai",
            llm_api_key="test-key",
            llm_model_heavy="heavy-model",
            llm_model_fast="fast-model",
        )
        assert settings.is_deployed is True

    def test_development_tolerates_an_empty_environment(self) -> None:
        settings = _settings(app_env=AppEnv.development)
        assert settings.llm_provider == "fake"


class TestDerivedValues:
    def test_jwks_url_and_issuer_derive_from_the_project_url(self) -> None:
        settings = _settings(supabase_url="https://project.supabase.co/")
        assert settings.supabase_jwks_url == (
            "https://project.supabase.co/auth/v1/.well-known/jwks.json"
        )
        assert settings.supabase_jwt_issuer == "https://project.supabase.co/auth/v1"

    def test_explicit_values_are_not_overwritten(self) -> None:
        settings = _settings(
            supabase_url="https://project.supabase.co",
            supabase_jwks_url="https://gateway.internal/jwks",
        )
        assert settings.supabase_jwks_url == "https://gateway.internal/jwks"

    def test_algorithms_parse_to_a_tuple(self) -> None:
        assert _settings(supabase_jwt_algorithms="ES256, RS256").jwt_algorithms == (
            "ES256",
            "RS256",
        )


class TestInvariants:
    def test_a_real_provider_requires_both_tier_models(self) -> None:
        with pytest.raises(ValidationError, match="LLM_MODEL_HEAVY"):
            _settings(app_env=AppEnv.development, llm_provider="openai", llm_api_key="k")

    def test_pool_maximum_cannot_be_below_the_minimum(self) -> None:
        with pytest.raises(ValidationError, match="db_rls_pool_max_size"):
            _settings(db_rls_pool_min_size=10, db_rls_pool_max_size=5)

    def test_signed_url_lifetime_cannot_exceed_one_hour(self) -> None:
        """PRD section 6.4 caps signed URLs at one hour."""
        with pytest.raises(ValidationError):
            _settings(storage_signed_url_ttl_seconds=3601)

    def test_upload_ceiling_cannot_exceed_the_prd_limit(self) -> None:
        """PRD CE-1 accepts files up to 50 MB."""
        with pytest.raises(ValidationError):
            _settings(storage_max_upload_bytes=104_857_601)

    def test_docs_are_hidden_in_production_only(self) -> None:
        assert _settings(app_env=AppEnv.development).expose_docs is True
        production = _settings(
            app_env=AppEnv.production,
            supabase_url="https://p.supabase.co",
            supabase_secret_key="s",
            database_url_rls="postgresql://a@b/c",
            database_url_privileged="postgresql://a@b/c",
            llm_provider="fake",
            llm_api_key="k",
        )
        assert production.expose_docs is False


class TestSecretHandling:
    def test_secrets_do_not_appear_in_the_repr(self) -> None:
        settings = _settings(llm_api_key="super-secret-value")
        assert "super-secret-value" not in repr(settings)
        assert settings.llm_api_key.get_secret_value() == "super-secret-value"
