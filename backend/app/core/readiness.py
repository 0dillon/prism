"""Readiness probe registry.

Liveness and readiness answer different questions, and conflating them causes outages:

* Liveness asks "is this process alive?". It must not touch dependencies. If it did, a brief
  database problem would make every orchestrator restart otherwise-healthy processes, turning
  a recoverable dependency blip into a rolling restart storm.
* Readiness asks "can this instance safely take traffic?". It may check dependencies, under a
  short timeout, and a failure removes the instance from the load balancer without killing it.

Subsystems register a probe as they come up during application startup.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Final

from app.core.logging import get_logger

logger = get_logger(__name__)

Probe = Callable[[], Awaitable[None]]

# A readiness check that hangs is itself an outage, so every probe runs under this ceiling.
PROBE_TIMEOUT_SECONDS: Final = 2.0

_probes: dict[str, Probe] = {}


def register_probe(name: str, probe: Probe) -> None:
    """Register a dependency check. Raising (or timing out) marks the instance not ready."""
    _probes[name] = probe


def clear_probes() -> None:
    """Used at shutdown and between tests."""
    _probes.clear()


@dataclass(frozen=True, slots=True)
class ReadinessResult:
    ready: bool
    checks: dict[str, str]


async def check_readiness() -> ReadinessResult:
    """Run every probe concurrently and summarise. Never raises."""
    if not _probes:
        return ReadinessResult(ready=True, checks={})

    names = list(_probes)
    results = await asyncio.gather(
        *(_run_probe(name, _probes[name]) for name in names),
        return_exceptions=False,
    )
    checks = dict(zip(names, results, strict=True))
    return ReadinessResult(ready=all(v == "ok" for v in checks.values()), checks=checks)


async def _run_probe(name: str, probe: Probe) -> str:
    try:
        async with asyncio.timeout(PROBE_TIMEOUT_SECONDS):
            await probe()
    except TimeoutError:
        logger.warning("readiness_probe_timeout", extra={"probe": name})
        return "timeout"
    except Exception as exc:  # a failing probe must never crash the readiness endpoint
        logger.warning("readiness_probe_failed", extra={"probe": name, "detail": str(exc)})
        return "failed"
    return "ok"
