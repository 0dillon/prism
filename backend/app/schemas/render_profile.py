"""Render Profile contract. Transcribed field-for-field from PRD section 5.3.

A Render Profile is the learner's own description of how they want to be taught. Three product
rules govern this model, and none of them are negotiable:

* **Profiles are preferences, not diagnoses** (PRD 2.3 principle 2). There is no diagnosis or
  disability field here, none is inferred, and none may ever be added. Presets are named by
  experience (`hyper_focus`), never by condition. Any learner can choose any preset.
* **Profiles are private by default** (PRD 6.4, B2B-5). The contents may reveal sensitive
  information, so they are visible to the learner alone unless that learner opts in to share.
* **A profile is preferences only.** It carries no lesson content and no progress. Switching
  profile mid-lesson must not disturb either (PRD CE-5).

JSON is camelCase, matching the TypeScript/Zod definition the frontend consumes.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Preset = Literal[
    "standard", "voice_native", "hyper_focus", "cognitive_ease", "visual_sign", "custom"
]
Layout = Literal["reader", "cards", "conversation", "visual"]
ReadingLevel = Literal["original", "plain", "simple"]
ChunkSize = Literal["concept", "section", "full"]
FontChoice = Literal["system", "atkinson", "lexend", "opendyslexic"]
SyncHighlight = Literal["off", "sentence", "word"]
Theme = Literal["system", "light", "dark", "high_contrast", "cream", "blue_tint"]
SignLanguage = Literal["ase"]
Celebration = Literal["none", "subtle", "full"]


class ProfileModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class ContentSettings(ProfileModel):
    reading_level: ReadingLevel = "original"
    chunk_size: ChunkSize = "section"
    show_examples: bool = True


class QuizSettings(ProfileModel):
    cadence: Annotated[int, Field(ge=1, le=10)] = Field(
        default=5, description="Quiz after every N concepts."
    )
    items_per_check: Annotated[int, Field(ge=1, le=5)] = 1
    retry_on_wrong: bool = True


class TypographySettings(ProfileModel):
    font: FontChoice = "system"
    size_scale: Annotated[float, Field(ge=0.8, le=2.5)] = 1.0
    letter_spacing: Annotated[float, Field(ge=0.0, le=0.3)] = Field(default=0.0, description="em")
    word_spacing: Annotated[float, Field(ge=0.0, le=0.6)] = Field(default=0.0, description="em")
    line_height: Annotated[float, Field(ge=1.2, le=2.4)] = 1.5
    max_line_length: Annotated[int, Field(ge=30, le=90)] = Field(
        default=70, description="characters"
    )
    word_anchors: bool = Field(
        default=False,
        description=(
            "Bold the leading letters of each word. Off in every preset: research support is "
            "limited, so it is offered as a user toggle only (PRD 5.3 and decision log)."
        ),
    )


class AudioSettings(ProfileModel):
    read_aloud: bool = False
    sync_highlight: SyncHighlight = "off"
    rate: Annotated[float, Field(ge=0.5, le=3.0)] = 1.0
    voice_input: bool = False
    earcons: bool = Field(default=False, description="Short non-speech audio cues.")


class VisualSettings(ProfileModel):
    theme: Theme = "system"
    reduced_motion: bool = False
    captions: bool = True
    sign_clips: bool = False
    sign_language: SignLanguage = Field(
        default="ase", description="ISO 639-3. ASL only in v1 (PRD 2.4)."
    )
    concept_images: bool = False


class FeedbackSettings(ProfileModel):
    progress_bar: bool = True
    streaks: bool = False
    celebration: Celebration = "subtle"
    haptics: bool = False


class RenderProfile(ProfileModel):
    """The complete learner presentation profile.

    Every field has a default, so `RenderProfile()` is a valid standard profile and a partial
    stored profile upgrades cleanly when new settings are added.
    """

    schema_version: Literal[1] = 1
    preset: Preset = "standard"
    layout: Layout = "reader"
    content: ContentSettings = Field(default_factory=ContentSettings)
    quiz: QuizSettings = Field(default_factory=QuizSettings)
    typography: TypographySettings = Field(default_factory=TypographySettings)
    audio: AudioSettings = Field(default_factory=AudioSettings)
    visual: VisualSettings = Field(default_factory=VisualSettings)
    feedback: FeedbackSettings = Field(default_factory=FeedbackSettings)
