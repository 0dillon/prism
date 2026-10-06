"""The Render Profile must match PRD section 5.3 exactly, including every default.

These tests are deliberately literal. They are the check that the Python transcription has not
drifted from the Zod definition the frontend consumes, so they assert values from the PRD text
rather than from the implementation.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.domain.profiles.presets import (
    PRESET_PATCHES,
    SELECTABLE_PRESETS,
    all_presets,
    build_preset,
    default_profile,
)
from app.schemas.render_profile import RenderProfile


class TestDefaults:
    def test_a_minimal_profile_fills_every_default(self) -> None:
        """PRD task P1-02: RenderProfile.parse({...minimal}) fills all defaults."""
        profile = RenderProfile.model_validate({})

        assert profile.schema_version == 1
        assert profile.preset == "standard"
        assert profile.layout == "reader"

        assert profile.content.reading_level == "original"
        assert profile.content.chunk_size == "section"
        assert profile.content.show_examples is True

        assert profile.quiz.cadence == 5
        assert profile.quiz.items_per_check == 1
        assert profile.quiz.retry_on_wrong is True

        assert profile.typography.font == "system"
        assert profile.typography.size_scale == 1.0
        assert profile.typography.letter_spacing == 0.0
        assert profile.typography.word_spacing == 0.0
        assert profile.typography.line_height == 1.5
        assert profile.typography.max_line_length == 70
        assert profile.typography.word_anchors is False

        assert profile.audio.read_aloud is False
        assert profile.audio.sync_highlight == "off"
        assert profile.audio.rate == 1.0
        assert profile.audio.voice_input is False
        assert profile.audio.earcons is False

        assert profile.visual.theme == "system"
        assert profile.visual.reduced_motion is False
        assert profile.visual.captions is True
        assert profile.visual.sign_clips is False
        assert profile.visual.sign_language == "ase"
        assert profile.visual.concept_images is False

        assert profile.feedback.progress_bar is True
        assert profile.feedback.streaks is False
        assert profile.feedback.celebration == "subtle"
        assert profile.feedback.haptics is False


class TestBounds:
    @pytest.mark.parametrize(
        ("path", "field", "low", "high"),
        [
            ("quiz", "cadence", 1, 10),
            ("quiz", "items_per_check", 1, 5),
            ("typography", "size_scale", 0.8, 2.5),
            ("typography", "letter_spacing", 0.0, 0.3),
            ("typography", "word_spacing", 0.0, 0.6),
            ("typography", "line_height", 1.2, 2.4),
            ("typography", "max_line_length", 30, 90),
            ("audio", "rate", 0.5, 3.0),
        ],
    )
    def test_numeric_bounds_match_the_prd(
        self, path: str, field: str, low: float, high: float
    ) -> None:
        RenderProfile.model_validate({path: {field: low}})
        RenderProfile.model_validate({path: {field: high}})

        step = 0.1 if isinstance(low, float) else 1
        with pytest.raises(ValidationError):
            RenderProfile.model_validate({path: {field: low - step}})
        with pytest.raises(ValidationError):
            RenderProfile.model_validate({path: {field: high + step}})

    def test_unknown_settings_are_rejected(self) -> None:
        """A renamed or invented setting must fail loudly, not vanish silently."""
        with pytest.raises(ValidationError):
            RenderProfile.model_validate({"typography": {"fontSizeX": 2}})

    def test_unknown_enum_values_are_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RenderProfile.model_validate({"layout": "hologram"})


class TestJsonShape:
    def test_json_is_camel_case_for_the_typescript_contract(self) -> None:
        payload = RenderProfile().model_dump(mode="json", by_alias=True)

        assert payload["schemaVersion"] == 1
        assert payload["content"]["readingLevel"] == "original"
        assert payload["content"]["chunkSize"] == "section"
        assert payload["content"]["showExamples"] is True
        assert payload["quiz"]["itemsPerCheck"] == 1
        assert payload["quiz"]["retryOnWrong"] is True
        assert payload["typography"]["sizeScale"] == 1.0
        assert payload["typography"]["letterSpacing"] == 0.0
        assert payload["typography"]["wordSpacing"] == 0.0
        assert payload["typography"]["lineHeight"] == 1.5
        assert payload["typography"]["maxLineLength"] == 70
        assert payload["typography"]["wordAnchors"] is False
        assert payload["audio"]["readAloud"] is False
        assert payload["audio"]["syncHighlight"] == "off"
        assert payload["audio"]["voiceInput"] is False
        assert payload["visual"]["reducedMotion"] is False
        assert payload["visual"]["signClips"] is False
        assert payload["visual"]["signLanguage"] == "ase"
        assert payload["visual"]["conceptImages"] is False
        assert payload["feedback"]["progressBar"] is True

    def test_camel_case_input_round_trips(self) -> None:
        original = RenderProfile.model_validate({"typography": {"lineHeight": 2.0}})
        restored = RenderProfile.model_validate(
            original.model_dump(mode="json", by_alias=True)
        )
        assert restored == original


class TestPresets:
    def test_every_preset_parses(self) -> None:
        """PRD task P3-01: every preset parses."""
        assert set(all_presets()) == set(PRESET_PATCHES)

    def test_standard_is_the_defaults(self) -> None:
        assert build_preset("standard") == RenderProfile()
        assert default_profile() == RenderProfile()

    def test_voice_native_matches_the_prd_table(self) -> None:
        profile = build_preset("voice_native")
        assert profile.layout == "conversation"
        assert profile.audio.read_aloud is True
        assert profile.audio.voice_input is True
        assert profile.audio.earcons is True
        assert profile.content.chunk_size == "concept"
        assert profile.quiz.cadence == 3

    def test_hyper_focus_matches_the_prd_table(self) -> None:
        profile = build_preset("hyper_focus")
        assert profile.layout == "cards"
        assert profile.content.chunk_size == "concept"
        assert profile.quiz.cadence == 3
        assert profile.feedback.streaks is True
        assert profile.feedback.celebration == "full"
        assert profile.feedback.haptics is True

    def test_cognitive_ease_matches_the_prd_table(self) -> None:
        profile = build_preset("cognitive_ease")
        assert profile.layout == "reader"
        assert profile.typography.font == "lexend"
        assert profile.typography.letter_spacing == 0.05
        assert profile.typography.word_spacing == 0.16
        assert profile.typography.line_height == 1.8
        assert profile.typography.max_line_length == 60
        assert profile.audio.read_aloud is True
        assert profile.audio.sync_highlight == "word"
        assert profile.visual.theme == "cream"
        assert profile.content.reading_level == "plain"

    def test_visual_sign_matches_the_prd_table(self) -> None:
        profile = build_preset("visual_sign")
        assert profile.layout == "visual"
        assert profile.visual.captions is True
        assert profile.visual.sign_clips is True
        assert profile.visual.concept_images is True
        assert profile.content.reading_level == "plain"
        assert profile.feedback.haptics is True
        assert profile.audio.earcons is False

    def test_word_anchors_are_off_in_every_preset(self) -> None:
        """Decision log: limited research support, so opt-in only, never preset-enabled."""
        for name, profile in all_presets().items():
            assert profile.typography.word_anchors is False, name

    def test_each_preset_records_its_own_name(self) -> None:
        for name, profile in all_presets().items():
            assert profile.preset == name

    def test_selectable_presets_exclude_custom(self) -> None:
        """`custom` is what a profile becomes after editing, not something to pick."""
        assert "custom" not in SELECTABLE_PRESETS
        assert set(SELECTABLE_PRESETS) | {"custom"} == set(PRESET_PATCHES)

    def test_unknown_preset_name_fails_loudly(self) -> None:
        with pytest.raises(KeyError):
            build_preset("maximum_overdrive")


class TestPrivacyByDesign:
    def test_no_diagnosis_or_disability_field_exists(self) -> None:
        """PRD 2.3 principle 2 and 6.4: no such field exists, and none may be added.

        A guard rather than a nicety: a field like this is the kind of thing that gets added
        in good faith to "personalise better" and then becomes a permanent liability.

        This checks field *names*. Enum values are deliberately exempt, because a typeface
        called OpenDyslexic is a font the learner picked, not a statement about the learner.
        """
        forbidden = (
            "diagnosis", "disability", "condition", "impairment", "disorder", "iep",
            "adhd", "dyslex", "blind", "deaf", "autis", "medical", "accommodation",
            "special_need", "sen_status",
        )

        for field_name in _all_property_names(RenderProfile.model_json_schema()):
            lowered = field_name.lower()
            for term in forbidden:
                assert term not in lowered, f"profile field {field_name!r} looks like a label"

    def test_preset_names_describe_experiences_not_conditions(self) -> None:
        """Decision log, 2026-10-05: presets are named by experience, never by condition."""
        condition_words = ("adhd", "dyslex", "blind", "deaf", "autis", "disab")
        for name in PRESET_PATCHES:
            assert not any(word in name.lower() for word in condition_words), name


def _all_property_names(schema: dict[str, object]) -> list[str]:
    """Every property name in a JSON Schema, including nested definitions."""
    names: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                names.extend(str(key) for key in properties)
            for key, value in node.items():
                if key != "enum":
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(schema)
    return names
