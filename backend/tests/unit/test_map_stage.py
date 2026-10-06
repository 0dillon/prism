"""Bounded-concurrency concept extraction (PRD 5.1 step 4, task P2-04, brief section 23)."""

from __future__ import annotations

import asyncio

import pytest

from app.ai.errors import (
    BudgetExceededError,
    InvalidOutputError,
    ProviderAuthError,
    ProviderConnectionError,
    RefusalError,
)
from app.ai.ingestion.chunk import Chunk, ChunkIndex, chunk_document
from app.ai.ingestion.extract import extract
from app.ai.schemas import CandidateConceptOut, ConceptExtractionOut
from app.ingestion.artifacts import ArtifactKind, InMemoryArtifactStore
from app.ingestion.concepts import MapStageFailedError, run_concept_extraction


def index_of(count: int) -> ChunkIndex:
    document = extract(
        data=(". ".join(f"Sentence {n} about the water cycle" for n in range(count * 60))).encode(),
        source_type="text",
    )
    built = chunk_document(document, chunk_tokens=100, overlap_tokens=10)
    return ChunkIndex(items=built.items[:count], source_sha256=built.source_sha256)


def concept_out(count: int = 1) -> ConceptExtractionOut:
    return ConceptExtractionOut(
        concepts=[
            CandidateConceptOut(
                title=f"Concept {n}",
                summary="A summary.",
                body="A body.",
                key_term=None,
                definition=None,
                examples=[],
                visual_hint=None,
                source_excerpt="Sentence 1 about the water cycle",
            )
            for n in range(count)
        ]
    )


class Harness:
    """Collects what the stage did, so tests assert on behaviour rather than on mocks."""

    def __init__(self) -> None:
        self.store = InMemoryArtifactStore()
        self.loaded: list[str] = []
        self.extracted: list[str] = []
        self.concurrent = 0
        self.peak = 0
        self.progress: list[float] = []

    async def load_text(self, chunk: Chunk) -> str:
        self.loaded.append(chunk.id)
        return chunk.text

    async def save_shard(self, chunk: Chunk, result: ConceptExtractionOut) -> None:
        await self.store.save(ArtifactKind.CHUNK_CONCEPTS, result, shard_key=chunk.id)

    async def report(self, fraction: float) -> None:
        self.progress.append(fraction)


class TestHappyPath:
    async def test_every_chunk_is_processed_and_sharded(self) -> None:
        harness = Harness()
        index = index_of(6)

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            harness.extracted.append(chunk.id)
            return concept_out(2)

        result = await run_concept_extraction(
            index=index,
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
        )

        assert len(harness.extracted) == 6
        assert result.total_concepts == 12
        assert await harness.store.shard_keys(ArtifactKind.CHUNK_CONCEPTS) == set(index.ids())

    async def test_progress_is_reported(self) -> None:
        """PRD CE-1: the upload page shows staged progress."""
        harness = Harness()

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            return concept_out()

        await run_concept_extraction(
            index=index_of(4),
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
            report_progress=harness.report,
        )

        assert harness.progress[-1] == pytest.approx(1.0)
        assert harness.progress == sorted(harness.progress)


class TestConcurrencyBound:
    async def test_in_flight_extractions_never_exceed_the_limit(self) -> None:
        """PRD 5.1 step 4: a concurrency limit of 4."""
        harness = Harness()

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            harness.concurrent += 1
            harness.peak = max(harness.peak, harness.concurrent)
            await asyncio.sleep(0.01)
            harness.concurrent -= 1
            return concept_out()

        await run_concept_extraction(
            index=index_of(20),
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
            concurrency=4,
        )

        assert harness.peak <= 4

    async def test_the_limit_is_configurable(self) -> None:
        harness = Harness()

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            harness.concurrent += 1
            harness.peak = max(harness.peak, harness.concurrent)
            await asyncio.sleep(0.01)
            harness.concurrent -= 1
            return concept_out()

        await run_concept_extraction(
            index=index_of(10),
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
            concurrency=2,
        )
        assert harness.peak <= 2

    async def test_work_really_is_parallel(self) -> None:
        """A limit of 4 that only ever runs one at a time would pass the bound test and
        still miss the 90-second ingestion budget in PRD 6.1."""
        harness = Harness()
        observed_peak = 0
        running = 0

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            nonlocal running, observed_peak
            running += 1
            observed_peak = max(observed_peak, running)
            await asyncio.sleep(0.02)
            running -= 1
            return concept_out()

        await run_concept_extraction(
            index=index_of(8),
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
            concurrency=4,
        )
        assert observed_peak > 1

    async def test_chunk_text_is_loaded_lazily(self) -> None:
        """The semaphore bounds in-flight calls, not memory. Loading every chunk's text up
        front is fine for a PDF and not fine for the 60-minute audio case in PRD 6.1."""
        harness = Harness()
        loaded_before_first_extract = -1

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            nonlocal loaded_before_first_extract
            if loaded_before_first_extract < 0:
                loaded_before_first_extract = len(harness.loaded)
            await asyncio.sleep(0.01)
            return concept_out()

        await run_concept_extraction(
            index=index_of(20),
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
            concurrency=4,
        )

        assert 0 < loaded_before_first_extract <= 4


class TestResume:
    async def test_completed_chunks_are_not_redone(self) -> None:
        """The entire point of per-chunk shards: a failure in chunk 9 of 12 re-runs chunk 9,
        not all twelve."""
        harness = Harness()
        index = index_of(12)
        done = set(index.ids()[:9])

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            harness.extracted.append(chunk.id)
            return concept_out()

        result = await run_concept_extraction(
            index=index,
            already_done=done,
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
        )

        assert len(harness.extracted) == 3
        assert set(harness.extracted) == set(index.ids()[9:])
        assert result.skipped == 9

    async def test_a_fully_complete_stage_does_nothing(self) -> None:
        harness = Harness()
        index = index_of(5)

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            raise AssertionError("should not be called")

        result = await run_concept_extraction(
            index=index,
            already_done=set(index.ids()),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
        )
        assert result.skipped == 5
        assert harness.loaded == []


class TestPartialFailure:
    async def test_one_unusable_answer_degrades_that_chunk_only(self) -> None:
        """PRD 2.3 principle 5 puts a teacher in front of the result, and 5.1 step 9 shows
        them what needs attention. A lesson with one visible gap beats a dead job."""
        harness = Harness()
        index = index_of(10)
        bad = index.ids()[3]

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            if chunk.id == bad:
                raise InvalidOutputError("nope", operation="ingest.concepts")
            return concept_out()

        result = await run_concept_extraction(
            index=index,
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
        )

        assert len(result.failed) == 1
        assert result.total_concepts == 9
        # The failed chunk still gets a shard, so a resume does not retry it forever.
        assert bad in await harness.store.shard_keys(ArtifactKind.CHUNK_CONCEPTS)

    async def test_a_refusal_degrades_rather_than_failing_the_job(self) -> None:
        harness = Harness()
        index = index_of(10)

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            if chunk.id == index.ids()[0]:
                raise RefusalError("declined", category="safety")
            return concept_out()

        result = await run_concept_extraction(
            index=index,
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
        )
        assert len(result.failed) == 1

    async def test_the_warnings_name_where_the_gap_is(self) -> None:
        """A teacher needs to know which part of their document produced nothing."""
        harness = Harness()
        index = index_of(10)

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            if chunk.id == index.ids()[2]:
                raise RefusalError("declined")
            return concept_out()

        result = await run_concept_extraction(
            index=index,
            already_done=set(),
            extract_chunk=extract_chunk,
            load_chunk_text=harness.load_text,
            save_shard=harness.save_shard,
        )

        warnings = result.warnings()
        assert len(warnings) == 1
        assert "no concepts were extracted" in warnings[0]

    async def test_too_much_degradation_fails_the_job(self) -> None:
        """Twelve bad chunks out of twelve is a broken pipeline, and saying so is more useful
        than handing a teacher a lesson full of holes."""
        harness = Harness()

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            raise InvalidOutputError("nope", operation="ingest.concepts")

        with pytest.raises(MapStageFailedError, match="may not be readable"):
            await run_concept_extraction(
                index=index_of(10),
                already_done=set(),
                extract_chunk=extract_chunk,
                load_chunk_text=harness.load_text,
                save_shard=harness.save_shard,
            )


class TestInfrastructureFailure:
    @pytest.mark.parametrize(
        "failure",
        [ProviderAuthError("bad key"), BudgetExceededError("over cap")],
    )
    async def test_a_terminal_failure_cancels_the_remaining_chunks(
        self, failure: Exception
    ) -> None:
        """An invalid key fails every chunk identically. Discovering that eleven more times
        is eleven more delays and no more information."""
        harness = Harness()
        attempts = 0

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            nonlocal attempts
            attempts += 1
            await asyncio.sleep(0.01)
            raise failure

        with pytest.raises(type(failure)):
            await run_concept_extraction(
                index=index_of(20),
                already_done=set(),
                extract_chunk=extract_chunk,
                load_chunk_text=harness.load_text,
                save_shard=harness.save_shard,
                concurrency=4,
            )

        # Only the batch already in flight ran; the other sixteen were cancelled.
        assert attempts <= 8

    async def test_an_exhausted_transport_failure_propagates(self) -> None:
        """Completed shards are already saved, so resuming re-runs only the stragglers."""
        harness = Harness()

        async def extract_chunk(chunk: Chunk, text: str) -> ConceptExtractionOut:
            raise ProviderConnectionError("network gone")

        with pytest.raises(BaseException):  # noqa: B017 - ExceptionGroup or the error itself
            await run_concept_extraction(
                index=index_of(6),
                already_done=set(),
                extract_chunk=extract_chunk,
                load_chunk_text=harness.load_text,
                save_shard=harness.save_shard,
            )
