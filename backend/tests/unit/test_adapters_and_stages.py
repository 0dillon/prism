"""Adapters (model output becoming application data) and the ingestion stage machine."""

from __future__ import annotations

from itertools import pairwise

import pytest

from app.ai.adapters import (
    intent_to_union,
    merge_to_graph,
    profile_patch_to_mapping,
    quiz_to_items,
)
from app.ai.ingestion.chunk import chunk_document
from app.ai.ingestion.extract import extract
from app.ai.schemas import (
    ContentPatchOut,
    MergedConceptOut,
    MergedSectionOut,
    MergeOut,
    ProfilePatchOut,
    QuizGenerationOut,
    QuizItemOut,
    QuizPatchOut,
    SessionIntentOut,
)
from app.ingestion.stages import (
    ORDERED_STAGES,
    STAGE_LABELS,
    IllegalTransitionError,
    Stage,
    assert_transition,
    can_transition,
    next_stage,
    progress_fraction,
    stages_from,
)

SOURCE = (
    "Water evaporates when it is heated by the sun. "
    "The vapour rises and cools, condensing into droplets that form clouds."
)


def chunks():  # type: ignore[no-untyped-def]
    return chunk_document(extract(data=SOURCE.encode(), source_type="text"))


def merged_concept(ref: str, **overrides: object) -> MergedConceptOut:
    base: dict[str, object] = {
        "ref": ref,
        "section_ref": "s1",
        "title": f"Concept {ref}",
        "summary": "A short summary.",
        "body": "A longer explanation.",
        "key_term": None,
        "definition": None,
        "examples": [],
        "visual_hint": None,
        "source_excerpt": "Water evaporates when it is heated by the sun.",
        "prerequisite_refs": [],
    }
    base.update(overrides)
    return MergedConceptOut.model_validate(base)


def merge_out(**overrides: object) -> MergeOut:
    base: dict[str, object] = {
        "title": "The Water Cycle",
        "overview": "How water moves around.",
        "sections": [MergedSectionOut(ref="s1", title="Evaporation")],
        "concepts": [merged_concept("c1")],
    }
    base.update(overrides)
    return MergeOut.model_validate(base)


class TestIdAssignment:
    def test_the_server_assigns_ids_not_the_model(self) -> None:
        """Ids are stable across graph versions and carry learner mastery. A model choosing
        one could collide with, or silently reassign, an existing learner's progress."""
        graph, refs = merge_to_graph(merge_out(), lesson_id="lesson_1", chunks=chunks())

        assert graph.concepts[0].id.startswith("c_")
        assert graph.sections[0].id.startswith("s_")
        # The model's handle appears nowhere in the result.
        assert "c1" not in {concept.id for concept in graph.concepts}
        assert refs == {"c1": graph.concepts[0].id}

    def test_ids_are_unique_across_a_large_graph(self) -> None:
        merged = merge_out(concepts=[merged_concept(f"c{n}") for n in range(50)])
        graph, _ = merge_to_graph(merged, lesson_id="lesson_1", chunks=chunks())
        assert len({c.id for c in graph.concepts}) == 50

    def test_ids_differ_between_runs(self) -> None:
        first, _ = merge_to_graph(merge_out(), lesson_id="l", chunks=chunks())
        second, _ = merge_to_graph(merge_out(), lesson_id="l", chunks=chunks())
        assert first.concepts[0].id != second.concepts[0].id


class TestLocatorResolution:
    def test_the_locator_comes_from_the_chunk_the_excerpt_was_found_in(self) -> None:
        """Resolved by searching the source, not by asking the model: a model that could pick
        a locator could make a fabricated concept look grounded."""
        graph, _ = merge_to_graph(merge_out(), lesson_id="lesson_1", chunks=chunks())
        locator = graph.concepts[0].source

        assert locator.kind == "offset"
        assert "Water evaporates" in locator.excerpt

    def test_an_unfindable_excerpt_still_produces_a_concept(self) -> None:
        """Dropping it would hide the problem from the teacher who needs to see it; the
        grounding check flags it instead."""
        merged = merge_out(
            concepts=[merged_concept("c1", source_excerpt="Entirely invented sentence.")]
        )
        graph, _ = merge_to_graph(merged, lesson_id="lesson_1", chunks=chunks())
        assert len(graph.concepts) == 1


class TestPrerequisiteResolution:
    def test_refs_become_real_ids(self) -> None:
        merged = merge_out(
            concepts=[merged_concept("c1"), merged_concept("c2", prerequisite_refs=["c1"])]
        )
        graph, refs = merge_to_graph(merged, lesson_id="l", chunks=chunks())
        assert graph.concepts[1].prerequisites == [refs["c1"]]

    def test_a_ref_pointing_at_nothing_is_dropped_not_guessed(self) -> None:
        merged = merge_out(
            concepts=[merged_concept("c1", prerequisite_refs=["c_nonexistent"])]
        )
        graph, _ = merge_to_graph(merged, lesson_id="l", chunks=chunks())
        assert graph.concepts[0].prerequisites == []

    def test_a_self_reference_is_dropped(self) -> None:
        merged = merge_out(concepts=[merged_concept("c1", prerequisite_refs=["c1"])])
        graph, _ = merge_to_graph(merged, lesson_id="l", chunks=chunks())
        assert graph.concepts[0].prerequisites == []


class TestContractLimits:
    def test_an_overlong_title_is_trimmed_at_a_word_boundary(self) -> None:
        """PRD 5.2 caps a title at 80 characters. A slight overrun should not fail the whole
        graph, but the result still has to read as words."""
        merged = merge_out(concepts=[merged_concept("c1", title="Photosynthesis " * 20)])
        graph, _ = merge_to_graph(merged, lesson_id="l", chunks=chunks())

        title = graph.concepts[0].title
        assert len(title) <= 80
        assert not title.endswith("Photosynthes")

    def test_an_overlong_summary_and_overview_are_trimmed(self) -> None:
        merged = merge_out(
            overview="word " * 400,
            concepts=[merged_concept("c1", summary="word " * 200)],
        )
        graph, _ = merge_to_graph(merged, lesson_id="l", chunks=chunks())
        assert len(graph.overview) <= 600
        assert len(graph.concepts[0].summary) <= 240

    def test_blank_optional_fields_become_null(self) -> None:
        merged = merge_out(concepts=[merged_concept("c1", key_term="   ", definition="")])
        graph, _ = merge_to_graph(merged, lesson_id="l", chunks=chunks())
        assert graph.concepts[0].key_term is None
        assert graph.concepts[0].definition is None


class TestQuizAdaptation:
    def _item(self, ref: str, **overrides: object) -> QuizItemOut:
        base: dict[str, object] = {
            "concept_ref": ref,
            "type": "mcq",
            "prompt": "What drives evaporation?",
            "options": ["Energy", "Gravity", "Pressure"],
            "answer": "Energy",
            "acceptable": [],
            "explanation": "Molecules need energy.",
            "difficulty": "recall",
        }
        base.update(overrides)
        return QuizItemOut.model_validate(base)

    def test_items_attach_to_concepts_by_ref(self) -> None:
        items = quiz_to_items(
            QuizGenerationOut(items=[self._item("c1")]), concept_ids={"c1": "c_real"}
        )
        assert items[0].concept_id == "c_real"
        assert items[0].id.startswith("q_")

    def test_an_item_for_an_unknown_concept_is_dropped(self) -> None:
        """Carrying it forward would make validation reject the whole graph, throwing away a
        complete ingestion over one stray question."""
        items = quiz_to_items(
            QuizGenerationOut(items=[self._item("c_ghost")]), concept_ids={"c1": "c_real"}
        )
        assert items == []

    def test_options_are_dropped_for_non_multiple_choice(self) -> None:
        """The wire form uses an empty list where the contract uses null."""
        items = quiz_to_items(
            QuizGenerationOut(
                items=[
                    self._item("c1", type="short_answer", options=[], answer="Energy"),
                    self._item("c1", type="true_false", options=[], answer="true"),
                ]
            ),
            concept_ids={"c1": "c_real"},
        )
        assert all(item.options is None for item in items)

    def test_blank_options_and_alternatives_are_removed(self) -> None:
        items = quiz_to_items(
            QuizGenerationOut(
                items=[self._item("c1", options=["Energy", "  ", "Gravity"],
                                  acceptable=["", "solar energy"])]
            ),
            concept_ids={"c1": "c_real"},
        )
        assert items[0].options == ["Energy", "Gravity"]
        assert items[0].acceptable == ["solar energy"]


class TestIntentAdaptation:
    @pytest.mark.parametrize(
        "intent_type",
        ["next", "previous", "repeat", "simplify", "elaborate", "example", "quiz_me",
         "pause", "resume", "where_am_i", "unknown"],
    )
    def test_payload_free_intents_narrow_cleanly(self, intent_type: str) -> None:
        raw = SessionIntentOut(
            type=intent_type,  # type: ignore[arg-type]
            value=None, target=None, direction=None, request=None, text=None,
        )
        assert intent_to_union(raw).type == intent_type

    def test_payload_carrying_intents_keep_their_payload(self) -> None:
        raw = SessionIntentOut(
            type="answer", value="Energy", target=None, direction=None, request=None, text=None
        )
        intent = intent_to_union(raw)
        assert intent.type == "answer"
        assert intent.value == "Energy"  # type: ignore[union-attr]

    def test_a_missing_payload_degrades_to_unknown_rather_than_failing(self) -> None:
        """The conversation renderer can ask a learner to repeat themselves. It cannot do
        anything useful with a 500."""
        raw = SessionIntentOut(
            type="answer", value=None, target=None, direction=None, request=None, text=None
        )
        assert intent_to_union(raw).type == "unknown"


class TestProfilePatchAdaptation:
    def test_nulls_are_dropped_so_unmentioned_settings_survive(self) -> None:
        """Passing the nulls through would reset a learner's carefully tuned profile because
        they asked for one thing."""
        patch = ProfilePatchOut(
            preset=None,
            layout="cards",
            content=ContentPatchOut(reading_level="plain", chunk_size=None, show_examples=None),
            quiz=QuizPatchOut(cadence=3, items_per_check=None, retry_on_wrong=None),
            typography=None,
            audio=None,
            visual=None,
            feedback=None,
        )
        assert profile_patch_to_mapping(patch) == {
            "layout": "cards",
            "content": {"reading_level": "plain"},
            "quiz": {"cadence": 3},
        }

    def test_an_entirely_empty_patch_is_an_empty_mapping(self) -> None:
        patch = ProfilePatchOut(
            preset=None, layout=None, content=None, quiz=None,
            typography=None, audio=None, visual=None, feedback=None,
        )
        assert profile_patch_to_mapping(patch) == {}

    def test_the_patch_schema_cannot_express_a_setting_that_does_not_exist(self) -> None:
        """Modelling the patch as a nullable mirror of the profile, rather than a free-form
        object, means the model has no field in which to invent a setting."""
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            ProfilePatchOut.model_validate({"telepathy": True})


# ---------------------------------------------------------------------------
class TestStageMachine:
    def test_the_happy_path_runs_in_the_prd_order(self) -> None:
        """PRD 5.1: extract, chunk, concepts, merge, quiz, validate, ground, signs."""
        assert ORDERED_STAGES == (
            Stage.EXTRACT, Stage.CHUNK, Stage.CONCEPTS, Stage.MERGE,
            Stage.QUIZ, Stage.VALIDATE, Stage.GROUND, Stage.SIGNS,
        )

    def test_each_stage_leads_to_the_next(self) -> None:
        assert next_stage(Stage.PENDING) is Stage.EXTRACT
        for current, following in pairwise(ORDERED_STAGES):
            assert next_stage(current) is following
        assert next_stage(Stage.SIGNS) is Stage.NEEDS_REVIEW

    def test_every_stage_can_fail(self) -> None:
        for stage in (Stage.PENDING, *ORDERED_STAGES):
            assert can_transition(stage, Stage.FAILED)

    def test_skipping_a_stage_is_refused(self) -> None:
        """A job that can be moved arbitrarily is a job whose recorded state means nothing,
        and that state is what the status endpoint shows a waiting teacher."""
        with pytest.raises(IllegalTransitionError):
            assert_transition(Stage.EXTRACT, Stage.QUIZ)

    def test_going_backwards_is_refused(self) -> None:
        with pytest.raises(IllegalTransitionError):
            assert_transition(Stage.MERGE, Stage.CHUNK)

    def test_terminal_stages_lead_nowhere(self) -> None:
        for stage in (Stage.NEEDS_REVIEW, Stage.FAILED):
            for target in Stage:
                assert not can_transition(stage, target)

    def test_the_full_transition_matrix_is_closed(self) -> None:
        """Every pair is either explicitly legal or explicitly refused; nothing is undefined."""
        for current in Stage:
            for requested in Stage:
                legal = can_transition(current, requested)
                if legal:
                    assert_transition(current, requested)
                else:
                    with pytest.raises(IllegalTransitionError):
                        assert_transition(current, requested)

    def test_resuming_skips_completed_stages(self) -> None:
        """The reason the failed stage is recorded: re-running extraction and the map stage
        of a part-finished job would spend the money twice."""
        assert stages_from(Stage.QUIZ) == (
            Stage.QUIZ, Stage.VALIDATE, Stage.GROUND, Stage.SIGNS
        )
        assert stages_from(Stage.PENDING) == ORDERED_STAGES
        assert stages_from(Stage.NEEDS_REVIEW) == ()

    def test_progress_increases_monotonically(self) -> None:
        values = [progress_fraction(stage) for stage in ORDERED_STAGES]
        assert values == sorted(values)
        assert progress_fraction(Stage.NEEDS_REVIEW) == 1.0

    def test_every_stage_has_a_label_a_teacher_can_read(self) -> None:
        """PRD CE-1: the upload page shows staged progress."""
        for stage in Stage:
            label = STAGE_LABELS[stage]
            assert label and label[0].isupper()
            assert stage.value not in label.lower().replace(" ", "_")
