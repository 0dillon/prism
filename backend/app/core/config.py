"""Application configuration.

Every secret and deployment-specific value arrives through the environment. Nothing is
hardcoded, and the process refuses to start when a value that production genuinely needs is
absent, rather than discovering it at the first request.

Naming follows PRD section 7.6 so that one env file can serve both the frontend and this
service. The NEXT_PUBLIC_ prefixes are dropped: those exist to mark values as browser-exposed,
and nothing here is browser-exposed.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from typing import Annotated, Literal, Self

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppEnv(StrEnum):
    development = "development"
    test = "test"
    staging = "staging"
    production = "production"


# Values without which a deployed instance cannot behave correctly. Missing any of these in a
# deployed environment is a startup failure, not a runtime surprise.
_REQUIRED_WHEN_DEPLOYED: tuple[str, ...] = (
    "supabase_url",
    "supabase_secret_key",
    "database_url_rls",
    "database_url_privileged",
    "llm_api_key",
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---- runtime ---------------------------------------------------------
    app_env: AppEnv = AppEnv.development
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    service_name: str = "prism-backend"

    # ---- Supabase --------------------------------------------------------
    supabase_url: str = ""
    supabase_publishable_key: SecretStr = SecretStr("")
    supabase_secret_key: SecretStr = SecretStr("")

    # ---- JWT verification ------------------------------------------------
    # Supabase signs with asymmetric keys (ES256/RS256) published at a JWKS endpoint. The
    # legacy shared HS256 secret is supported only when explicitly configured, and is routed
    # through a separate key resolver so an asymmetric public key can never be fed into HMAC
    # verification (the algorithm-confusion attack).
    supabase_jwks_url: str = ""
    supabase_jwt_issuer: str = ""
    supabase_jwt_audience: str = "authenticated"
    supabase_jwt_algorithms: str = "ES256,RS256"
    supabase_jwt_leeway_seconds: Annotated[int, Field(ge=0, le=60)] = 5
    supabase_jwks_cache_ttl_seconds: Annotated[int, Field(ge=30, le=3600)] = 300
    supabase_jwks_refresh_cooldown_seconds: Annotated[int, Field(ge=1, le=600)] = 30
    supabase_jwks_timeout_seconds: Annotated[float, Field(gt=0, le=30)] = 5.0
    supabase_legacy_jwt_secret: SecretStr = SecretStr("")

    # ---- database --------------------------------------------------------
    # Two DSNs, two Postgres login roles. The RLS role is NOINHERIT and holds no table grants
    # of its own; it must SET ROLE per transaction, so a forgotten identity fails loudly with
    # "permission denied" instead of silently returning every row.
    database_url_rls: str = ""
    database_url_privileged: str = ""
    db_rls_pool_min_size: Annotated[int, Field(ge=0, le=100)] = 2
    db_rls_pool_max_size: Annotated[int, Field(ge=1, le=200)] = 20
    db_privileged_pool_min_size: Annotated[int, Field(ge=0, le=20)] = 0
    db_privileged_pool_max_size: Annotated[int, Field(ge=1, le=20)] = 3
    db_statement_timeout_ms: Annotated[int, Field(ge=100, le=600_000)] = 5_000
    db_dashboard_statement_timeout_ms: Annotated[int, Field(ge=100, le=600_000)] = 2_000
    db_connect_timeout_seconds: Annotated[float, Field(gt=0, le=60)] = 10.0
    # Transaction-mode poolers cannot reuse prepared statements across requests.
    db_use_transaction_pooler: bool = False

    # ---- LLM -------------------------------------------------------------
    llm_provider: Literal["openai", "fake"] = "fake"
    llm_api_key: SecretStr = SecretStr("")
    llm_base_url: str = ""
    llm_model_heavy: str = ""
    llm_model_fast: str = ""
    llm_timeout_heavy_seconds: Annotated[float, Field(gt=0, le=600)] = 120.0
    llm_timeout_fast_seconds: Annotated[float, Field(gt=0, le=600)] = 20.0
    llm_max_attempts: Annotated[int, Field(ge=1, le=10)] = 3
    llm_max_inflight_heavy: Annotated[int, Field(ge=1, le=64)] = 8
    llm_max_inflight_fast: Annotated[int, Field(ge=1, le=256)] = 32

    # ---- ingestion -------------------------------------------------------
    ingestion_map_concurrency: Annotated[int, Field(ge=1, le=32)] = 4
    ingestion_artifact_inline_max_bytes: Annotated[int, Field(ge=1024, le=4_194_304)] = 262_144
    ingestion_max_degraded_fraction: Annotated[float, Field(ge=0.0, le=1.0)] = 0.20
    ingestion_stage_deadline_seconds: Annotated[int, Field(ge=30, le=7200)] = 900
    ingestion_runner: Literal["inprocess", "durable"] = "inprocess"

    # ---- storage ---------------------------------------------------------
    storage_max_upload_bytes: Annotated[int, Field(ge=1024, le=104_857_600)] = 52_428_800
    # PRD section 6.4 caps signed URL lifetime at one hour. Shorter is preferred.
    storage_signed_url_ttl_seconds: Annotated[int, Field(ge=30, le=3600)] = 900

    # ---- speech ----------------------------------------------------------
    stt_provider: Literal["browser", "openai"] = "browser"
    stt_api_key: SecretStr = SecretStr("")
    tts_provider: Literal["browser", "openai"] = "browser"
    tts_api_key: SecretStr = SecretStr("")
    speech_timeout_seconds: Annotated[float, Field(gt=0, le=120)] = 15.0

    # ---- rate limiting ---------------------------------------------------
    rate_limit_backend: Literal["postgres", "memory", "disabled"] = "postgres"
    rate_limit_enabled: bool = True

    # ---- request limits --------------------------------------------------
    max_request_bytes: Annotated[int, Field(ge=1024, le=104_857_600)] = 1_048_576
    request_id_max_length: Annotated[int, Field(ge=8, le=256)] = 128

    # ---- payments (not used by the MVP; present so config stays complete) -
    stripe_secret_key: SecretStr = SecretStr("")
    stripe_webhook_secret: SecretStr = SecretStr("")
    stripe_publishable_key: str = ""
    platform_fee_bps: Annotated[int, Field(ge=0, le=10_000)] = 1500

    # ---- observability ---------------------------------------------------
    sentry_dsn: SecretStr = SecretStr("")

    # ------------------------------------------------------------------
    @model_validator(mode="after")
    def _derive_jwt_endpoints(self) -> Self:
        """JWKS URL and issuer follow from the project URL; allow explicit override."""
        base = self.supabase_url.rstrip("/")
        if base:
            if not self.supabase_jwks_url:
                self.supabase_jwks_url = f"{base}/auth/v1/.well-known/jwks.json"
            if not self.supabase_jwt_issuer:
                self.supabase_jwt_issuer = f"{base}/auth/v1"
        return self

    @model_validator(mode="after")
    def _require_deployment_config(self) -> Self:
        """Fail at startup, listing every missing name at once."""
        if self.app_env in (AppEnv.development, AppEnv.test):
            return self
        missing = sorted(
            name.upper()
            for name in _REQUIRED_WHEN_DEPLOYED
            if not _is_present(getattr(self, name))
        )
        if missing:
            raise ValueError(
                f"missing required configuration for app_env={self.app_env.value}: "
                f"{', '.join(missing)}"
            )
        return self

    @model_validator(mode="after")
    def _check_pool_bounds(self) -> Self:
        if self.db_rls_pool_max_size < self.db_rls_pool_min_size:
            raise ValueError("db_rls_pool_max_size must be >= db_rls_pool_min_size")
        if self.db_privileged_pool_max_size < self.db_privileged_pool_min_size:
            raise ValueError("db_privileged_pool_max_size must be >= db_privileged_pool_min_size")
        return self

    @model_validator(mode="after")
    def _check_llm_models_named(self) -> Self:
        """A real provider needs both tier models named; the fake provider does not.

        The fake is given placeholder names rather than left blank, so the exemption holds all
        the way down: the gateway requires a model id per tier, and an empty one would turn
        "the fake needs no configuration" into a failure at the first call.
        """
        if self.llm_provider == "fake":
            if not self.llm_model_heavy:
                self.llm_model_heavy = "fake-heavy"
            if not self.llm_model_fast:
                self.llm_model_fast = "fake-fast"
            return self

        if not (self.llm_model_heavy and self.llm_model_fast):
            raise ValueError(
                "LLM_MODEL_HEAVY and LLM_MODEL_FAST are required when LLM_PROVIDER is not 'fake'"
            )
        return self

    # ------------------------------------------------------------------
    @property
    def jwt_algorithms(self) -> tuple[str, ...]:
        return tuple(a.strip() for a in self.supabase_jwt_algorithms.split(",") if a.strip())

    @property
    def is_deployed(self) -> bool:
        return self.app_env in (AppEnv.staging, AppEnv.production)

    @property
    def expose_docs(self) -> bool:
        """OpenAPI is served everywhere except production."""
        return self.app_env is not AppEnv.production


def _is_present(value: object) -> bool:
    if isinstance(value, SecretStr):
        return bool(value.get_secret_value())
    return bool(value)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings. Cached so the environment is read exactly once."""
    return Settings()
