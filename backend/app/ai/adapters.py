"""Converting LLM wire models into the PRD's contracts.

The boundary where untrusted model output becomes application data. Everything here is a
decision the server makes, not one the model gets to make:

* **Ids are assigned here**, as ULIDs. The model supplies a temporary `ref` it can use within
  one response; refs never leave this module. Ids are stable across graph versions and carry
  learner mastery, so a model choosing one could collide with, or silently reassign, an
  existing learner's progress.
* **Source locators are resolved here**, by finding which chunk the returned excerpt came
  from. If the model could choose a locator, a fabricated concept could be made to look
  grounded.
* **Refs that point at nothing are dropped**, not guessed at.

Nothing here is lossy in the other direction: every field the PRD defines is populated, and
anything the model offers that the contract has no room for is discarded rather than smuggled
through.
"""

from __future__ import annotations

from collections.abc import Sequence

from ulid import ULID

from app.ai.ingestion.chunk import Chunk, ChunkIndex
from app.ai.ingestion.grounding import normalise
from app.ai.schemas import (
    MergeOut,
    ProfilePatchOut,
    QuizGenerationOut,
    SessionIntentOut,
)
from app.schemas.intents import SessionIntent
from app.schemas.knowledge_graph import (
    Concept,
    DraftKnowledgeGraph,
    QuizItem,
    Section,
    SourceLocator,
)


def new_concept_id() -> str:
    return f"c_{ULID()}"


def new_quiz_id() -> str:
    return f"q_{ULID()}"


def new_section_id() -> str:
    return f"s_{ULID()}"


# ---------------------------------------------------------------------------
# Merge output -> a draft Knowledge Graph
# ---------------------------------------------------------------------------
def merge_to_graph(
    merged: MergeOut,
    *,
    lesson_id: str,
    chunks: ChunkIndex,
    language: str = "en",
) -> tuple[DraftKnowledgeGraph, dict[str, str]]:
    """Build a draft graph, returning it alongside the ref-to-id map.

    The map is handed back because the quiz stage runs against the same refs: generating quiz
    items and then matching them to concepts by title would be guesswork, and wrong whenever
    two concepts have similar titles.
    """
    section_ids: dict[str, str] = {}
    sections: list[Section] = []
    for order, section in enumerate(merged.sections):
        section_id = new_section_id()
        section_ids[section.ref] = section_id
        sections.append(Section(id=section_id, title=section.title, order=order))

    concept_ids: dict[str, str] = {
        concept.ref: new_concept_id() for concept in merged.concepts
    }

    # Positions restart within each section, which is what the reader and cards renderers
    # expect when they group by section.
    order_in_section: dict[str, int] = {}
    concepts: list[Concept] = []

    for merged_concept in merged.concepts:
        resolved = section_ids.get(merged_concept.section_ref)
        if resolved is None:
            # A concept in a section the model never declared. Attached to the first section
            # rather than silently dropped: validation flags the graph for review either way,
            # and losing a concept would lose part of the teacher's material.
            if not sections:
                sections.append(Section(id=new_section_id(), title="Lesson", order=0))
            resolved = sections[0].id
            section_ids[merged_concept.section_ref] = resolved
        section_id = resolved

        position = order_in_section.get(section_id, 0)
        order_in_section[section_id] = position + 1

        prerequisites = [
            concept_ids[ref]
            for ref in merged_concept.prerequisite_refs
            if ref in concept_ids and ref != merged_concept.ref
        ]

        concepts.append(
            Concept(
                id=concept_ids[merged_concept.ref],
                section_id=section_id,
                order=position,
                title=_clip(merged_concept.title, 80),
                summary=_clip(merged_concept.summary, 240),
                body=merged_concept.body,
                key_term=_clean(merged_concept.key_term),
                definition=_clean(merged_concept.definition),
                examples=[e for e in merged_concept.examples if e.strip()],
                prerequisites=prerequisites,
                visual_hint=_clean(merged_concept.visual_hint),
                source=locator_for(merged_concept.source_excerpt, chunks),
                flags=[],
            )
        )

    graph = DraftKnowledgeGraph(
        schema_version=1,
        lesson_id=lesson_id,
        title=merged.title.strip() or "Untitled lesson",
        overview=_clip(merged.overview, 600),
        language=language,
        sections=sections,
        concepts=concepts,
        quiz_items=[],
        transcript=None,
    )
    return graph, concept_ids


def locator_for(excerpt: str, chunks: ChunkIndex) -> SourceLocator:
    """Find which chunk an excerpt came from, and build the locator from that chunk.

    Resolved by searching the chunks rather than by asking the model, so the locator is a
    fact about the source rather than a claim about it. An excerpt that matches nothing still
    produces a locator - the grounding check flags it separately, and discarding the concept
    here would hide the problem from the teacher who needs to see it.
    """
    needle = normalise(excerpt)
    if needle:
        for chunk in chunks.items:
            if needle in normalise(chunk.text):
                return _locator_from_chunk(chunk, excerpt)

    first = chunks.items[0] if chunks.items else None
    if first is not None:
        return _locator_from_chunk(first, excerpt)
    return SourceLocator(kind="offset", start=0, end=None, excerpt=_clip(excerpt, 1200))


def _locator_from_chunk(chunk: Chunk, excerpt: str) -> SourceLocator:
    return SourceLocator(
        kind=chunk.kind,
        start=chunk.start,
        end=chunk.end,
        excerpt=_clip(excerpt, 1200),
    )


# ---------------------------------------------------------------------------
# Quiz output -> quiz items
# ---------------------------------------------------------------------------
def quiz_to_items(
    generated: QuizGenerationOut, *, concept_ids: dict[str, str]
) -> list[QuizItem]:
    """Attach generated questions to concepts by ref.

    Items whose ref matches no concept are dropped here rather than carried forward as
    dangling references: validation would reject the whole graph for them, which would throw
    away an entire ingestion over one stray question.
    """
    items: list[QuizItem] = []
    for generated_item in generated.items:
        concept_id = concept_ids.get(generated_item.concept_ref)
        if concept_id is None:
            continue

        options: list[str] | None = None
        if generated_item.type == "mcq":
            options = [option for option in generated_item.options if option.strip()]
        items.append(
            QuizItem(
                id=new_quiz_id(),
                concept_id=concept_id,
                type=generated_item.type,
                prompt=generated_item.prompt,
                options=options,
                answer=generated_item.answer,
                acceptable=[a for a in generated_item.acceptable if a.strip()],
                explanation=generated_item.explanation,
                difficulty=generated_item.difficulty,
                flags=[],
            )
        )
    return items


# ---------------------------------------------------------------------------
# Intent output -> the discriminated union
# ---------------------------------------------------------------------------
def intent_to_union(raw: SessionIntentOut) -> SessionIntent:
    """Narrow the flat wire form back to the PRD's union.

    A payload-carrying intent whose payload is missing becomes `unknown` rather than an error.
    The conversation renderer can ask the learner to repeat themselves; it cannot do anything
    useful with a 500.
    """
    from app.schemas.intents import (
        AnswerIntent,
        ChangeProfileIntent,
        GoToIntent,
        QuestionIntent,
        SessionIntentEnvelope,
        SetRateIntent,
        UnknownIntent,
    )

    if raw.type == "answer":
        return AnswerIntent(value=raw.value) if raw.value else UnknownIntent()
    if raw.type == "go_to":
        return GoToIntent(target=raw.target) if raw.target else UnknownIntent()
    if raw.type == "set_rate":
        return SetRateIntent(direction=raw.direction) if raw.direction else UnknownIntent()
    if raw.type == "change_profile":
        return ChangeProfileIntent(request=raw.request) if raw.request else UnknownIntent()
    if raw.type == "question":
        return QuestionIntent(text=raw.text) if raw.text else UnknownIntent()

    envelope = SessionIntentEnvelope.model_validate({"intent": {"type": raw.type}})
    return envelope.intent


# ---------------------------------------------------------------------------
# Profile patch output -> a plain patch mapping
# ---------------------------------------------------------------------------
def profile_patch_to_mapping(patch: ProfilePatchOut) -> dict[str, object]:
    """Drop every null, leaving only the settings the learner actually asked to change.

    Null means "leave this alone" in the wire form. Passing the nulls through would overwrite
    every unmentioned setting with None and fail validation - or worse, reset a learner's
    carefully tuned profile because they asked for one thing.
    """
    return _without_nulls(patch.model_dump())


def _without_nulls(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    cleaned: dict[str, object] = {}
    for key, item in value.items():
        if item is None:
            continue
        if isinstance(item, dict):
            nested = _without_nulls(item)
            if nested:
                cleaned[str(key)] = nested
        else:
            cleaned[str(key)] = item
    return cleaned


# ---------------------------------------------------------------------------
def _clip(text: str, limit: int) -> str:
    """Trim to a contract limit without producing a mid-word fragment.

    The PRD caps a concept title at 80 characters and a summary at 240. A model that overruns
    slightly should not fail the whole graph, but the result still has to read as a sentence.
    """
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    clipped = cleaned[:limit].rsplit(" ", 1)[0]
    return (clipped or cleaned[:limit]).rstrip(" ,;:-")


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def refs_in_order(items: Sequence[object]) -> list[str]:
    return [str(getattr(item, "ref", "")) for item in items]
