"""Knowledge Graph contract. Transcribed field-for-field from PRD section 5.2.

The graph is the product's central contract: every renderer, quiz and progress metric is keyed
to the concept ids defined here. Two rules from the PRD are structural, not stylistic:

* The graph contains **no presentation data**. No fonts, layouts or renderer names. Knowledge
  is separate from interface (PRD 2.3 principle 1), which is what lets one lesson be rendered
  four ways without duplicating content.
* Concept and quiz ids are **stable across graph versions** when the item is unchanged or
  merely edited. Deleting an item retires its id rather than reusing it. Learner mastery and
  historical Learning Events are keyed to those ids, so reuse would silently rewrite history.

JSON is camelCase, matching the TypeScript/Zod definition the frontend consumes.

Two models, deliberately:

* :class:`KnowledgeGraph` is the published-grade contract. Parsing enforces referential
  integrity, so a graph that validates is a graph a renderer can safely consume.
* :class:`DraftKnowledgeGraph` is the same shape without the cross-reference checks, for
  intermediate pipeline states. The ingestion validate stage reports its problems as findings
  a teacher can act on, rather than refusing to parse (PRD 5.1 step 9).
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from app.domain.graph import find_dangling, find_duplicates, find_prerequisite_cycles

ConceptFlag = Literal["ungrounded", "low_confidence", "edited"]
QuizType = Literal["mcq", "true_false", "short_answer"]
Difficulty = Literal["recall", "apply"]
LocatorKind = Literal["page", "time", "offset"]

# Reading levels a concept's text can be rendered at (PRD 5.3 content.readingLevel).
ReadingLevel = Literal["original", "plain", "simple"]


class GraphModel(BaseModel):
    """Shared configuration for every Knowledge Graph model.

    `extra="forbid"` is stricter than Zod's default, which silently strips unknown keys. A
    typo'd or renamed field should surface as a loud 422 naming the field, not as data that
    quietly vanishes somewhere between the two languages. Recorded in PRD section 9.1.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=False,
        frozen=False,
    )


class SourceLocator(GraphModel):
    """Where in the uploaded source this concept came from.

    Every concept carries one. PRD CE-1 requires that every concept link back to its location
    in the source, and the review UI shows `excerpt` beside the concept so a teacher can check
    the extraction against the original (CE-2).
    """

    kind: LocatorKind
    start: float = Field(description="Page number, seconds into the audio, or character offset.")
    end: float | None = None
    excerpt: Annotated[str, Field(max_length=1200)] = Field(
        description="Verbatim source text supporting the concept. Checked against the source."
    )


class Section(GraphModel):
    id: str
    title: str
    order: int


class Concept(GraphModel):
    """The smallest teachable unit. Everything else keys off `id`."""

    id: str = Field(description="Stable across graph versions, e.g. c_01HZX... (ULID).")
    section_id: str
    order: int
    title: Annotated[str, Field(max_length=80)] = Field(description="Short; one idea.")
    summary: Annotated[str, Field(max_length=240)] = Field(
        description="One or two sentences. Used by the cards and conversation renderers."
    )
    body: str = Field(description="Full explanation in plain Markdown.")
    key_term: str | None = None
    definition: str | None = None
    examples: list[str] = Field(default_factory=list)
    prerequisites: list[str] = Field(
        default_factory=list, description="Concept ids that should be understood first."
    )
    visual_hint: str | None = Field(
        default=None, description="Description of a helpful diagram or image."
    )
    source: SourceLocator
    flags: list[ConceptFlag] = Field(default_factory=list)


class QuizItem(GraphModel):
    id: str
    concept_id: str
    type: QuizType
    prompt: str
    options: list[str] | None = Field(default=None, description="MCQ only; 3 to 4 options.")
    answer: str = Field(
        description="Correct option text, 'true'/'false', or the model answer for short answer."
    )
    acceptable: list[str] = Field(
        default_factory=list, description="Alternative correct phrasings."
    )
    explanation: str = Field(description="Shown or spoken after answering.")
    difficulty: Difficulty
    flags: list[ConceptFlag] = Field(default_factory=list)

    def is_locally_gradable(self) -> bool:
        """MCQ and true/false are graded on the client with no LLM call (PRD 6.2)."""
        return self.type in ("mcq", "true_false")


class TranscriptSegment(GraphModel):
    start: float
    end: float
    text: str


class DraftKnowledgeGraph(GraphModel):
    """The graph shape without cross-reference enforcement.

    Used for intermediate pipeline state and for teacher review edits, where problems are
    reported as findings rather than refusing to parse.
    """

    schema_version: Literal[1] = 1
    lesson_id: str
    title: str
    overview: Annotated[str, Field(max_length=600)]
    language: str = "en"
    sections: list[Section] = Field(default_factory=list)
    concepts: Annotated[list[Concept], Field(min_length=1)]
    quiz_items: list[QuizItem] = Field(default_factory=list)
    transcript: list[TranscriptSegment] | None = Field(
        default=None, description="Present for audio sources."
    )

    # ---- convenience accessors -------------------------------------------
    @property
    def concept_ids(self) -> list[str]:
        return [concept.id for concept in self.concepts]

    def concept_by_id(self, concept_id: str) -> Concept | None:
        return next((c for c in self.concepts if c.id == concept_id), None)

    def quiz_items_for(self, concept_id: str) -> list[QuizItem]:
        return [item for item in self.quiz_items if item.concept_id == concept_id]

    def prerequisite_map(self) -> dict[str, list[str]]:
        return {concept.id: list(concept.prerequisites) for concept in self.concepts}

    def concepts_in_order(self) -> list[Concept]:
        """Section order first, then concept order within the section."""
        section_rank = {section.id: section.order for section in self.sections}
        return sorted(
            self.concepts,
            key=lambda c: (section_rank.get(c.section_id, 1 << 30), c.order, c.id),
        )


class KnowledgeGraph(DraftKnowledgeGraph):
    """A graph that is safe to publish and safe for a renderer to consume.

    Parsing enforces the structural invariants in PRD task P1-01 and P2-07. These are checked
    here, in code, rather than being left to the extraction prompt: an LLM may propose content,
    but it never decides whether that content is valid.
    """

    @model_validator(mode="after")
    def _check_referential_integrity(self) -> Self:
        problems: list[str] = []

        section_ids = [section.id for section in self.sections]
        concept_ids = self.concept_ids
        quiz_ids = [item.id for item in self.quiz_items]

        for label, duplicates in (
            ("section", find_duplicates(section_ids)),
            ("concept", find_duplicates(concept_ids)),
            ("quiz item", find_duplicates(quiz_ids)),
        ):
            if duplicates:
                problems.append(f"duplicate {label} ids: {', '.join(duplicates)}")

        # A quiz item pointing at no concept would crash a renderer and create orphan mastery
        # rows, so it is a hard rejection rather than a flag.
        dangling_quiz = find_dangling(
            (item.concept_id for item in self.quiz_items), concept_ids
        )
        if dangling_quiz:
            problems.append(
                f"quiz items reference unknown concepts: {', '.join(dangling_quiz)}"
            )

        dangling_sections = find_dangling(
            (concept.section_id for concept in self.concepts), section_ids
        )
        if dangling_sections:
            problems.append(
                f"concepts reference unknown sections: {', '.join(dangling_sections)}"
            )

        dangling_prereqs = find_dangling(
            (prereq for concept in self.concepts for prereq in concept.prerequisites),
            concept_ids,
        )
        if dangling_prereqs:
            problems.append(
                f"prerequisites reference unknown concepts: {', '.join(dangling_prereqs)}"
            )

        cycles = find_prerequisite_cycles(self.prerequisite_map())
        if cycles:
            rendered = "; ".join(" -> ".join(cycle) for cycle in cycles)
            problems.append(f"prerequisite cycles: {rendered}")

        problems.extend(self._quiz_answerability_problems())

        if problems:
            raise ValueError("; ".join(problems))
        return self

    def _quiz_answerability_problems(self) -> list[str]:
        """An unanswerable quiz item is a correctness bug, not a quality issue.

        PRD 6.2 grades MCQ and true/false locally, by comparing the learner's chosen option
        against `answer`. If no option equals `answer`, the learner can never be correct, and
        PRD 5.7 mastery is computed from exactly those answers.
        """
        problems: list[str] = []
        for item in self.quiz_items:
            if item.type == "mcq":
                if not item.options:
                    problems.append(f"quiz item {item.id} is mcq but has no options")
                    continue
                matches = [option for option in item.options if option == item.answer]
                if not matches:
                    problems.append(
                        f"quiz item {item.id} has no option equal to its answer"
                    )
                elif len(matches) > 1:
                    problems.append(
                        f"quiz item {item.id} has {len(matches)} options equal to its answer"
                    )
            elif item.options is not None:
                problems.append(f"quiz item {item.id} is {item.type} but carries options")

            if item.type == "true_false" and item.answer not in ("true", "false"):
                problems.append(
                    f"quiz item {item.id} is true_false but its answer is not true or false"
                )
        return problems
