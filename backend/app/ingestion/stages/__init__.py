"""The ingestion stage machine.

PRD 5.1 defines the pipeline, and 6.5 requires that jobs be "idempotent and resumable per
step". Representing the stages explicitly - rather than as a sequence of function calls - is
what makes both true: a job records where it is, an illegal transition raises instead of
silently corrupting state, and a failure records which stage to resume from rather than
leaving it to be inferred.

Keeping the order in one tuple matters too. Three copies of "what comes after merge" in the
runner, the resume logic and the status endpoint is three chances to disagree.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Final


class Stage(StrEnum):
    """Where a job is. Mirrors the `ingestion_stage` enum in the database."""

    PENDING = "pending"
    EXTRACT = "extract"
    CHUNK = "chunk"
    CONCEPTS = "concepts"
    MERGE = "merge"
    QUIZ = "quiz"
    VALIDATE = "validate"
    GROUND = "ground"
    SIGNS = "signs"
    NEEDS_REVIEW = "needs_review"
    FAILED = "failed"


# The working stages, in order. The single source of truth for pipeline sequence.
ORDERED_STAGES: Final[tuple[Stage, ...]] = (
    Stage.EXTRACT,
    Stage.CHUNK,
    Stage.CONCEPTS,
    Stage.MERGE,
    Stage.QUIZ,
    Stage.VALIDATE,
    Stage.GROUND,
    Stage.SIGNS,
)

TERMINAL_STAGES: Final[frozenset[Stage]] = frozenset({Stage.NEEDS_REVIEW, Stage.FAILED})

LEGAL_TRANSITIONS: Final[Mapping[Stage, frozenset[Stage]]] = {
    Stage.PENDING: frozenset({Stage.EXTRACT, Stage.FAILED}),
    Stage.EXTRACT: frozenset({Stage.CHUNK, Stage.FAILED}),
    Stage.CHUNK: frozenset({Stage.CONCEPTS, Stage.FAILED}),
    Stage.CONCEPTS: frozenset({Stage.MERGE, Stage.FAILED}),
    Stage.MERGE: frozenset({Stage.QUIZ, Stage.FAILED}),
    Stage.QUIZ: frozenset({Stage.VALIDATE, Stage.FAILED}),
    Stage.VALIDATE: frozenset({Stage.GROUND, Stage.FAILED}),
    Stage.GROUND: frozenset({Stage.SIGNS, Stage.FAILED}),
    Stage.SIGNS: frozenset({Stage.NEEDS_REVIEW, Stage.FAILED}),
    # Terminal success. A published lesson moves on through the lesson status, not here.
    Stage.NEEDS_REVIEW: frozenset(),
    # Resuming re-enters the stage that failed, which is recorded separately, so there is no
    # transition out of FAILED in this table.
    Stage.FAILED: frozenset(),
}


class IllegalTransitionError(ValueError):
    """An attempt to move a job somewhere it cannot go from where it is.

    Raised rather than tolerated. A job that can be moved arbitrarily is a job whose recorded
    state means nothing, and the status endpoint reports that state to a waiting teacher.
    """

    def __init__(self, current: Stage, requested: Stage) -> None:
        super().__init__(
            f"cannot move an ingestion job from {current.value} to {requested.value}"
        )
        self.current = current
        self.requested = requested


def can_transition(current: Stage, requested: Stage) -> bool:
    return requested in LEGAL_TRANSITIONS.get(current, frozenset())


def assert_transition(current: Stage, requested: Stage) -> None:
    if not can_transition(current, requested):
        raise IllegalTransitionError(current, requested)


def next_stage(current: Stage) -> Stage:
    """The stage that follows `current` on the success path."""
    if current is Stage.PENDING:
        return ORDERED_STAGES[0]
    if current in TERMINAL_STAGES:
        raise IllegalTransitionError(current, current)
    index = ORDERED_STAGES.index(current)
    if index + 1 < len(ORDERED_STAGES):
        return ORDERED_STAGES[index + 1]
    return Stage.NEEDS_REVIEW


def stages_from(resume_at: Stage) -> tuple[Stage, ...]:
    """The stages still to run when resuming at `resume_at`.

    Completed stages are not repeated. That is the whole point of recording where a job
    failed: re-running the extraction and the map stage of a part-finished job would spend
    the money twice.
    """
    if resume_at is Stage.PENDING:
        return ORDERED_STAGES
    if resume_at in TERMINAL_STAGES:
        return ()
    index = ORDERED_STAGES.index(resume_at)
    return ORDERED_STAGES[index:]


def progress_fraction(stage: Stage) -> float:
    """Roughly how far along a job is, for the status endpoint.

    Deliberately coarse. A teacher watching an upload wants to see movement and a sense of
    how much is left, not a precise figure.
    """
    if stage is Stage.PENDING:
        return 0.0
    if stage is Stage.NEEDS_REVIEW:
        return 1.0
    if stage is Stage.FAILED:
        return 0.0
    return (ORDERED_STAGES.index(stage) + 1) / (len(ORDERED_STAGES) + 1)


# Human-readable labels for the staged progress PRD CE-1 requires the upload page to show.
STAGE_LABELS: Final[Mapping[Stage, str]] = {
    Stage.PENDING: "Waiting to start",
    Stage.EXTRACT: "Reading your file",
    Stage.CHUNK: "Breaking it into sections",
    Stage.CONCEPTS: "Finding the key ideas",
    Stage.MERGE: "Putting the ideas in order",
    Stage.QUIZ: "Writing practice questions",
    Stage.VALIDATE: "Checking everything fits together",
    Stage.GROUND: "Checking it against your source",
    Stage.SIGNS: "Matching key terms to sign clips",
    Stage.NEEDS_REVIEW: "Ready for your review",
    Stage.FAILED: "Something went wrong",
}
