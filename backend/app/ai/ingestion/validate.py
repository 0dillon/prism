"""Graph validation, in code rather than by prompt (PRD tasks P2-05, P2-07).

Pure: no I/O, no model call, no database. It takes a draft graph and returns findings.

**The rule that decides reject from flag.** Reject when the graph is structurally unusable,
would crash a renderer, or would silently mislead a learner. Flag when a human can see and fix
it during review — PRD 5.1 step 9 lists flagged items first, and 2.3 principle 5 requires that
review to happen regardless.

Rejecting what a teacher could fix in ten seconds wastes a job that cost real money and real
waiting. Flagging something that breaks a renderer ships a broken lesson. Each row in the
table below is a judgement about which of those two mistakes is worse for that specific defect.

**An LLM may only ever add flags.** The grounding stage is a separate, later step and may
annotate; nothing from a model decides whether a graph is acceptable. The application decides.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from app.ai.ingestion.grounding import excerpt_is_grounded
from app.domain.graph import find_duplicates, find_prerequisite_cycles
from app.schemas.knowledge_graph import DraftKnowledgeGraph

Severity = Literal["reject", "flag"]


@dataclass(frozen=True, slots=True)
class Finding:
    """One problem, in terms a reviewing teacher can act on."""

    code: str
    severity: Severity
    path: str
    message: str
    target_id: str | None = None


@dataclass(slots=True)
class ValidationReport:
    findings: list[Finding] = field(default_factory=list)
    repaired: list[str] = field(default_factory=list)

    @property
    def rejections(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "reject"]

    @property
    def flags(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "flag"]

    @property
    def ok(self) -> bool:
        return not self.rejections

    def summary(self) -> str:
        """A human-readable error for `ingestion_jobs.error` (PRD 5.1 requires one)."""
        if self.ok:
            return "valid"
        return "; ".join(f"{f.code}: {f.message}" for f in self.rejections[:5])


class GraphRejectedError(ValueError):
    def __init__(self, report: ValidationReport) -> None:
        super().__init__(report.summary())
        self.report = report


def validate_graph(
    graph: DraftKnowledgeGraph, *, source_text: str | None = None
) -> ValidationReport:
    """Check a draft graph and report everything wrong with it."""
    report = ValidationReport()
    concept_ids = {concept.id for concept in graph.concepts}
    section_ids = {section.id for section in graph.sections}

    _check_identity(graph, report)
    _check_references(graph, report, concept_ids, section_ids)
    _check_prerequisites(graph, report, concept_ids)
    _check_quiz_items(graph, report)
    _check_ordering(graph, report)
    if source_text is not None:
        _check_grounding(graph, report, source_text)
    return report


# --------------------------------------------------------------------------
def _check_identity(graph: DraftKnowledgeGraph, report: ValidationReport) -> None:
    for label, ids, path in (
        ("concept", [c.id for c in graph.concepts], "concepts"),
        ("quiz item", [q.id for q in graph.quiz_items], "quizItems"),
        ("section", [s.id for s in graph.sections], "sections"),
    ):
        for duplicate in find_duplicates(ids):
            # Ids are primary keys, and learner mastery is keyed to them. There is no way to
            # choose which duplicate is the real one, so this cannot be repaired.
            report.findings.append(
                Finding(
                    code=f"DUPLICATE_{label.replace(' ', '_').upper()}_ID",
                    severity="reject",
                    path=path,
                    message=f"Two {label}s share the id {duplicate}.",
                    target_id=duplicate,
                )
            )

    if not graph.concepts:
        report.findings.append(
            Finding(
                code="NO_CONCEPTS",
                severity="reject",
                path="concepts",
                message="The graph contains no concepts, so there is nothing to teach.",
            )
        )


def _check_references(
    graph: DraftKnowledgeGraph,
    report: ValidationReport,
    concept_ids: set[str],
    section_ids: set[str],
) -> None:
    for index, item in enumerate(graph.quiz_items):
        if item.concept_id not in concept_ids:
            # A quiz item with no concept crashes the renderer and creates orphan mastery
            # rows. Not teacher-fixable in any meaningful sense: the question is about
            # something that is not in the lesson.
            report.findings.append(
                Finding(
                    code="DANGLING_QUIZ_CONCEPT",
                    severity="reject",
                    path=f"quizItems[{index}].conceptId",
                    message=(
                        f"Question {item.id} refers to concept {item.concept_id}, "
                        "which is not in the lesson."
                    ),
                    target_id=item.id,
                )
            )

    for index, concept in enumerate(graph.concepts):
        if concept.section_id not in section_ids:
            # The reader renderer groups by section; an unknown section has nowhere to render.
            report.findings.append(
                Finding(
                    code="DANGLING_SECTION",
                    severity="reject",
                    path=f"concepts[{index}].sectionId",
                    message=(
                        f"Concept {concept.title!r} belongs to section "
                        f"{concept.section_id}, which does not exist."
                    ),
                    target_id=concept.id,
                )
            )


def _check_prerequisites(
    graph: DraftKnowledgeGraph, report: ValidationReport, concept_ids: set[str]
) -> None:
    for index, concept in enumerate(graph.concepts):
        missing = [p for p in concept.prerequisites if p not in concept_ids]
        if missing:
            # Prerequisites are advisory in v1 - no renderer gates on them - so a bad edge
            # costs nothing when dropped, while rejecting the job costs the whole ingestion.
            report.findings.append(
                Finding(
                    code="DANGLING_PREREQUISITE",
                    severity="flag",
                    path=f"concepts[{index}].prerequisites",
                    message=(
                        f"Concept {concept.title!r} lists prerequisites that are not in the "
                        f"lesson: {', '.join(missing)}. They were removed."
                    ),
                    target_id=concept.id,
                )
            )

        if concept.id in concept.prerequisites:
            report.findings.append(
                Finding(
                    code="SELF_PREREQUISITE",
                    severity="flag",
                    path=f"concepts[{index}].prerequisites",
                    message=(
                        f"Concept {concept.title!r} listed itself as its own prerequisite. "
                        "That was removed."
                    ),
                    target_id=concept.id,
                )
            )

    # Cycles are checked after self-edges are accounted for, so the report names real loops
    # rather than restating the trivial case.
    prerequisites = {
        concept.id: [
            p
            for p in concept.prerequisites
            if p in concept_ids and p != concept.id
        ]
        for concept in graph.concepts
    }
    titles = {concept.id: concept.title for concept in graph.concepts}
    for cycle in find_prerequisite_cycles(prerequisites):
        # Ordering is undefined with a cycle, and PRD P2-05 requires this be caught in code.
        readable = " -> ".join(titles.get(cid, cid) for cycle_id in [cycle] for cid in cycle_id)
        report.findings.append(
            Finding(
                code="PREREQUISITE_CYCLE",
                severity="reject",
                path="concepts[].prerequisites",
                message=(
                    f"These concepts depend on each other in a loop, so they cannot be put "
                    f"in order: {readable}."
                ),
            )
        )


def _check_quiz_items(graph: DraftKnowledgeGraph, report: ValidationReport) -> None:
    for index, item in enumerate(graph.quiz_items):
        path = f"quizItems[{index}]"

        if item.type == "mcq":
            options = item.options or []
            if not options:
                report.findings.append(
                    Finding(
                        code="MCQ_WITHOUT_OPTIONS",
                        severity="reject",
                        path=f"{path}.options",
                        message=f"Question {item.id} is multiple choice but has no options.",
                        target_id=item.id,
                    )
                )
                continue

            matches = [option for option in options if option == item.answer]
            if not matches:
                # The sharpest case in this file. PRD 6.2 grades multiple choice on the
                # client by comparing the chosen option against `answer`. With no matching
                # option the learner can never be correct, and PRD 5.7 computes mastery from
                # exactly those answers. Unanswerable is a correctness bug, not a quality one.
                report.findings.append(
                    Finding(
                        code="MCQ_ANSWER_NOT_IN_OPTIONS",
                        severity="reject",
                        path=f"{path}.answer",
                        message=(
                            f"Question {item.id} has no option matching its answer, so it "
                            "could never be answered correctly."
                        ),
                        target_id=item.id,
                    )
                )
            elif len(matches) > 1:
                report.findings.append(
                    Finding(
                        code="MCQ_ANSWER_AMBIGUOUS",
                        severity="reject",
                        path=f"{path}.options",
                        message=(
                            f"Question {item.id} has {len(matches)} options matching its "
                            "answer, so grading it would be ambiguous."
                        ),
                        target_id=item.id,
                    )
                )

            if len(set(options)) != len(options):
                report.findings.append(
                    Finding(
                        code="MCQ_DUPLICATE_OPTIONS",
                        severity="reject",
                        path=f"{path}.options",
                        message=f"Question {item.id} repeats an option.",
                        target_id=item.id,
                    )
                )

            if not 3 <= len(options) <= 4:
                # PRD 5.2 says 3 to 4 in a comment, not in the schema. A teacher can add or
                # remove an option in the review screen.
                report.findings.append(
                    Finding(
                        code="MCQ_OPTION_COUNT",
                        severity="flag",
                        path=f"{path}.options",
                        message=(
                            f"Question {item.id} has {len(options)} options; 3 or 4 works "
                            "best."
                        ),
                        target_id=item.id,
                    )
                )

        elif item.options is not None:
            report.findings.append(
                Finding(
                    code="OPTIONS_ON_NON_MCQ",
                    severity="reject",
                    path=f"{path}.options",
                    message=(
                        f"Question {item.id} is a {item.type} question but carries multiple "
                        "choice options."
                    ),
                    target_id=item.id,
                )
            )

        if item.type == "true_false" and item.answer not in ("true", "false"):
            report.findings.append(
                Finding(
                    code="TRUE_FALSE_ANSWER_INVALID",
                    severity="reject",
                    path=f"{path}.answer",
                    message=(
                        f"Question {item.id} is true or false, but its answer is "
                        f"{item.answer!r}."
                    ),
                    target_id=item.id,
                )
            )

    _check_quiz_coverage(graph, report)


def _check_quiz_coverage(graph: DraftKnowledgeGraph, report: ValidationReport) -> None:
    """PRD 5.1 step 6 wants at least two items per concept, one of them multiple choice.

    A quality target, and the review screen lets a teacher add questions (P2-13), so thin
    coverage is flagged rather than fatal.
    """
    for concept in graph.concepts:
        items = graph.quiz_items_for(concept.id)
        if not items:
            report.findings.append(
                Finding(
                    code="CONCEPT_WITHOUT_QUIZ",
                    severity="flag",
                    path="quizItems",
                    message=(
                        f"Concept {concept.title!r} has no questions, so a learner cannot "
                        "show they have mastered it."
                    ),
                    target_id=concept.id,
                )
            )
            continue

        if len(items) < 2 or not any(item.type == "mcq" for item in items):
            report.findings.append(
                Finding(
                    code="CONCEPT_QUIZ_THIN",
                    severity="flag",
                    path="quizItems",
                    message=(
                        f"Concept {concept.title!r} has {len(items)} question(s); two or "
                        "more including a multiple choice one works better."
                    ),
                    target_id=concept.id,
                )
            )


def _check_ordering(graph: DraftKnowledgeGraph, report: ValidationReport) -> None:
    """Ordering problems are repaired deterministically rather than rejected.

    Stable-sorting by the order the model gave and renumbering is an exact repair, so
    rejecting a job over it would be throwing away work we can fix. The flag tells the
    teacher we touched it.
    """
    _check_order_sequence(
        [(section.id, section.order) for section in graph.sections], report, "sections"
    )
    by_section: dict[str, list[tuple[str, int]]] = {}
    for concept in graph.concepts:
        by_section.setdefault(concept.section_id, []).append((concept.id, concept.order))
    for section_id, entries in by_section.items():
        _check_order_sequence(entries, report, f"concepts (section {section_id})")


def _check_order_sequence(
    entries: Sequence[tuple[str, int]], report: ValidationReport, path: str
) -> None:
    if not entries:
        return
    orders = [order for _, order in entries]
    if len(set(orders)) != len(orders):
        report.findings.append(
            Finding(
                code="ORDER_DUPLICATE",
                severity="flag",
                path=path,
                message=f"Two items in {path} share a position; they were renumbered.",
            )
        )
    elif sorted(orders) != list(range(len(orders))):
        report.findings.append(
            Finding(
                code="ORDER_NOT_CONTIGUOUS",
                severity="flag",
                path=path,
                message=f"Positions in {path} had gaps; they were renumbered.",
            )
        )


def _check_grounding(
    graph: DraftKnowledgeGraph, report: ValidationReport, source_text: str
) -> None:
    """Every excerpt must appear in the source. Flagged, never rejected.

    PDF extraction mangles text in ways unrelated to honesty, so false positives are expected
    and a teacher adjudicates. This is still the single most useful check in the file: it is
    what catches fabrication and successful prompt injection mechanically.
    """
    for index, concept in enumerate(graph.concepts):
        if not excerpt_is_grounded(concept.source.excerpt, source_text):
            report.findings.append(
                Finding(
                    code="EXCERPT_NOT_IN_SOURCE",
                    severity="flag",
                    path=f"concepts[{index}].source.excerpt",
                    message=(
                        f"The supporting quote for {concept.title!r} was not found in your "
                        "document. Please check this concept carefully."
                    ),
                    target_id=concept.id,
                )
            )


def repair_graph(graph: DraftKnowledgeGraph) -> DraftKnowledgeGraph:
    """Apply the deterministic repairs the findings above describe.

    Only the repairs that are exact: dropping prerequisite edges that point at nothing, and
    renumbering positions. Nothing here changes what the lesson says.
    """
    concept_ids = {concept.id for concept in graph.concepts}
    data = graph.model_dump(mode="json", by_alias=True)

    for concept in data["concepts"]:
        concept["prerequisites"] = [
            p
            for p in concept.get("prerequisites", [])
            if p in concept_ids and p != concept["id"]
        ]

    data["sections"] = _renumber(data.get("sections", []))

    by_section: dict[str, list[dict[str, Any]]] = {}
    for concept in data["concepts"]:
        by_section.setdefault(str(concept["sectionId"]), []).append(concept)
    renumbered: list[dict[str, Any]] = []
    for entries in by_section.values():
        renumbered.extend(_renumber(entries))
    data["concepts"] = renumbered

    return DraftKnowledgeGraph.model_validate(data)


def _renumber(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stable sort by the order given, with the id as a deterministic tiebreak."""
    def sort_key(entry: dict[str, Any]) -> tuple[int, str]:
        raw = entry.get("order", 0)
        return (int(raw) if isinstance(raw, int | float | str) else 0, str(entry.get("id", "")))

    ordered = sorted(entries, key=sort_key)
    for position, entry in enumerate(ordered):
        entry["order"] = position
    return ordered
