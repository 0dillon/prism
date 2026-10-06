"""Needs-to-profile parsing (PRD task P3-10, 5.4A, CE-4).

The central invariant throughout: a failed parse never changes the stored profile.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.ai.errors import ProviderUnavailableError, RefusalError
from app.ai.gateway import LlmGateway
from app.ai.intents.profile import MAX_REQUEST_CHARACTERS, ProfileParser
from app.ai.providers.fake import FakeProvider, malformed_response, response_for
from app.core.config import AppEnv, Settings
from app.domain.profiles.presets import build_preset
from app.schemas.render_profile import RenderProfile


def settings() -> Settings:
    return Settings(
        app_env=AppEnv.test,
        llm_provider="fake",
        llm_model_heavy="h",
        llm_model_fast="f",
        llm_max_attempts=1,
        _env_file=None,  # type: ignore[call-arg]
    )


def parser_for(*script: Any) -> tuple[ProfileParser, FakeProvider]:
    # The gateway retries once with validation feedback, so the last scripted item repeats:
    # that models a model making the same mistake twice, which is the terminal case.
    provider = FakeProvider(script, default=script[-1] if script else None)
    gateway = LlmGateway(provider=provider, settings=settings())
    return ProfileParser(gateway), provider


def parse_output(
    patch: dict[str, Any] | None = None,
    *,
    explanation: str = "I switched you to cards.",
    unsupported: list[str] | None = None,
) -> dict[str, Any]:
    """A complete ProfileParseOut payload, with every nullable field present."""
    empty_group = {
        "content": None, "quiz": None, "typography": None,
        "audio": None, "visual": None, "feedback": None,
    }
    full_patch: dict[str, Any] = {"preset": None, "layout": None, **empty_group}
    full_patch.update(patch or {})
    return {
        "patch": full_patch,
        "explanation": explanation,
        "unsupported": unsupported or [],
    }


class TestSuccessfulParsing:
    async def test_a_valid_patch_is_applied(self) -> None:
        parser, _ = parser_for(
            response_for(
                parse_output(
                    {
                        "layout": "cards",
                        "quiz": {
                            "cadence": 3, "items_per_check": None, "retry_on_wrong": None
                        },
                    },
                    explanation="I switched to cards with a quiz every 3 ideas.",
                )
            )
        )

        result = await parser.parse(request_text="one idea at a time, quiz me often",
                                    current=RenderProfile())

        assert result.changed is True
        assert result.profile.layout == "cards"
        assert result.profile.quiz.cadence == 3
        assert "quiz every 3 ideas" in result.explanation

    def test_unmentioned_settings_are_preserved(self) -> None:
        """A learner asking for one thing must not lose the rest of their setup."""

    async def test_unmentioned_settings_survive(self) -> None:
        current = build_preset("cognitive_ease")
        parser, _ = parser_for(
            response_for(parse_output({"quiz": {"cadence": 2, "items_per_check": None,
                                                "retry_on_wrong": None}}))
        )

        result = await parser.parse(request_text="quiz me more", current=current)

        assert result.profile.quiz.cadence == 2
        assert result.profile.typography.font == current.typography.font
        assert result.profile.typography.line_height == current.typography.line_height
        assert result.profile.visual.theme == current.visual.theme

    async def test_editing_settings_marks_the_profile_as_custom(self) -> None:
        """A preset is a starting point. Once a learner changes something it is theirs."""
        parser, _ = parser_for(
            response_for(parse_output({"typography": {
                "font": None, "size_scale": 1.5, "letter_spacing": None,
                "word_spacing": None, "line_height": None, "max_line_length": None,
                "word_anchors": None,
            }}))
        )

        result = await parser.parse(request_text="bigger text", current=build_preset("standard"))
        assert result.profile.preset == "custom"

    async def test_an_explicit_preset_request_is_honoured(self) -> None:
        parser, _ = parser_for(response_for(parse_output({"preset": "voice_native"})))
        result = await parser.parse(request_text="read everything to me",
                                    current=RenderProfile())
        assert result.profile.preset == "voice_native"


class TestTheProfileIsNeverLost:
    async def test_an_invalid_patch_leaves_the_profile_untouched(self) -> None:
        """PRD CE-4 and brief 60. The model proposed something out of range."""
        current = build_preset("hyper_focus")
        parser, _ = parser_for(
            response_for(
                parse_output({"quiz": {"cadence": 99, "items_per_check": None,
                                       "retry_on_wrong": None}})
            )
        )

        result = await parser.parse(request_text="quiz me constantly", current=current)

        assert result.changed is False
        assert result.profile == current
        assert "unchanged" in result.explanation.lower()

    async def test_unparseable_model_output_leaves_the_profile_untouched(self) -> None:
        current = build_preset("visual_sign")
        parser, _ = parser_for(malformed_response())

        result = await parser.parse(request_text="something", current=current)

        assert result.changed is False
        assert result.profile == current

    async def test_a_provider_outage_leaves_the_profile_untouched(self) -> None:
        """PRD 6.5: if the LLM fails, the learner keeps everything they already had."""
        current = build_preset("cognitive_ease")
        parser, _ = parser_for(ProviderUnavailableError("provider down"))

        result = await parser.parse(request_text="make text bigger", current=current)

        assert result.changed is False
        assert result.profile == current
        assert "nothing has changed" in result.explanation.lower()

    async def test_a_refusal_leaves_the_profile_untouched(self) -> None:
        current = RenderProfile()
        parser, _ = parser_for(RefusalError("declined"))

        result = await parser.parse(request_text="something", current=current)
        assert result.profile == current

    async def test_a_value_outside_the_wire_schema_never_reaches_the_merge(self) -> None:
        """An invented enum value fails structured-output validation first, so the profile is
        protected by two independent layers rather than one."""
        current = build_preset("standard")
        parser, _ = parser_for(response_for(parse_output({"layout": "holodeck"})))

        result = await parser.parse(request_text="use the holodeck", current=current)

        assert result.profile == current
        assert result.changed is False

    @pytest.mark.parametrize(
        "bad_patch",
        [
            {"typography": {"font": None, "size_scale": 99.0, "letter_spacing": None,
                            "word_spacing": None, "line_height": None,
                            "max_line_length": None, "word_anchors": None}},
            {"quiz": {"cadence": -5, "items_per_check": None, "retry_on_wrong": None}},
            {"audio": {"read_aloud": None, "sync_highlight": None, "rate": 99.0,
                       "voice_input": None, "earcons": None}},
        ],
    )
    async def test_out_of_range_proposals_are_all_rejected(
        self, bad_patch: dict[str, Any]
    ) -> None:
        current = build_preset("standard")
        parser, _ = parser_for(response_for(parse_output(bad_patch)))

        result = await parser.parse(request_text="change something", current=current)
        assert result.profile == current
        assert result.changed is False


class TestUnsupportedRequests:
    async def test_unsupported_requests_are_reported_not_swallowed(self) -> None:
        """PRD CE-4: a clear "I can't do that yet", never a silent failure."""
        parser, _ = parser_for(
            response_for(
                parse_output(
                    {"layout": "cards"},
                    unsupported=["translate the lesson into Yoruba"],
                )
            )
        )

        result = await parser.parse(request_text="cards, and translate it",
                                    current=RenderProfile())

        assert result.unsupported == ["translate the lesson into Yoruba"]
        assert result.should_record_unmet_need is True

    async def test_an_entirely_unsupported_request_changes_nothing_but_explains(self) -> None:
        parser, _ = parser_for(
            response_for(
                parse_output(
                    {},
                    explanation="I can't translate lessons yet.",
                    unsupported=["translate into Yoruba"],
                )
            )
        )

        result = await parser.parse(request_text="translate this", current=RenderProfile())

        assert result.changed is False
        assert result.unsupported
        assert result.explanation

    async def test_blank_unsupported_entries_are_dropped(self) -> None:
        parser, _ = parser_for(
            response_for(parse_output({"layout": "cards"}, unsupported=["", "  ", "real one"]))
        )
        result = await parser.parse(request_text="x", current=RenderProfile())
        assert result.unsupported == ["real one"]


class TestInputHandling:
    async def test_an_empty_request_does_not_call_the_model(self) -> None:
        """Spending a model call to discover the learner typed nothing is pure waste."""
        parser, provider = parser_for()
        result = await parser.parse(request_text="   ", current=RenderProfile())

        assert provider.call_count == 0
        assert result.changed is False

    async def test_an_overlong_request_is_truncated_rather_than_rejected(self) -> None:
        """Bounded so the endpoint is not a way to push arbitrary text through a model on
        someone else's bill, but a learner who writes an essay still gets an answer."""
        parser, provider = parser_for(response_for(parse_output({"layout": "cards"})))

        await parser.parse(request_text="x" * (MAX_REQUEST_CHARACTERS * 3),
                           current=RenderProfile())

        sent = provider.last_request.prompt.user
        delimited = sent.split("<learner_request>")[1].split("</learner_request>")[0]
        assert delimited.count("x") <= MAX_REQUEST_CHARACTERS

    async def test_the_learner_text_is_delimited_in_the_prompt(self) -> None:
        parser, provider = parser_for(response_for(parse_output({"layout": "cards"})))
        await parser.parse(request_text="make it simpler", current=RenderProfile())

        user_turn = provider.last_request.prompt.user
        assert "<learner_request>" in user_turn
        assert "</learner_request>" in user_turn


class TestPrivacyByDesign:
    def test_the_prompt_forbids_recording_a_condition(self) -> None:
        """PRD 2.3 principle 2 and 6.4: Prism never asks for or stores a diagnosis."""
        from app.ai.prompts.profile import PARSE_NEEDS_SYSTEM

        lowered = " ".join(PARSE_NEEDS_SYSTEM.lower().split())
        assert "never ask about, infer, or record a medical condition" in lowered
        assert "diagnosis" in lowered

    def test_the_patch_schema_has_no_field_for_a_condition(self) -> None:
        """The structural guarantee behind the instruction: even a model that ignored the
        prompt has no field in which to record one."""
        from app.ai.schemas import ProfilePatchOut

        for name in ProfilePatchOut.model_fields:
            assert not any(
                term in name.lower()
                for term in ("diagnos", "disab", "condition", "impair", "medical")
            )
