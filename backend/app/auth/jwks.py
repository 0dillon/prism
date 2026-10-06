"""Asynchronous JWKS cache for Supabase signing keys.

Supabase signs access tokens with asymmetric keys (ES256 or RS256) and publishes the public
keys at a JWKS endpoint. Verification is therefore local: calling `/auth/v1/user` on every
request would add a network round trip to the hot path and make the auth service a hard
dependency of every single request.

PyJWT ships `PyJWKClient`, whose caching semantics are exactly right, but it fetches with
`urllib` — blocking, synchronous I/O. Called from a coroutine that would stall the event loop
for the whole timeout on a JWKS outage, taking down every concurrent request on the instance.
So this reuses PyJWT's key parsing and does the transport with httpx.

Two behaviours matter beyond "cache the keys":

* **Serve stale on fetch failure.** A JWKS endpoint returning 503 must not log every user out.
  The public keys we already hold remain valid; only the discovery of *new* keys is delayed.
* **Single flight.** After a key rotation, every in-flight request misses at once. One HTTP
  request is issued, not one per request.

Key rotation works because nothing pins a `kid`: an unrecognised one triggers a refresh,
rate-limited by a cooldown so an attacker cannot use garbage key ids to hammer the auth server.
"""

from __future__ import annotations

import asyncio
import time

import httpx
from jwt import PyJWK, PyJWKSet

from app.core.logging import get_logger

logger = get_logger(__name__)


class JwksUnavailableError(RuntimeError):
    """No keys are available at all. Distinct from "this key is unknown"."""


class UnknownSigningKeyError(LookupError):
    """The token names a key id that is not in the published set."""


class AsyncJwksCache:
    """Caches the published signing keys, refreshing on miss and on expiry."""

    def __init__(
        self,
        url: str,
        *,
        ttl_seconds: float = 300.0,
        cooldown_seconds: float = 30.0,
        timeout_seconds: float = 5.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = url
        self._ttl = ttl_seconds
        self._cooldown = cooldown_seconds
        self._timeout = timeout_seconds
        self._keys: dict[str, PyJWK] = {}
        self._fetched_at: float = 0.0
        self._last_attempt: float = 0.0
        self._lock = asyncio.Lock()
        self._client = client
        self._owns_client = client is None

    async def startup(self) -> None:
        """Prewarm, so the first authenticated request does not pay for discovery."""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        await self._refresh(force=True)

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
        self._client = None

    @property
    def is_warm(self) -> bool:
        return bool(self._keys)

    async def get_key(self, kid: str) -> PyJWK:
        """The public key for a key id, refreshing if it is unknown or the set is stale."""
        now = time.monotonic()
        if kid in self._keys and (now - self._fetched_at) < self._ttl:
            return self._keys[kid]

        # An unknown key id forces a fetch even if the cached set is still within its TTL:
        # that is what picks up a key rotated in moments ago, without waiting out the TTL or
        # needing a restart. The cooldown is what keeps invented key ids from turning this
        # into an amplification channel against the auth server.
        if not self._keys or (now - self._last_attempt) >= self._cooldown:
            await self._refresh(force=True, awaited_kid=kid)

        key = self._keys.get(kid)
        if key is None:
            raise UnknownSigningKeyError(kid)
        return key

    async def _refresh(self, *, force: bool = False, awaited_kid: str | None = None) -> None:
        async with self._lock:
            now = time.monotonic()
            fresh = bool(self._keys) and (now - self._fetched_at) < self._ttl
            if not force and fresh:
                return
            # Another coroutine may have fetched the key we are waiting for while this one
            # queued on the lock. This is what makes a thundering herd one HTTP request.
            if awaited_kid is not None and fresh and awaited_kid in self._keys:
                return
            self._last_attempt = now

            if self._client is None:
                self._client = httpx.AsyncClient(timeout=self._timeout)

            try:
                response = await self._client.get(self._url)
                response.raise_for_status()
                key_set = PyJWKSet.from_dict(response.json())
            except Exception as exc:
                if self._keys:
                    logger.warning(
                        "jwks_refresh_failed_serving_stale",
                        extra={"detail": str(exc), "cached_keys": len(self._keys)},
                    )
                    return
                logger.error("jwks_unavailable", extra={"detail": str(exc)})
                raise JwksUnavailableError(str(exc)) from exc

            self._keys = {key.key_id: key for key in key_set.keys if key.key_id}
            self._fetched_at = time.monotonic()
            logger.info("jwks_refreshed", extra={"key_count": len(self._keys)})

    async def check_ready(self) -> None:
        """Readiness probe: keys are held, so tokens can be verified."""
        if not self._keys:
            raise JwksUnavailableError("no signing keys cached")


class StaticJwksCache(AsyncJwksCache):
    """An in-memory key set, for tests and for a locally pinned configuration.

    Subclasses rather than reimplements so the production verification path is the one under
    test: only the transport is replaced.
    """

    def __init__(self, keys: dict[str, PyJWK]) -> None:
        super().__init__(url="", ttl_seconds=float("inf"))
        self._keys = dict(keys)
        self._fetched_at = time.monotonic()

    async def startup(self) -> None:
        return None

    async def aclose(self) -> None:
        return None

    async def _refresh(self, *, force: bool = False, awaited_kid: str | None = None) -> None:
        return None
