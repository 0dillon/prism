"""Pipeline orchestration: stage order, failure recording, and resume."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from app.ai.gateway import LlmGateway
from app.ai.providers.fake import FakeProvider
from app.core.config import AppEnv, Settings
from app.ingestion.artifacts import InMemoryArtifactStore
from app.ingestion.pipeline import (
    PipelineOutcome,
    StageContext,
    default_deadline,
    run_pipeline,
)
from app.ingestion.stages import ORDERED_STAGES, IllegalTransitionError, Stage


@dataclass
class RecordingState:
    """Captures what the runner told the job store, in order."""

    advanced: list[tuple[Stage, float]] = field(default_factory=list)
    failures: list[tuple[Stage, str]] = field(default_factory=list)
    finished: bool = False
    warnings: list[str] = field(default_factory=list)

    async def advance(self, job_id: UUID, stage: Stage, progress: float) -> None:
        self.advanced.append((stage, progress))

    async def fail(self, job_id: UUID, stage: Stage, error: str) -> None:
        self.failures.append((stage, error))

    async def finish(self, job_id: UUID, lesson_id: UUID, warnings: list[str]) -> None:
        self.finished = True
        self.warnings = list(warnings)


def make_context(**overrides: object) -> StageContext:
    settings = Settings(
        app_env=AppEnv.test, llm_provider="fake", _env_file=None  # type: ignore[call-arg]
    )
    base: dict[str, object] = {
        "job_id": uuid4(),
        "lesson_id": uuid4(),
        "owner_id": uuid4(),
        "nonce": "abcd1234",
        "deadline": default_deadline(600),
        "gateway": LlmGateway(provider=FakeProvider(), settings=settings),
        "artifacts": InMemoryArtifactStore(),
    }
    base.update(overrides)
    return StageContext(**base)  # type: ignore[arg-type]


def trivial_pipeline(ran: list[Stage]) -> tuple[tuple[Stage, object], ...]:
    def make(stage: Stage):  # type: ignore[no-untyped-def]
        async def run(context: StageContext) -> None:
            ran.append(stage)

        return run

    return tuple((stage, make(stage)) for stage in ORDERED_STAGES)


class TestHappyPath:
    async def test_every_stage_runs_in_order(self) -> None:
        ran: list[Stage] = []
        state = RecordingState()

        outcome = await run_pipeline(
            pipeline=trivial_pipeline(ran),  # type: ignore[arg-type]
            context=make_context(),
            state=state,
        )

        assert outcome.ok
        assert ran == list(ORDERED_STAGES)
        assert state.finished is True
        assert [stage for stage, _ in state.advanced] == list(ORDERED_STAGES)

    async def test_progress_increases(self) -> None:
        """PRD CE-1: a teacher watching the upload sees it moving."""
        state = RecordingState()
        await run_pipeline(
            pipeline=trivial_pipeline([]),  # type: ignore[arg-type]
            context=make_context(),
            state=state,
        )
        progress = [value for _, value in state.advanced]
        assert progress == sorted(progress)
        assert all(0.0 <= value <= 1.0 for value in progress)

    async def test_warnings_reach_the_review_screen(self) -> None:
        state = RecordingState()
        context = make_context()

        async def warning_stage(ctx: StageContext) -> None:
            ctx.warn("pages 7 to 8 produced no concepts")

        pipeline = tuple(
            (stage, warning_stage if stage is Stage.CONCEPTS else _noop)
            for stage in ORDERED_STAGES
        )

        outcome = await run_pipeline(
            pipeline=pipeline,  # type: ignore[arg-type]
            context=context,
            state=state,
        )

        assert outcome.warnings == ["pages 7 to 8 produced no concepts"]
        assert state.warnings == ["pages 7 to 8 produced no concepts"]


async def _noop(context: StageContext) -> None:
    return None


class TestFailure:
    async def test_a_failing_stage_stops_the_pipeline(self) -> None:
        ran: list[Stage] = []
        state = RecordingState()

        async def boom(context: StageContext) -> None:
            raise RuntimeError("internal detail nobody should see")

        pipeline = tuple(
            (stage, boom if stage is Stage.MERGE else _recorder(stage, ran))
            for stage in ORDERED_STAGES
        )

        outcome = await run_pipeline(
            pipeline=pipeline,  # type: ignore[arg-type]
            context=make_context(),
            state=state,
        )

        assert outcome.ok is False
        assert outcome.failed_stage is Stage.MERGE
        assert ran == [Stage.EXTRACT, Stage.CHUNK, Stage.CONCEPTS]
        assert state.finished is False

    async def test_the_recorded_error_is_readable_and_leaks_nothing(self) -> None:
        """PRD 5.1 requires a human-readable error. Provider internals go to the logs."""
        state = RecordingState()

        async def boom(context: StageContext) -> None:
            raise RuntimeError("connection to 10.0.0.4:5432 failed: password authentication")

        pipeline = tuple(
            (stage, boom if stage is Stage.EXTRACT else _noop) for stage in ORDERED_STAGES
        )
        await run_pipeline(
            pipeline=pipeline,  # type: ignore[arg-type]
            context=make_context(),
            state=state,
        )

        stage, message = state.failures[0]
        assert stage is Stage.EXTRACT
        assert "10.0.0.4" not in message
        assert "password" not in message
        assert "retry" in message.lower()

    @pytest.mark.parametrize(
        ("raised", "expected_fragment"),
        [
            ("auth", "administrator"),
            ("rate_limit", "unavailable"),
            ("budget", "budget"),
            ("refusal", "declined"),
        ],
    )
    async def test_each_failure_class_gets_its_own_message(
        self, raised: str, expected_fragment: str
    ) -> None:
        from app.ai.errors import (
            BudgetExceededError,
            ProviderAuthError,
            ProviderRateLimitError,
            RefusalError,
        )

        failures = {
            "auth": ProviderAuthError("bad key"),
            "rate_limit": ProviderRateLimitError("429"),
            "budget": BudgetExceededError("over cap"),
            "refusal": RefusalError("declined"),
        }

        async def boom(context: StageContext) -> None:
            raise failures[raised]

        state = RecordingState()
        pipeline = tuple(
            (stage, boom if stage is Stage.CONCEPTS else _noop) for stage in ORDERED_STAGES
        )
        await run_pipeline(
            pipeline=pipeline,  # type: ignore[arg-type]
            context=make_context(),
            state=state,
        )

        assert expected_fragment in state.failures[0][1].lower()

    async def test_an_expired_deadline_stops_the_job(self) -> None:
        state = RecordingState()
        context = make_context(deadline=datetime.now(UTC) - timedelta(seconds=1))

        outcome = await run_pipeline(
            pipeline=trivial_pipeline([]),  # type: ignore[arg-type]
            context=context,
            state=state,
        )

        assert outcome.failed_stage is Stage.EXTRACT
        assert "longer than expected" in (outcome.error or "")


def _recorder(stage: Stage, into: list[Stage]):  # type: ignore[no-untyped-def]
    async def run(context: StageContext) -> None:
        into.append(stage)

    return run


class TestResume:
    async def test_resuming_skips_completed_stages(self) -> None:
        """The whole reason the failed stage is recorded: re-running extraction and the map
        stage of a part-finished job would spend the money twice."""
        ran: list[Stage] = []
        state = RecordingState()

        outcome = await run_pipeline(
            pipeline=trivial_pipeline(ran),  # type: ignore[arg-type]
            context=make_context(),
            state=state,
            resume_at=Stage.QUIZ,
        )

        assert outcome.ok
        assert ran == [Stage.QUIZ, Stage.VALIDATE, Stage.GROUND, Stage.SIGNS]
        assert outcome.skipped == [
            Stage.EXTRACT, Stage.CHUNK, Stage.CONCEPTS, Stage.MERGE
        ]

    async def test_resuming_at_the_first_stage_runs_everything(self) -> None:
        ran: list[Stage] = []
        await run_pipeline(
            pipeline=trivial_pipeline(ran),  # type: ignore[arg-type]
            context=make_context(),
            state=RecordingState(),
            resume_at=Stage.EXTRACT,
        )
        assert ran == list(ORDERED_STAGES)

    async def test_resuming_a_finished_job_does_nothing(self) -> None:
        ran: list[Stage] = []
        with pytest.raises(IllegalTransitionError):
            await run_pipeline(
                pipeline=trivial_pipeline(ran),  # type: ignore[arg-type]
                context=make_context(),
                state=RecordingState(),
                resume_at=Stage.NEEDS_REVIEW,
            )
        assert ran == []

    async def test_a_resumed_job_re_enters_its_failed_stage(self) -> None:
        """Re-entering the stage that failed is not a transition, so it must not be refused
        by the transition check."""
        ran: list[Stage] = []
        outcome = await run_pipeline(
            pipeline=trivial_pipeline(ran),  # type: ignore[arg-type]
            context=make_context(),
            state=RecordingState(),
            resume_at=Stage.GROUND,
        )
        assert outcome.ok
        assert ran == [Stage.GROUND, Stage.SIGNS]


class TestStageIsolation:
    async def test_a_stage_cannot_choose_what_runs_next(self) -> None:
        """Stages take a context and return None. There is no return value through which one
        could redirect the pipeline, which is what lets the same functions run under a
        durable worker unchanged."""
        import inspect

        from app.ingestion.pipeline import StageFn

        signature = str(StageFn)
        assert "None" in signature

        source = inspect.getsource(run_pipeline)
        assert "await stage_fn(context)" in source
        assert "= await stage_fn" not in source


class TestOutcome:
    def test_an_outcome_with_no_failure_is_ok(self) -> None:
        assert PipelineOutcome().ok is True
        assert PipelineOutcome(failed_stage=Stage.QUIZ).ok is False
