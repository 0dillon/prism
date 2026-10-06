"""Stage artifact storage.

PRD 5.1 requires a failed ingestion job to be "resumable from the failed step", and 6.5 says
jobs are "idempotent and resumable per step". Both are only meaningful if completed stages are
not re-run: resuming a job that re-does extraction and the whole map stage has spent the money
twice and resumed nothing.

So each stage writes what it produced, and a resumed job reads rather than recomputes.

**Map output is sharded per chunk.** This is the part that makes resume real. A whole-stage
artifact means a failure in chunk 9 of 12 re-runs all twelve; a shard per chunk re-runs chunk
9. Chunk ids are deterministic in the source and the content, so the shards of a resumed job
match - and if the chunker itself changes, they correctly stop matching and the stage re-runs.

**Small artifacts stay in Postgres, large ones spill to object storage.** The per-chunk map
results are numerous, small and hot, which suits a row; the whole-document artifacts are
singular, large and cold, which does not. One `load`/`save` API over both, so no caller ever
branches on size.
"""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, TypeVar

import orjson
from pydantic import BaseModel

from app.core.logging import get_logger

logger = get_logger(__name__)

TModel = TypeVar("TModel", bound=BaseModel)

# Chosen so the numerous per-chunk map results stay in the database, where they are cheap to
# list and transactional, while whole-document artifacts spill to the bucket.
DEFAULT_INLINE_MAX_BYTES = 262_144


class ArtifactKind(StrEnum):
    """Mirrors the `artifact_kind` enum in the database."""

    SOURCE_DOCUMENT = "source_document"
    CHUNKS = "chunks"
    CHUNK_TEXT = "chunk_text"
    CHUNK_CONCEPTS = "chunk_concepts"
    MERGED_GRAPH = "merged_graph"
    QUIZ_GRAPH = "quiz_graph"
    VALIDATED_GRAPH = "validated_graph"
    GROUNDED_GRAPH = "grounded_graph"
    GRAPH_FINDINGS = "graph_findings"
    SIGN_LINKS = "sign_links"


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    kind: ArtifactKind
    shard_key: str = ""
    content_sha256: str = ""
    size_bytes: int = 0


def content_hash(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


class ArtifactStore(ABC):
    """Reads and writes stage artifacts.

    Abstract so the pipeline is testable without a database, and so the spill-to-storage
    decision lives in one place rather than at every call site.
    """

    def __init__(self, *, inline_max_bytes: int = DEFAULT_INLINE_MAX_BYTES) -> None:
        self._inline_max_bytes = inline_max_bytes

    # ---- subclass responsibilities ------------------------------------
    @abstractmethod
    async def _read(self, kind: ArtifactKind, shard_key: str) -> bytes | None: ...

    @abstractmethod
    async def _write(
        self, kind: ArtifactKind, shard_key: str, payload: bytes, *, spill: bool
    ) -> ArtifactRef: ...

    @abstractmethod
    async def shard_keys(self, kind: ArtifactKind) -> set[str]: ...

    @abstractmethod
    async def discard(self, kind: ArtifactKind, shard_key: str = "") -> None: ...

    # ---- the API callers use ------------------------------------------
    async def save(
        self, kind: ArtifactKind, value: BaseModel | dict[str, Any] | list[Any],
        *, shard_key: str = "",
    ) -> ArtifactRef:
        payload = (
            value.model_dump_json(by_alias=True).encode()
            if isinstance(value, BaseModel)
            else orjson.dumps(value)
        )
        spill = len(payload) > self._inline_max_bytes
        ref = await self._write(kind, shard_key, payload, spill=spill)
        logger.debug(
            "artifact_saved",
            extra={
                "kind": kind.value,
                "shard_key": shard_key or None,
                "size_bytes": len(payload),
                "spilled": spill,
            },
        )
        return ref

    async def load(
        self, kind: ArtifactKind, model: type[TModel], *, shard_key: str = ""
    ) -> TModel | None:
        payload = await self._read(kind, shard_key)
        if payload is None:
            return None
        return model.model_validate_json(payload)

    async def load_raw(
        self, kind: ArtifactKind, *, shard_key: str = ""
    ) -> Any | None:
        payload = await self._read(kind, shard_key)
        return None if payload is None else orjson.loads(payload)

    async def exists(self, kind: ArtifactKind, *, shard_key: str = "") -> bool:
        return await self._read(kind, shard_key) is not None


class InMemoryArtifactStore(ArtifactStore):
    """For tests and for the in-process runner's unit coverage."""

    def __init__(self, *, inline_max_bytes: int = DEFAULT_INLINE_MAX_BYTES) -> None:
        super().__init__(inline_max_bytes=inline_max_bytes)
        self._rows: dict[tuple[ArtifactKind, str], bytes] = {}
        self.spilled: set[tuple[ArtifactKind, str]] = set()

    async def _read(self, kind: ArtifactKind, shard_key: str) -> bytes | None:
        return self._rows.get((kind, shard_key))

    async def _write(
        self, kind: ArtifactKind, shard_key: str, payload: bytes, *, spill: bool
    ) -> ArtifactRef:
        self._rows[(kind, shard_key)] = payload
        if spill:
            self.spilled.add((kind, shard_key))
        return ArtifactRef(
            kind=kind,
            shard_key=shard_key,
            content_sha256=content_hash(payload),
            size_bytes=len(payload),
        )

    async def shard_keys(self, kind: ArtifactKind) -> set[str]:
        return {shard for (stored_kind, shard) in self._rows if stored_kind == kind}

    async def discard(self, kind: ArtifactKind, shard_key: str = "") -> None:
        self._rows.pop((kind, shard_key), None)

    def clear(self) -> None:
        self._rows.clear()
        self.spilled.clear()
