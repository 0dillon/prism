"""Named starting profiles, from the table in PRD section 5.3.

Presets are expressed as patches over the schema defaults, exactly as the PRD table lists them:
only the differences. That keeps this file checkable line by line against the PRD, and means a
new setting added to the schema automatically takes its default in every preset rather than
needing five edits.

Preset names describe an experience a learner wants, never a condition they have. There is no
mapping anywhere from preset to diagnosis, and none may be added (PRD 2.3 principle 2).
"""

from __future__ import annotations

from typing import Any, Final, get_args

from app.domain.profiles.merge import deep_merge_profile
from app.schemas.render_profile import Preset, RenderProfile

# Only differences from the schema defaults, per the PRD table.
PRESET_PATCHES: Final[dict[str, dict[str, Any]]] = {
    "standard": {
        "layout": "reader",
    },
    "voice_native": {
        "layout": "conversation",
        "content": {"chunk_size": "concept"},
        "quiz": {"cadence": 3},
        "audio": {"read_aloud": True, "voice_input": True, "earcons": True},
    },
    "hyper_focus": {
        "layout": "cards",
        "content": {"chunk_size": "concept"},
        "quiz": {"cadence": 3},
        "feedback": {"streaks": True, "celebration": "full", "haptics": True},
    },
    "cognitive_ease": {
        "layout": "reader",
        "content": {"reading_level": "plain"},
        "typography": {
            "font": "lexend",
            "letter_spacing": 0.05,
            "word_spacing": 0.16,
            "line_height": 1.8,
            "max_line_length": 60,
        },
        "audio": {"read_aloud": True, "sync_highlight": "word"},
        "visual": {"theme": "cream"},
    },
    "visual_sign": {
        "layout": "visual",
        "content": {"reading_level": "plain"},
        "audio": {"earcons": False},
        "visual": {"captions": True, "sign_clips": True, "concept_images": True},
        "feedback": {"haptics": True},
    },
    # `custom` is what a profile becomes once a learner edits it. It has no patch of its own.
    "custom": {},
}

# Default presets for the personas in PRD section 3, used by onboarding copy and the demo seed.
# This is a presentation default a learner can change at any time, never an assignment.
SELECTABLE_PRESETS: Final[tuple[str, ...]] = (
    "standard",
    "voice_native",
    "hyper_focus",
    "cognitive_ease",
    "visual_sign",
)


def build_preset(preset: str) -> RenderProfile:
    """The full profile for a named preset.

    Raises `KeyError` for an unknown name rather than silently returning defaults, so a typo in
    a seed script or an API payload fails where it happens.
    """
    patch = PRESET_PATCHES[preset]
    profile = deep_merge_profile(RenderProfile(), {**patch, "preset": preset})
    return profile


def default_profile() -> RenderProfile:
    """The profile a new learner starts with before onboarding."""
    return build_preset("standard")


def all_presets() -> dict[str, RenderProfile]:
    return {name: build_preset(name) for name in PRESET_PATCHES}


def _assert_presets_cover_the_enum() -> None:
    """Every value of the Preset literal has a patch, and vice versa.

    Checked at import so adding a preset to the schema without defining it here fails
    immediately rather than at the first learner who selects it.
    """
    declared = set(get_args(Preset))
    defined = set(PRESET_PATCHES)
    if declared != defined:
        missing = declared - defined
        extra = defined - declared
        raise RuntimeError(
            f"preset table does not match the schema: missing={sorted(missing)} "
            f"unexpected={sorted(extra)}"
        )


_assert_presets_cover_the_enum()
