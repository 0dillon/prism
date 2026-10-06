"""Token verification, including the attacks it must refuse.

No network and no database: keys are generated in-process, so the real verification path runs
against a real signature.
"""

from __future__ import annotations

import time
from typing import Any
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from jwt import PyJWK
from jwt.algorithms import ECAlgorithm, RSAAlgorithm
from pydantic import SecretStr

from app.auth.jwks import (
    AsyncJwksCache,
    JwksUnavailableError,
    StaticJwksCache,
    UnknownSigningKeyError,
)
from app.auth.verifier import InvalidTokenError, Verifier
from app.core.config import AppEnv, Settings

ISSUER = "https://project.supabase.co/auth/v1"
AUDIENCE = "authenticated"


# --------------------------------------------------------------------------
# Key material
# --------------------------------------------------------------------------
class KeyPair:
    def __init__(self, kid: str) -> None:
        self.kid = kid
        self.private = ec.generate_private_key(ec.SECP256R1())
        public_jwk: dict[str, Any] = dict(
            ECAlgorithm.to_jwk(self.private.public_key(), as_dict=True)
        )
        public_jwk.update({"kid": kid, "alg": "ES256", "use": "sig"})
        self.public_jwk = public_jwk

    def public_pem(self) -> bytes:
        return self.private.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )

    def as_pyjwk(self) -> PyJWK:
        return PyJWK.from_dict(self.public_jwk)

    def sign(self, payload: dict[str, Any], *, alg: str = "ES256") -> str:
        return jwt.encode(payload, self.private, algorithm=alg, headers={"kid": self.kid})


@pytest.fixture(scope="module")
def keypair() -> KeyPair:
    return KeyPair("key-1")


@pytest.fixture(scope="module")
def other_keypair() -> KeyPair:
    return KeyPair("key-2")


@pytest.fixture
def settings() -> Settings:
    return Settings(
        app_env=AppEnv.test,
        supabase_url="https://project.supabase.co",
        supabase_jwt_audience=AUDIENCE,
        _env_file=None,  # type: ignore[call-arg]
    )


@pytest.fixture
def verifier(settings: Settings, keypair: KeyPair) -> Verifier:
    return Verifier(settings, StaticJwksCache({keypair.kid: keypair.as_pyjwk()}))


def claims(**overrides: Any) -> dict[str, Any]:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": str(uuid4()),
        "role": "authenticated",
        "aud": AUDIENCE,
        "iss": ISSUER,
        "iat": now,
        "exp": now + 900,
        "session_id": str(uuid4()),
        "aal": "aal1",
        "email": "learner@example.com",
        "is_anonymous": False,
    }
    payload.update(overrides)
    return payload


# --------------------------------------------------------------------------
class TestAcceptsValidTokens:
    async def test_a_properly_signed_token_yields_a_principal(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        payload = claims()
        identity = await verifier.verify(keypair.sign(payload))

        assert str(identity.user_id) == payload["sub"]
        assert identity.role == "authenticated"
        assert identity.email == "learner@example.com"
        assert identity.session_id == payload["session_id"]

    async def test_an_anonymous_supabase_user_is_recognised(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        identity = await verifier.verify(keypair.sign(claims(is_anonymous=True)))
        assert identity.is_anonymous is True


def forge_hs256(payload: dict[str, Any], *, secret: bytes, kid: str) -> str:
    """Hand-build an HS256 token.

    PyJWT refuses to encode with PEM key material as an HMAC secret, which is a good guardrail
    for honest callers and exactly the guardrail an attacker does not have. So the token is
    assembled directly, the way a real attempt would be.
    """
    import base64
    import hashlib
    import hmac
    import json

    def b64(raw: bytes) -> bytes:
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    header = b64(json.dumps({"alg": "HS256", "typ": "JWT", "kid": kid}).encode())
    body = b64(json.dumps(payload).encode())
    signing_input = header + b"." + body
    signature = b64(hmac.new(secret, signing_input, hashlib.sha256).digest())
    return (signing_input + b"." + signature).decode()


class TestAlgorithmConfusion:
    async def test_a_token_signed_with_the_public_key_as_an_hmac_secret_is_rejected(
        self, settings: Settings, keypair: KeyPair
    ) -> None:
        """The classic attack: the verifier is tricked into treating a published *public* key
        as a shared secret, letting anyone mint valid tokens.

        Tested with the legacy HS256 path deliberately enabled, because that is the dangerous
        configuration. Even then the symmetric branch resolves only the configured secret and
        can never reach a key obtained from JWKS.
        """
        permissive = settings.model_copy(
            update={
                "supabase_jwt_algorithms": "ES256,RS256,HS256",
                "supabase_legacy_jwt_secret": SecretStr(
                    "the-real-legacy-secret-at-least-32-bytes"
                ),
            }
        )
        verifier = Verifier(permissive, StaticJwksCache({keypair.kid: keypair.as_pyjwk()}))

        forged = forge_hs256(claims(), secret=keypair.public_pem(), kid=keypair.kid)
        with pytest.raises(InvalidTokenError):
            await verifier.verify(forged)

    async def test_the_same_forgery_is_rejected_when_hs256_is_not_configured(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        """The default posture: HS256 is not in the allowlist, so the branch is unreachable."""
        forged = forge_hs256(claims(), secret=keypair.public_pem(), kid=keypair.kid)
        with pytest.raises(InvalidTokenError, match="unsupported signing algorithm"):
            await verifier.verify(forged)

    async def test_hs256_is_refused_when_no_legacy_secret_is_configured(
        self, verifier: Verifier
    ) -> None:
        forged = jwt.encode(claims(), "guessed-secret-of-at-least-32-bytes-long", algorithm="HS256")
        with pytest.raises(InvalidTokenError, match="unsupported signing algorithm"):
            await verifier.verify(forged)

    async def test_the_none_algorithm_is_refused(self, verifier: Verifier) -> None:
        unsigned = jwt.encode(claims(), key="", algorithm="none")
        with pytest.raises(InvalidTokenError, match="unsupported signing algorithm"):
            await verifier.verify(unsigned)

    async def test_a_configured_legacy_secret_verifies_only_hs256(
        self, settings: Settings, keypair: KeyPair
    ) -> None:
        """Legacy support exists for projects mid-migration, through its own branch."""
        legacy = settings.model_copy(
            update={
                "supabase_legacy_jwt_secret": SecretStr(
                    "shared-secret-of-at-least-32-bytes-long"
                ),
                "supabase_jwt_algorithms": "ES256,RS256,HS256",
            }
        )
        verifier = Verifier(legacy, StaticJwksCache({keypair.kid: keypair.as_pyjwk()}))

        token = jwt.encode(claims(), "shared-secret-of-at-least-32-bytes-long", algorithm="HS256")
        assert (await verifier.verify(token)).role == "authenticated"

        wrong = jwt.encode(claims(), "not-the-secret-of-at-least-32-bytes-long", algorithm="HS256")
        with pytest.raises(InvalidTokenError):
            await verifier.verify(wrong)


class TestPrivilegeEscalation:
    @pytest.mark.parametrize("role", ["service_role", "anon", "postgres", "supabase_admin"])
    async def test_a_non_user_token_is_rejected(
        self, verifier: Verifier, keypair: KeyPair, role: str
    ) -> None:
        """Supabase's anon and service_role API keys are themselves valid JWTs for this
        project. Accepting one would turn a leaked key into a usable request credential, and
        service_role maps to a BYPASSRLS database role.
        """
        token = keypair.sign(claims(role=role))
        with pytest.raises(InvalidTokenError, match="not a user access token"):
            await verifier.verify(token)

    async def test_a_token_without_a_role_claim_is_rejected(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        payload = claims()
        del payload["role"]
        with pytest.raises(InvalidTokenError):
            await verifier.verify(keypair.sign(payload))

    async def test_a_token_without_a_subject_is_rejected(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        """Fails closed rather than producing a principal with a null id."""
        payload = claims()
        del payload["sub"]
        with pytest.raises(InvalidTokenError):
            await verifier.verify(keypair.sign(payload))

    async def test_a_non_uuid_subject_is_rejected(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        with pytest.raises(InvalidTokenError):
            await verifier.verify(keypair.sign(claims(sub="' or 1=1 --")))


class TestClaimValidation:
    async def test_an_expired_token_is_rejected(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        now = int(time.time())
        with pytest.raises(InvalidTokenError, match="expired"):
            await verifier.verify(keypair.sign(claims(iat=now - 7200, exp=now - 3600)))

    async def test_the_wrong_audience_is_rejected(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        with pytest.raises(InvalidTokenError):
            await verifier.verify(keypair.sign(claims(aud="some-other-service")))

    async def test_the_wrong_issuer_is_rejected(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        """A token from a different Supabase project must not work against this one."""
        with pytest.raises(InvalidTokenError):
            await verifier.verify(keypair.sign(claims(iss="https://attacker.supabase.co/auth/v1")))

    async def test_a_token_signed_by_an_unknown_key_is_rejected(
        self, verifier: Verifier, other_keypair: KeyPair
    ) -> None:
        with pytest.raises(InvalidTokenError, match="unknown signing key"):
            await verifier.verify(other_keypair.sign(claims()))

    async def test_a_tampered_payload_is_rejected(
        self, verifier: Verifier, keypair: KeyPair
    ) -> None:
        import base64
        import json

        token = keypair.sign(claims())
        header, payload, signature = token.split(".")
        decoded = json.loads(base64.urlsafe_b64decode(payload + "=="))
        decoded["sub"] = str(uuid4())
        tampered = (
            base64.urlsafe_b64encode(json.dumps(decoded).encode()).decode().rstrip("=")
        )
        with pytest.raises(InvalidTokenError):
            await verifier.verify(f"{header}.{tampered}.{signature}")

    @pytest.mark.parametrize(
        "garbage", ["", "not-a-token", "a.b", "a.b.c", "....", "Bearer token"]
    )
    async def test_malformed_tokens_are_rejected(
        self, verifier: Verifier, garbage: str
    ) -> None:
        with pytest.raises(InvalidTokenError):
            await verifier.verify(garbage)


# --------------------------------------------------------------------------
class TestJwksCache:
    async def test_keys_are_fetched_once_and_reused(self, keypair: KeyPair) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"keys": [keypair.public_jwk]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        cache = AsyncJwksCache("https://jwks.test/keys", client=client)
        await cache.startup()

        for _ in range(5):
            await cache.get_key(keypair.kid)
        assert calls == 1

    async def test_an_unknown_key_id_triggers_one_refresh_then_fails(
        self, keypair: KeyPair
    ) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"keys": [keypair.public_jwk]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        cache = AsyncJwksCache("https://jwks.test/keys", client=client, cooldown_seconds=0)
        await cache.startup()

        with pytest.raises(UnknownSigningKeyError):
            await cache.get_key("rotated-in-key")
        # One prewarm plus one refresh attempt. Not an unbounded retry: an attacker sending
        # invented key ids must not be able to hammer the auth server through us.
        assert calls == 2

    async def test_a_rotated_in_key_is_picked_up_without_a_restart(self) -> None:
        first, second = KeyPair("old"), KeyPair("new")
        published = [first.public_jwk]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"keys": list(published)})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        cache = AsyncJwksCache("https://jwks.test/keys", client=client, cooldown_seconds=0)
        await cache.startup()

        published.append(second.public_jwk)
        assert await cache.get_key(second.kid) is not None

    async def test_an_outage_serves_stale_keys_rather_than_failing_everyone(
        self, keypair: KeyPair
    ) -> None:
        """A JWKS 503 must not log every user out: the keys we hold are still valid."""
        healthy = True

        def handler(request: httpx.Request) -> httpx.Response:
            if healthy:
                return httpx.Response(200, json={"keys": [keypair.public_jwk]})
            return httpx.Response(503)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        cache = AsyncJwksCache(
            "https://jwks.test/keys", client=client, ttl_seconds=0, cooldown_seconds=0
        )
        await cache.startup()

        healthy = False
        assert await cache.get_key(keypair.kid) is not None

    async def test_a_cold_cache_with_an_outage_raises_rather_than_rejecting(self) -> None:
        """Distinct from an invalid token, so the API answers 503 and not 401."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        cache = AsyncJwksCache("https://jwks.test/keys", client=client)

        with pytest.raises(JwksUnavailableError):
            await cache.startup()

    async def test_concurrent_misses_issue_one_request(self, keypair: KeyPair) -> None:
        """Single flight: after a rotation every in-flight request misses at once."""
        import asyncio

        calls = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            return httpx.Response(200, json={"keys": [keypair.public_jwk]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        cache = AsyncJwksCache("https://jwks.test/keys", client=client)

        await asyncio.gather(*(cache.get_key(keypair.kid) for _ in range(10)))
        assert calls == 1


class TestRsaKeysAlsoWork:
    async def test_rs256_tokens_verify(self, settings: Settings) -> None:
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_jwk: dict[str, Any] = dict(
            RSAAlgorithm.to_jwk(private.public_key(), as_dict=True)
        )
        public_jwk.update({"kid": "rsa-1", "alg": "RS256", "use": "sig"})

        verifier = Verifier(settings, StaticJwksCache({"rsa-1": PyJWK.from_dict(public_jwk)}))
        token = jwt.encode(claims(), private, algorithm="RS256", headers={"kid": "rsa-1"})

        assert (await verifier.verify(token)).role == "authenticated"
