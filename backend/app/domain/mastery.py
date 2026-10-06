"""Concept mastery. The reference implementation of the rule in PRD section 5.7.

| Status        | Rule                                                              |
| ------------- | ----------------------------------------------------------------- |
| `not_started` | No `concept_viewed` event                                          |
| `in_progress` | Viewed, and the mastered rule is not met                           |
| `mastered`    | The two most recent answers on that concept's quiz items are both correct |

Two things this module is careful about, because both are easy to get wrong:

**Mastery is a pure function of the event set, never a running counter.** Events arrive
batched, at-least-once, and potentially out of order, with a client-supplied `occurredAt`.
An incremental counter that remembered "last two correct" would conclude `mastered` from
`[wrong@t3]` arriving before `[correct@t1, correct@t2]`, when the true ordered state is
`in_progress`. Recomputing from the ordered set converges on the same answer regardless of
arrival order, and is idempotent under replay.

**Mastery does not depend on the renderer.** Cards, reader, conversation and visual must
produce identical mastery for equivalent answer sequences (PRD CE-10). Nothing here reads
`layout`, and nothing may be added that does.

This is the authority the SQL trigger is tested against: `tests/unit/test_mastery.py` checks
the rule, and the database parity test checks the trigger agrees with it.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final, Literal

MasteryStatus = Literal["not_started", "in_progress", "mastered"]

# "The two most recent answers". Named rather than inlined so the SQL trigger and this
# function can be read against the same constant.
MASTERY_WINDOW: Final = 2


def compute_status(*, viewed: bool, answers_oldest_first: Sequence[bool]) -> MasteryStatus:
    """Mastery status for one learner on one concept.

    `answers_oldest_first` holds the correctness of every `quiz_answered` event for the
    concept, ordered by when it occurred. Only the most recent two decide mastery; the rest
    are history.
    """
    recent = list(answers_oldest_first)[-MASTERY_WINDOW:]
    if len(recent) == MASTERY_WINDOW and all(recent):
        return "mastered"
    if viewed or answers_oldest_first:
        return "in_progress"
    return "not_started"


def lesson_progress(mastered_concepts: int, total_concepts: int) -> float:
    """Mastered concepts over total concepts in the current graph version (PRD 5.7).

    Returns 0.0 for an empty graph rather than raising: a lesson mid-republish should render a
    zeroed progress bar, not a 500.
    """
    if total_concepts <= 0:
        return 0.0
    return mastered_concepts / total_concepts
