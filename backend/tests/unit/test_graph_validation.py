"""Graph validation: what is rejected, what is flagged, and what is repaired."""

from __future__ import annotations

from typing import Any

import pytest

from app.ai.ingestion.validate import repair_graph, validate_graph
from app.schemas.knowledge_graph import DraftKnowledgeGraph


def concept(cid: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": cid,
        "sectionId": "s_1",
        "order": 0,
        "title": f"Concept {cid}",
        "summary": "A summary of the idea.",
        "body": "The full explanation of the idea.",
        "source": {
            "kind": "page",
            "start": 1,
            "excerpt": "Water evaporates when it is heated by the sun.",
        },
    }
    base.update(overrides)
    return base


def quiz(qid: str, cid: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": qid,
        "conceptId": cid,
        "type": "mcq",
        "prompt": "What drives evaporation?",
        "options": ["Energy", "Gravity", "Pressure"],
        "answer": "Energy",
        "explanation": "Molecules need energy to escape.",
        "difficulty": "recall",
    }
    base.update(overrides)
    return base


def draft(**overrides: Any) -> DraftKnowledgeGraph:
    base: dict[str, Any] = {
        "schemaVersion": 1,
        "lessonId": "lesson_1",
        "title": "The Water Cycle",
        "overview": "How water moves around.",
        "sections": [{"id": "s_1", "title": "Evaporation", "order": 0}],
        "concepts": [concept("c_1")],
        "quizItems": [quiz("q_1", "c_1"), quiz("q_2", "c_1", type="short_answer",
                                               options=None, answer="Energy")],
    }
    base.update(overrides)
    return DraftKnowledgeGraph.model_validate(base)


def codes(report: Any, severity: str | None = None) -> set[str]:
    return {
        f.code for f in report.findings if severity is None or f.severity == severity
    }


class TestAcceptsAGoodGraph:
    def test_a_sound_graph_produces_no_rejections(self) -> None:
        report = validate_graph(draft())
        assert report.ok
        assert not report.rejections


class TestRejections:
    def test_a_quiz_item_pointing_at_no_concept(self) -> None:
        report = validate_graph(draft(quizItems=[quiz("q_1", "c_missing")]))
        assert "DANGLING_QUIZ_CONCEPT" in codes(report, "reject")
        assert not report.ok

    def test_a_concept_in_a_section_that_does_not_exist(self) -> None:
        report = validate_graph(draft(concepts=[concept("c_1", sectionId="s_missing")]))
        assert "DANGLING_SECTION" in codes(report, "reject")

    def test_duplicate_concept_ids(self) -> None:
        report = validate_graph(
            draft(concepts=[concept("c_1"), concept("c_1")], quizItems=[])
        )
        assert "DUPLICATE_CONCEPT_ID" in codes(report, "reject")

    def test_a_prerequisite_cycle(self) -> None:
        report = validate_graph(
            draft(
                concepts=[
                    concept("c_1", prerequisites=["c_2"]),
                    concept("c_2", prerequisites=["c_1"]),
                ],
                quizItems=[],
            )
        )
        assert "PREREQUISITE_CYCLE" in codes(report, "reject")

    def test_an_mcq_whose_answer_is_not_an_option(self) -> None:
        """Unanswerable, so a correctness bug rather than a quality issue: the learner can
        never be marked correct, and mastery is computed from exactly these answers."""
        report = validate_graph(draft(quizItems=[quiz("q_1", "c_1", answer="Sunshine")]))
        assert "MCQ_ANSWER_NOT_IN_OPTIONS" in codes(report, "reject")

    def test_an_mcq_with_two_options_matching_the_answer(self) -> None:
        report = validate_graph(
            draft(quizItems=[quiz("q_1", "c_1", options=["Energy", "Energy", "Gravity"])])
        )
        assert "MCQ_ANSWER_AMBIGUOUS" in codes(report, "reject")
        assert "MCQ_DUPLICATE_OPTIONS" in codes(report, "reject")

    def test_an_mcq_with_no_options(self) -> None:
        report = validate_graph(draft(quizItems=[quiz("q_1", "c_1", options=None)]))
        assert "MCQ_WITHOUT_OPTIONS" in codes(report, "reject")

    def test_options_on_a_short_answer_question(self) -> None:
        report = validate_graph(
            draft(
                quizItems=[
                    quiz("q_1", "c_1", type="short_answer", options=["a", "b", "c"])
                ]
            )
        )
        assert "OPTIONS_ON_NON_MCQ" in codes(report, "reject")

    def test_a_true_false_question_answered_with_something_else(self) -> None:
        report = validate_graph(
            draft(
                quizItems=[
                    quiz("q_1", "c_1", type="true_false", options=None, answer="maybe")
                ]
            )
        )
        assert "TRUE_FALSE_ANSWER_INVALID" in codes(report, "reject")

    def test_the_summary_names_the_problems_in_readable_terms(self) -> None:
        """PRD 5.1 requires a failed step to record a human-readable error."""
        report = validate_graph(draft(quizItems=[quiz("q_1", "c_missing")]))
        summary = report.summary()
        assert "DANGLING_QUIZ_CONCEPT" in summary
        assert "not in the lesson" in summary


class TestFlags:
    def test_a_prerequisite_pointing_at_nothing_is_flagged_not_fatal(self) -> None:
        """Prerequisites are advisory in v1; dropping one bad edge loses nothing, while
        rejecting the job throws away an ingestion that cost real money."""
        report = validate_graph(draft(concepts=[concept("c_1", prerequisites=["c_ghost"])]))
        assert "DANGLING_PREREQUISITE" in codes(report, "flag")
        assert report.ok

    def test_a_self_prerequisite_is_flagged(self) -> None:
        report = validate_graph(draft(concepts=[concept("c_1", prerequisites=["c_1"])]))
        assert "SELF_PREREQUISITE" in codes(report, "flag")
        assert report.ok

    def test_a_concept_with_no_questions_is_flagged(self) -> None:
        report = validate_graph(draft(quizItems=[]))
        assert "CONCEPT_WITHOUT_QUIZ" in codes(report, "flag")
        assert report.ok

    def test_thin_quiz_coverage_is_flagged(self) -> None:
        """PRD 5.1 step 6 wants two or more items including an MCQ; the review screen lets a
        teacher add one, so this is a nudge rather than a failure."""
        report = validate_graph(draft(quizItems=[quiz("q_1", "c_1")]))
        assert "CONCEPT_QUIZ_THIN" in codes(report, "flag")

    def test_an_unusual_option_count_is_flagged(self) -> None:
        report = validate_graph(
            draft(quizItems=[quiz("q_1", "c_1", options=["Energy", "Gravity"])])
        )
        assert "MCQ_OPTION_COUNT" in codes(report, "flag")
        assert report.ok

    def test_gappy_ordering_is_flagged_and_repairable(self) -> None:
        report = validate_graph(
            draft(
                concepts=[concept("c_1", order=0), concept("c_2", order=7)],
                quizItems=[],
            )
        )
        assert "ORDER_NOT_CONTIGUOUS" in codes(report, "flag")
        assert report.ok

    def test_an_excerpt_absent_from_the_source_is_flagged(self) -> None:
        """The tripwire for fabrication and for successful prompt injection.

        Flagged rather than rejected because PDF extraction mangles text in ways unrelated to
        honesty, so false positives are expected and a teacher adjudicates.
        """
        report = validate_graph(
            draft(), source_text="A completely different document about geology."
        )
        assert "EXCERPT_NOT_IN_SOURCE" in codes(report, "flag")
        assert report.ok

    def test_a_grounded_excerpt_is_not_flagged(self) -> None:
        report = validate_graph(
            draft(),
            source_text=(
                "Chapter 1. Water evaporates when it is heated by the sun. It then rises."
            ),
        )
        assert "EXCERPT_NOT_IN_SOURCE" not in codes(report)


class TestRepair:
    def test_dangling_and_self_prerequisites_are_dropped(self) -> None:
        repaired = repair_graph(
            draft(
                concepts=[concept("c_1", prerequisites=["c_ghost", "c_1", "c_2"]),
                          concept("c_2")],
                quizItems=[],
            )
        )
        assert repaired.concepts[0].prerequisites == ["c_2"]

    def test_ordering_is_renumbered_contiguously_preserving_sequence(self) -> None:
        repaired = repair_graph(
            draft(
                concepts=[
                    concept("c_b", order=50, title="Second"),
                    concept("c_a", order=10, title="First"),
                    concept("c_c", order=99, title="Third"),
                ],
                quizItems=[],
            )
        )
        assert [c.title for c in repaired.concepts] == ["First", "Second", "Third"]
        assert [c.order for c in repaired.concepts] == [0, 1, 2]

    def test_repair_is_deterministic(self) -> None:
        source = draft(
            concepts=[concept("c_b", order=5), concept("c_a", order=5)], quizItems=[]
        )
        assert repair_graph(source).model_dump() == repair_graph(source).model_dump()

    def test_repair_leaves_a_sound_graph_unchanged_in_substance(self) -> None:
        original = draft()
        repaired = repair_graph(original)
        assert [c.title for c in repaired.concepts] == [c.title for c in original.concepts]
        assert [c.body for c in repaired.concepts] == [c.body for c in original.concepts]

    def test_a_repaired_graph_passes_the_checks_it_was_flagged_for(self) -> None:
        before = draft(
            concepts=[concept("c_1", order=9, prerequisites=["c_ghost"])], quizItems=[]
        )
        after = validate_graph(repair_graph(before))
        assert "DANGLING_PREREQUISITE" not in codes(after)
        assert "ORDER_NOT_CONTIGUOUS" not in codes(after)


class TestNoModelInvolvement:
    def test_validation_is_pure(self) -> None:
        """An LLM may propose content. It never decides whether content is acceptable."""
        import inspect

        from app.ai.ingestion import validate as module

        source = inspect.getsource(module)
        for forbidden in ("gateway", "generate_structured", "await ", "async def"):
            assert forbidden not in source, (
                f"{forbidden!r} in the validator: validation must stay deterministic and "
                "must never ask a model whether a graph is acceptable"
            )


@pytest.mark.parametrize("severity", ["reject", "flag"])
def test_every_finding_is_actionable(severity: str) -> None:
    """A finding a teacher cannot act on is noise in the review screen."""
    report = validate_graph(
        draft(
            concepts=[concept("c_1", prerequisites=["c_ghost"], sectionId="s_missing")],
            quizItems=[quiz("q_1", "c_1", answer="Nope")],
        )
    )
    for finding in report.findings:
        if finding.severity != severity:
            continue
        assert finding.code and finding.code.isupper()
        assert finding.path
        assert finding.message.endswith(".")
        assert len(finding.message) > 20
