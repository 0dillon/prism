"""Learning Event and Session Intent contracts (PRD sections 5.7 and 5.4)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.events import (
    MAX_EVENT_BATCH_SIZE,
    MAX_EVENT_DURATION_MS,
    LearningEvent,
    LearningEventBatch,
)
from app.schemas.intents import SessionIntent, SessionIntentEnvelope

intent_adapter: TypeAdapter[Any] = TypeAdapter(SessionIntent)


def _event(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "01HZX3QK9J2W8V5N6M7P8Q9R0S",
        "lessonId": "lesson_1",
        "graphVersion": 1,
        "type": "concept_viewed",
        "conceptId": "c_1",
        "layout": "cards",
        "occurredAt": "2026-10-06T10:00:00Z",
    }
    base.update(overrides)
    return base


class TestLearningEvent:
    def test_a_valid_event_parses(self) -> None:
        event = LearningEvent.model_validate(_event())
        assert event.graph_version == 1
        assert event.occurred_at == datetime(2026, 10, 6, 10, 0, tzinfo=UTC)

    def test_json_is_camel_case(self) -> None:
        payload = LearningEvent.model_validate(_event()).model_dump(
            mode="json", by_alias=True
        )
        for key in ("lessonId", "graphVersion", "conceptId", "occurredAt"):
            assert key in payload
        assert "quizItemId" in payload

    def test_the_inbound_model_has_no_user_id(self) -> None:
        """Identity comes from the verified token, never from the request body.

        PRD task P5-02 and brief section 34. If this field existed, a learner could write
        events attributed to someone else and corrupt another student's mastery.
        """
        assert "user_id" not in LearningEvent.model_fields
        assert "userId" not in LearningEvent.model_fields

        with pytest.raises(ValidationError):
            LearningEvent.model_validate(_event(userId="someone-else"))

    @pytest.mark.parametrize(
        "event_type",
        [
            "lesson_started", "concept_viewed", "concept_variant_requested",
            "quiz_presented", "quiz_answered", "question_asked",
            "session_paused", "session_resumed", "lesson_completed", "profile_changed",
        ],
    )
    def test_every_prd_event_type_is_accepted(self, event_type: str) -> None:
        assert LearningEvent.model_validate(_event(type=event_type)).type == event_type

    def test_an_unknown_event_type_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            LearningEvent.model_validate(_event(type="learner_gave_up"))

    @pytest.mark.parametrize("layout", ["reader", "cards", "conversation", "visual"])
    def test_every_renderer_layout_is_accepted(self, layout: str) -> None:
        assert LearningEvent.model_validate(_event(layout=layout)).layout == layout

    def test_layout_is_required_so_aggregate_analytics_are_complete(self) -> None:
        payload = _event()
        del payload["layout"]
        with pytest.raises(ValidationError):
            LearningEvent.model_validate(payload)

    def test_graph_version_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            LearningEvent.model_validate(_event(graphVersion=0))

    def test_duration_is_capped_at_sixty_seconds(self) -> None:
        """PRD 5.7: active time caps each event at 60s, to exclude idle time."""
        event = LearningEvent.model_validate(_event(durationMs=10 * 60 * 1000))
        assert event.capped_duration_ms() == MAX_EVENT_DURATION_MS

        assert LearningEvent.model_validate(_event()).capped_duration_ms() == 0
        assert (
            LearningEvent.model_validate(_event(durationMs=1500)).capped_duration_ms() == 1500
        )

    def test_negative_duration_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            LearningEvent.model_validate(_event(durationMs=-1))


class TestEventBatch:
    def test_a_batch_parses(self) -> None:
        batch = LearningEventBatch.model_validate({"events": [_event(), _event(id="other")]})
        assert len(batch.events) == 2

    def test_an_empty_batch_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            LearningEventBatch.model_validate({"events": []})

    def test_an_oversized_batch_is_rejected(self) -> None:
        events = [_event(id=f"evt_{index}") for index in range(MAX_EVENT_BATCH_SIZE + 1)]
        with pytest.raises(ValidationError):
            LearningEventBatch.model_validate({"events": events})

    def test_a_batch_carries_no_user_identity(self) -> None:
        assert "user_id" not in LearningEventBatch.model_fields


class TestSessionIntent:
    @pytest.mark.parametrize(
        "intent_type",
        [
            "next", "previous", "repeat", "simplify", "elaborate", "example",
            "quiz_me", "pause", "resume", "where_am_i", "unknown",
        ],
    )
    def test_payload_free_intents_parse(self, intent_type: str) -> None:
        assert intent_adapter.validate_python({"type": intent_type}).type == intent_type

    def test_intents_with_payloads_parse(self) -> None:
        assert intent_adapter.validate_python({"type": "answer", "value": "B"}).value == "B"
        assert (
            intent_adapter.validate_python({"type": "go_to", "target": "Condensation"}).target
            == "Condensation"
        )
        assert (
            intent_adapter.validate_python(
                {"type": "set_rate", "direction": "slower"}
            ).direction
            == "slower"
        )
        assert (
            intent_adapter.validate_python(
                {"type": "change_profile", "request": "bigger text"}
            ).request
            == "bigger text"
        )
        assert (
            intent_adapter.validate_python(
                {"type": "question", "text": "why does it rain?"}
            ).text
            == "why does it rain?"
        )

    def test_the_union_covers_every_prd_member(self) -> None:
        """PRD 5.4 lists sixteen members. All sixteen must exist."""
        expected = {
            "next", "previous", "repeat", "simplify", "elaborate", "example", "quiz_me",
            "answer", "pause", "resume", "where_am_i", "go_to", "set_rate",
            "change_profile", "question", "unknown",
        }
        schema = SessionIntentEnvelope.model_json_schema()
        discriminated = schema["$defs"]
        found = {
            definition["properties"]["type"]["const"]
            for definition in discriminated.values()
            if "properties" in definition and "type" in definition["properties"]
        }
        assert found == expected

    def test_a_required_payload_cannot_be_omitted(self) -> None:
        with pytest.raises(ValidationError):
            intent_adapter.validate_python({"type": "answer"})

    def test_an_unknown_intent_type_is_rejected(self) -> None:
        """Distinct from the `unknown` member, which is a recognised 'I did not understand'."""
        with pytest.raises(ValidationError):
            intent_adapter.validate_python({"type": "order_pizza"})

    def test_set_rate_direction_is_constrained(self) -> None:
        with pytest.raises(ValidationError):
            intent_adapter.validate_python({"type": "set_rate", "direction": "sideways"})

    def test_round_trip_through_json(self) -> None:
        for payload in (
            {"type": "next"},
            {"type": "answer", "value": "photosynthesis"},
            {"type": "set_rate", "direction": "faster"},
        ):
            parsed = intent_adapter.validate_python(payload)
            assert intent_adapter.dump_python(parsed, mode="json", by_alias=True) == payload
