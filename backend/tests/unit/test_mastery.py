"""The mastery rule from PRD section 5.7.

This is the reference the SQL trigger is held to. If this file and the trigger ever disagree,
the trigger is wrong: a learner's progress must be reproducible from their events.
"""

from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.mastery import compute_status, lesson_progress


class TestThePrdExamples:
    def test_one_correct_answer_is_not_yet_mastery(self) -> None:
        assert compute_status(viewed=True, answers_oldest_first=[True]) == "in_progress"

    def test_two_consecutive_correct_answers_are_mastery(self) -> None:
        assert compute_status(viewed=True, answers_oldest_first=[True, True]) == "mastered"

    def test_a_later_wrong_answer_returns_to_in_progress(self) -> None:
        assert (
            compute_status(viewed=True, answers_oldest_first=[True, True, False])
            == "in_progress"
        )


class TestStatusBoundaries:
    def test_never_viewed_and_never_answered_is_not_started(self) -> None:
        assert compute_status(viewed=False, answers_oldest_first=[]) == "not_started"

    def test_viewed_without_answering_is_in_progress(self) -> None:
        assert compute_status(viewed=True, answers_oldest_first=[]) == "in_progress"

    def test_answering_implies_progress_even_without_a_view_event(self) -> None:
        """A dropped concept_viewed event must not report a learner as not started."""
        assert compute_status(viewed=False, answers_oldest_first=[False]) == "in_progress"

    def test_only_the_two_most_recent_answers_count(self) -> None:
        """Early mistakes do not permanently block mastery; recovery is possible."""
        assert (
            compute_status(
                viewed=True, answers_oldest_first=[False, False, False, True, True]
            )
            == "mastered"
        )

    def test_two_correct_answers_that_are_not_the_most_recent_are_not_mastery(self) -> None:
        assert (
            compute_status(viewed=True, answers_oldest_first=[True, True, False, False])
            == "in_progress"
        )

    def test_one_correct_then_one_wrong_is_not_mastery(self) -> None:
        assert (
            compute_status(viewed=True, answers_oldest_first=[True, False]) == "in_progress"
        )


class TestOrderIndependence:
    def test_the_rule_depends_on_order_not_on_arrival(self) -> None:
        """The reason mastery is recomputed rather than incremented.

        Events arrive batched, at-least-once and out of order. A counter fed
        `wrong, correct, correct` in arrival order would say "mastered"; the true ordered
        history `correct, correct, wrong` is in_progress.
        """
        true_history = [True, True, False]
        assert compute_status(viewed=True, answers_oldest_first=true_history) == "in_progress"

        arrival_order = [False, True, True]
        assert compute_status(viewed=True, answers_oldest_first=arrival_order) == "mastered"
        # Different sequences, different answers. Ordering by occurredAt is what makes the
        # first one authoritative.

    @given(st.lists(st.booleans(), min_size=0, max_size=12))
    def test_recomputation_is_idempotent(self, answers: list[bool]) -> None:
        first = compute_status(viewed=True, answers_oldest_first=answers)
        second = compute_status(viewed=True, answers_oldest_first=list(answers))
        assert first == second

    @given(st.lists(st.booleans(), min_size=2, max_size=12))
    def test_mastery_is_exactly_the_last_two_being_correct(self, answers: list[bool]) -> None:
        expected = "mastered" if answers[-1] and answers[-2] else "in_progress"
        assert compute_status(viewed=True, answers_oldest_first=answers) == expected


class TestRendererIndependence:
    def test_the_rule_takes_no_renderer_input(self) -> None:
        """PRD CE-10: cards, reader, conversation and visual must agree.

        Enforced structurally: there is no parameter through which a renderer could influence
        the result.
        """
        import inspect

        parameters = set(inspect.signature(compute_status).parameters)
        assert parameters == {"viewed", "answers_oldest_first"}


class TestLessonProgress:
    @pytest.mark.parametrize(
        ("mastered", "total", "expected"),
        [(0, 10, 0.0), (5, 10, 0.5), (10, 10, 1.0)],
    )
    def test_progress_is_mastered_over_total(
        self, mastered: int, total: int, expected: float
    ) -> None:
        assert lesson_progress(mastered, total) == expected

    def test_an_empty_graph_reports_zero_rather_than_dividing_by_zero(self) -> None:
        assert lesson_progress(0, 0) == 0.0
