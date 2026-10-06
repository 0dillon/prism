"""Wire models for structured LLM output.

A separate family from `app/schemas/`, and deliberately so.

Strict structured output forbids optional keys: every property must appear in `required`, and
`additionalProperties` must be false. The PRD's contracts have genuine optionals - a concept
may have no key term, a quiz item may have no options - so satisfying the provider by editing
those contracts would let a vendor limitation reshape the product's data model. That is
exactly the silent schema divergence the brief warns about.

So the provider gets its own models, where "absent" is expressed as an explicit null, and
`app/ai/adapters.py` converts between the two. The PRD's contracts stay as the PRD wrote them.

Two further rules hold throughout:

* **The model never assigns an id.** It assigns a temporary `ref` it can refer to within one
  response; the server assigns the real ULIDs. Ids are stable across graph versions and carry
  learner mastery, so they are not something a model gets to choose.
* **The model never picks a source locator.** It returns the excerpt it relied on, and the
  server resolves which chunk that excerpt came from. A model that could choose locators could
  make a fabricated concept look grounded.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class WireModel(BaseModel):
    """Base for every model-facing schema.

    `extra="forbid"` matches the `additionalProperties: false` the provider enforces, so a
    response carrying an invented field fails here rather than being silently dropped.
    """

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Concept extraction (map stage)
# ---------------------------------------------------------------------------
class CandidateConceptOut(WireModel):
    title: str = Field(description="Short, one idea, at most 80 characters.")
    summary: str = Field(description="One or two sentences, at most 240 characters.")
    body: str = Field(description="A full plain-language explanation, in Markdown.")
    key_term: str | None = Field(description="The main vocabulary item, or null.")
    definition: str | None = Field(description="A definition of the key term, or null.")
    examples: list[str] = Field(description="Examples drawn from the document. May be empty.")
    visual_hint: str | None = Field(
        description="A description of a diagram that would help, or null."
    )
    source_excerpt: str = Field(
        description=(
            "Verbatim text from the document that supports this concept. Copy it exactly; "
            "it is checked against the document."
        )
    )


class ConceptExtractionOut(WireModel):
    concepts: list[CandidateConceptOut]


# ---------------------------------------------------------------------------
# Merge and order (reduce stage)
# ---------------------------------------------------------------------------
class MergedSectionOut(WireModel):
    ref: str = Field(description="A short handle for this section, unique in this response.")
    title: str


class MergedConceptOut(WireModel):
    ref: str = Field(description="A short handle for this concept, unique in this response.")
    section_ref: str = Field(description="The ref of the section this concept belongs to.")
    title: str
    summary: str
    body: str
    key_term: str | None
    definition: str | None
    examples: list[str]
    visual_hint: str | None
    source_excerpt: str
    prerequisite_refs: list[str] = Field(
        description=(
            "Refs of concepts a learner should understand first. Must not form a loop, and "
            "must not include this concept's own ref."
        )
    )


class MergeOut(WireModel):
    title: str = Field(description="A title for the whole lesson.")
    overview: str = Field(description="At most 600 characters describing the lesson.")
    sections: list[MergedSectionOut] = Field(description="In teaching order.")
    concepts: list[MergedConceptOut] = Field(description="In teaching order.")


# ---------------------------------------------------------------------------
# Quiz generation
# ---------------------------------------------------------------------------
class QuizItemOut(WireModel):
    concept_ref: str
    type: Literal["mcq", "true_false", "short_answer"]
    prompt: str
    options: list[str] = Field(
        description=(
            "For multiple choice, 3 or 4 options, exactly one of which equals `answer`. "
            "Empty for other question types."
        )
    )
    answer: str = Field(
        description=(
            "For multiple choice, the exact text of the correct option. For true or false, "
            "'true' or 'false'. Otherwise, a model answer."
        )
    )
    acceptable: list[str] = Field(description="Alternative correct phrasings. May be empty.")
    explanation: str
    difficulty: Literal["recall", "apply"]


class QuizGenerationOut(WireModel):
    items: list[QuizItemOut]


# ---------------------------------------------------------------------------
# Grounding check
# ---------------------------------------------------------------------------
class GroundingVerdictOut(WireModel):
    ref: str
    supported: bool = Field(description="Whether the source excerpt supports the claim.")
    reason: str = Field(description="One short sentence. Shown to the teacher when not.")


class GroundingOut(WireModel):
    verdicts: list[GroundingVerdictOut]


# ---------------------------------------------------------------------------
# Sign tagging
# ---------------------------------------------------------------------------
class SignMatchOut(WireModel):
    concept_ref: str
    gloss: str | None = Field(
        description=(
            "A gloss from the supplied list whose meaning matches the key term, or null. "
            "Never invent a gloss that is not in the list."
        )
    )


class SignTaggingOut(WireModel):
    matches: list[SignMatchOut]


# ---------------------------------------------------------------------------
# Content variants
# ---------------------------------------------------------------------------
class VariantOut(WireModel):
    summary: str
    body: str


# ---------------------------------------------------------------------------
# Short-answer grading
# ---------------------------------------------------------------------------
class GradeOut(WireModel):
    correct: bool
    feedback: str = Field(description="One or two sentences addressed to the learner.")


# ---------------------------------------------------------------------------
# Session intent
#
# The PRD's SessionIntent is a discriminated union, and strict structured output cannot have a
# union at the root. So the wire form is one flat object with a `type` plus every possible
# payload field as a nullable, and the adapter narrows it back to the real union.
# ---------------------------------------------------------------------------
class SessionIntentOut(WireModel):
    type: Literal[
        "next", "previous", "repeat", "simplify", "elaborate", "example", "quiz_me",
        "answer", "pause", "resume", "where_am_i", "go_to", "set_rate",
        "change_profile", "question", "unknown",
    ]
    value: str | None = Field(description="For 'answer': what the learner said.")
    target: str | None = Field(description="For 'go_to': the section or concept title.")
    direction: Literal["slower", "faster"] | None = Field(description="For 'set_rate'.")
    request: str | None = Field(description="For 'change_profile': the learner's words.")
    text: str | None = Field(description="For 'question': the learner's question.")


# ---------------------------------------------------------------------------
# Needs-to-profile parsing
#
# The patch mirrors the Render Profile with every field nullable, where null means "leave this
# alone". Expressing it this way rather than as a free-form object has a real benefit beyond
# satisfying strict mode: the model cannot propose a setting that does not exist, because
# there is no field in which to express one.
# ---------------------------------------------------------------------------
class ContentPatchOut(WireModel):
    reading_level: Literal["original", "plain", "simple"] | None
    chunk_size: Literal["concept", "section", "full"] | None
    show_examples: bool | None


class QuizPatchOut(WireModel):
    cadence: int | None = Field(description="Quiz after every N concepts, 1 to 10.")
    items_per_check: int | None = Field(description="1 to 5.")
    retry_on_wrong: bool | None


class TypographyPatchOut(WireModel):
    font: Literal["system", "atkinson", "lexend", "opendyslexic"] | None
    size_scale: float | None = Field(description="0.8 to 2.5.")
    letter_spacing: float | None = Field(description="0 to 0.3 em.")
    word_spacing: float | None = Field(description="0 to 0.6 em.")
    line_height: float | None = Field(description="1.2 to 2.4.")
    max_line_length: int | None = Field(description="30 to 90 characters.")
    word_anchors: bool | None


class AudioPatchOut(WireModel):
    read_aloud: bool | None
    sync_highlight: Literal["off", "sentence", "word"] | None
    rate: float | None = Field(description="0.5 to 3.0.")
    voice_input: bool | None
    earcons: bool | None


class VisualPatchOut(WireModel):
    theme: Literal["system", "light", "dark", "high_contrast", "cream", "blue_tint"] | None
    reduced_motion: bool | None
    captions: bool | None
    sign_clips: bool | None
    concept_images: bool | None


class FeedbackPatchOut(WireModel):
    progress_bar: bool | None
    streaks: bool | None
    celebration: Literal["none", "subtle", "full"] | None
    haptics: bool | None


class ProfilePatchOut(WireModel):
    preset: Literal[
        "standard", "voice_native", "hyper_focus", "cognitive_ease", "visual_sign", "custom"
    ] | None
    layout: Literal["reader", "cards", "conversation", "visual"] | None
    content: ContentPatchOut | None
    quiz: QuizPatchOut | None
    typography: TypographyPatchOut | None
    audio: AudioPatchOut | None
    visual: VisualPatchOut | None
    feedback: FeedbackPatchOut | None


class ProfileParseOut(WireModel):
    patch: ProfilePatchOut
    explanation: str = Field(
        description=(
            "Plain language, addressed to the learner, describing what changed. For example: "
            "'I switched to cards with a quiz every 3 concepts.'"
        )
    )
    unsupported: list[str] = Field(
        description=(
            "Anything the learner asked for that no setting covers. Say it plainly; these "
            "are recorded so the product can grow to cover them."
        )
    )
