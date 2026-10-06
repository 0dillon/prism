"""Supabase access token verification.

Three decisions here are security-critical. Each is a real attack if omitted.

**The algorithm comes from a server-side allowlist, not from the token.** The token header
only selects which branch runs; the branch then fixes both the algorithm set and the type of
key material. Taking `algorithms=[header["alg"]]` would let an attacker present an HS256 token
signed with the *public* key — which is published at the JWKS endpoint — and have it verify.
That is the classic algorithm-confusion attack, and the asymmetric and symmetric paths below
never share a key resolver.

**A token whose `role` claim is not `authenticated` is rejected.** Supabase's legacy `anon` and
`service_role` API keys are themselves JWTs, signed by the same project and carrying
`aud: authenticated`. Without this check, pasting a leaked service-role key into an
Authorization header would produce a valid principal — and because that role maps to a
BYPASSRLS database role, it would be total. This single line is what keeps a leaked key from
being a request-path privilege escalation.

**Claims are required, not merely read.** Demanding `sub`, `role`, `aud`, `iss`, `exp` and
`iat` means a token missing one fails closed rather than yielding a principal with a null id.
"""

from __future__ import annotations

from typing import Any, Final

import jwt
from pydantic import ValidationError

from app.auth.identity import Identity
from app.auth.jwks import AsyncJwksCache, JwksUnavailableError, UnknownSigningKeyError
from app.core.config import Settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Supabase's asymmetric signing algorithms. These resolve keys from JWKS.
ASYMMETRIC_ALGORITHMS: Final[frozenset[str]] = frozenset({"ES256", "RS256"})

# The legacy shared-secret algorithm, supported only when a secret is explicitly configured,
# and resolved through a completely separate branch.
SYMMETRIC_ALGORITHM: Final = "HS256"

REQUIRED_CLAIMS: Final[list[str]] = ["sub", "role", "aud", "iss", "exp", "iat"]


class InvalidTokenError(Exception):
    """The token is absent, malformed, expired, or not acceptable to this service."""


class Verifier:
    """Verifies bearer tokens against the project's signing keys."""

    def __init__(self, settings: Settings, jwks: AsyncJwksCache) -> None:
        self._settings = settings
        self._jwks = jwks
        self._allowed = frozenset(settings.jwt_algorithms) & (
            ASYMMETRIC_ALGORITHMS | {SYMMETRIC_ALGORITHM}
        )
        legacy = settings.supabase_legacy_jwt_secret.get_secret_value()
        self._legacy_secret = legacy or None

    async def verify(self, token: str) -> Identity:
        """Return the principal, or raise.

        Raises:
            InvalidTokenError: the token is not acceptable. Always a 401.
            JwksUnavailableError: keys cannot be obtained. A 503, never a 401 - a 401 would
                make every client try to re-authenticate and amplify the outage.
        """
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise InvalidTokenError("malformed token header") from exc

        algorithm = header.get("alg")
        if not isinstance(algorithm, str) or algorithm not in self._allowed:
            raise InvalidTokenError(f"unsupported signing algorithm: {algorithm!r}")

        key: Any
        if algorithm in ASYMMETRIC_ALGORITHMS:
            kid = header.get("kid")
            if not isinstance(kid, str) or not kid:
                raise InvalidTokenError("token does not name a signing key")
            try:
                key = (await self._jwks.get_key(kid)).key
            except UnknownSigningKeyError as exc:
                raise InvalidTokenError("unknown signing key") from exc
            algorithms = [algorithm]
        else:
            # Reached only when a legacy secret is configured, and never with a key that
            # came from JWKS.
            if self._legacy_secret is None:
                raise InvalidTokenError("symmetric tokens are not accepted")
            key = self._legacy_secret
            algorithms = [SYMMETRIC_ALGORITHM]

        try:
            payload: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=algorithms,
                audience=self._settings.supabase_jwt_audience,
                issuer=self._settings.supabase_jwt_issuer or None,
                leeway=self._settings.supabase_jwt_leeway_seconds,
                options={
                    "require": REQUIRED_CLAIMS,
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_iat": True,
                    "verify_aud": True,
                    "verify_iss": bool(self._settings.supabase_jwt_issuer),
                },
            )
        except jwt.ExpiredSignatureError as exc:
            raise InvalidTokenError("token has expired") from exc
        except jwt.PyJWTError as exc:
            # The specific reason goes to the logs; the client is told only that it failed,
            # so a probing caller learns nothing about why.
            logger.info("token_rejected", extra={"detail": type(exc).__name__})
            raise InvalidTokenError("token verification failed") from exc

        return self._to_identity(payload)

    def _to_identity(self, payload: dict[str, Any]) -> Identity:
        if payload.get("role") != "authenticated":
            # See the module docstring: this is the check that contains a leaked key.
            logger.warning(
                "non_user_token_rejected", extra={"claimed_role": str(payload.get("role"))}
            )
            raise InvalidTokenError("this token is not a user access token")

        try:
            return Identity(
                user_id=payload["sub"],
                role="authenticated",
                session_id=_optional_str(payload.get("session_id")),
                aal=_optional_str(payload.get("aal")),
                email=_optional_str(payload.get("email")),
                is_anonymous=bool(payload.get("is_anonymous", False)),
                claims=payload,
            )
        except (ValidationError, KeyError, ValueError) as exc:
            raise InvalidTokenError("token claims are not usable") from exc


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = [
    "ASYMMETRIC_ALGORITHMS",
    "InvalidTokenError",
    "JwksUnavailableError",
    "Verifier",
]
