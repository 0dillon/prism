"""The concept extraction map stage (PRD 5.1 step 4, task P2-04).

PRD 5.1 specifies parallel extraction with a concurrency limit of 4. Three details of the
implementation are load-bearing, and each corresponds to a way this is commonly got wrong.

**The semaphore is acquired inside the task, not around task creation.** Acquiring it outside
means every task starts immediately and the limit does nothing - the classic version of this
bug, and one that looks correct right up until the provider rate-limits.

**Chunk text is loaded per task, not up front.** The semaphore bounds in-flight calls, not
memory. Loading every chunk's text before starting is fine for a 20-page PDF and not fine for
the 60-minute audio case in PRD 6.1; loading inside the task bounds peak memory at
`concurrency x chunk size`.

**Infrastructure failures cancel siblings; content failures do not.** An invalid API key will
fail every chunk identically, so discovering that eleven more times is eleven more delays for
nothing. A refusal or an unparseable answer on one chunk is a fact about that chunk, and the
lesson is still worth producing with a visible gap - PRD 2.3 principle 5 puts a teacher in
front of it before any learner, and PRD 5.1 step 9 shows them what needs attention.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from app.ai.errors import (
    BudgetExceededError,
    InvalidOutputError,
    ProviderAuthError,
    ProviderBadRequestError,
    RefusalError,
)
from app.ai.ingestion.chunk import Chunk, ChunkIndex
from app.ai.schemas import ConceptExtractionOut
from app.core.logging import get_logger

logger = get_logger(__name__)

# Beyond this proportion of chunks producing nothing, the job has not partly succeeded - it
# has failed, and saying so is more useful than handing a teacher a lesson full of holes.
DEFAULT_MAX_DEGRADED_FRACTION = 0.20


@dataclass(frozen=True, slots=True)
class ChunkOutcome:
    chunk_id: str
    ok: bool
    concept_count: int = 0
    reason: str | None = None
    locator: str | None = None


@dataclass(slots=True)
class MapResult:
    outcomes: list[ChunkOutcome] = field(default_factory=list)
    skipped: int = 0

    @property
    def failed(self) -> list[ChunkOutcome]:
        return [outcome for outcome in self.outcomes if not outcome.ok]

    @property
    def total_concepts(self) -> int:
        return sum(outcome.concept_count for outcome in self.outcomes)

    def warnings(self) -> list[str]:
        """Human-readable notes for the review screen."""
        return [
            f"{outcome.locator or outcome.chunk_id}: no concepts were extracted "
            f"({outcome.reason})"
            for outcome in self.failed
        ]


class MapStageFailedError(RuntimeError):
    """Too much of the document produced nothing for the result to be worth reviewing."""


ExtractChunk = Callable[[Chunk, str], Awaitable[ConceptExtractionOut]]
LoadChunkText = Callable[[Chunk], Awaitable[str]]
SaveShard = Callable[[Chunk, ConceptExtractionOut], Awaitable[None]]
ReportProgress = Callable[[float], Awaitable[None]]


async def run_concept_extraction(
    *,
    index: ChunkIndex,
    already_done: set[str],
    extract_chunk: ExtractChunk,
    load_chunk_text: LoadChunkText,
    save_shard: SaveShard,
    report_progress: ReportProgress | None = None,
    concurrency: int = 4,
    max_degraded_fraction: float = DEFAULT_MAX_DEGRADED_FRACTION,
) -> MapResult:
    """Extract concepts from every chunk that has not already been done.

    `already_done` carries the shard keys a previous attempt completed, which is what turns
    a resume into "finish the remaining chunks" rather than "start again".
    """
    todo = [chunk for chunk in index.items if chunk.id not in already_done]
    result = MapResult(skipped=len(index) - len(todo))

    if not todo:
        logger.info("map_stage_already_complete", extra={"chunks": len(index)})
        return result

    semaphore = asyncio.Semaphore(concurrency)
    completed = 0

    async def process(chunk: Chunk) -> None:
        nonlocal completed
        # Acquired here, inside the task. Around create_task it would bound nothing.
        async with semaphore:
            text = await load_chunk_text(chunk)
            try:
                extracted = await extract_chunk(chunk, text)
            except (InvalidOutputError, RefusalError) as exc:
                # A fact about this chunk, not about the job. The lesson is still worth
                # producing, with the gap visible to the teacher who reviews it.
                logger.warning(
                    "chunk_extraction_degraded",
                    extra={"chunk_id": chunk.id, "failure": type(exc).__name__},
                )
                await save_shard(chunk, ConceptExtractionOut(concepts=[]))
                result.outcomes.append(
                    ChunkOutcome(
                        chunk_id=chunk.id,
                        ok=False,
                        reason=_readable(exc),
                        locator=_locator_label(chunk),
                    )
                )
            else:
                await save_shard(chunk, extracted)
                result.outcomes.append(
                    ChunkOutcome(
                        chunk_id=chunk.id, ok=True, concept_count=len(extracted.concepts)
                    )
                )

            completed += 1
            if report_progress is not None:
                await report_progress(completed / len(todo))

    try:
        async with asyncio.TaskGroup() as group:
            for chunk in todo:
                group.create_task(process(chunk))
    except* (ProviderAuthError, ProviderBadRequestError, BudgetExceededError) as group_error:
        # Not data-dependent: every sibling would fail the same way. TaskGroup has already
        # cancelled them, which is the point - discovering a bad API key once is enough.
        raise group_error.exceptions[0] from None

    failures = len(result.failed)
    if failures and failures / len(index) > max_degraded_fraction:
        raise MapStageFailedError(
            f"{failures} of {len(index)} sections produced no concepts. "
            "The document may not be readable as teaching material."
        )

    logger.info(
        "map_stage_complete",
        extra={
            "chunks": len(index),
            "processed": len(todo),
            "skipped": result.skipped,
            "degraded": failures,
            "concepts": result.total_concepts,
        },
    )
    return result


def _readable(exc: Exception) -> str:
    if isinstance(exc, RefusalError):
        return "the model declined to process this section"
    return "the model's answer could not be used"


def _locator_label(chunk: Chunk) -> str:
    if chunk.kind == "page":
        return f"page {int(chunk.start)}"
    if chunk.kind == "time":
        return f"{int(chunk.start) // 60}:{int(chunk.start) % 60:02d}"
    return f"section {chunk.index + 1}"
