"""The Knowledge Graph must match PRD section 5.2, and a published graph must be coherent."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.schemas.knowledge_graph import DraftKnowledgeGraph, KnowledgeGraph


def _concept(concept_id: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": concept_id,
        "sectionId": "s_1",
        "order": 0,
        "title": "Evaporation",
        "summary": "Liquid water becomes vapour when it gains enough energy.",
        "body": "Evaporation happens when water molecules gain enough energy to escape.",
        "source": {"kind": "page", "start": 1, "excerpt": "Water evaporates when heated."},
    }
    base.update(overrides)
    return base


def _quiz(quiz_id: str, concept_id: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": quiz_id,
        "conceptId": concept_id,
        "type": "mcq",
        "prompt": "What drives evaporation?",
        "options": ["Energy", "Gravity", "Pressure"],
        "answer": "Energy",
        "explanation": "Molecules need energy to escape the liquid.",
        "difficulty": "recall",
    }
    base.update(overrides)
    return base


def _graph(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "schemaVersion": 1,
        "lessonId": "lesson_1",
        "title": "The Water Cycle",
        "overview": "How water moves between the ground, the air and the clouds.",
        "sections": [{"id": "s_1", "title": "Evaporation", "order": 0}],
        "concepts": [_concept("c_1")],
        "quizItems": [_quiz("q_1", "c_1")],
    }
    base.update(overrides)
    return base


class TestShape:
    def test_a_valid_graph_parses(self) -> None:
        graph = KnowledgeGraph.model_validate(_graph())
        assert graph.schema_version == 1
        assert graph.language == "en"
        assert graph.concepts[0].examples == []
        assert graph.concepts[0].prerequisites == []
        assert graph.concepts[0].flags == []
        assert graph.quiz_items[0].acceptable == []

    def test_json_is_camel_case(self) -> None:
        payload = KnowledgeGraph.model_validate(_graph()).model_dump(
            mode="json", by_alias=True
        )
        assert payload["schemaVersion"] == 1
        assert payload["lessonId"] == "lesson_1"
        assert payload["concepts"][0]["sectionId"] == "s_1"
        assert payload["quizItems"][0]["conceptId"] == "c_1"

    def test_round_trip_is_stable(self) -> None:
        original = KnowledgeGraph.model_validate(_graph())
        restored = KnowledgeGraph.model_validate(
            original.model_dump(mode="json", by_alias=True)
        )
        assert restored == original

    @pytest.mark.parametrize(
        ("field", "limit"),
        [("title", 80), ("summary", 240)],
    )
    def test_concept_text_limits_match_the_prd(self, field: str, limit: int) -> None:
        KnowledgeGraph.model_validate(_graph(concepts=[_concept("c_1", **{field: "x" * limit})]))
        with pytest.raises(ValidationError):
            KnowledgeGraph.model_validate(
                _graph(concepts=[_concept("c_1", **{field: "x" * (limit + 1)})])
            )

    def test_overview_and_excerpt_limits_match_the_prd(self) -> None:
        KnowledgeGraph.model_validate(_graph(overview="x" * 600))
        with pytest.raises(ValidationError):
            KnowledgeGraph.model_validate(_graph(overview="x" * 601))

        with pytest.raises(ValidationError):
            KnowledgeGraph.model_validate(
                _graph(
                    concepts=[
                        _concept(
                            "c_1",
                            source={"kind": "page", "start": 1, "excerpt": "x" * 1201},
                        )
                    ]
                )
            )

    def test_at_least_one_concept_is_required(self) -> None:
        with pytest.raises(ValidationError):
            KnowledgeGraph.model_validate(_graph(concepts=[], quizItems=[]))

    def test_presentation_data_is_rejected(self) -> None:
        """PRD 2.3 principle 1: knowledge is separate from interface."""
        with pytest.raises(ValidationError):
            KnowledgeGraph.model_validate(
                _graph(concepts=[_concept("c_1", layout="cards", font="lexend")])
            )


class TestReferentialIntegrity:
    def test_a_quiz_item_referencing_a_missing_concept_is_rejected(self) -> None:
        """PRD task P1-01, done when: rejects a graph whose quiz item references nothing."""
        with pytest.raises(ValidationError, match="unknown concepts"):
            KnowledgeGraph.model_validate(_graph(quizItems=[_quiz("q_1", "c_missing")]))

    def test_a_concept_referencing_a_missing_section_is_rejected(self) -> None:
        with pytest.raises(ValidationError, match="unknown sections"):
            KnowledgeGraph.model_validate(
                _graph(concepts=[_concept("c_1", sectionId="s_missing")])
            )

    def test_a_missing_prerequisite_is_rejected(self) -> None:
        with pytest.raises(ValidationError, match="prerequisites reference unknown"):
            KnowledgeGraph.model_validate(
                _graph(concepts=[_concept("c_1", prerequisites=["c_ghost"])])
            )

    def test_duplicate_concept_ids_are_rejected(self) -> None:
        with pytest.raises(ValidationError, match="duplicate concept ids"):
            KnowledgeGraph.model_validate(
                _graph(
                    concepts=[_concept("c_1"), _concept("c_1", title="Other")],
                    quizItems=[],
                )
            )

    def test_duplicate_quiz_ids_are_rejected(self) -> None:
        with pytest.raises(ValidationError, match="duplicate quiz item ids"):
            KnowledgeGraph.model_validate(
                _graph(quizItems=[_quiz("q_1", "c_1"), _quiz("q_1", "c_1")])
            )

    def test_a_prerequisite_cycle_is_rejected(self) -> None:
        """PRD task P2-05: enforced in code, not only by the prompt."""
        with pytest.raises(ValidationError, match="prerequisite cycles"):
            KnowledgeGraph.model_validate(
                _graph(
                    concepts=[
                        _concept("c_1", prerequisites=["c_2"]),
                        _concept("c_2", prerequisites=["c_1"]),
                    ],
                    quizItems=[],
                )
            )

    def test_a_self_prerequisite_is_rejected(self) -> None:
        with pytest.raises(ValidationError, match="prerequisite cycles"):
            KnowledgeGraph.model_validate(
                _graph(concepts=[_concept("c_1", prerequisites=["c_1"])], quizItems=[])
            )

    def test_an_acyclic_prerequisite_chain_is_accepted(self) -> None:
        graph = KnowledgeGraph.model_validate(
            _graph(
                concepts=[
                    _concept("c_1"),
                    _concept("c_2", prerequisites=["c_1"]),
                    _concept("c_3", prerequisites=["c_1", "c_2"]),
                ],
                quizItems=[],
            )
        )
        assert len(graph.concepts) == 3


class TestQuizAnswerability:
    def test_an_mcq_whose_answer_is_not_an_option_is_rejected(self) -> None:
        """Local grading compares the chosen option to `answer` (PRD 6.2).

        With no matching option the learner can never be correct, and PRD 5.7 mastery is
        computed from exactly those answers. That is a correctness bug, not a quality issue.
        """
        with pytest.raises(ValidationError, match="no option equal to its answer"):
            KnowledgeGraph.model_validate(
                _graph(quizItems=[_quiz("q_1", "c_1", answer="Heat")])
            )

    def test_an_ambiguous_mcq_is_rejected(self) -> None:
        with pytest.raises(ValidationError, match="options equal to its answer"):
            KnowledgeGraph.model_validate(
                _graph(
                    quizItems=[
                        _quiz("q_1", "c_1", options=["Energy", "Energy", "Gravity"])
                    ]
                )
            )

    def test_an_mcq_without_options_is_rejected(self) -> None:
        with pytest.raises(ValidationError, match="no options"):
            KnowledgeGraph.model_validate(
                _graph(quizItems=[_quiz("q_1", "c_1", options=None)])
            )

    def test_a_true_false_item_must_answer_true_or_false(self) -> None:
        with pytest.raises(ValidationError, match="not true or false"):
            KnowledgeGraph.model_validate(
                _graph(
                    quizItems=[
                        _quiz("q_1", "c_1", type="true_false", options=None, answer="yes")
                    ]
                )
            )

    def test_a_valid_true_false_item_is_accepted(self) -> None:
        graph = KnowledgeGraph.model_validate(
            _graph(
                quizItems=[
                    _quiz("q_1", "c_1", type="true_false", options=None, answer="true")
                ]
            )
        )
        assert graph.quiz_items[0].is_locally_gradable() is True

    def test_short_answer_is_not_locally_gradable(self) -> None:
        graph = KnowledgeGraph.model_validate(
            _graph(
                quizItems=[
                    _quiz(
                        "q_1",
                        "c_1",
                        type="short_answer",
                        options=None,
                        answer="Energy from the sun",
                        acceptable=["solar energy"],
                    )
                ]
            )
        )
        assert graph.quiz_items[0].is_locally_gradable() is False


class TestDraftIsLenient:
    def test_a_draft_tolerates_problems_a_teacher_will_fix(self) -> None:
        """PRD 5.1 step 9 lists flagged items for review rather than refusing the job."""
        draft = DraftKnowledgeGraph.model_validate(
            _graph(quizItems=[_quiz("q_1", "c_missing")])
        )
        assert draft.quiz_items[0].concept_id == "c_missing"

    def test_a_draft_still_enforces_the_field_shape(self) -> None:
        with pytest.raises(ValidationError):
            DraftKnowledgeGraph.model_validate(_graph(overview="x" * 601))


class TestOrdering:
    def test_concepts_order_by_section_then_position(self) -> None:
        graph = KnowledgeGraph.model_validate(
            _graph(
                sections=[
                    {"id": "s_2", "title": "Condensation", "order": 1},
                    {"id": "s_1", "title": "Evaporation", "order": 0},
                ],
                concepts=[
                    _concept("c_3", sectionId="s_2", order=0, title="Clouds"),
                    _concept("c_2", sectionId="s_1", order=1, title="Vapour"),
                    _concept("c_1", sectionId="s_1", order=0, title="Heat"),
                ],
                quizItems=[],
            )
        )
        assert [c.id for c in graph.concepts_in_order()] == ["c_1", "c_2", "c_3"]
