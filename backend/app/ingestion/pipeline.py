"""The ingestion pipeline: stage order, the runner contract, and the in-process runner.

PRD 5.1 defines the stages; `app/ingestion/stages/` defines the legal transitions between
them. This module is what actually walks them.

**One source of stage order.** `PIPELINE` is the only place the sequence is written down.
Three copies of "what comes after merge" - in the runner, in the resume logic, in the status
endpoint - would be three chances to disagree.

**Stages never decide what runs next.** A stage function reads its input artifact, does its
work, and writes its output. It does not advance the job, choose a successor, swallow an
exception, or retry transport. That separation is what lets the same stage functions run under
the MVP's in-process runner and under a durable worker later, with no change to any of them.

**Resume is cheap because stages are artifact-idempotent.** A re-entered stage reads what is
already there and skips it, which is why the map stage can resume per chunk rather than
re-running a whole document's extraction.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Protocol
from uuid import UUID

from app.ai.gateway import LlmGateway
from app.core.logging import get_logger
from app.ingestion.artifacts import ArtifactStore
from app.ingestion.stages import (
    ORDERED_STAGES,
    Stage,
    assert_transition,
    progress_fraction,
    stages_from,
)

logger = get_logger(__name__)


@dataclass(slots=True)
class StageContext:
    """Everything a stage needs, and nothing about what runs before or after it."""

    job_id: UUID
    lesson_id: UUID
    owner_id: UUID
    nonce: str
    deadline: datetime
    gateway: LlmGateway
    artifacts: ArtifactStore
    org_id: UUID | None = None
    warnings: list[str] = field(default_factory=list)
    _progress: Callable[[float], Awaitable[None]] | None = None

    async def report_progress(self, fraction: float) -> None:
        if self._progress is not None:
            await self._progress(max(0.0, min(1.0, fraction)))

    def expired(self) -> bool:
        return datetime.now(UTC) > self.deadline

    def warn(self, message: str) -> None:
        """Record something the reviewing teacher should see (PRD 5.1 step 9)."""
        self.warnings.append(message)


StageFn = Callable[[StageContext], Awaitable[None]]


class JobStateStore(Protocol):
    """How a runner records progress. A Protocol so the pipeline needs no database to test."""

    async def advance(self, job_id: UUID, stage: Stage, progress: float) -> None: ...
    async def fail(self, job_id: UUID, stage: Stage, error: str) -> None: ...
    async def finish(self, job_id: UUID, lesson_id: UUID, warnings: list[str]) -> None: ...


class IngestionRunner(Protocol):
    """Starting and resuming jobs.

    The seam between the MVP and production. PRD 8.0 permits the MVP to run the pipeline in a
    single request; PRD 7.2 moves it to a durable worker later. Both satisfy this, and nothing
    above it changes.
    """

    async def start(self, *, job_id: UUID, lesson_id: UUID, resume_at: Stage | None = None) -> None:
        ...


@dataclass(slots=True)
class PipelineOutcome:
    completed: list[Stage] = field(default_factory=list)
    skipped: list[Stage] = field(default_factory=list)
    failed_stage: Stage | None = None
    error: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.failed_stage is None


class StageDeadlineExceededError(RuntimeError):
    """The job ran past its budget. Resumable, like any other stage failure."""


async def run_pipeline(
    *,
    pipeline: tuple[tuple[Stage, StageFn], ...],
    context: StageContext,
    state: JobStateStore,
    resume_at: Stage | None = None,
) -> PipelineOutcome:
    """Walk the stages from `resume_at`, recording progress and stopping at the first failure.

    Returns the outcome rather than raising: a failed ingestion is an ordinary, expected state
    that a teacher is shown and can retry, not an exception for someone to catch.
    """
    outcome = PipelineOutcome()
    remaining = stages_from(resume_at or Stage.PENDING)
    outcome.skipped = [stage for stage, _ in pipeline if stage not in remaining]

    current = resume_at or Stage.PENDING
    by_stage = dict(pipeline)

    for stage in remaining:
        stage_fn = by_stage.get(stage)
        if stage_fn is None:
            continue

        # A resumed job re-enters the stage it failed at, which is not a transition.
        if current is not stage:
            assert_transition(current, stage)

        await state.advance(context.job_id, stage, progress_fraction(stage))
        current = stage

        try:
            if context.expired():
                raise StageDeadlineExceededError(
                    "Ingestion took longer than expected and was stopped."
                )
            await stage_fn(context)
        except Exception as exc:
            message = _readable_error(exc)
            logger.warning(
                "ingestion_stage_failed",
                extra={
                    "job_id": str(context.job_id),
                    "lesson_id": str(context.lesson_id),
                    "stage": stage.value,
                    "failure": type(exc).__name__,
                },
            )
            await state.fail(context.job_id, stage, message)
            outcome.failed_stage = stage
            outcome.error = message
            outcome.warnings = context.warnings
            return outcome

        outcome.completed.append(stage)

    assert_transition(current, Stage.NEEDS_REVIEW)
    await state.finish(context.job_id, context.lesson_id, context.warnings)
    outcome.warnings = context.warnings
    logger.info(
        "ingestion_complete",
        extra={
            "job_id": str(context.job_id),
            "lesson_id": str(context.lesson_id),
            "stages_run": len(outcome.completed),
            "stages_skipped": len(outcome.skipped),
            "warnings": len(outcome.warnings),
        },
    )
    return outcome


def _readable_error(exc: Exception) -> str:
    """A message for the teacher watching the upload.

    PRD 5.1 requires a failed step to record a human-readable error. Provider internals and
    stack traces go to the logs; what surfaces here is what someone can act on.
    """
    from app.ai.errors import (
        BudgetExceededError,
        InvalidOutputError,
        ProviderAuthError,
        ProviderRateLimitError,
        ProviderTimeoutError,
        ProviderTransportError,
        RefusalError,
    )
    from app.ai.ingestion.extract import ExtractionError
    from app.ai.ingestion.validate import GraphRejectedError
    from app.ingestion.concepts import MapStageFailedError

    if isinstance(exc, ExtractionError | MapStageFailedError):
        return str(exc)
    if isinstance(exc, GraphRejectedError):
        return f"The extracted lesson did not hold together: {exc}"
    if isinstance(exc, StageDeadlineExceededError):
        return str(exc)
    if isinstance(exc, BudgetExceededError):
        return "This would exceed the monthly AI budget for your organisation."
    if isinstance(exc, ProviderAuthError):
        return "Prism could not reach its AI provider. An administrator has been notified."
    if isinstance(exc, ProviderRateLimitError | ProviderTimeoutError | ProviderTransportError):
        return "The AI service was unavailable. You can retry this upload."
    if isinstance(exc, RefusalError):
        return "The AI service declined to process this document."
    if isinstance(exc, InvalidOutputError):
        return "Prism could not read a usable lesson from this document. You can retry."
    return "Something went wrong while processing this document. You can retry."


def default_deadline(seconds: int) -> datetime:
    return datetime.now(UTC) + timedelta(seconds=seconds)


__all__ = [
    "ORDERED_STAGES",
    "IngestionRunner",
    "JobStateStore",
    "PipelineOutcome",
    "StageContext",
    "StageDeadlineExceededError",
    "StageFn",
    "default_deadline",
    "run_pipeline",
]
